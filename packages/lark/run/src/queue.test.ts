/**
 * RunQueue 测试（SPEC lark-run.md §8）：
 * per-scope 串行、跨 scope 并行、并发上限、排队取消不启动。
 */
import { describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import { RunQueue } from "./queue.js";

const options = { maxRuns: 2, maxRunsPerUser: 1, maxQueuedPerScope: 3 };
const CANCEL_SETTLE_TIMEOUT_MS = 100;

function scope(userId: string, conversationId: string): Scope {
  return {
    tenantId: makeTenantId("t"),
    botId: makeBotId("b"),
    deploymentId: makeDeploymentId("d"),
    userId: makeUserId(userId),
    conversationId: makeConversationId(conversationId),
  };
}

/** 记录执行顺序的假任务。 */
function task(log: string[], name: string, delayMs = 0) {
  return async () => {
    log.push(`${name}:start`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    log.push(`${name}:end`);
  };
}

describe("RunQueue", () => {
  it("同一 scope 严格串行", async () => {
    const queue = new RunQueue(options);
    const log: string[] = [];
    const s = scope("ou_1", "oc_1");
    const first = queue.enqueue(s, task(log, "a", 20));
    const second = queue.enqueue(s, task(log, "b"));
    await Promise.all([first.run, second.run]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("不同 scope 并行（受全局并发上限）", async () => {
    const queue = new RunQueue(options);
    const log: string[] = [];
    const a = queue.enqueue(scope("ou_1", "oc_1"), task(log, "a", 30));
    const b = queue.enqueue(scope("ou_2", "oc_2"), task(log, "b", 30));
    const c = queue.enqueue(scope("ou_3", "oc_3"), task(log, "c"));
    await Promise.all([a.run, b.run, c.run]);
    // 全局上限 2：a/b 先并行启动；c 在某个名额释放后才启动。
    expect(log.slice(0, 2)).toEqual(["a:start", "b:start"]);
    const firstEnd = log.findIndex((entry) => entry.endsWith(":end"));
    const cStart = log.indexOf("c:start");
    expect(cStart).toBeGreaterThan(firstEnd);
    expect(log.at(-1)).toBe("b:end");
  });

  it("每用户并发上限：同用户不同群也串行", async () => {
    const queue = new RunQueue(options);
    const log: string[] = [];
    const a = queue.enqueue(scope("ou_1", "oc_1"), task(log, "a", 20));
    const b = queue.enqueue(scope("ou_1", "oc_2"), task(log, "b"));
    await Promise.all([a.run, b.run]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("排队中被取消的 run 不启动任务", async () => {
    const queue = new RunQueue(options);
    const log: string[] = [];
    const s = scope("ou_1", "oc_1");
    queue.enqueue(s, task(log, "a", 20));
    const second = queue.enqueue(s, task(log, "b"));
    second.cancel();
    await second.run;
    expect(log).toEqual(["a:start", "a:end"]);
  });

  it("等待全局并发名额时取消的 run 不启动任务", async () => {
    const queue = new RunQueue({ ...options, maxRuns: 1 });
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue(scope("ou_1", "oc_1"), async () => {
      log.push("a:start");
      await firstGate;
      log.push("a:end");
    });
    await vi.waitFor(() => expect(log).toEqual(["a:start"]));
    const second = queue.enqueue(scope("ou_2", "oc_2"), task(log, "b"));
    await vi.waitFor(() => expect(queue.depth()).toBe(0));
    second.cancel();
    releaseFirst();

    await Promise.all([first.run, second.run]);
    expect(log).toEqual(["a:start", "a:end"]);
  });

  it("等待全局并发名额时取消会立即结算，不滞留等待者", async () => {
    const queue = new RunQueue({ ...options, maxRuns: 1 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue(scope("ou_1", "oc_1"), () => firstGate);
    await vi.waitFor(() => expect(queue.depth()).toBe(0));
    const second = queue.enqueue(scope("ou_2", "oc_2"), async () => undefined);
    await vi.waitFor(() => expect(queue.depth()).toBe(0));

    let settled = false;
    void second.run.then(() => { settled = true; });
    second.cancel();
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: CANCEL_SETTLE_TIMEOUT_MS });
    } finally {
      releaseFirst();
    }
    await Promise.all([first.run, second.run]);
  });

  it("每 scope 排队上限：超出抛 QueueFullError", () => {
    const queue = new RunQueue(options);
    const s = scope("ou_1", "oc_1");
    queue.enqueue(s, async () => undefined);
    queue.enqueue(s, async () => undefined);
    queue.enqueue(s, async () => undefined);
    expect(() => queue.enqueue(s, async () => undefined)).toThrowError(/队列已满/);
  });

  it("depth 统计等待中的 run 数", async () => {
    const queue = new RunQueue(options);
    const s = scope("ou_1", "oc_1");
    const first = queue.enqueue(s, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    queue.enqueue(s, async () => undefined);
    // 入队后、链执行前：两个都在等待（含队首尚未启动的 run）。
    expect(queue.depth()).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 队首启动后：只剩第二个在等待。
    expect(queue.depth()).toBe(1);
    await first.run;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.depth()).toBe(0);
  });
});
