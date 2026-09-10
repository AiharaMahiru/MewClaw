/**
 * 执行器测试：领取 → 提交（合成 RunRequest）→ complete 回写；
 * 提交失败记 failed；租约心跳丢失时放弃写历史。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunRequest } from "dsh-lark-contracts";

import { CronRunner } from "./runner.js";
import type { CronRunOutcome, ClaimedCronJob } from "dsh-lark-contracts";

function makeJob(): ClaimedCronJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    scope: {
      tenantId: "t" as never,
      botId: "b" as never,
      deploymentId: "d" as never,
      userId: "ou_1" as never,
      conversationId: "oc_1" as never,
    },
    task: "每天总结",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    status: "active",
    nextRunAt: "2026-08-20T09:00:00.000Z",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    leaseToken: "lease-1",
  };
}

function makeStore(overrides: Partial<{
  claimDue: (now: Date, limit: number) => Promise<ClaimedCronJob[]>;
  renewLease: (jobId: string, leaseToken: string, now: Date) => Promise<boolean>;
  complete: (claim: ClaimedCronJob, runId: string, outcome: CronRunOutcome, finishedAt: Date) => Promise<void>;
}> = {}) {
  return {
    claimDue: vi.fn(async () => []),
    renewLease: vi.fn(async () => true),
    complete: vi.fn(async () => undefined),
    ...overrides,
  };
}

const NOW = new Date("2026-08-20T00:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("CronRunner", () => {
  it("tick：领取到期任务 → 合成 RunRequest 提交 → complete 回写结果", async () => {
    const job = makeJob();
    const submitted: RunRequest[] = [];
    const store = makeStore({ claimDue: async () => [job] });
    const runner = new CronRunner(store as never, async (request) => {
      submitted.push(request);
      return { status: "completed", output: "运行结果文本" };
    }, { now: () => NOW });

    expect(await runner.tick()).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      scope: job.scope,
      prompt: "每天总结",
      profile: "standard",
    });
    expect(submitted[0]!.runId).toMatch(/^cron-/);
    expect(store.complete).toHaveBeenCalledWith(job, submitted[0]!.runId, {
      status: "completed",
      output: "运行结果文本",
    }, NOW);
  });

  it("提交抛错 → failed 结局（错误截断）", async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const store = makeStore({ claimDue: async () => [job] });
    const runner = new CronRunner(store as never, async () => {
      throw new Error("boom");
    }, { now: () => NOW });

    await runner.tick();
    expect(store.complete).toHaveBeenCalledWith(job, expect.anything(), {
      status: "failed",
      output: "",
      error: "定时任务执行失败",
    }, NOW);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("快速完成后取消尚未触发的心跳计时器", async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const store = makeStore({ claimDue: async () => [job] });
    const runner = new CronRunner(store as never, async () => ({ status: "completed", output: "x" }), {
      now: () => NOW,
      leaseMs: 15_000,
    });

    await runner.tick();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("租约心跳丢失 → 放弃写历史", async () => {
    const job = makeJob();
    const store = makeStore({
      claimDue: async () => [job],
      renewLease: async () => false,
    });
    const runner = new CronRunner(store as never, async () => ({ status: "completed", output: "x" }), {
      now: () => NOW,
      leaseMs: 6, // 心跳间隔 = 2ms，等待期间续期失败。
    });

    await runner.tick();
    expect(store.complete).not.toHaveBeenCalled();
  });
});
