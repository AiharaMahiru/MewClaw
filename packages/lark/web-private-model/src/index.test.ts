import { describe, expect, it, vi } from "vitest";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";

import { UrlPolicy } from "dsh-lark-url-policy";

import { WebPrivateModelAdapter } from "./index.js";

const reference = {
  rpcId: "rpc-private",
  profileId: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  model: "user-model",
  capability: "A".repeat(43),
};

describe("WebPrivateModelAdapter", () => {
  it("没有当前 prompt 的 capability 时 fail closed，且不请求 Auth Edge", async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = new WebPrivateModelAdapter({
      authBaseUrl: "http://127.0.0.1:13080",
      workerToken: "worker-token",
      routes: { webModelRouteForCurrentSelection: () => undefined },
      fetch: request,
    });
    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: "PRIVATE_MODEL_ROUTE_UNAVAILABLE" });
    expect(request).not.toHaveBeenCalled();
  });

  it("路由换取只携带一次性引用，且私网 Base URL 在真实出站前被拒绝", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      route: {
        profileId: reference.profileId,
        revision: reference.revision,
        model: reference.model,
        baseUrl: "https://127.0.0.1/v1",
        apiKey: "test-key",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new WebPrivateModelAdapter({
      authBaseUrl: "http://127.0.0.1:13080",
      workerToken: "worker-token",
      routes: { webModelRouteForCurrentSelection: () => reference },
      fetch: request,
      urlPolicy: new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    });
    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: "PRIVATE_MODEL_REQUEST_FAILED" });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:13080/internal/models/resolve");
    expect(init?.headers).toMatchObject({ authorization: "Bearer worker-token", "cache-control": "no-store" });
    expect(String(init?.body)).toContain(reference.capability);
    expect(String(init?.body)).not.toContain("test-key");
  });

  it("沿用 OpenAI 兼容工具流，工具参数始终是 JSON Schema object", async () => {
    let schemaObject = false;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { parameters?: { type?: string } } }> };
      schemaObject = request.tools?.[0]?.function?.parameters?.type === "object";
      return new Response([
        'data: {"id":"chatcmpl_test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    try {
      const adapter = new WebPrivateModelAdapter({
        authBaseUrl: "http://127.0.0.1:13080",
        workerToken: "worker-token",
        routes: { webModelRouteForCurrentSelection: () => reference },
        fetch: async () => new Response(JSON.stringify({
          route: { profileId: reference.profileId, revision: 1, model: reference.model, baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
        }), { status: 200, headers: { "content-type": "application/json" } }),
        urlPolicy: new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
      });
      const chunks = await collect(adapter.stream({
        ...options(),
        tools: [{ name: "bash", description: "运行命令", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
      }));
      expect(schemaObject).toBe(true);
      expect(chunks.map((chunk) => (chunk as { type: string }).type)).toContain("tool-call-delta");
      expect(chunks.map((chunk) => (chunk as { type: string }).type)).toContain("finish");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function options(): GenerateOptions {
  return {
    provider: "web-private",
    model: "user-model",
    sessionId: "session-private" as NonNullable<GenerateOptions["sessionId"]>,
    messages: [],
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const item of stream) result.push(item);
  return result;
}
