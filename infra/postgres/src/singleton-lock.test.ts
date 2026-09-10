/**
 * singleton-lock 模块测试。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  acquireSingletonProcessLock,
  deriveAdvisoryLockKeys,
  SingletonLockUnavailableError,
} from "./singleton-lock.js";

class FakeLockClient extends EventEmitter {
  readonly connect = vi.fn(async () => undefined);
  readonly end = vi.fn(async () => undefined);
  readonly query = vi.fn(async (sql: string) => ({
    rows: sql.includes("pg_try_advisory_lock")
      ? [{ acquired: this.acquired }]
      : [{ unlocked: true }],
  }));

  constructor(private readonly acquired = true) {
    super();
  }
}

describe("singleton process lock", () => {
  it("acquires a dedicated PostgreSQL advisory lock", async () => {
    const client = new FakeLockClient();
    await acquireSingletonProcessLock({
      connectionString: "postgresql://example.invalid/db",
      identity: "gateway\0tenant\0bot\0deployment",
      clientFactory: () => client,
      onLockLost: vi.fn(),
    });

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      deriveAdvisoryLockKeys("gateway\0tenant\0bot\0deployment"),
    );
  });

  it("fails fast and closes the client when the identity is already locked", async () => {
    const client = new FakeLockClient(false);
    const acquisition = acquireSingletonProcessLock({
      connectionString: "postgresql://example.invalid/db",
      identity: "gateway\0tenant\0bot\0deployment",
      clientFactory: () => client,
      onLockLost: vi.fn(),
    });

    await expect(acquisition).rejects.toBeInstanceOf(SingletonLockUnavailableError);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("derives distinct signed integer keys for different identities", () => {
    const first = deriveAdvisoryLockKeys("gateway\0tenant-a\0bot\0deployment");
    const second = deriveAdvisoryLockKeys("gateway\0tenant-b\0bot\0deployment");

    expect(first).not.toEqual(second);
    expect(first.every(Number.isInteger)).toBe(true);
  });

  it("unlocks and closes its dedicated client exactly once", async () => {
    const client = new FakeLockClient();
    const lock = await acquireSingletonProcessLock({
      connectionString: "postgresql://example.invalid/db",
      identity: "gateway\0tenant\0bot\0deployment",
      clientFactory: () => client,
      onLockLost: vi.fn(),
    });

    await lock.release();
    await lock.release();

    expect(client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1, $2) AS unlocked",
      deriveAdvisoryLockKeys("gateway\0tenant\0bot\0deployment"),
    );
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("reports connection loss through the fail-closed callback", async () => {
    const client = new FakeLockClient();
    const onLockLost = vi.fn();
    await acquireSingletonProcessLock({
      connectionString: "postgresql://example.invalid/db",
      identity: "gateway\0tenant\0bot\0deployment",
      clientFactory: () => client,
      onLockLost,
    });
    const error = new Error("connection lost");

    client.emit("error", error);

    expect(onLockLost).toHaveBeenCalledWith(error);
  });
});
