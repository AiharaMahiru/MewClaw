import { describe, expect, it, vi } from "vitest";

import { waitForReady } from "./readiness.js";

describe("service readiness probe", () => {
  it("retries until the dependency accepts requests", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForReady(probe, { timeoutMs: 100, retryDelayMs: 10, sleep });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenLastCalledWith(10);
  });

  it("fails with a bounded error when the dependency never becomes ready", async () => {
    const clock = { value: 0 };
    const sleep = vi.fn(async (delayMs: number) => { clock.value += delayMs; });
    const probe = vi.fn().mockResolvedValue(false);

    await expect(waitForReady(probe, {
      timeoutMs: 25,
      retryDelayMs: 10,
      sleep,
      now: () => clock.value,
    })).rejects.toThrow("Service did not become ready within 25ms");
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
