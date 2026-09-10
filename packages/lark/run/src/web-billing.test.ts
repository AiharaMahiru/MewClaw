import { describe, expect, it, vi } from "vitest";

import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { BillingService } from "dsh-lark-billing";
import { parseScope } from "dsh-lark-contracts";

import { installWebBilling } from "./web-billing.js";

const parsed = parseScope({
  tenantId: "tenant",
  botId: "bot",
  deploymentId: "deployment",
  userId: "user-web",
  conversationId: "session-web",
});
const scope = parsed.ok ? parsed.value : (() => { throw new Error("unreachable"); })();

function fixture(resolveScope = vi.fn((id: string) => id === "session-web" ? scope : undefined)) {
  type Listener = (...args: unknown[]) => unknown;
  const listeners = new Map<string, Listener[]>();
  const ctx = {
    logger: { warn: vi.fn() },
    on: vi.fn((name: string, listener: Listener) => {
      const bucket = listeners.get(name) ?? [];
      bucket.push(listener);
      listeners.set(name, bucket);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener));
    }),
  };
  const billing = {
    assertCanStart: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => ({})),
  } as unknown as BillingService;
  const dispose = installWebBilling(ctx as never, billing, resolveScope);
  const emit = async (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) await listener(...args);
  };
  return { billing, ctx, dispose, emit, resolveScope };
}

const session = Session.create(SessionId("session-web"));
const agent = { id: "session-web" };

function restoredSession(provider = "openai", model = "gpt-5.6-luna") {
  return Session.create(SessionId("session-web"), [{
    type: "request/context",
    seq: SessionSeq(0),
    time: 1,
    data: { provider, model },
  }]);
}

