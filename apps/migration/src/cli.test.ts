import type { DoorAgentMigrationService } from "dsh-dooragent-migration";
import { describe, expect, it, vi } from "vitest";

import {
  HELP_TEXT,
  runMigrationCli,
  type MigrationCliDependencies,
  type MigrationRuntime,
} from "./cli.js";

const ACTOR_ARGS = [
  "--tenant-id", "tenant",
  "--bot-id", "bot",
  "--deployment-id", "migration",
  "--user-id", "admin",
  "--conversation-id", "cutover",
  "--operator-session-id", "session",
  "--request-id", "request",
  "--state-path", join(tmpdir(), "migration-cli-state.sqlite"),
];

describe("migration CLI", () => {
  it("--help 不启动 Cordis composition", async () => {
    const harness = makeHarness();

    const exitCode = await runMigrationCli(["--help"], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stdout).toEqual([HELP_TEXT]);
  });

  it("--boot-check 启动完整 composition 后始终 dispose", async () => {
    const harness = makeHarness();

    const exitCode = await runMigrationCli(["--boot-check", ...ACTOR_ARGS], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.stdout[0] ?? "")).toEqual({
      ok: true,
      command: "boot-check",
    });
  });

  it("--boot-check 未指定状态路径时使用进程级临时文件", async () => {
    const harness = makeHarness();
    const actorArgs = ACTOR_ARGS.slice(0, -2);

    expect(await runMigrationCli(["--boot-check", ...actorArgs], harness.dependencies)).toBe(0);
    expect(harness.start.mock.calls[0]?.[1]).toBe(join(tmpdir(), `dsh-migration-boot-check-${process.pid}.sqlite`));
  });

  it("管理员命令未显式启用时在启动前拒绝", async () => {
    const harness = makeHarness();

    const exitCode = await runMigrationCli([
      "apply", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--approval-ref", "approval-secret",
      "--cutover-epoch-id", "epoch",
    ], harness.dependencies);

    expect(exitCode).toBe(2);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stderr.join("\n")).not.toContain("approval-secret");
    expect(JSON.parse(harness.stderr[0] ?? "")).toEqual({
      ok: false,
      error: { code: "ADMIN_MODE_REQUIRED" },
    });
  });

  it("命令失败时 dispose 且错误输出不回显异常、路径或批准引用", async () => {
    const harness = makeHarness();
    harness.service.inspect.mockRejectedValueOnce(
      new Error("D:/secret/source.sqlite approval-secret scrypt:0123456789abcdef0123456789abcdef:" + "a".repeat(128)),
    );

    const exitCode = await runMigrationCli([
      "inspect", ...ACTOR_ARGS,
      "--snapshot", "D:/secret/snapshot",
      "--manifest", "D:/secret/manifest.json",
      "--manifest-digest", "a".repeat(64),
    ], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.stderr).toHaveLength(1);
    expect(harness.stderr[0]).toBe('{"ok":false,"error":{"code":"MIGRATION_FAILED"}}');
  });

  it("按 inspect -> plan -> dryRun 重建状态并清理成功输出", async () => {
    const harness = makeHarness();
    harness.service.inspect.mockResolvedValueOnce({ inventoryDigest: "inventory" });
    harness.service.plan.mockResolvedValueOnce({ runId: "run", planId: "plan" });
    harness.service.dryRun.mockResolvedValueOnce({
      email: "private@example.com",
      diagnostic: "scrypt:0123456789abcdef0123456789abcdef:" + "a".repeat(128),
    });

    const exitCode = await runMigrationCli([
      "dry-run", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
    ], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.service.inspect).toHaveBeenCalledOnce();
    expect(harness.service.plan).toHaveBeenCalledOnce();
    expect(harness.service.dryRun).toHaveBeenCalledOnce();
    expect(harness.stdout[0]).not.toContain("private@example.com");
    expect(harness.stdout[0]).not.toContain("scrypt:");
  });

  it("approve-apply 在同一进程签发并消费批准且不输出引用", async () => {
    const harness = makeHarness();
    const plan = { runId: "run", planId: "plan" };
    const approval = { approvalRef: "approval-secret", cutoverEpochId: "epoch" };
    harness.service.inspect.mockResolvedValueOnce({ inventoryDigest: "inventory" });
    harness.service.plan.mockResolvedValueOnce(plan);
    harness.service.issueApplyApproval.mockResolvedValueOnce(approval);
    harness.service.apply.mockResolvedValueOnce({ reportDigest: "b".repeat(64) });

    const exitCode = await runMigrationCli([
      "approve-apply", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--cutover-epoch-id", "epoch",
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.service.issueApplyApproval).toHaveBeenCalledWith(plan, "epoch");
    expect(harness.service.apply).toHaveBeenCalledWith(plan, approval);
    expect(harness.stdout.join("\n")).not.toContain("approval-secret");
    expect(harness.stderr).toHaveLength(0);
  });

  it("approve-apply 缺少 cutover epoch 时在启动前拒绝", async () => {
    const harness = makeHarness();

    const exitCode = await runMigrationCli([
      "approve-apply", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(2);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stderr[0]).toBe('{"ok":false,"error":{"code":"APPROVAL_REQUIRED"}}');
  });

  it("approve-rollback 在同一进程签发并消费原 run 批准且不输出引用", async () => {
    const harness = makeHarness();
    const plan = { runId: "planned-run", planId: "plan" };
    const approval = { approvalRef: "rollback-secret", cutoverEpochId: "epoch" };
    harness.service.inspect.mockResolvedValueOnce({ inventoryDigest: "inventory" });
    harness.service.plan.mockResolvedValueOnce(plan);
    harness.service.issueRollbackApproval.mockResolvedValueOnce(approval);
    harness.service.rollback.mockResolvedValueOnce({ reportDigest: "c".repeat(64) });

    const exitCode = await runMigrationCli([
      "approve-rollback", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--run-id", "planned-run",
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.service.issueRollbackApproval).toHaveBeenCalledWith("planned-run");
    expect(harness.service.rollback).toHaveBeenCalledWith("planned-run", approval);
    expect(harness.stdout.join("\n")).not.toContain("rollback-secret");
    expect(harness.stderr).toHaveLength(0);
  });

  it("reconcile 只接受当前 deterministic plan 的 runId", async () => {
    const harness = makeHarness();
    harness.service.inspect.mockResolvedValueOnce({ inventoryDigest: "inventory" });
    harness.service.plan.mockResolvedValueOnce({ runId: "planned-run" });

    const exitCode = await runMigrationCli([
      "reconcile", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--run-id", "other-run",
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.service.reconcile).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.stderr[0]).toBe('{"ok":false,"error":{"code":"RUN_ID_MISMATCH"}}');
  });

  it("sync-credentials 直接复用原 run 且不重新规划", async () => {
    const harness = makeHarness();
    harness.service.inspect.mockResolvedValueOnce({ inventoryDigest: "inventory" });
    harness.service.syncCredentials.mockResolvedValueOnce({
      eligible: 16,
      processed: 16,
      alreadyProcessed: 0,
    });

    const exitCode = await runMigrationCli([
      "sync-credentials", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--run-id", "original-run",
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.service.inspect).not.toHaveBeenCalled();
    expect(harness.service.plan).not.toHaveBeenCalled();
    expect(harness.service.syncCredentials).toHaveBeenCalledWith(
      "original-run",
      expect.objectContaining({ manifestDigest: "a".repeat(64) }),
    );
  });

  it("sync-credentials 缺少原 runId 时在启动前拒绝", async () => {
    const harness = makeHarness();

    const exitCode = await runMigrationCli([
      "sync-credentials", ...ACTOR_ARGS,
      "--snapshot", "snapshot",
      "--manifest", "manifest",
      "--manifest-digest", "a".repeat(64),
      "--enable-admin-command",
    ], harness.dependencies);

    expect(exitCode).toBe(2);
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.stderr[0]).toBe('{"ok":false,"error":{"code":"CLI_USAGE_INVALID"}}');
  });

  it("dispose 失败会覆盖成功状态并返回稳定错误码", async () => {
    const harness = makeHarness();
    harness.dispose.mockRejectedValueOnce(new Error("sensitive dispose detail"));

    const exitCode = await runMigrationCli(["--boot-check", ...ACTOR_ARGS], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.stderr[0]).toBe(
      '{"ok":false,"error":{"code":"MIGRATION_DISPOSE_FAILED"}}',
    );
    expect(harness.stdout).toHaveLength(0);
  });
});

function makeHarness(): {
  dependencies: MigrationCliDependencies;
  dispose: ReturnType<typeof vi.fn>;
  service: Record<keyof DoorAgentMigrationService, ReturnType<typeof vi.fn>>;
  start: ReturnType<typeof vi.fn>;
  stderr: string[];
  stdout: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dispose = vi.fn(async () => undefined);
  const service = {
    inspect: vi.fn(),
    plan: vi.fn(),
    dryRun: vi.fn(),
    issueApplyApproval: vi.fn(),
    issueRollbackApproval: vi.fn(),
    apply: vi.fn(),
    syncCredentials: vi.fn(),
    reconcile: vi.fn(),
    rollback: vi.fn(),
  };
  const runtime: MigrationRuntime = {
    service: service as unknown as DoorAgentMigrationService,
    dispose,
  };
  const start = vi.fn(async () => runtime);
  return {
    dependencies: {
      start,
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    },
    dispose,
    service,
    start,
    stderr,
    stdout,
  };
}
import { tmpdir } from "node:os";
import { join } from "node:path";
