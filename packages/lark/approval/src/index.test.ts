/**
 * dsh-lark-approval 插件测试（SPEC lark-approval.md §8）：
 * mock ctx/userQuestions/agent，覆盖 ask 全链路（出卡事件、答案送达、
 * TTL 过期、signal 中止、幂等重复答案）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AskUserQuestionRequest, UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import { makeBotId, makeConversationId, makeDeploymentId, makeInteractionId, makeTenantId, makeUserId, type InteractionId, type Scope } from "dsh-lark-contracts";

import { apply } from "./index.js";

// 旧宿主适配夹具沿用当前服务的问答契约。
type UserQuestionProvider = Pick<UserQuestionService, "ask">;

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

function makeCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  let provider: UserQuestionProvider | undefined;
  const appended: Array<{ type: string; data: unknown }> = [];
  const ctx = {
    userQuestions: {
      registerProvider: vi.fn((p: UserQuestionProvider) => {
        provider = p;
        return () => {
          provider = undefined;
        };
      }),
    },
    // 会话 → Scope 索引（lark-run 宿主级提供；测试按 agent.id 命中）。
    larkScopeIndex: {
      get: (sessionId: string) => (sessionId === "session-1" ? scope : undefined),
    },
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    }),
    effect: vi.fn((register: () => () => void) => register()),
    logger: { warn: vi.fn() },
  };
  return {
    ctx,
    listeners,
    getProvider: () => provider!,
    emit: (event: string, payload: unknown) => {
      // 方差吸收：存入的插件 handler 参数是 never（异构回调列表的存底形态）。
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload as never);
    },
    makeAgent: () => ({
      id: "session-1",
      session: {
        append: vi.fn((type: string, data: unknown) => {
          appended.push({ type, data });
        }),
      },
    }),
    appended,
  };
}

const config = { ttlMs: 60_000, maxOptions: 4, maxPendingPerScope: 5 };

let env: ReturnType<typeof makeCtx>;

/** 从落盘的 requested 事件提取交互 ID（品牌化恢复）。 */
function interactionIdAt(index: number): InteractionId {
  const data = env.appended[index]!.data as { interactionId: string };
  return makeInteractionId(data.interactionId);
}

beforeEach(() => {
  vi.useRealTimers();
  env = makeCtx();
  apply(env.ctx as never, config);
});

afterEach(() => {
  vi.useRealTimers();
});

function askRequest(questions: AskUserQuestionRequest["questions"], signal?: AbortSignal): AskUserQuestionRequest {
  return {
    questions,
    agent: env.makeAgent() as never,
    ...(signal ? { signal } : {}),
  };
}

describe("ask 答案交付", () => {
  it("发出 approval/requested 事件并等待答案（答案送达后返回）", async () => {
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([
      { id: "q1", question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] },
    ]));
    // 等待事件写出（微任务）。
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    expect(env.appended[0]).toMatchObject({
      type: "lark/approval/requested",
      data: { kind: "questionnaire", question: { id: "q1", options: ["继续", "停止"] } },
    });
    // 答案送达（网关 → 控制端点 → 进程内事件）。
    const interactionId = interactionIdAt(0);
    env.emit("lark/interaction/resolved", {
      scope,
      interactionId,
      answer: { selected: ["继续"] },
    });
    await expect(asking).resolves.toEqual({ answers: [{ id: "q1", selected: ["继续"] }] });
    expect(env.appended[1]).toMatchObject({ type: "lark/approval/resolved", data: { outcome: "answered" } });
  });

  it("多问题顺序等待（逐个出卡、逐个解答）", async () => {
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([
      { id: "q1", question: "一", options: [{ label: "a" }] },
      { id: "q2", question: "二", options: [{ label: "b" }] },
    ]));
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    const first = interactionIdAt(0);
    env.emit("lark/interaction/resolved", { scope, interactionId: first, answer: { selected: ["a"] } });
    await vi.waitFor(() => expect(env.appended).toHaveLength(3));
    const second = interactionIdAt(2);
    env.emit("lark/interaction/resolved", { scope, interactionId: second, answer: { selected: ["b"], custom: "补充" } });
    await expect(asking).resolves.toEqual({
      answers: [{ id: "q1", selected: ["a"] }, { id: "q2", selected: ["b"], custom: "补充" }],
    });
  });
});

