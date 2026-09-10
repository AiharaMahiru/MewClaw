/**
 * per-scope 运行队列（SPEC lark-run.md §6）。
 *
 * 不变量：同一 Scope 严格串行（每 scope 一条 promise 链）；不同 Scope 并行
 * 但受全局并发与每用户并发上限约束；排队中 run 被取消后**不**启动模型请求。
 */
import { scopeKey, type Scope } from "dsh-lark-contracts";

export interface RunQueueOptions {
  /** 全局并发上限（默认 4）。 */
  maxRuns: number;
  /** 每用户并发上限（默认 1）。 */
  maxRunsPerUser: number;
  /** 每 scope 排队上限（默认 3，超出即拒绝入队）。 */
  maxQueuedPerScope: number;
}

export interface QueueHandle {
  /** 执行开始（队列轮到该 run 且未被取消）时 resolve 的回调载体。 */
  run: Promise<void>;
  /** 标记取消：排队中生效（轮到时不启动）；运行中由调用方另行处理。 */
  cancel(): void;
  /** 是否已被取消。 */
  readonly cancelled: boolean;
}

/** 队列/并发满（SPEC contracts.md §4.4 QUEUE_FULL）。 */
export class QueueFullError extends Error {
  constructor() {
    super("运行队列已满，请稍后重试");
    this.name = "QueueFullError";
  }
}

export class RunQueue {
  private readonly options: RunQueueOptions;
  private active = 0;
  private readonly activePerUser = new Map<string, number>();
  private readonly queued = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 等待并发名额的任务（FIFO 唤醒）。 */
  private readonly waiters: Array<() => void> = [];

  constructor(options: RunQueueOptions) {
    this.options = options;
  }

  /** 当前等待执行的 run 数（healthz 摘要用，不含 scope 细节）。 */
  depth(): number {
    let total = 0;
    for (const count of this.queued.values()) total += count;
    return total;
  }

  /** 入队一个 run；队满抛 QueueFullError。 */
  enqueue(scope: Scope, execute: () => Promise<void>): QueueHandle {
    const chainKey = scopeKey(scope);
    const queuedCount = this.queued.get(chainKey) ?? 0;
    if (queuedCount >= this.options.maxQueuedPerScope) throw new QueueFullError();
    this.queued.set(chainKey, queuedCount + 1);

    const cancellation = new AbortController();

    // 串行链：同一 scope 的任务依次执行；链自身吞错，不因单次失败断链。
    const previous = this.chains.get(chainKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      this.queued.set(chainKey, (this.queued.get(chainKey) ?? 1) - 1);
      if ((this.queued.get(chainKey) ?? 0) <= 0) this.queued.delete(chainKey);
      if (cancellation.signal.aborted) return; // 取消的排队 run 不启动模型请求。
      const acquired = await this.acquire(scope, cancellation.signal);
      if (!acquired) return;
      try {
        await execute();
      } finally {
        this.release(scope);
      }
    });
    this.chains.set(chainKey, task.catch(() => undefined));

    return {
      run: task,
      cancel: () => {
        cancellation.abort();
      },
      get cancelled() {
        return cancellation.signal.aborted;
      },
    };
  }

  /** 等并发名额（全局 + 每用户）；取消时立即从 FIFO 等待者中退出。 */
  private async acquire(scope: Scope, signal: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal.aborted) return false;
      const userActive = this.activePerUser.get(scope.userId) ?? 0;
      if (this.active < this.options.maxRuns && userActive < this.options.maxRunsPerUser) {
        this.active += 1;
        this.activePerUser.set(scope.userId, userActive + 1);
        return true;
      }
      await this.waitForSlot(signal);
    }
  }

  private waitForSlot(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", wake);
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      this.waiters.push(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  /** 释放名额并唤醒一个等待者（每次 release 恰好唤醒一个，多余名额由后续 release 接力）。 */
  private release(scope: Scope): void {
    this.active -= 1;
    const userActive = (this.activePerUser.get(scope.userId) ?? 1) - 1;
    if (userActive <= 0) this.activePerUser.delete(scope.userId);
    else this.activePerUser.set(scope.userId, userActive);
    this.waiters.shift()?.();
  }
}
