import { describe, expect, it, vi } from "vitest";

import { makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";

const mocks = vi.hoisted(() => ({ executeRun: vi.fn() }));

vi.mock("./executor.js", () => ({ executeRun: mocks.executeRun }));

import { RunCoordinator } from "./run-coordinator.js";

const parsedScope = parseScope({
  tenantId: "t",
  botId: "b",
  deploymentId: "d",
  userId: "ou_1",
  conversationId: "oc_1",
});
const scope = parsedScope.ok ? parsedScope.value : (() => { throw new Error("unreachable"); })();

function makeCoordinator() {
  const ctx = {
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: "p", model: "m" })) },
    agents: {},
    agentPresets: {},
    sessionPersistence: {},
    skillTrust: {},
    larkUploads: {},
    memory: {},
    emit: vi.fn(),
    logger: { warn: vi.fn() },
  };
  const coordinator = new RunCoordinator({
    ctx: ctx as never,
    config: {
      host: "127.0.0.1",
      port: 8788,
      runHardTimeoutMs: 0,
      profileTimeouts: { quick: 1, standard: 1, long: 1 },
      concurrency: { maxRuns: 1, maxRunsPerUser: 1, maxQueuedPerScope: 1 },
      heartbeatIntervalMs: 1,
      presetId: "lark-standard",
      agentPresetId: "standard",
      workspaceRoot: ".workspaces",
    },
    preset: { name: "p", version: "1", revision: "r", skills: [], trustedSkills: [], denyTools: [], autoRetrieve: false },
  });
  return { coordinator, ctx };
}

