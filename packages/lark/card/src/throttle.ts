/**
 * 节流缓冲（SPEC lark-card.md §3/§6；lark-claw card-update-buffer 语义保留）。
 *
 * 不变量：有序——节流只合并、不重排；间隔或字节任一满足即投递；
 * flush() 强制投递剩余（终态路径必然调用）。
 */
export interface CardThrottleOptions {
  /** 增量更新最小间隔（毫秒）。 */
  intervalMs: number;
  /** 增量合并字节阈值（缓冲达到即投递）。 */
  bytes: number;
  /** 单卡正文字节上限（超出截断 + 截断标记）。 */
  maxCardBytes: number;
  /** 投递回调（插件层 → ctx.lark updateMessage）。 */
  flush: (text: string) => void;
}

export class CardThrottle {
  private readonly options: CardThrottleOptions;
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(options: CardThrottleOptions) {
    this.options = options;
  }

  /** 追加增量文本；达到间隔/字节阈值即投递（不重排）。 */
  push(text: string): void {
    if (text.length === 0) return;
    this.buffer += text;
    // 字节阈值：立即投递。
    if (this.buffer.length >= this.options.bytes) {
      this.drain();
      return;
    }
    // 间隔阈值：首个增量到达后武装定时器，到期投递。
    this.timer ??= setTimeout(() => this.drain(), this.options.intervalMs);
  }

  /** 强制投递剩余缓冲（终态替换前必然调用）。 */
  flush(): void {
    this.drain();
  }

  /** 取消定时器并丢弃缓冲、不投递（插件销毁路径——不再触发投递）。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.buffer = "";
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    let text = this.buffer;
    this.buffer = "";
    // 正文字节上限：截断 + 标记（超出部分丢弃，不重排）。
    if (text.length > this.options.maxCardBytes) {
      text = `${text.slice(0, this.options.maxCardBytes)}\n\n…（内容过长，已截断）`;
    }
    this.options.flush(text);
  }
}
