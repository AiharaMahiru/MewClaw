/**
 * createRunClient 测试（SPEC lark-run-client.md §8）：
 * mock fetch 传输层，覆盖 NDJSON 解析（心跳混排/超大帧/畸形 JSON）、
 * envelope 不匹配拒绝、断流判定、cancel 幂等与连接失败不重发。
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeArtifactId, makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";

import { createRunClient, RunClientError, type RunClientOptions } from "./client.js";

const scope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!scope.ok) throw new Error("unreachable");
const scopeValue = scope.value;

const request = {
  runId: makeRunId("run-1"),
  scope: scopeValue,
  messageId: makeMessageId("om_1"),
  prompt: "你好",
};

const artifactBytes = Uint8Array.from([1, 2, 3]);
const artifactRequest = {
  scope: scopeValue,
  artifactId: makeArtifactId("a".repeat(64)),
  name: "generated-image.png",
  digest: createHash("sha256").update(artifactBytes).digest("hex"),
  bytes: artifactBytes.byteLength,
};

/** 把多行文本转为 Response（流式 body）。 */
function streamResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
  return new Response(body, { status });
}

/** 收集一个流的所有产出。 */
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function eventLine(
  type = "turn/start",
  data: Record<string, unknown> = { turn: 1 },
  runId = "run-1",
): string {
  return JSON.stringify({ event: { type, seq: 0, time: 1, data }, envelope: { runId, scope: scopeValue } });
}

function outcomeLine(code = "OK", runId = "run-1"): string {
  const outcome = code === "OK" ? { code: "OK" } : { code, message: code };
  return JSON.stringify({ envelope: { runId, scope: scopeValue }, outcome });
}

