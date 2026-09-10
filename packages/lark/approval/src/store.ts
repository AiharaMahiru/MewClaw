/**
 * M1 内存待办存储（SPEC lark-approval.md §2/§6）。
 *
 * 不变量：解答幂等（CAS——仅 pending 状态可解答一次，并发重复回调返回
 * 首次结果）；每 scope 未决上限；TTL 到期自动过期（逐记录 onExpire 回调）。
 * M1 显式非持久（进程重启即丢失；M2 起 PG provider）。
 */
import { randomUUID } from "node:crypto";

import { scopeKey, type InteractionId, type Scope } from "dsh-lark-contracts";

export interface InteractionAnswer {
  selected: string[];
  custom?: string;
}

export interface PendingRecord {
  id: InteractionId;
  scope: Scope;
  questionId: string;
  state: "pending" | "answered" | "expired" | "aborted";
}

export interface PendingStoreOptions {
  /** 待办默认 TTL（毫秒）。 */
  ttlMs: number;
  /** 每 scope 未决上限；超出抛 StoreFullError。 */
  maxPendingPerScope: number;
}

export class StoreFullError extends Error {
  constructor() {
    super("该会话未决交互过多，请稍后重试");
    this.name = "StoreFullError";
  }
}

interface Entry extends PendingRecord {
  timer: NodeJS.Timeout;
  /** 到期回调（注册一次；TTL 触发时调用）。 */
  onExpired?: () => void;
}

export class MemoryPendingStore {
  private readonly options: PendingStoreOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(options: PendingStoreOptions) {
    this.options = options;
  }

  /** 创建待办（interactionId = UUID）；超限抛 StoreFullError。 */
  create(scope: Scope, questionId: string): PendingRecord {
    let pendingInScope = 0;
    const key = scopeKey(scope);
    for (const entry of this.entries.values()) {
      if (entry.state === "pending" && scopeKey(entry.scope) === key) {
        pendingInScope += 1;
      }
    }
    if (pendingInScope >= this.options.maxPendingPerScope) throw new StoreFullError();
    const id = randomUUID() as InteractionId;
    // entry 即返回给调用方的记录对象（单一实例，状态变更调用方可见）。
    const entry: Entry = { id, scope, questionId, state: "pending", timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      try {
        if (entry.state === "pending") {
          entry.state = "expired";
          entry.onExpired?.();
        }
      } finally {
        this.entries.delete(id);
      }
    }, this.options.ttlMs);
    this.entries.set(id, entry);
    return entry;
  }

  /** 注册待答记录的到期回调；TTL 触发时恰好一次。 */
  onExpire(id: InteractionId, handler: () => void): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "pending") return;
    entry.onExpired = handler;
  }

  find(id: InteractionId): PendingRecord | undefined {
    return this.entries.get(id);
  }

  /** 解答（幂等 CAS）：仅 pending 可解答一次；重复返回 undefined。 */
  resolve(id: InteractionId): PendingRecord | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "pending") return undefined;
    entry.state = "answered";
    // 保留到初始 TTL，重复回调仍能被拒绝，随后定时清理记录。
    return entry;
  }

  /** 显式过期（abort/取消路径）。 */
  expire(id: InteractionId, outcome: "expired" | "aborted"): PendingRecord | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "pending") return undefined;
    entry.state = outcome;
    // 取消后同样保留到初始 TTL，再由定时器释放。
    return entry;
  }

  /** 停用：清空全部定时器（插件卸载）。 */
  dispose(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
