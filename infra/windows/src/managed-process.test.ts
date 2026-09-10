/**
 * managed-process 模块测试。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ManagedProcess, restartDelayMs, type ManagedChild } from "./managed-process.js";

class FakeChild extends EventEmitter implements ManagedChild {
  readonly pid = 42;
  readonly connected = true;
  readonly send = vi.fn(() => true);
  readonly kill = vi.fn(() => true);

  exit(code = 1): void {
    this.emit("exit", code, null);
  }
}

describe("ManagedProcess", () => {
  it("restarts an unexpectedly exited process with bounded exponential backoff", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const process = new ManagedProcess("worker", spawn);

    process.start();
    children[0]!.exit();
    vi.advanceTimersByTime(restartDelayMs(1) - 1);
    expect(spawn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(process.snapshot().restartCount).toBe(1);
    vi.useRealTimers();
  });

  it("uses the shutdown channel and does not restart after an intentional stop", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const process = new ManagedProcess("gateway", () => child);
    process.start();

    const stopping = process.stop();
    expect(child.send).toHaveBeenCalledWith({ type: "shutdown" });
    child.exit(0);
    await stopping;
    vi.runAllTimers();

    expect(process.snapshot().desired).toBe(false);
    expect(process.snapshot().running).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("force-terminates a child that ignores the shutdown channel", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const process = new ManagedProcess("worker", () => child, { shutdownGraceMs: 25 });
    process.start();

    const stopping = process.stop();
    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledOnce();
    child.exit(1);
    await stopping;

    expect(process.snapshot().desired).toBe(false);
    vi.useRealTimers();
  });
});
