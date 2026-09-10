/**
 * supervisor 模块测试。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPostgresStatus: vi.fn(),
  order: [] as string[],
  spawn: vi.fn(),
  startPostgres: vi.fn(),
  stopPostgres: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: mocks.spawn }));
vi.mock("dsh-lark-postgres-runtime", () => ({
  createRuntimePaths: vi.fn(() => ({})),
  getPostgresStatus: mocks.getPostgresStatus,
  loadLocalDatabaseConfig: vi.fn(() => ({})),
  startPostgres: mocks.startPostgres,
  stopPostgres: mocks.stopPostgres,
}));

import type { ManagedChild } from "./managed-process.js";
import type { PodmanLifecycle, PodmanRuntimeSnapshot } from "./podman-runtime.js";
import { ServiceSupervisor } from "./supervisor.js";

class FakeChild extends EventEmitter implements ManagedChild {
  readonly connected = true;
  readonly pid = 42;

  send(): boolean {
    this.emit("exit", 0, null);
    return true;
  }

  kill(): boolean {
    this.emit("exit", 1, "SIGTERM");
    return true;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPostgresStatus.mockReset();
  mocks.startPostgres.mockReset();
  mocks.order.length = 0;
  mocks.getPostgresStatus.mockResolvedValue({ running: false });
  mocks.startPostgres.mockImplementation(async () => {
    mocks.order.push("postgres");
  });
  mocks.stopPostgres.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation((_command, args: string[]) => {
    const entry = args[0] ?? "";
    if (entry.includes("lark-worker")) mocks.order.push("worker");
    if (entry.includes("admin")) mocks.order.push("admin");
    if (/apps[\\/]auth[\\/]/u.test(entry)) mocks.order.push("auth");
    if (entry.includes("lark-gateway")) mocks.order.push("gateway");
    return new FakeChild();
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ServiceSupervisor default full lifecycle", () => {
  it("default full profile skips Podman and passes the host-execution overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-"));
    const podman = {
      ensureReady: vi.fn(),
      maintain: vi.fn(),
      snapshot: vi.fn(),
    } as unknown as PodmanLifecycle;
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100, podman });

    try {
      await supervisor.run();
      expect(mocks.order.slice(0, 2)).toEqual(["postgres", "worker"]);
      expect(podman.ensureReady).not.toHaveBeenCalled();
      const workerSpawn = mocks.spawn.mock.calls.find((call) => String(call[1]?.[0]).includes("lark-worker"));
      expect(workerSpawn?.[1]).toEqual([
        expect.stringMatching(/apps[\\/]lark-worker[\\/]dist[\\/]main\.js$/u),
        "--patch",
        "apps/lark-worker/full.overlay.yml",
      ]);
      const status = JSON.parse(await readFile(join(root, "var/services/status.json"), "utf8"));
      expect(status.isolation).toEqual({ profile: "full" });
      expect(status.podman).toMatchObject({ required: false, state: "not-required" });
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
});

describe("ServiceSupervisor PostgreSQL readiness", () => {
  it("restarts the readiness path when pg_ctl reports a starting server", async () => {
    mocks.getPostgresStatus
      .mockResolvedValueOnce({ running: true, vectorVersion: null })
      .mockResolvedValueOnce({ running: true, vectorVersion: "0.8.1" });
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-pg-"));
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100 });

    try {
      await supervisor.run();
      expect(mocks.startPostgres).toHaveBeenCalledOnce();
      expect(mocks.getPostgresStatus).toHaveBeenCalledOnce();
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops all child services before stopping PostgreSQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-stop-"));
    mocks.stopPostgres.mockImplementation(async () => {
      mocks.order.push("postgres-stop");
    });
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100 });

    try {
      await supervisor.run();
      mocks.order.length = 0;
      await supervisor.stop();
      expect(mocks.order.at(-1)).toBe("postgres-stop");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

});

describe("ServiceSupervisor auth edge lifecycle", () => {
  it("keeps Worker/Admin loopback and starts auth after both internal services", async () => {
    vi.stubEnv("DSH_AUTH_ENABLED", "true");
    vi.stubEnv("AUTH_PORT", "3180");
    vi.stubEnv("DSH_WEB_INTERNAL_PORT", "3181");
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-auth-"));
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100 });

    try {
      await supervisor.run();
      expect(mocks.order.slice(0, 4)).toEqual(["postgres", "worker", "admin", "auth"]);
      const workerSpawn = mocks.spawn.mock.calls.find((call) => String(call[1]?.[0]).includes("lark-worker"));
      expect(workerSpawn?.[1]).toContain("3181");
      const authSpawn = mocks.spawn.mock.calls.find((call) => /apps[\\/]auth[\\/]dist[\\/]main\.js$/u.test(String(call[1]?.[0])));
      expect(authSpawn).toBeTruthy();
      const status = JSON.parse(await readFile(join(root, "var/services/status.json"), "utf8"));
      expect(status.auth).toMatchObject({ running: true, healthy: true });
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("ServiceSupervisor OCI lifecycle", () => {
  it("OCI profile starts Podman before Worker and maintains it in the service status loop", async () => {
    vi.stubEnv("DSH_LARK_ISOLATION_PROFILE", "oci");
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-"));
    const podmanSnapshot: PodmanRuntimeSnapshot = {
      failureCode: null,
      healthy: true,
      lastCheckedAt: "2026-08-10T00:00:00.000Z",
      machine: "podman-machine-default",
      recoveryCount: 1,
      state: "running",
    };
    const podman: PodmanLifecycle = {
      ensureReady: vi.fn(async () => {
        mocks.order.push("podman");
      }),
      maintain: vi.fn(async () => true),
      snapshot: vi.fn(() => podmanSnapshot),
    };
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100, podman });

    try {
      await supervisor.run();
      expect(mocks.order.slice(0, 3)).toEqual(["postgres", "podman", "worker"]);
      const workerSpawn = mocks.spawn.mock.calls.find((call) => String(call[1]?.[0]).includes("lark-worker"));
      expect(workerSpawn?.[1]).toEqual([
        expect.stringMatching(/apps[\\/]lark-worker[\\/]dist[\\/]main\.js$/u),
        "--patch",
        "apps/lark-worker/oci.overlay.yml",
      ]);

      const status = JSON.parse(await readFile(join(root, "var/services/status.json"), "utf8"));
      expect(status.podman).toEqual(podman.snapshot());

      await vi.waitFor(() => {
        expect(podman.maintain).toHaveBeenCalled();
      });
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
  });

});

describe("ServiceSupervisor full lifecycle", () => {
  it("full profile skips Podman and passes the host-execution overlay", async () => {
    vi.stubEnv("DSH_LARK_ISOLATION_PROFILE", "full");
    const root = await mkdtemp(join(tmpdir(), "dsh-lark-supervisor-"));
    const podman = {
      ensureReady: vi.fn(),
      maintain: vi.fn(),
      snapshot: vi.fn(),
    } as unknown as PodmanLifecycle;
    const supervisor = new ServiceSupervisor(root, { monitorIntervalMs: 100, podman });

    try {
      await supervisor.run();
      expect(podman.ensureReady).not.toHaveBeenCalled();
      const workerSpawn = mocks.spawn.mock.calls.find((call) => String(call[1]?.[0]).includes("lark-worker"));
      expect(workerSpawn?.[1]).toEqual([
        expect.stringMatching(/apps[\\/]lark-worker[\\/]dist[\\/]main\.js$/u),
        "--patch",
        "apps/lark-worker/full.overlay.yml",
      ]);
      const status = JSON.parse(await readFile(join(root, "var/services/status.json"), "utf8"));
      expect(status.isolation).toEqual({ profile: "full" });
      expect(status.podman).toMatchObject({ required: false, state: "not-required" });
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("ServiceSupervisor isolation validation", () => {
  it("rejects an unknown isolation profile before spawning services", () => {
    vi.stubEnv("DSH_LARK_ISOLATION_PROFILE", "unsafe-local");
    expect(() => new ServiceSupervisor("D:\\AI\\dsh")).toThrow(/DSH_LARK_ISOLATION_PROFILE/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical health port before spawning services", () => {
    vi.stubEnv("ADMIN_PORT", "8791junk");

    expect(() => new ServiceSupervisor("D:\\AI\\dsh")).toThrow(/ADMIN_PORT/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