describe("Web billing bridge", () => {
  it("按 request/context 路由结算 usage，并在下一步前等待入账和检查额度", async () => {
    const env = fixture();
    let release!: () => void;
    vi.mocked(env.billing.recordUsage).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({} as never);
    }));
    await env.emit("session/event", session, { type: "request/context", data: { provider: "openai", model: "gpt-5.6-luna" } });
    await env.emit("session/event", session, { type: "assistant/message", data: {
      turn: 0, step: 0, usage: { inputTokens: 120, outputTokens: 30 }, message: { content: [] },
    } });
    const next = vi.fn(async () => ({ kind: "enter", messages: [] }));
    const preStep = env.emit("agent/pre-step", { agent }, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    release();
    await preStep;
    expect(env.billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      scope, runId: "web:session-web", turn: 0, step: 0,
      provider: "openai", model: "gpt-5.6-luna",
      usage: { inputTokens: 120, outputTokens: 30 },
    }));
    expect(env.billing.assertCanStart).toHaveBeenCalledWith(scope);
    expect(next).toHaveBeenCalledOnce();
    await env.dispose();
  });

  it("未绑定 Web Scope 与飞书独占运行均不结算", async () => {
    const env = fixture(vi.fn(() => undefined));
    await env.emit("session/event", session, { type: "request/context", data: { provider: "openai", model: "gpt-5.6-luna" } });
    await env.emit("session/event", session, { type: "assistant/message", data: {
      turn: 1, step: 2, usage: { inputTokens: 1, outputTokens: 1 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(env.billing.recordUsage).not.toHaveBeenCalled();
    expect(env.billing.assertCanStart).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    await env.dispose();
  });

  it("结算失败会阻断后续模型步骤且不会调用 next", async () => {
    const env = fixture();
    vi.mocked(env.billing.recordUsage).mockRejectedValueOnce(new Error("ledger unavailable"));
    await env.emit("session/event", session, { type: "request/context", data: { provider: "openai", model: "gpt-5.6-luna" } });
    await env.emit("session/event", session, { type: "assistant/message", data: {
      turn: 0, step: 0, usage: { inputTokens: 1, outputTokens: 1 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await expect(env.emit("agent/pre-step", { agent }, next)).rejects.toThrow("ledger unavailable");
    expect(next).not.toHaveBeenCalled();
    expect(env.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Web 计费结算失败"));
    await env.dispose();
  });

  it("额度耗尽会在模型调用前阻断 Web 步骤", async () => {
    const env = fixture();
    vi.mocked(env.billing.assertCanStart).mockRejectedValueOnce(new Error("quota exhausted"));
    const next = vi.fn(async () => undefined);
    await expect(env.emit("agent/pre-step", { agent }, next)).rejects.toThrow("quota exhausted");
    expect(next).not.toHaveBeenCalled();
    expect(env.billing.recordUsage).not.toHaveBeenCalled();
    await env.dispose();
  });

  it("usage 缺少模型路由时 fail loud", async () => {
    const env = fixture();
    await env.emit("session/event", session, { type: "assistant/message", data: {
      turn: 0, step: 0, usage: { inputTokens: 1, outputTokens: 1 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await expect(env.emit("agent/pre-step", { agent }, next)).rejects.toThrow("缺少 request/context");
    expect(env.billing.recordUsage).not.toHaveBeenCalled();
    await env.dispose();
  });

  it("Worker 重启恢复旧会话时从持久化 request context 重建路由", async () => {
    const env = fixture();
    const restored = restoredSession();
    await env.emit("session/created", restored);
    await env.emit("session/event", restored, { type: "assistant/message", data: {
      turn: 3, step: 1, usage: { inputTokens: 9, outputTokens: 4 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(env.billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-5.6-luna", turn: 3, step: 1,
    }));
    expect(env.ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("缺少模型路由"));
    expect(next).toHaveBeenCalledOnce();
    await env.dispose();
  });

  it("漏接 session/created 时在首笔 usage 到达后惰性恢复路由", async () => {
    const env = fixture();
    const restored = restoredSession("openai", "gpt-5.6-sol");
    await env.emit("session/event", restored, { type: "assistant/message", data: {
      turn: 7, step: 2, usage: { inputTokens: 11, outputTokens: 5 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(env.billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-5.6-sol", turn: 7, step: 2,
    }));
    expect(next).toHaveBeenCalledOnce();
    await env.dispose();
  });

  it("恢复后收到新的 request/context 时使用新模型路由", async () => {
    const env = fixture();
    const restored = restoredSession("openai", "gpt-5.6-luna");
    await env.emit("session/created", restored);
    await env.emit("session/event", restored, { type: "request/context", data: {
      provider: "openai", model: "gpt-5.6-terra",
    } });
    await env.emit("session/event", restored, { type: "assistant/message", data: {
      turn: 8, step: 1, usage: { inputTokens: 13, outputTokens: 6 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(env.billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-5.6-terra", turn: 8, step: 1,
    }));
    await env.dispose();
  });

  it("惰性恢复结果会缓存且不会为每笔 usage 重扫历史", async () => {
    const env = fixture();
    const restored = restoredSession();
    const requestContext = vi.spyOn(restored, "requestContext");
    for (const step of [1, 2]) {
      await env.emit("session/event", restored, { type: "assistant/message", data: {
        turn: 9, step, usage: { inputTokens: step, outputTokens: step }, message: { content: [] },
      } });
    }
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(requestContext).toHaveBeenCalledOnce();
    expect(env.billing.recordUsage).toHaveBeenCalledTimes(2);
    await env.dispose();
  });

  it("会话释放后同 ID 恢复不会沿用旧路由", async () => {
    const env = fixture();
    const previous = restoredSession("openai", "gpt-5.6-luna");
    await env.emit("session/created", previous);
    await env.emit("session/disposed", previous);
    const resumed = restoredSession("openai", "gpt-5.6-sol");
    await env.emit("session/created", resumed);
    await env.emit("session/event", resumed, { type: "assistant/message", data: {
      turn: 10, step: 1, usage: { inputTokens: 7, outputTokens: 3 }, message: { content: [] },
    } });
    const next = vi.fn(async () => undefined);
    await env.emit("agent/pre-step", { agent }, next);
    expect(env.billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-5.6-sol", turn: 10, step: 1,
    }));
    await env.dispose();
  });
});
