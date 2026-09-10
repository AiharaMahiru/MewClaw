/**
 * 事件去重（SPEC lark-gateway.md §6：同一 platform messageId 窗口内幂等）。
 *
 * LRU（Map 插入序）+ TTL：窗口内命中即忽略；条目超上限逐出最旧。
 */
export interface DedupeOptions {
  /** 去重窗口（毫秒）。 */
  ttlMs: number;
  /** 条目上限（LRU 逐出）。 */
  maxEntries: number;
}

export class Dedupe {
  private readonly options: DedupeOptions;
  private readonly seen = new Map<string, number>();

  constructor(options: DedupeOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new Error("lark-gateway dedupe: ttlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("lark-gateway dedupe: maxEntries must be a positive safe integer");
    }
    this.options = options;
  }

  /** 检查并记录一个 eventId；返回 true = 首次（应处理），false = 重复（忽略）。 */
  check(eventId: string, now = Date.now()): boolean {
    const seenAt = this.seen.get(eventId);
    if (seenAt !== undefined && now - seenAt < this.options.ttlMs) {
      // 刷新时间戳（窗口滑动），保持近期事件不过期误判。
      this.seen.set(eventId, now);
      return false;
    }
    this.seen.set(eventId, now);
    // LRU：Map 插入序最旧的先逐出。
    while (this.seen.size > this.options.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
