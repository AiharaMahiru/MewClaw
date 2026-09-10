/**
 * executeRun 测试（SPEC lark-run.md §8）：mock agents/sessionPersistence，
 * 覆盖 create/resume 判定、事件流、空回复、超时与用户取消。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@deepseek-ai/dsh-session";
import { makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";
import type { BillingService } from "dsh-lark-billing";

import { applyPresetSkillPolicy, executeRun, type RunExecutionOptions } from "./executor.js";
import { sessionIdForScope } from "./session-overview.js";

const scope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!scope.ok) throw new Error("unreachable");
// 函数声明会被提升，闭包内不做收窄——先取出值再供闭包使用。
const scopeValue = scope.value;
type RunInputOptions = Omit<RunExecutionOptions, "sessionId" | "applyPreset">;

/** 构建假 agent：记录调用并允许测试注入事件与结局。 */
function makeAgent(events: Array<{ type: string; data: unknown }> = []) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const agent = {
    session: { append: vi.fn(), events },
    ctx: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const list = listeners.get(event) || [];
        list.push(listener);
        listeners.set(event, list);
        return () => undefined;
      }),
    },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {
      for (const listener of listeners.get("session/event") ?? []) {
        if (events.length > 0) {
          for (const event of events) listener(agent.session, { ...event, seq: 1, time: Date.now() } as never);
        } else {
          // 模拟回合内事件：先发可见文本事件，再 idle。
          listener(agent.session, { type: "assistant/message", seq: 1, time: Date.now(), data: { message: { content: [{ type: "text", text: "回答内容" }] } } });
        }
      }
    }),
  };
  const handle = { agent, dispose: vi.fn(async () => undefined) };
  return { agent, handle, listeners };
}

function makeOptions(overrides: Partial<RunInputOptions> & { events?: Array<{ type: string; data: unknown }> }): {
  options: RunInputOptions;
  create: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  listSnapshots: ReturnType<typeof vi.fn>;
  readRaw: ReturnType<typeof vi.fn>;
  agent: ReturnType<typeof makeAgent>;
} {
  const mock = makeAgent(overrides.events);
  const create = vi.fn(async () => mock.handle);
  const resume = vi.fn(async () => mock.handle);
  const listSnapshots = vi.fn(async () => []);
  const readRaw = vi.fn(async () => undefined);
  const streamed: unknown[] = [];
  const options: RunInputOptions = {
    agents: { get: vi.fn(), create, resume } as never,
    agentPresets: { mount: vi.fn() } as never,
    sessionPersistence: { listSnapshots, readRaw } as never,
    sessionDirectory: { resolve: vi.fn(async () => ({ mode: "deterministic" })) } as never,
    selection: { provider: "deepseek-official", model: "deepseek-chat" } as never,
    agentPresetId: "standard",
    workspaceRoot: ".workspaces-test",
    request: {
      runId: makeRunId("run-1"),
      scope: scopeValue,
      messageId: makeMessageId("om_1"),
      prompt: "你好",
    },
    stream: (item) => streamed.push(item),
    runTimeoutMs: 60_000,
    runHardTimeoutMs: 0,
  };
  return { options: { ...options, ...overrides }, create, resume, listSnapshots, readRaw, agent: mock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function registerSkillPolicyTest(): void {
  it("preset 未声明的受审 Skill 在 agent scope 注册为不可调用 shadow", () => {
    const register = vi.fn();
    applyPresetSkillPolicy({ skills: { register } } as never, {
      name: "knowledge-assistant",
      version: "1.0.0",
      revision: "a".repeat(64),
      skills: ["lark-rag"],
      trustedSkills: ["lark-cron", "lark-rag", "lark-web"],
      denyTools: [],
      autoRetrieve: true,
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: "lark-cron",
      invocation: { modelInvocable: false, userInvocable: false },
    }));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: "lark-web" }));
    expect(register).not.toHaveBeenCalledWith(expect.objectContaining({ name: "lark-rag" }));
  });
}

