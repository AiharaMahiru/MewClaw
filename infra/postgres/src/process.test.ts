/**
 * process 模块测试。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runProcess } from "./process.js";

describe("runProcess", () => {
  beforeEach(() => spawnMock.mockReset());

  it("can finish on process exit when descendants keep stdio open", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    spawnMock.mockReturnValue(child);

    const result = runProcess("pg_ctl.exe", ["start"], { completeOnExit: true });
    child.stdout.write("server started\n");
    child.emit("exit", 0);

    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
