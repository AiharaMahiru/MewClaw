import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { createPromptAuditModel, createPromptAuditModelClient } from "./prompt-audit-model.js";

function fixture(chunks: StreamChunk[]) {
  const requests: GenerateOptions[] = [];
  const close = vi.fn(async () => {});
  const model = createPromptAuditModelClient(async function* (request) {
    requests.push(request);
    yield* chunks;
  }, close, 512);
  return { model, requests, close };
}

describe("审计模型协议", () => {
  const input = () => ({ system: "仅进行审计", text: "待审计内容", signal: new AbortController().signal });

  it("官方插件复用设置与凭证引用，调用仅到配置的审计模型地址", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "dsh-audit-model-test-"));
    const requests: { url: string | undefined; authorization: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      const received = { url: request.url, authorization: request.headers.authorization, body: "" };
      requests.push(received);
      request.on("data", (chunk: Buffer) => { received.body += chunk.toString(); });
      request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
      'data: {"choices":[{"delta":{"content":"{\\"allow\\":false}"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ].join("\n\n") + "\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let model: Awaited<ReturnType<typeof createPromptAuditModel>> | undefined;
    try {
      await writeFile(join(dshHome, "settings.yaml"), [
        "llm-deepseek:", `  baseURL: http://127.0.0.1:${port}/v1`,
        "  apiKeyEnv: AUDIT_TEST_CREDENTIAL", "  thinking: disabled",
        "  modelAliases:", "    deepseek-v4.1-flash: deepseek/deepseek-v4.1-flash",
      ].join("\n"));
      await writeFile(join(dshHome, ".credentials.yaml"), "AUDIT_TEST_CREDENTIAL: synthetic-managed-key\n", { mode: 0o600 });
      model = await createPromptAuditModel({
        dshHome,
        launchEnvironment: createLaunchEnvironmentSnapshot([
          { source: "process", values: { AUDIT_TEST_CREDENTIAL: "synthetic-stale-control-key" } },
          { source: "project-env", values: { AUDIT_TEST_CREDENTIAL: "synthetic-fallback-key" } },
        ]),
      });
      await expect(model.generate(input())).resolves.toBe('{"allow":false}');
      expect(requests).toEqual([{ url: "/v1/chat/completions", authorization: "Bearer synthetic-stale-control-key", body: expect.any(String) }]);
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", thinking: { type: "disabled" } });
    } finally {
      await model?.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("固定使用 V4.1 Flash 路由，隔离系统规则与用户文本，并传递取消信号", async () => {
    const { model, requests, close } = fixture([
      { type: "reasoning-delta", index: 0, text: "内部推理" },
      { type: "text-delta", index: 1, text: '{"allow":' },
      { type: "text-delta", index: 1, text: "false}" },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    const request = input();
    await expect(model.generate(request)).resolves.toBe('{"allow":false}');
    expect(requests[0]).toMatchObject({
      provider: "deepseek-official", model: "deepseek-v4.1-flash", system: request.system,
      signal: request.signal, maxTokens: 512,
      messages: [{ role: "user", content: [{ type: "text", text: request.text }] }],
    });
    expect(requests[0]?.tools).toBeUndefined();
    await model.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each<StreamChunk[]>([
    [],
    [{ type: "text-delta", index: 0, text: '{"allow":true}' }],
    [{ type: "finish", reason: { kind: "stop" } }],
    [{ type: "finish", reason: { kind: "max-tokens" } }],
    [{ type: "finish", reason: { kind: "tool-calls" } }],
    [{ type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "已取消" } } }],
    [{ type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "连接失败" } } }],
  ])("空响应、缺失结束、截断或非正常结束均拒绝 %#", async (...chunks) => {
    const { model } = fixture(chunks);
    await expect(model.generate(input())).rejects.toThrow("prompt audit:");
  });

  it("预先取消时不启动模型调用", async () => {
    const { model, requests } = fixture([]);
    await expect(model.generate({ ...input(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("已有判定也不能覆盖上游错误或截断", async () => {
    const { model } = fixture([
      { type: "text-delta", index: 0, text: '{"decision":"allow"}' },
      { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "内部异常" } } },
    ]);
    await expect(model.generate(input())).rejects.toThrow("finish error TRANSPORT");
  });

  it("拒绝异常超长模型输出", async () => {
    const { model } = fixture([{ type: "text-delta", index: 0, text: "x".repeat(4097) }]);
    await expect(model.generate(input())).rejects.toThrow("oversized");
  });

  it("调用中取消即拒绝响应", async () => {
    const controller = new AbortController();
    const model = createPromptAuditModelClient(async function* () {
      controller.abort();
      yield { type: "text-delta", index: 0, text: '{"allow":true}' };
    }, async () => {}, 512);
    await expect(model.generate({ ...input(), signal: controller.signal })).rejects.toThrow();
  });
});
