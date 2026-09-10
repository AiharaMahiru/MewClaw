import type { Context } from "@deepseek-ai/cordis";
import type { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";
import { parseScope, parseSessionId, type RunId, type RunRequest, type RunStreamDone, type RunStreamItem } from "dsh-lark-contracts";
import type { WebModelRouteRef } from "dsh-lark-contracts";
import type {} from "@deepseek-ai/dsh-workspace";

import type { ResolvedRunConfig } from "./config.js";
import { executeRun, type RunPreset } from "./executor.js";
import type { NdjsonWriter } from "./http.js";
import { QueueFullError, RunQueue, type QueueHandle } from "./queue.js";
import { describeRunFailure, type RunStageReporter } from "./run-diagnostics.js";

interface CoordinatorOptions {
  ctx: Context;
  config: ResolvedRunConfig;
  preset: RunPreset;
}

interface ActiveRun {
  controller: AbortController;
  queued?: QueueHandle;
}

/** 结局联合与 lark/run/lifecycle 事件声明保持一致（contracts/context.ts）。 */
type LifecycleOutcome = "ok" | "cancelled" | "timed-out" | "empty" | "failed" | "queued-full";

interface LifecycleInput {
  ctx: Context;
  runId: RunId;
  phase: "started" | "ended";
  outcome?: LifecycleOutcome;
  code?: string;
  durationMs?: number;
}

const DISCARD_WRITER: NdjsonWriter = {
  write: () => undefined,
  end: () => undefined,
  get closed() {
    return true;
  },
};

function emitLifecycle(input: LifecycleInput): void {
  const { ctx, runId, phase, outcome, code, durationMs } = input;
  ctx.logger?.info?.(`lark-run: ${phase} run=${runId}${outcome ? ` outcome=${outcome}` : ""}${code ? ` code=${code}` : ""}${durationMs !== undefined ? ` ${durationMs}ms` : ""}`);
  ctx.emit("lark/run/lifecycle", {
    runId,
    phase,
    ...(outcome ? { outcome } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

export class RunCoordinator {
  readonly #queue: RunQueue;
  readonly #activeCancels = new Map<string, ActiveRun>();
  readonly #scopeEntries = new Map<string, RunRequest["scope"]>();
  readonly #webScopeEntries = new Map<string, RunRequest["scope"]>();
  readonly #webModelRoutes = new Map<string, WebModelRouteRef>();
  readonly #webModelSelections = new Map<string, { rpcId: string; route: WebModelRouteRef }>();

  constructor(private readonly options: CoordinatorOptions) {
    this.#queue = new RunQueue(options.config.concurrency);
  }

  scopeForSession(sessionId: string): RunRequest["scope"] | undefined {
    return this.#scopeEntries.get(sessionId) ?? this.#webScopeEntries.get(sessionId);
  }

  /** 仅返回原生 Web 运行的 Scope；飞书执行期间必须由 executeRun 独占结算。 */
  webBillingScopeForSession(sessionId: string): RunRequest["scope"] | undefined {
    if (this.#scopeEntries.has(sessionId)) return undefined;
    return this.#webScopeEntries.get(sessionId);
  }

  bindWebScope(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("lark-run: Web Scope 绑定格式无效");
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "sessionId" && key !== "scope" && key !== "rpcId" && key !== "modelRoute")) throw new Error("lark-run: Web Scope 绑定包含未知字段");
    const sessionId = parseSessionId(record.sessionId);
    const scope = parseScope(record.scope);
    if (!sessionId.ok || !scope.ok) throw new Error("lark-run: Web Scope 绑定校验失败");
    const route = parseWebModelRoute(record.modelRoute);
    const rpcId = typeof record.rpcId === "string" ? record.rpcId : undefined;
    if ((route !== undefined || record.modelRoute !== undefined) && (!rpcId || rpcId.length > 256)) throw new Error("lark-run: Web 私有模型引用校验失败");
    // 绑定会在每次 Web prompt 前刷新；上限只防止长期进程被废弃会话撑满。
    if (!this.#webScopeEntries.has(sessionId.value) && this.#webScopeEntries.size >= 10_000) {
      const oldest = this.#webScopeEntries.keys().next().value as string | undefined;
      if (oldest) this.#webScopeEntries.delete(oldest);
    }
    this.#webScopeEntries.delete(sessionId.value);
    this.#webScopeEntries.set(sessionId.value, scope.value);
    if (route && rpcId) {
      const key = webModelRouteKey(sessionId.value, rpcId);
      if (!this.#webModelRoutes.has(key) && this.#webModelRoutes.size >= 10_000) {
        const oldest = this.#webModelRoutes.keys().next().value as string | undefined;
        if (oldest) this.#webModelRoutes.delete(oldest);
      }
      this.#webModelRoutes.delete(key);
      this.#webModelRoutes.set(key, route);
      this.#webModelSelections.set(sessionId.value, { rpcId, route });
    } else {
      this.#webModelSelections.delete(sessionId.value);
    }
  }

  webModelRouteFor(sessionId: string, rpcId: string): WebModelRouteRef | undefined {
    const route = this.#webModelRoutes.get(webModelRouteKey(sessionId, rpcId));
    return route ? { ...route } : undefined;
  }

  webModelRouteForCurrentSelection(sessionId: string): (WebModelRouteRef & { rpcId: string }) | undefined {
    const current = this.#webModelSelections.get(sessionId);
    return current ? { ...current.route, rpcId: current.rpcId } : undefined;
  }

  webModelSelectionFor(sessionId: string): { provider: "web-private"; model: string } | undefined {
    const current = this.#webModelSelections.get(sessionId);
    return current ? { provider: "web-private", model: current.route.model } : undefined;
  }

  queueDepth(): number {
    return this.#queue.depth();
  }

  cancel(runId: string): boolean {
    const active = this.#activeCancels.get(runId);
    if (!active) return false;
    active.controller.abort();
    active.queued?.cancel();
    return true;
  }

  submitDetached(request: RunRequest): void {
    void this.run(request, new AbortController().signal, DISCARD_WRITER).catch((error: unknown) => {
      this.options.ctx.logger.warn(`lark-run: cron 运行提交失败（${error instanceof Error ? error.message : "unknown"}）`);
    });
  }

  async run(request: RunRequest, signal: AbortSignal, writer: NdjsonWriter): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const active: ActiveRun = { controller };
    let queued: QueueHandle | undefined;
    let executionStarted = false;
    const onAbort = () => {
      controller.abort();
      queued?.cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#activeCancels.set(request.runId, active);
    emitLifecycle({ ctx: this.options.ctx, runId: request.runId, phase: "started" });
    try {
      queued = this.#queue.enqueue(request.scope, async () => {
        executionStarted = true;
        await this.#execute(request, controller, writer);
      });
      active.queued = queued;
      if (signal.aborted) onAbort();
      if (controller.signal.aborted) queued.cancel();
      await queued.run;
      if (queued.cancelled && !executionStarted) {
        emitLifecycle({
          ctx: this.options.ctx,
          runId: request.runId,
          phase: "ended",
          outcome: "cancelled",
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      if (error instanceof QueueFullError) {
        emitLifecycle({ ctx: this.options.ctx, runId: request.runId, phase: "ended", outcome: "queued-full" });
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#activeCancels.delete(request.runId);
    }
  }

  async #execute(request: RunRequest, controller: AbortController, writer: NdjsonWriter): Promise<void> {
    const startedAt = Date.now();
    let outcome: Awaited<ReturnType<typeof executeRun>>;
    try {
      outcome = await executeRun(this.#executionOptions(request, controller, writer));
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      const diagnostic = describeRunFailure(error);
      this.options.ctx.logger.warn(`lark-run: 会话执行失败（${diagnostic}）`);
      this.options.ctx.logger?.warn?.(`lark-run: failure run=${request.runId} error=${name} ${diagnostic}`);
      emitLifecycle({
        ctx: this.options.ctx,
        runId: request.runId,
        phase: "ended",
        outcome: "failed",
        code: "RUNTIME_ERROR",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
    emitLifecycle({
      ctx: this.options.ctx,
      runId: request.runId,
      phase: "ended",
      outcome: outcome.kind,
      ...(outcome.code ? { code: outcome.code } : {}),
      durationMs: Date.now() - startedAt,
    });
  }

  #executionOptions(request: RunRequest, controller: AbortController, writer: NdjsonWriter) {
    const { ctx, config, preset } = this.options;
    const defaultModel = ctx.agentDefaultModel as AgentDefaultModelConfig;
    const reportStage: RunStageReporter = (stage, durationMs, outcome) => {
      ctx.logger?.info?.(`lark-run: stage run=${request.runId} name=${stage} outcome=${outcome} ${durationMs}ms`);
    };
    return {
      agents: ctx.agents!,
      agentPresets: ctx.agentPresets!,
      sessionPersistence: ctx.sessionPersistence!,
      sessionDirectory: ctx.larkSessionDirectory!,
      workspaceRegistry: ctx.workspaceRegistry,
      sessionProjectionCache: ctx.sessionProjectionCache,
      selection: defaultModel.currentSelection(),
      agentPresetId: config.agentPresetId,
      workspaceRoot: config.workspaceRoot,
      request,
      stream: (item: RunStreamItem | RunStreamDone) => {
        if ("event" in item) ctx.emit("lark/run/stream", { runId: request.runId, event: item.event });
        writer.write(item);
      },
      runTimeoutMs: config.profileTimeouts[request.profile ?? "standard"],
      runHardTimeoutMs: config.runHardTimeoutMs,
      signal: controller.signal,
      reportStage,
      skillTrust: ctx.skillTrust!,
      uploads: ctx.larkUploads!,
      preset,
      memory: ctx.memory!,
      logger: ctx.logger,
      ...(ctx.billing ? { billing: ctx.billing } : {}),
      registerScope: (sessionId: string, scope: RunRequest["scope"]) => {
        this.#scopeEntries.set(sessionId, scope);
        return () => this.#scopeEntries.delete(sessionId);
      },
    };
  }
}

function webModelRouteKey(sessionId: string, rpcId: string): string {
  return sessionId + "\u0000" + rpcId;
}

function parseWebModelRoute(value: unknown): WebModelRouteRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lark-run: Web 私有模型引用格式无效");
  const record = value as Record<string, unknown>;
  const revision = record.revision;
  if (record.mode === "shared" && Object.keys(record).length === 1) return undefined;
  if (record.mode !== "private" || Object.keys(record).some((key) => key !== "mode" && key !== "profileId" && key !== "revision" && key !== "model" && key !== "capability")
    || typeof record.profileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(record.profileId)
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || typeof record.model !== "string" || !record.model || record.model.length > 256
    || typeof record.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.capability)) {
    throw new Error("lark-run: Web 私有模型引用校验失败");
  }
  return { profileId: record.profileId.toLowerCase(), revision, model: record.model, capability: record.capability };
}
