/**
 * podman-runtime 模块测试。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  PODMAN_MACHINE_NAME,
  PodmanMachineKeepalive,
  type PodmanCommandRunner,
} from "./podman-runtime.js";

describe("PodmanMachineKeepalive", () => {
  it("keeps a healthy Podman machine without starting it again", async () => {
    const run = vi.fn<PodmanCommandRunner>().mockResolvedValue(true);
    const keepalive = new PodmanMachineKeepalive({ run });

    await keepalive.ensureReady();

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(["info", "--format", "json"], 15_000);
    expect(keepalive.snapshot()).toMatchObject({
      healthy: true,
      machine: PODMAN_MACHINE_NAME,
      recoveryCount: 0,
      state: "running",
    });
  });

  it("starts a stopped machine and verifies the recovered API", async () => {
    const run = vi.fn<PodmanCommandRunner>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const keepalive = new PodmanMachineKeepalive({ run });

    await expect(keepalive.maintain()).resolves.toBe(true);

    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["info", "--format", "json"],
      ["machine", "start", PODMAN_MACHINE_NAME],
      ["info", "--format", "json"],
    ]);
    expect(keepalive.snapshot()).toMatchObject({
      healthy: true,
      recoveryCount: 1,
      state: "running",
    });
  });

  it("records a sanitized failure and backs off before retrying", async () => {
    let now = 1_000;
    const run = vi.fn<PodmanCommandRunner>().mockResolvedValue(false);
    const keepalive = new PodmanMachineKeepalive({
      now: () => now,
      retryDelayMs: 30_000,
      run,
    });

    await expect(keepalive.maintain()).resolves.toBe(false);
    await expect(keepalive.maintain()).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(2);
    expect(keepalive.snapshot()).toMatchObject({
      failureCode: "PODMAN_UNAVAILABLE",
      healthy: false,
      state: "failed",
    });

    now += 30_000;
    await keepalive.maintain();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent health checks into one command", async () => {
    let finish!: (healthy: boolean) => void;
    const run = vi.fn<PodmanCommandRunner>(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const keepalive = new PodmanMachineKeepalive({ run });

    const first = keepalive.maintain();
    const second = keepalive.maintain();
    expect(run).toHaveBeenCalledOnce();

    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(run).toHaveBeenCalledOnce();
  });
});
