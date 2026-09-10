import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { BillingService } from "dsh-lark-billing";
import type { Scope } from "dsh-lark-contracts";

interface ModelRoute {
  provider: string;
  model: string;
}

type ScopeResolver = (sessionId: string) => Scope | undefined;
const DISPOSE_SETTLEMENT_TIMEOUT_MS = 5_000;

/**
 * 把原生 DSH Web Agent 接入统一账本。session/event 是提交后通知，因此结算串行排队，
 * 下一次 pre-step 会先等待并传播上一笔结算错误，避免继续产生未入账调用。
 */
export function installWebBilling(
  ctx: Context,
  billing: BillingService,
  scopeForSession: ScopeResolver,
): () => Promise<void> {
  const routes = new Map<string, ModelRoute>();
  const pending = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();

  /** 恢复会话的构造种子不会重发 session/event，需从持久化折叠结果补回模型路由。 */
  const adoptRoute = (session: Session): ModelRoute | undefined => {
    const sessionId = String(session.id);
    const current = routes.get(sessionId);
    if (current) return current;
    const restored = session.requestContext();
    if (!restored) return undefined;
    const route = { provider: restored.provider, model: restored.model };
    routes.set(sessionId, route);
    return route;
  };

  const enqueue = (sessionId: string, operation: () => Promise<void>): void => {
    const previous = pending.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation);
    pending.set(sessionId, current);
    void current.then(
      () => {
        if (pending.get(sessionId) === current) pending.delete(sessionId);
      },
      (error: unknown) => {
        failures.set(sessionId, error);
        ctx.logger.warn(`lark-run: Web 计费结算失败 session=${sessionId}`);
      },
    );
  };

  const offCreated = ctx.on("session/created", (session) => {
    adoptRoute(session);
  });

  const offSession = ctx.on("session/event", (session, event: SessionEvent) => {
    const sessionId = String(session.id);
    if (event.type === "request/context") {
      routes.set(sessionId, { provider: event.data.provider, model: event.data.model });
      return;
    }
    if (event.type !== "assistant/message" || !event.data.usage) return;
    const scope = scopeForSession(sessionId);
    if (!scope) return;
    const route = routes.get(sessionId) ?? adoptRoute(session);
    if (!route) {
      failures.set(sessionId, new Error("billing: Web usage 缺少 request/context"));
      ctx.logger.warn(`lark-run: Web usage 缺少模型路由 session=${sessionId}`);
      return;
    }
    enqueue(sessionId, async () => {
      await billing.recordUsage({
        scope,
        runId: `web:${sessionId}`,
        turn: event.data.turn,
        step: event.data.step,
        provider: route.provider,
        model: route.model,
        usage: event.data.usage!,
      });
    });
  });

  const offPreStep = ctx.on("agent/pre-step", async (payload, next) => {
    const sessionId = String(payload.agent.id);
    const scope = scopeForSession(sessionId);
    if (!scope) return next();
    await pending.get(sessionId);
    const failure = failures.get(sessionId);
    if (failure) throw failure;
    await billing.assertCanStart(scope);
    return next();
  });

  const offDisposed = ctx.on("session/disposed", (session) => {
    const sessionId = String(session.id);
    routes.delete(sessionId);
    failures.delete(sessionId);
    const settlement = pending.get(sessionId);
    if (settlement) void settlement.then(
      () => pending.delete(sessionId),
      () => pending.delete(sessionId),
    );
  });

  return async () => {
    offDisposed();
    offPreStep();
    offSession();
    offCreated();
    const settlements = [...pending.values()];
    if (settlements.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(settlements),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, DISPOSE_SETTLEMENT_TIMEOUT_MS); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    routes.clear();
    failures.clear();
    pending.clear();
  };
}