function registerSessionLifecycleTests(): void {
  it("无持久化产物 → create；记录 lark/message/in 后 followup", async () => {
    const { options, create, resume, agent } = makeOptions({});
    const result = await executeRun(options);
    expect(result.kind).toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    // 模型可见 ⟺ 落盘：append 先于 followup。
    expect(agent.agent.session.append).toHaveBeenCalledWith("lark/message/in", expect.objectContaining({ text: "你好" }));
    expect(agent.agent.session.append.mock.invocationCallOrder[0]!).toBeLessThan(agent.agent.followup.mock.invocationCallOrder[0]!);
    // 会话 id = session-<scopeKey>；元数据带 cwd 与 agentPreset。
    const call = create.mock.calls[0]![0] as { sessionId: ReturnType<typeof SessionId>; meta: { cwd: string; agentPreset: string } };
    expect(String(call.sessionId)).toMatch(/^session-[0-9a-f]{64}$/);
    expect(call.meta.agentPreset).toBe("standard");
    expect(call.meta.cwd).toContain(".workspaces-test");
  });

  it("存在持久化产物 → resume（重启恢复语义）", async () => {
    const { options, create, resume, listSnapshots } = makeOptions({});
    listSnapshots.mockResolvedValue([{ header: { id: sessionIdForScope(scopeValue, 0) } }]);
    await executeRun(options);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("确定性 Feishu run 通过官方 workspace registry attach，保留隔离 cwd", async () => {
    const { options, create } = makeOptions({});
    const attachSession = vi.fn(async () => undefined);
    const setTitle = vi.fn(async () => undefined);
    const workspaceCreate = vi.fn(async () => ({ title: "飞书 · 你好", setTitle, attachSession }));

    await executeRun({ ...options, workspaceRegistry: { create: workspaceCreate } });

    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.stringContaining(".workspaces-test"),
      "飞书 · 你好",
    );
    expect(attachSession).toHaveBeenCalledWith(sessionIdForScope(scopeValue, 0));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ cwd: expect.stringContaining(".workspaces-test") }),
    }));
  });

  it("官方 session/title 到达时同步临时 workspace 标题", async () => {
    const { options, agent } = makeOptions({});
    const setTitle = vi.fn(async () => undefined);
    const workspaceCreate = vi.fn(async () => ({ title: "飞书 · 你好", setTitle, attachSession: vi.fn(async () => undefined) }));
    agent.agent.whenIdle = vi.fn(async () => {
      for (const listener of agent.listeners.get("session/event") ?? []) {
        listener(agent.agent.session, {
          type: "session/title",
          seq: 2,
          time: Date.now(),
          data: { title: "CSV 报表分析", messageSeqs: [1], source: { kind: "provider", provider: "test" } },
        });
      }
    });

    await executeRun({ ...options, workspaceRegistry: { create: workspaceCreate } });
    await vi.waitFor(() => expect(setTitle).toHaveBeenCalledWith("飞书 · CSV 报表分析"));
  });

  it("deterministic Feishu run 在 agent idle 后刷新官方投影缓存", async () => {
    const { options, agent } = makeOptions({});
    const write = vi.fn(async () => undefined);

    await executeRun({
      ...options,
      sessionProjectionCache: { coldSnapshot: vi.fn(), write },
    });

    expect(write).toHaveBeenCalledWith(agent.agent.session);
    expect(agent.agent.whenIdle.mock.invocationCallOrder[0]!).toBeLessThan(write.mock.invocationCallOrder[0]!);
    expect(write.mock.invocationCallOrder[0]!).toBeLessThan(agent.handle.dispose.mock.invocationCallOrder[0]!);
  });

  it("shared Web run 不触发 deterministic 投影缓存 checkpoint", async () => {
    const { options } = makeOptions({});
    options.sessionDirectory.resolve = vi.fn(async () => ({
      mode: "shared",
      sessionId: sessionIdForScope(scopeValue, 0),
    })) as never;
    const write = vi.fn(async () => undefined);

    await executeRun({
      ...options,
      sessionProjectionCache: { coldSnapshot: vi.fn(), write },
    });

    expect(write).not.toHaveBeenCalled();
  });

  it("投影缓存 checkpoint 失败不改变主运行结局", async () => {
    const { options } = makeOptions({});
    const write = vi.fn(async () => { throw new Error("cache unavailable"); });

    const result = await executeRun({
      ...options,
      sessionProjectionCache: { coldSnapshot: vi.fn(), write },
    });

    expect(result.kind).toBe("ok");
  });

  it("持久化列表异常不得静默降级为新会话", async () => {
    const { options, create, resume, listSnapshots } = makeOptions({});
    const error = new Error("session format unsupported");
    listSnapshots.mockRejectedValue(error);

    await expect(executeRun(options)).rejects.toMatchObject({ stage: "agent-list-snapshots", original: error });
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("首个 session 输入事件失败时保留阶段诊断", async () => {
    const { options, agent } = makeOptions({});
    const error = new Error("unknown session event type");
    agent.agent.session.append.mockImplementationOnce(() => { throw error; });

    await expect(executeRun(options)).rejects.toMatchObject({ stage: "session-input", original: error });
  });

  it("存在性探测不读取 raw artifact", async () => {
    const { options, create, readRaw } = makeOptions({});

    await executeRun(options);
    expect(readRaw).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("可见文本 → OK 终止行；无可见输出 → EMPTY_RESPONSE", async () => {
    const withText = makeOptions({});
    const items = (withText.options.stream as unknown as { mock: never }) as never;
    void items;
    const first = await executeRun(withText.options);
    expect(first.kind).toBe("ok");

    // 无可见文本：whenIdle 不发事件。
    const silent = makeAgent();
    silent.agent.whenIdle = vi.fn(async () => undefined);
    const createSilent = vi.fn(async () => silent.handle);
    const empty = await executeRun({
      ...withText.options,
      agents: { get: vi.fn(), create: createSilent, resume: vi.fn() } as never,
    });
    expect(empty.kind).toBe("empty");
  });

  it("request/context + assistant/message usage → 结算到 billing 且额度预检先于 agent", async () => {
    const { options, create } = makeOptions({ events: [
      { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
      {
        type: "assistant/message",
        data: {
          turn: 0,
          step: 0,
          usage: { inputTokens: 12, outputTokens: 4 },
          message: { content: [{ type: "text", text: "已计费" }] },
        },
      },
    ] });
    const assertCanStart = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async () => undefined);
    const billing = { assertCanStart, recordUsage } as unknown as BillingService;
    await executeRun({ ...options, billing });
    expect(assertCanStart).toHaveBeenCalledWith(scopeValue);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { inputTokens: 12, outputTokens: 4 },
    }));
    expect(assertCanStart.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });

  it("额度预检失败时不创建 agent", async () => {
    const { options, create } = makeOptions({});
    const assertCanStart = vi.fn(async () => { throw new Error("quota exhausted"); });
    const billing = { assertCanStart, recordUsage: vi.fn() } as unknown as BillingService;
    await expect(executeRun({ ...options, billing })).rejects.toMatchObject({ stage: "billing-quota" });
    expect(create).not.toHaveBeenCalled();
  });
}

function registerCancellationTests(): void {
  it("用户取消 → cancel + CANCELLED 结局", async () => {
    const { options, agent } = makeOptions({});
    const abort = new AbortController();
    // whenIdle 挂起直到 cancel 触发（模拟 agent 被取消后回到 quiescence）。
    let resolveIdle: (() => void) | undefined;
    agent.agent.whenIdle = vi.fn(() => new Promise<void>((resolve) => {
      resolveIdle = resolve;
    }));
    agent.agent.cancel.mockImplementation(() => resolveIdle?.());
    const run = executeRun({ ...options, signal: abort.signal });
    // 等执行器进入 whenIdle（取消发生在运行中的现实路径）。
    await vi.waitFor(() => expect(agent.agent.whenIdle).toHaveBeenCalled());
    abort.abort();
    const result = await run;
    expect(agent.agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    expect(result.kind).toBe("cancelled");
  });

  it("无进展窗口到期 → cancel(hook) + timed-out", async () => {
    vi.useFakeTimers();
    try {
      const { options, agent } = makeOptions({});
      let resolveIdle: (() => void) | undefined;
      agent.agent.whenIdle = vi.fn(() => new Promise<void>((resolve) => {
        resolveIdle = resolve;
      }));
      agent.agent.cancel.mockImplementation(() => resolveIdle?.());
      const run = executeRun({ ...options, runTimeoutMs: 1000, runHardTimeoutMs: 0 });
      // 等待异步 create/followup 链完成，再推进无进展窗口。
      await vi.waitFor(() => expect(agent.agent.whenIdle).toHaveBeenCalled(), { timeout: 1000, interval: 10 });
      await vi.advanceTimersByTimeAsync(1100);
      const result = await run;
      expect(agent.agent.cancel).toHaveBeenCalledWith({ kind: "hook", reason: "lark/run-no-progress" });
      expect(result.kind).toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });
}

function registerEnvelopeTest(): void {
  it("事件流携带信封（runId + 完整 scope）", async () => {
    const { options } = makeOptions({});
    const streamed: Array<{ envelope: unknown; event?: unknown }> = [];
    options.stream = (item) => streamed.push(item as never);
    await executeRun(options);
    const events = streamed.filter((item) => item.event);
    expect(events.length).toBeGreaterThan(0);
    for (const item of events) {
      expect(item.envelope).toEqual({ runId: "run-1", scope: scopeValue });
    }
    const done = streamed.find((item) => !("event" in item)) as { outcome: { code: string } } | undefined;
    expect(done?.outcome.code).toBe("OK");
  });
}

function registerArtifactSnapshotTest(): void {
  it("运行前创建 artifact 基线，并仅用该基线收集本轮交付物", async () => {
    const { options, create } = makeOptions({});
    const baseline = { files: new Map() };
    const snapshot = vi.fn(async () => baseline);
    const collect = vi.fn(async () => undefined);

    await executeRun({ ...options, uploads: { snapshot, collect } as never });

    expect(snapshot).toHaveBeenCalledWith({ workspace: expect.stringContaining(".workspaces-test") });
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ baseline, scope: scopeValue }));
    expect(snapshot.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });
}

describe("executeRun", () => {
  registerSkillPolicyTest();
  registerSessionLifecycleTests();
  registerCancellationTests();
  registerEnvelopeTest();
  registerArtifactSnapshotTest();
});
