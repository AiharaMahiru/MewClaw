/**
 * CardThrottle 测试（SPEC lark-card.md §8）：间隔/字节阈值、有序性、截断标记。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CardThrottle } from "./throttle.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeThrottle(overrides: Partial<ConstructorParameters<typeof CardThrottle>[0]> = {}) {
  const flushed: string[] = [];
  const throttle = new CardThrottle({
    intervalMs: 500,
    bytes: 1024,
    maxCardBytes: 4096,
    flush: (text) => flushed.push(text),
    ...overrides,
  });
  return { throttle, flushed };
}

describe("CardThrottle", () => {
  it("间隔阈值：到期投递累计内容（有序合并）", () => {
    vi.useFakeTimers();
    const { throttle, flushed } = makeThrottle();
    throttle.push("第一段");
    throttle.push("第二段");
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(flushed).toEqual(["第一段第二段"]);
  });

  it("字节阈值：达到即投递，不重排", () => {
    const { throttle, flushed } = makeThrottle({ bytes: 8 });
    throttle.push("12345");
    throttle.push("678");
    expect(flushed).toEqual(["12345678"]);
  });

  it("flush 强制投递剩余", () => {
    vi.useFakeTimers();
    const { throttle, flushed } = makeThrottle();
    throttle.push("未到阈值");
    throttle.flush();
    expect(flushed).toEqual(["未到阈值"]);
    // 再次 flush 为空 no-op。
    throttle.flush();
    expect(flushed).toHaveLength(1);
  });

  it("正文超上限：截断 + 截断标记", () => {
    const { throttle, flushed } = makeThrottle({ maxCardBytes: 8 });
    throttle.push("a".repeat(20));
    throttle.flush();
    expect(flushed[0]).toContain("aaaaaaaa");
    expect(flushed[0]).toContain("已截断");
    expect(flushed[0]!.startsWith("a".repeat(8))).toBe(true);
  });

  it("空增量 no-op", () => {
    vi.useFakeTimers();
    const { throttle, flushed } = makeThrottle();
    throttle.push("");
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(0);
  });
});

describe("CardThrottle · 可逆性", () => {
  it("dispose 取消 pending 定时器并丢弃缓冲（不再投递）", async () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      const throttle = new CardThrottle({ intervalMs: 100, bytes: 1024, maxCardBytes: 1024, flush });
      throttle.push("未投递增量");
      throttle.dispose();
      vi.advanceTimersByTime(500);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