describe("ask 幂等", () => {
  it("重复答案幂等：第二次送达不重复解答", async () => {
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([{ id: "q1", question: "继续？", options: [{ label: "是" }] }]));
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    const interactionId = interactionIdAt(0);
    env.emit("lark/interaction/resolved", { scope, interactionId, answer: { selected: ["是"] } });
    env.emit("lark/interaction/resolved", { scope, interactionId, answer: { selected: ["否"] } });
    await expect(asking).resolves.toEqual({ answers: [{ id: "q1", selected: ["是"] }] });
    // resolved 事件只写一次。
    expect(env.appended.filter((item) => item.type === "lark/approval/resolved")).toHaveLength(1);
  });
});

describe("ask 生命周期", () => {
  it("TTL 到期：reject（EXPIRED）+ resolved(expired) 事件", async () => {
    vi.useFakeTimers();
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([{ id: "q1", question: "继续？", options: [] }]));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(61_000);
    await expect(asking).rejects.toMatchObject({ code: "EXPIRED" });
    expect(env.appended.at(-1)).toMatchObject({ type: "lark/approval/resolved", data: { outcome: "expired" } });
  });

  it("signal 中止：reject（ABORTED）+ resolved(aborted)", async () => {
    const abort = new AbortController();
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([{ id: "q1", question: "继续？", options: [] }], abort.signal));
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    abort.abort();
    await expect(asking).rejects.toMatchObject({ code: "ABORTED" });
    expect(env.appended.at(-1)).toMatchObject({ type: "lark/approval/resolved", data: { outcome: "aborted" } });
  });
});

describe("ask 请求校验", () => {
  it("缺少 Scope（索引未命中）：NO_SCOPE 拒绝", async () => {
    const provider = env.getProvider();
    const agent = env.makeAgent();
    (agent as { id: string }).id = "session-unknown";
    await expect(provider.ask({ questions: [{ id: "q1", question: "x" }], agent: agent as never }))
      .rejects.toMatchObject({ code: "NO_SCOPE" });
  });

  it("选项截断到 maxOptions", async () => {
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([
      { id: "q1", question: "选一个", options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }] },
    ]));
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    const data = env.appended[0]!.data as { question: { options: string[] } };
    expect(data.question.options).toEqual(["1", "2", "3", "4"]);
    // 让测试干净结束：送达答案。
    const interactionId = interactionIdAt(0);
    env.emit("lark/interaction/resolved", { scope, interactionId, answer: { selected: ["1"] } });
    await asking;
  });
});

describe("ask Scope 授权", () => {
  it("拒绝其他用户解答待办", async () => {
    const provider = env.getProvider();
    const asking = provider.ask(askRequest([{ id: "q1", question: "继续？", options: [{ label: "是" }] }]));
    await vi.waitFor(() => expect(env.appended).toHaveLength(1));
    const interactionId = interactionIdAt(0);
    const otherScope = { ...scope, userId: makeUserId("ou_other") };

    env.emit("lark/interaction/resolved", {
      scope: otherScope,
      interactionId,
      answer: { selected: ["否"] },
    });
    await Promise.resolve();
    expect(env.appended.filter((item) => item.type === "lark/approval/resolved")).toHaveLength(0);

    env.emit("lark/interaction/resolved", {
      scope,
      interactionId,
      answer: { selected: ["是"] },
    });
    await expect(asking).resolves.toEqual({ answers: [{ id: "q1", selected: ["是"] }] });
  });
});

describe("配置边界", () => {
  it("非法数值在注册 Provider 前 fail loud", () => {
    const invalid = makeCtx();

    expect(() => apply(invalid.ctx as never, { ...config, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(invalid.ctx.userQuestions.registerProvider).not.toHaveBeenCalled();
  });
});