describe("RunCoordinator", () => {
  it("严格绑定 Auth Edge Web Scope，飞书运行 Scope 仍具有更高优先级", () => {
    const { coordinator } = makeCoordinator();
    const sessionId = "session-web";
    coordinator.bindWebScope({ sessionId, scope });
    expect(coordinator.scopeForSession(sessionId)).toStrictEqual(scope);
    expect(coordinator.webBillingScopeForSession(sessionId)).toStrictEqual(scope);
    expect(() => coordinator.bindWebScope({ sessionId, scope, extra: true })).toThrow("未知字段");
    expect(() => coordinator.bindWebScope({ sessionId: "", scope })).toThrow("校验失败");
  });

  it("按 session + rpcId 保存无密钥私有路由，并为 Adapter 暴露当前 prompt 引用", () => {
    const { coordinator } = makeCoordinator();
    const modelRoute = {
      mode: "private",
      profileId: "11111111-1111-4111-8111-111111111111",
      revision: 2,
      model: "user-model",
      capability: "A".repeat(43),
    };
    coordinator.bindWebScope({ sessionId: "session-private", rpcId: "rpc-private", scope, modelRoute });
    expect(coordinator.webModelRouteFor("session-private", "rpc-private")).toEqual({
      profileId: modelRoute.profileId,
      revision: 2,
      model: "user-model",
      capability: modelRoute.capability,
    });
    expect(coordinator.webModelRouteForCurrentSelection("session-private")).toEqual({
      profileId: modelRoute.profileId,
      revision: 2,
      model: "user-model",
      capability: modelRoute.capability,
      rpcId: "rpc-private",
    });
    expect(coordinator.webModelSelectionFor("session-private")).toEqual({ provider: "web-private", model: "user-model" });
    expect(() => coordinator.bindWebScope({ sessionId: "session-private", rpcId: "rpc-private", scope, modelRoute: { ...modelRoute, capability: "short" } })).toThrow("私有模型引用");
  });

  it("注册 Scope 后按 agent session id 可被 Worker Consumer 命中，并在释放后消失", async () => {
    mocks.executeRun.mockReset();
    const { coordinator } = makeCoordinator();
    const writer = { write: vi.fn(), end: vi.fn(), get closed() { return false; } };
    const request = {
      runId: makeRunId("run-scope"),
      scope,
      messageId: makeMessageId("om-scope"),
      prompt: "x",
    };
    const sessionId = "session-scope";
    mocks.executeRun.mockImplementationOnce(async (options: { registerScope: (id: string, larkScope: typeof scope) => () => void }) => {
      const unregister = options.registerScope(sessionId, request.scope);
      expect(coordinator.scopeForSession(sessionId)).toBe(request.scope);
      expect(coordinator.webBillingScopeForSession(sessionId)).toBeUndefined();
      unregister();
      expect(coordinator.scopeForSession(sessionId)).toBeUndefined();
      return { kind: "ok", durationMs: 1 };
    });

    await coordinator.run(request, new AbortController().signal, writer);
  });

  it("执行异常仍发布 failed 终态，避免 cron 等待表悬挂", async () => {
    mocks.executeRun.mockRejectedValueOnce(new Error("bootstrap failed"));
    const { coordinator, ctx } = makeCoordinator();
    const writer = { write: vi.fn(), end: vi.fn(), get closed() { return false; } };
    const request = {
      runId: makeRunId("run-1"),
      scope,
      messageId: makeMessageId("om_1"),
      prompt: "x",
    };

    await expect(coordinator.run(request, new AbortController().signal, writer)).rejects.toThrow("bootstrap failed");
    expect(mocks.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      agentPresets: ctx.agentPresets,
      agentPresetId: "standard",
    }));
    expect(ctx.emit).toHaveBeenLastCalledWith("lark/run/lifecycle", expect.objectContaining({
      runId: request.runId,
      phase: "ended",
      outcome: "failed",
      code: "RUNTIME_ERROR",
    }));
  });

  it("客户端断开时取消排队任务，不在前序任务结束后创建 agent", async () => {
    mocks.executeRun.mockReset();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mocks.executeRun.mockResolvedValue({ kind: "ok", durationMs: 1 });
    mocks.executeRun.mockImplementationOnce(async () => {
      await firstGate;
      return { kind: "ok", durationMs: 1 };
    });
    const { coordinator, ctx } = makeCoordinator();
    const writer = { write: vi.fn(), end: vi.fn(), get closed() { return false; } };
    const first = coordinator.run({
      runId: makeRunId("run-first"), scope, messageId: makeMessageId("om-first"), prompt: "first",
    }, new AbortController().signal, writer);
    await vi.waitFor(() => expect(mocks.executeRun).toHaveBeenCalledTimes(1));

    const disconnect = new AbortController();
    const queued = coordinator.run({
      runId: makeRunId("run-queued"), scope, messageId: makeMessageId("om-queued"), prompt: "queued",
    }, disconnect.signal, writer);
    disconnect.abort();
    releaseFirst();

    await Promise.all([first, queued]);
    expect(mocks.executeRun).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenLastCalledWith("lark/run/lifecycle", expect.objectContaining({
      runId: makeRunId("run-queued"), phase: "ended", outcome: "cancelled",
    }));
  });

  it("HTTP cancel 取消排队任务，不在前序任务结束后创建 agent", async () => {
    mocks.executeRun.mockReset();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mocks.executeRun.mockResolvedValue({ kind: "ok", durationMs: 1 });
    mocks.executeRun.mockImplementationOnce(async () => {
      await firstGate;
      return { kind: "ok", durationMs: 1 };
    });
    const { coordinator, ctx } = makeCoordinator();
    const writer = { write: vi.fn(), end: vi.fn(), get closed() { return false; } };
    const first = coordinator.run({
      runId: makeRunId("run-http-first"), scope, messageId: makeMessageId("om-http-first"), prompt: "first",
    }, new AbortController().signal, writer);
    await vi.waitFor(() => expect(mocks.executeRun).toHaveBeenCalledTimes(1));

    const queuedRunId = makeRunId("run-http-queued");
    const queued = coordinator.run({
      runId: queuedRunId, scope, messageId: makeMessageId("om-http-queued"), prompt: "queued",
    }, new AbortController().signal, writer);
    expect(coordinator.cancel(queuedRunId)).toBe(true);
    releaseFirst();

    await Promise.all([first, queued]);
    expect(mocks.executeRun).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenLastCalledWith("lark/run/lifecycle", expect.objectContaining({
      runId: queuedRunId, phase: "ended", outcome: "cancelled",
    }));
  });
});