function delayedHeartbeatResponse(delayMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(`${eventLine()}\n`));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(new TextEncoder().encode(`${outcomeLine()}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function signalAwareDelayedResponse(delayMs: number, signal: AbortSignal | null | undefined): Response {
  if (!signal) throw new Error("测试响应需要 AbortSignal");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        clearTimeout(timer);
        controller.error(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        controller.enqueue(new TextEncoder().encode(`${outcomeLine()}\n`));
        controller.close();
      }, delayMs);
      signal.addEventListener("abort", abort, { once: true });
      controller.enqueue(new TextEncoder().encode(`${eventLine()}\n`));
    },
  });
  return new Response(body, { status: 200 });
}

async function expectSchemaError(options: RunClientOptions): Promise<void> {
  await expect(collect(await createRunClient(options).submit(request)))
    .rejects.toMatchObject({ code: "STREAM_SCHEMA_ERROR" });
}

function makeOptions(overrides: Partial<RunClientOptions> = {}): { options: RunClientOptions; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  return {
    fetchMock,
    options: {
      baseURL: "http://127.0.0.1:8787",
      token: "secret",
      connectTimeoutMs: 5000,
      heartbeatToleranceMs: 1000,
      maxEventBytes: 64 * 1024,
      maxResponseBytes: 32 * 1024 * 1024,
      fetch: fetchMock as unknown as typeof fetch,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("submit/正常流", () => {
  it("事件行 + 心跳空行 + 终止行（心跳对上层透明）", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([eventLine(), "", outcomeLine()]));
    const client = createRunClient(options);
    const stream = await client.submit(request);
    const items = await collect(stream);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ event: { type: "turn/start" } });
    expect(items[1]).toMatchObject({ outcome: { code: "OK" } });
    // 鉴权头与 body。
    const call = fetchMock.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
    expect(call.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(call.body)).toEqual(request);
  });
});

describe("submit/协议校验", () => {
  it("envelope 不匹配（runId 或 scope 不一致）→ STREAM_SCHEMA_ERROR", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([eventLine("turn/start", { turn: 1 }, "run-OTHER")]));
    const stream = await createRunClient(options).submit(request);
    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_SCHEMA_ERROR" });
  });

  it("畸形 JSON / 超大帧 → STREAM_SCHEMA_ERROR", async () => {
    const bad = makeOptions();
    bad.fetchMock.mockResolvedValue(streamResponse(["{not json"]));
    await expectSchemaError(bad.options);

    const huge = makeOptions({ maxEventBytes: 32 });
    huge.fetchMock.mockResolvedValue(streamResponse([eventLine("t", {})]));
    await expectSchemaError(huge.options);
  });
});

describe("submit/传输失败", () => {
  it("连接超时仅覆盖首字节，长响应流保持有效", async () => {
    const { options, fetchMock } = makeOptions({ connectTimeoutMs: 30, heartbeatToleranceMs: 200 });
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(signalAwareDelayedResponse(80, init.signal)));

    const items = await collect(await createRunClient(options).submit(request));

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ outcome: { code: "OK" } });
  });

  it("首字节后用户取消仍中断响应流", async () => {
    const { options, fetchMock } = makeOptions({ connectTimeoutMs: 200, heartbeatToleranceMs: 500 });
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(signalAwareDelayedResponse(300, init.signal)));
    const abort = new AbortController();
    const stream = await createRunClient(options).submit(request, abort.signal);

    abort.abort();

    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_BROKEN" });
  });

  it("连接失败 → CONNECT_FAILED（不重发）", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(createRunClient(options).submit(request)).rejects.toMatchObject({ code: "CONNECT_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("4xx/5xx → HTTP_ERROR（带状态码）", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([], 500));
    await expect(createRunClient(options).submit(request)).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
  });

  it("心跳超时（帧间隔超容忍窗口）→ STREAM_BROKEN", async () => {
    const { options, fetchMock } = makeOptions({ heartbeatToleranceMs: 60 });
    // 两帧间隔 150ms > 容忍 60ms。
    fetchMock.mockResolvedValue(delayedHeartbeatResponse(150));
    const errors: unknown[] = [];
    const client = createRunClient({ ...options, onStreamError: (_runId, code) => errors.push(code) });
    const stream = await client.submit(request);
    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_BROKEN" });
    expect(errors).toEqual(["STREAM_BROKEN"]);
  });

  it("提交被取消 → STREAM_BROKEN", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const abort = new AbortController();
    abort.abort();
    await expect(createRunClient(options).submit(request, abort.signal)).rejects.toMatchObject({ code: "STREAM_BROKEN" });
  });
});

describe("cancel", () => {
  it("200 与 404 都视为成功（幂等）", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([], 200));
    await expect(createRunClient(options).cancel(makeRunId("run-1"))).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(streamResponse([], 404));
    await expect(createRunClient(options).cancel(makeRunId("run-1"))).resolves.toBeUndefined();
    const call = fetchMock.mock.calls[0]![0] as string;
    expect(call).toBe("http://127.0.0.1:8787/v1/runs/run-1/cancel");
  });

  it("500 → HTTP_ERROR；网络失败 → CONNECT_FAILED", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([], 500));
    await expect(createRunClient(options).cancel(makeRunId("run-1"))).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(createRunClient(options).cancel(makeRunId("run-1"))).rejects.toMatchObject({ code: "CONNECT_FAILED" });
  });
});

describe("resolveInteraction", () => {
  it("把完整 Scope 作为授权上下文发送", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(streamResponse([], 200));
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c" as never;

    await createRunClient(options).resolveInteraction(scopeValue, interactionId, { selected: ["继续"] });

    const call = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(call.body)).toEqual({
      scope: scopeValue,
      interactionId,
      answer: { selected: ["继续"] },
    });
  });
});

describe("sessionOverview", () => {
  it("把完整 Scope 与会话代次发往窄查询端点", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ exists: false }), { status: 200 }));

    await createRunClient(options).sessionOverview({ scope: scopeValue, sessionGeneration: 2 });

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8787/v1/session-overview");
    const call = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(call.body)).toEqual({ scope: scopeValue, sessionGeneration: 2 });
  });

  it("超出 JSON 预算时在会话投影解析前拒绝", async () => {
    const { options, fetchMock } = makeOptions({ maxResponseBytes: 64 });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      exists: false,
      ignoredByParser: "x".repeat(65),
    }), { status: 200 }));

    await expect(createRunClient(options).sessionOverview({ scope: scopeValue, sessionGeneration: 0 }))
      .rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
  });

  it("拒绝未知字段、过大的 TODO 与异常 usage 计数", async () => {
    const { options, fetchMock } = makeOptions();
    const usage = {
      runs: 1,
      modelCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
    };
    const valid = {
      exists: true,
      todos: [{ content: "整理结果", status: "pending" }],
      usage,
      lastActivityAt: "2026-08-17T00:00:00.000Z",
    };
    const invalidBodies = [
      { exists: false, extra: true },
      { ...valid, extra: true },
      { ...valid, usage: { ...usage, extra: 1 } },
      { ...valid, usage: { ...usage, runs: 1_000_000_000_001 } },
      { ...valid, todos: [{ content: "x".repeat(4_097), status: "pending" }] },
      { ...valid, todos: Array.from({ length: 129 }, () => ({ content: "x", status: "pending" })) },
      { ...valid, todos: [{ content: "x", status: "pending", extra: true }] },
    ];

    for (const body of invalidBodies) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(createRunClient(options).sessionOverview({ scope: scopeValue, sessionGeneration: 0 }))
        .rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
    }
  });
});

describe("readArtifact", () => {
  it("请求完整 artifact 证据，并只返回有界且校验过的图片字节", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(new Response(artifactBytes, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    }));

    const result = await createRunClient(options).readArtifact(artifactRequest);

    expect(result).toEqual({ bytes: artifactBytes, mimeType: "image/png" });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8787/v1/artifacts/read");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual(artifactRequest);
  });

  it("拒绝非图片、字节数或摘要不符的 Worker 响应", async () => {
    const cases = [
      new Response(artifactBytes, { status: 200, headers: { "content-type": "text/plain", "content-length": "3" } }),
      new Response(Uint8Array.from([3, 2, 1]), { status: 200, headers: { "content-type": "image/png", "content-length": "3" } }),
      new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png", "content-length": "4" } }),
    ];

    for (const response of cases) {
      const { options, fetchMock } = makeOptions();
      fetchMock.mockResolvedValue(response);
      await expect(createRunClient(options).readArtifact(artifactRequest))
        .rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
    }
  });
});

describe("cron 投递响应", () => {
  it("畸形 Scope 不得跨 worker 边界进入 gateway", async () => {
    const { options, fetchMock } = makeOptions();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      deliveries: [{
        runId: "run-1",
        deliveryToken: "token",
        scope: { ...scopeValue, conversationId: "oc_\nunsafe" },
        task: "任务",
        status: "completed",
        scheduledFor: "2026-08-16T00:00:00.000Z",
        finishedAt: "2026-08-16T00:01:00.000Z",
        output: "结果",
      }],
    }), { status: 200 }));

    await expect(createRunClient(options).claimCronDeliveries({
      tenantId: scopeValue.tenantId,
      botId: scopeValue.botId,
      deploymentId: scopeValue.deploymentId,
      userIds: [scopeValue.userId],
    })).rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
  });
});

// RunClientError 独立构造也应有完整面（供 gateway 兜底展示）。
describe("RunClientError", () => {
  it("类型化错误携带 code/status", () => {
    const error = new RunClientError("HTTP_ERROR", "worker 返回 502", 502);
    expect(error).toMatchObject({ name: "RunClientError", code: "HTTP_ERROR", status: 502 });
  });
});
