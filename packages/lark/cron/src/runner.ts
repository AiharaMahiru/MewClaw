/**
 * 执行器（lark-claw cron-runner 平移）：领取到期任务 → 提交合成运行 →
 * 租约心跳 → 输出捕获 → complete（执行历史 + 下次调度 + outbox 行）。
 *
 * 提交经 lark/run/submit 进程事件进 lark-run 的 per-scope 串行队列
 * （与聊天运行共享序列化——ADR-9）；输出经 lark/run/stream 镜像捕获；
 * 结局经 lark/run/lifecycle 回写（SPEC cron.md §10-1 已解决）。
 */
import { makeMessageId, makeRunId, type RunRequest } from "dsh-lark-contracts";

import { DEFAULT_BATCH_SIZE, DEFAULT_LEASE_MS } from "./config.js";
import type { PostgresCronStore } from "./store.js";
import type { ClaimedCronJob, CronRunOutcome } from "dsh-lark-contracts";

const LEASE_HEARTBEAT_DIVISOR = 3;
const MAX_OUTPUT_LENGTH = 100_000;

export interface CronRunnerOptions {
  batchSize?: number;
  leaseMs?: number;
  now?: () => Date;
}

export interface CronRunnerSubmit {
  /** 提交合成运行并等待结局（status + 输出文本）。 */
  (request: RunRequest): Promise<CronRunOutcome>;
}

export class CronRunner {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: PostgresCronStore,
    private readonly submit: CronRunnerSubmit,
    options: CronRunnerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** 扫描一轮：领取到期任务并全部执行（数量返回给轮询日志）。 */
  async tick(): Promise<number> {
    const jobs = await this.store.claimDue(this.now(), this.batchSize);
    await Promise.all(jobs.map((job) => this.run(job)));
    return jobs.length;
  }

  private async run(job: ClaimedCronJob): Promise<void> {
    const runId = makeRunId(`cron-${job.id}`);
    let outcome: CronRunOutcome;
    try {
      const request: RunRequest = {
        runId,
        scope: job.scope,
        messageId: makeMessageId(`cron-${job.id}`),
        prompt: job.task,
        profile: "standard",
      };
      const leaseValid = await this.executeWithHeartbeat(job, () => this.submit(request));
      if (!leaseValid) return;
      outcome = leaseValid;
    } catch {
      outcome = { status: "failed", output: "", error: "定时任务执行失败" };
    }
    const finishedAt = this.now();
    await this.store.complete(job, runId, {
      status: outcome.status,
      output: outcome.output.slice(0, MAX_OUTPUT_LENGTH),
      ...(outcome.error ? { error: outcome.error.slice(0, 10_000) } : {}),
    }, finishedAt);
  }

  /** 租约心跳：执行期间每 leaseMs/3 续期；结束后最终续期校验决定是否写历史。 */
  private async executeWithHeartbeat(
    job: ClaimedCronJob,
    execute: () => Promise<CronRunOutcome>,
  ): Promise<CronRunOutcome | null> {
    const stop = new AbortController();
    const heartbeat = this.heartbeat(job, stop.signal);
    let outcome: CronRunOutcome | undefined;
    let executionError: unknown;
    let failed = false;
    try {
      outcome = await execute();
    } catch (error) {
      executionError = error;
      failed = true;
    } finally {
      stop.abort();
    }
    if (!await heartbeat || !await this.renewLease(job)) return null;
    if (failed) throw executionError;
    return outcome!;
  }

  private async heartbeat(job: ClaimedCronJob, signal: AbortSignal): Promise<boolean> {
    const intervalMs = Math.max(1, Math.floor(this.leaseMs / LEASE_HEARTBEAT_DIVISOR));
    while (await this.waitForHeartbeat(intervalMs, signal)) if (!await this.renewLease(job)) return false;
    return true;
  }

  private waitForHeartbeat(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), milliseconds);
      const finish = (continueHeartbeat: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(continueHeartbeat);
      };
      if (signal.aborted) finish(false);
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async renewLease(job: ClaimedCronJob): Promise<boolean> {
    try {
      return await this.store.renewLease(job.id, job.leaseToken, this.now());
    } catch {
      return false;
    }
  }
}
