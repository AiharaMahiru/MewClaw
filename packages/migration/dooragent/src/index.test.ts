import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthCapability } from "dsh-lark-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply, inject, name, type Config } from "./index.js";
import { DefaultDoorAgentMigrationService } from "./service.js";
import type { MigrationUserResultEvent } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), "dooragent-index-"));
  roots.push(root);
  return { statePath: join(root, "migration-state.sqlite"), actor: {
    scope: {
      tenantId: "tenant",
      botId: "bot",
      deploymentId: "dooragent-cutover",
      userId: "admin-user",
      conversationId: "migration-run",
    },
    operator: {
      userId: "admin-user",
      sessionId: "admin-session",
      requestId: "request-1",
    },
  } };
}

describe("dsh-dooragent-migration Cordis provider", () => {
  it("声明稳定插件身份并注入官方 capability", () => {
    expect(name).toBe("dooragent-migration");
    expect(inject).toEqual(["auth", "credentials"]);
  });

  it("向一次性管理 Context 提供有状态迁移服务", () => {
    const ctx = makeContext();
    const config = makeConfig();

    apply(ctx as never, config);

    expect(ctx.provide).toHaveBeenCalledWith(
      "dooragentMigration",
      expect.any(DefaultDoorAgentMigrationService),
    );
    expect(ctx.provide).toHaveBeenCalledOnce();
    ctx.disposers[0]?.();
  });

  it("Auth capability 缺失时 fail loud", () => {
    const ctx = makeContext(null);

    expect(() => apply(ctx as never, makeConfig())).toThrow("Auth capability 未激活");
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("拒绝 operator 与 Scope 用户不一致的配置", () => {
    const ctx = makeContext();
    const invalid = makeConfig();
    invalid.actor.operator.userId = "other-user";

    expect(() => apply(ctx as never, invalid)).toThrow("actor 配置无效");
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("拒绝相对 statePath", () => {
    const ctx = makeContext();
    const invalid = makeConfig();
    invalid.statePath = "relative/migration-state.sqlite";

    expect(() => apply(ctx as never, invalid)).toThrow();
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("用户结果通过 async Cordis 管理事件投递", async () => {
    const ctx = makeContext();
    apply(ctx as never, makeConfig());
    const service = ctx.provide.mock.calls[0]?.[1] as DefaultDoorAgentMigrationService;
    const event = userResultEvent();

    await (service as unknown as {
      deliverUserResult(value: MigrationUserResultEvent): Promise<void>;
    }).deliverUserResult(event);

    expect(ctx.parallel).toHaveBeenCalledWith("migration/dooragent-user-result", event);
    ctx.disposers[0]?.();
  });

  it("Context dispose 时清理迁移服务中的源凭证缓存", () => {
    const dispose = vi.spyOn(DefaultDoorAgentMigrationService.prototype, "dispose");
    const ctx = makeContext();
    apply(ctx as never, makeConfig());

    expect(ctx.disposers).toHaveLength(1);
    ctx.disposers[0]?.();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("配置工作区 Provider 时异步解析官方凭证后再提供服务", async () => {
    const ctx = makeContext();
    const config = makeConfig();
    const providerRoot = join(config.statePath, "..", "workspaces");
    config.workspaceProvider = {
      baseUrl: "http://127.0.0.1:13081",
      tokenEnv: "DSH_WORKSPACE_PROVIDER_TOKEN",
      userRoot: providerRoot,
      adminRoot: providerRoot,
    };

    await apply(ctx as never, config);

    expect(ctx.credentials.resolve).toHaveBeenCalledWith("DSH_WORKSPACE_PROVIDER_TOKEN");
    expect(ctx.provide).toHaveBeenCalledWith("dooragentMigration", expect.any(DefaultDoorAgentMigrationService));
    ctx.disposers[0]?.();
  });
});

interface TestContext {
  auth?: AuthCapability;
  credentials: { resolve: ReturnType<typeof vi.fn> };
  disposers: Array<() => void>;
  effect: ReturnType<typeof vi.fn>;
  provide: ReturnType<typeof vi.fn>;
  parallel: ReturnType<typeof vi.fn>;
}

function makeContext(auth: AuthCapability | null = {} as AuthCapability): TestContext {
  const disposers: Array<() => void> = [];
  return {
    ...(auth ? { auth } : {}),
    credentials: { resolve: vi.fn(async () => ({ value: "provider-token" })) },
    disposers,
    effect: vi.fn((register: () => () => void) => {
      disposers.push(register());
    }),
    provide: vi.fn(),
    parallel: vi.fn(async () => undefined),
  };
}

function userResultEvent(): MigrationUserResultEvent {
  return {
    eventId: "event-1",
    runId: "a".repeat(64),
    planId: "b".repeat(64),
    cutoverEpochId: "epoch-1",
    snapshotDigest: "c".repeat(64),
    sequence: 1,
    occurredAt: "2026-08-24T00:00:00.000Z",
    ignorable: false,
    source: {
      sourceSystem: "dooragent",
      sourceType: "user",
      sourceId: "source-user",
      sourceDigest: "d".repeat(64),
    },
    targetUserId: "target-user",
    result: "migrated",
    reasonCode: null,
  };
}
