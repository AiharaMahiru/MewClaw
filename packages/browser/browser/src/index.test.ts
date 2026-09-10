import { describe, expect, it, vi } from "vitest";
import { apply, name } from "./index.js";

describe("dsh-browser Provider", () => {
  it("由 WORKER_TOKEN 凭证引用提供 ctx.browser", async () => {
    const resolve = vi.fn(async () => ({ value: "secret" }));
    const provide = vi.fn();
    const effect = vi.fn();
    await apply({ credentials: { resolve }, provide, effect } as never, {});
    expect(name).toBe("dsh-browser");
    expect(resolve).toHaveBeenCalledWith("WORKER_TOKEN");
    expect(provide).toHaveBeenCalledWith("browser", expect.anything());
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("缺失凭证时失败", async () => {
    await expect(apply({ credentials: { resolve: vi.fn(async () => undefined) } } as never, {})).rejects.toThrow(/WORKER_TOKEN/);
  });
});
