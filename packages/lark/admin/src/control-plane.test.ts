import { describe, expect, it, vi } from "vitest";

import {
  createControlPlane,
  type ControlPlaneConfig,
  type WorkerFetch,
} from "./control-plane.js";

const WORKER_TOKEN = "worker-test-token";
const DEFAULT_GENERATION = 2;
const TARGET_ID = "current-agent";

type WorkerFetchMock = WorkerFetch & {
  mock: { calls: Parameters<WorkerFetch>[] };
};

const config: ControlPlaneConfig = {
  workerBaseUrl: "http://127.0.0.1:8787",
  workerTokenEnv: "WORKER_TOKEN",
  targets: [{
    id: TARGET_ID,
    label: "当前 Agent",
    scope: {
      tenantId: "t",
      botId: "b",
      deploymentId: "d",
      userId: "ou_admin",
      conversationId: "oc_admin",
    },
    defaultGeneration: DEFAULT_GENERATION,
  }],
};

function mockCredentials(value = WORKER_TOKEN) {
  return { resolve: vi.fn(async () => ({ value })) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workerFetch(
  implementation: WorkerFetch = async (input) => {
    if (String(input).endsWith("/healthz")) return jsonResponse({ ok: true, queueDepth: 3 });
    return jsonResponse({
      exists: true,
      todos: [{ content: "验证 WebUI", status: "in_progress" }],
      usage: {
        runs: 4,
        modelCalls: 5,
        inputTokens: 6,
        outputTokens: 7,
        cacheReadTokens: 8,
        cacheWriteTokens: 9,
        reasoningTokens: 10,
      },
      lastActivityAt: "2026-08-16T15:00:00.000Z",
    });
  },
): WorkerFetchMock {
  return vi.fn(implementation) as unknown as WorkerFetchMock;
}

describe("admin control-plane", () => {
  it("仅为配置 target 派生 Scope，并使用服务端 worker 凭证", async () => {
    const request = workerFetch();
    const credentials = mockCredentials();
    const control = await createControlPlane(config, credentials, request);

    const dashboard = await control.dashboard();

    expect(dashboard.worker.queueDepth).toBe(3);
    expect(dashboard.targets[0]).toMatchObject({
      target: { id: TARGET_ID, label: "当前 Agent" },
      generation: DEFAULT_GENERATION,
      session: { exists: true },
    });
    expect(request).toHaveBeenCalledTimes(2);
    const overviewInit = request.mock.calls[1]?.[1];
    expect(new Headers(overviewInit?.headers).get("authorization")).toBe(`Bearer ${WORKER_TOKEN}`);
    expect(JSON.parse(String(overviewInit?.body))).toEqual({
      scope: config.targets[0]?.scope,
      sessionGeneration: DEFAULT_GENERATION,
    });
    expect(JSON.stringify(dashboard)).not.toContain("oc_admin");
  });

  it("未知 target 或非法 generation 在网络调用前拒绝", async () => {
    const request = workerFetch();
    const control = await createControlPlane(config, mockCredentials(), request);

    await expect(control.conversation("unknown", 0)).rejects.toMatchObject({
      status: 404,
      code: "TARGET_NOT_FOUND",
    });
    await expect(control.conversation(TARGET_ID, -1)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("worker 畸形响应 fail closed，不显示未经校验的会话数据", async () => {
    const request = workerFetch(async (input) => {
      if (String(input).endsWith("/healthz")) return jsonResponse({ ok: true, queueDepth: 1 });
      return jsonResponse({ exists: true, todos: [] });
    });
    const control = await createControlPlane(config, mockCredentials(), request);

    await expect(control.dashboard()).rejects.toMatchObject({
      status: 502,
      code: "WORKER_INVALID_RESPONSE",
    });
  });

  it("保留既有会话投影中可选 lastActivityAt 的缺失语义", async () => {
    const request = workerFetch(async () => jsonResponse({
      exists: true,
      todos: [],
      usage: {
        runs: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    }));
    const control = await createControlPlane(config, mockCredentials(), request);

    const snapshot = await control.conversation(TARGET_ID, 0);

    expect(snapshot.session).toMatchObject({ exists: true, todos: [], usage: { runs: 0 } });
    expect(snapshot.session).not.toHaveProperty("lastActivityAt");
  });

  it("非法 worker origin 与重复 target 在装载期拒绝", async () => {
    await expect(createControlPlane({ ...config, workerBaseUrl: "https://worker.example" }, mockCredentials()))
      .rejects.toThrow("workerBaseUrl");
    await expect(createControlPlane({ ...config, targets: [...config.targets, config.targets[0]! ] }, mockCredentials()))
      .rejects.toThrow("target id");
  });

  it("拒绝超出管理投影上限的 worker 会话数据", async () => {
    const tooManyTodos = Array.from({ length: 129 }, () => ({ content: "待办", status: "pending" }));
    const tooLongTodo = [{ content: "x".repeat(4_097), status: "pending" }];
    const oversizedPayload = Array.from(
      { length: 128 },
      (_, index) => ({ content: String(index) + "-" + "x".repeat(2_048), status: "pending" }),
    );
    for (const todos of [tooManyTodos, tooLongTodo, oversizedPayload]) {
      const request = workerFetch(async () => jsonResponse({
        exists: true,
        todos,
        usage: {
          runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        },
      }));
      const control = await createControlPlane(config, mockCredentials(), request);

      await expect(control.conversation(TARGET_ID, 0)).rejects.toMatchObject({
        status: 502,
        code: "WORKER_INVALID_RESPONSE",
      });
    }
  });
});
