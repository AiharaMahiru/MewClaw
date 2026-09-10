import type { Context } from "@deepseek-ai/cordis";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import type { DoorAgentMigrationService } from "dsh-dooragent-migration";
import { describe, expect, it, vi } from "vitest";

import { startMigrationRuntime, type MigrationActorInput } from "./runtime.js";

const ACTOR: MigrationActorInput = {
  scope: {
    tenantId: "tenant",
    botId: "bot",
    deploymentId: "migration",
    userId: "admin",
    conversationId: "cutover",
  },
  operator: {
    userId: "admin",
    sessionId: "session",
    requestId: "request",
  },
};
const STATE_PATH = join(tmpdir(), "migration-runtime-state.sqlite");

describe("migration runtime", () => {
  it("boot 前注入仅含 inherited process 层的环境快照", async () => {
    const dispose = vi.fn(async () => undefined);
    const service = {} as DoorAgentMigrationService;
    const provide = vi.fn();
    const boot = vi.fn(async (_name, _path, _patches, prepare) => {
      await prepare?.({ provide } as unknown as Context);
      return {
        dooragentMigrationCommand: service,
        fiber: { dispose },
      } as unknown as Context;
    });

    const runtime = await startMigrationRuntime(ACTOR, STATE_PATH, {
      boot,
      environment: { DATABASE_URL: "postgres://inherited" },
    });

    expect(provide).toHaveBeenCalledOnce();
    expect(provide.mock.calls[0]?.[0]).toBe(DSH_LAUNCH_ENVIRONMENT_KEY);
    const snapshot = provide.mock.calls[0]?.[1] as { get: (name: string) => unknown };
    expect(snapshot.get("DATABASE_URL")).toEqual({
      value: "postgres://inherited",
      source: "process",
    });
    expect(snapshot.get("MISSING")).toBeUndefined();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("Consumer service 缺失时清理已启动的 Context", async () => {
    const dispose = vi.fn(async () => undefined);
    const boot = vi.fn(async () => ({ fiber: { dispose } }) as unknown as Context);

    await expect(startMigrationRuntime(ACTOR, STATE_PATH, { boot, environment: {} }))
      .rejects.toThrow("MIGRATION_SERVICE_UNAVAILABLE");

    expect(dispose).toHaveBeenCalledOnce();
  });
});
