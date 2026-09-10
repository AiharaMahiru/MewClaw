import { describe, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session";
import { inspectStoredSession } from "./persistence.js";

describe("只读日志句柄", () => {
  it.each([false, true])("读取失败=%s 时仍关闭句柄且不请求写权限", async (fails) => {
    const close = vi.fn(async () => undefined);
    const error = new Error("read failed");
    const open = vi.fn(async () => ({
      header: { id: "test" }, inheritedEventCount: 0,
      read: async () => { if (fails) throw error; return { events: [] }; }, close,
    }));
    const result = inspectStoredSession({ open } as never, SessionId("test"));
    if (fails) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toEqual({ meta: { id: "test" }, inheritedEventCount: 0, events: [] });
    expect(open).toHaveBeenCalledWith("test", "read");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
