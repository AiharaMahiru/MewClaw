/**
 * dsh-lark-cron 插件入口（SPEC cron.md）。
 *
 * 跨会话 cron 能力缝（worker 宿主面）：
 * - ctx.cron：PG 存储/租约/执行历史/投递 outbox（PostgresCronStore）；
 * - 轮询执行：claimDue → lark/run/submit（进 lark-run 的 per-scope 串行队列）
 *   → 输出经 lark/run/stream 镜像捕获 → lifecycle 结局 → complete；
 * - 与 lark-claw 语义对齐：租约心跳、send-before-ack、endAt 含端点、
 *   同 SQL 重算 nextRunAt 并清租约。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import type { RunId } from "dsh-lark-contracts";
import "dsh-lark-contracts/context";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { resolveCronConfig, type CronRuntimeConfig } from "./config.js";
import { CRON_MIGRATIONS } from "./migrations.js";
import { CronRunner } from "./runner.js";
import { PgCronDatabase } from "./store-pg.js";
import { PostgresCronStore } from "./store.js";
import type { CronRunOutcome, CronService } from "dsh-lark-contracts";

export const name = "lark-cron";

export const inject = ["credentials"];

export interface Config extends CronRuntimeConfig {
  /** 数据库连接串凭证引用（env 变量名；与 knowledge 同库）。 */
  databaseUrlEnv: string;
  /** 是否启动轮询（默认 true；测试关闭）。 */
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  databaseUrlEnv: z.string().required(),
  pollIntervalMs: z.number(),
  leaseMs: z.number(),
  outboxLeaseMs: z.number(),
  batchSize: z.number(),
  enabled: z.boolean(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtimeConfig = resolveCronConfig(config);
  const resolved = await ctx.credentials!.resolve(config.databaseUrlEnv as CredentialRef);
  if (!resolved?.value) {
    throw new Error(`lark-cron: 凭证引用未配置（${config.databaseUrlEnv}）——连接串值绝不写入配置`);
  }
  const database = new PgCronDatabase(resolved.value);
  await runMigrations(database, [...CRON_MIGRATIONS]);
  const store = new PostgresCronStore(database, {
    leaseMs: runtimeConfig.leaseMs,
    outboxLeaseMs: runtimeConfig.outboxLeaseMs,
  });
  // 连接池随上下文销毁关闭（effect 后注册先清理：轮询定时器先停，再关池）。
  ctx.effect(() => () => database.close());

  /** 运行结局等待表：submit 事件发出后，lifecycle 结束回填。 */
  const pendingOutcomes = new Map<RunId, {
    output: string;
    resolve: (outcome: CronRunOutcome) => void;
  }>();

  // 输出镜像：按 runId 累积 assistant 文本（有界）。
  ctx.on("lark/run/stream", (payload: { runId: RunId; event: SessionEvent }) => {
    const pending = pendingOutcomes.get(payload.runId);
    if (!pending || payload.event.type !== "assistant/message") return;
    for (const block of payload.event.data.message.content) {
      if (block.type === "text" && block.text) {
        pending.output = (pending.output + block.text).slice(0, 100_000);
      }
    }
  });

  // 结局回填：本次运行结束 → 解析 submit 的 promise。
  ctx.on("lark/run/lifecycle", (payload: {
    runId: RunId;
    phase: "started" | "ended";
    outcome?: "ok" | "cancelled" | "timed-out" | "empty" | "failed" | "queued-full";
    code?: string;
  }) => {
    if (payload.phase !== "ended") return;
    const pending = pendingOutcomes.get(payload.runId);
    if (!pending) return;
    pendingOutcomes.delete(payload.runId);
    if (payload.outcome === "ok") {
      pending.resolve({ status: "completed", output: pending.output });
    } else {
      pending.resolve({
        status: "failed",
        output: pending.output,
        error: payload.code ?? payload.outcome ?? "Scheduled execution failed",
      });
    }
  });

  const runner = new CronRunner(store, (request) => new Promise<CronRunOutcome>((resolve) => {
    pendingOutcomes.set(request.runId, { output: "", resolve });
    // 提交进 lark-run 的 per-scope 串行队列（ADR-9：与聊天运行共享序列化）。
    ctx.emit("lark/run/submit", request);
  }), {
    batchSize: runtimeConfig.batchSize,
    leaseMs: runtimeConfig.leaseMs,
  });

  const service: CronService = {
    create: (scope, input) => store.create(scope, input, new Date()),
    update: (scope, jobId, input) => store.update(scope, jobId, input, new Date()),
    pause: (scope, jobId) => store.updateStatus(scope, jobId, "paused", undefined),
    resume: async (scope, jobId) => {
      const job = await store.get(scope, jobId);
      if (!job) return undefined;
      return store.updateStatus(scope, jobId, "active", job.nextRunAt ? new Date(job.nextRunAt) : undefined);
    },
    remove: (scope, jobId) => store.remove(scope, jobId),
    list: (scope, filter) => store.list(scope, filter.filter ?? "all", filter.limit ?? 50),
    listRuns: (scope, limit) => store.listRuns(scope, limit),
    get: (scope, jobId) => store.get(scope, jobId),
    claimDue: (now, limit) => store.claimDue(now, limit),
    renewLease: (jobId, leaseToken, now) => store.renewLease(jobId, leaseToken, now),
    complete: (claim, runId, outcome, finishedAt) => store.complete(claim, runId, outcome, finishedAt),
    claimDeliveries: (input) => store.claimDeliveries(input),
    ackDelivery: (runId, deliveryToken, deliveredAt) => store.ackDelivery(runId, deliveryToken, deliveredAt),
  };
  ctx.provide("cron", service);

  // 轮询：定时唤醒扫描（状态在 PG；重复 tick 由 running 守卫防重入）。
  if (config.enabled !== false) {
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void runner.tick()
        .catch((error: unknown) => {
          ctx.logger.warn(`lark-cron: 轮询失败（${error instanceof Error ? error.message : "unknown"}）`);
        })
        .finally(() => { ticking = false; });
    }, runtimeConfig.pollIntervalMs);
    ctx.effect(() => () => {
      clearInterval(timer);
    });
  }
}

export * from "./migrations.js";
export * from "./runner.js";
export * from "./schedule.js";
export * from "./store.js";
export { PgCronDatabase } from "./store-pg.js";
