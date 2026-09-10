import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthImportError, type AuthCapability, type AuthUserImportPlan } from "dsh-lark-auth";
import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { digestCanonical } from "./canonical-json.js";
import { MemoryMigrationRunStore, SqliteMigrationRunStore } from "./migration-state.js";
import { DefaultDoorAgentMigrationService } from "./service.js";
import type {
  DoorAgentUserRecord,
  FrozenDoorAgentSource,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationApproval,
  MigrationPolicy,
  WorkspaceRollbackJournal,
} from "./types.js";

const SNAPSHOT_DIGEST = "a".repeat(64);
const SOURCE: FrozenDoorAgentSource = {
  snapshotPath: "D:/immutable/dooragent",
  manifestPath: "manifest-v4.json",
  manifestDigest: SNAPSHOT_DIGEST,
};
const POLICY: MigrationPolicy = { allowCredentialReuse: true, includeAssociatedData: false };
const APPROVAL: MigrationApproval = { approvalRef: "run-approval", cutoverEpochId: "cutover-epoch" };
const SCOPE: Scope = {
  tenantId: makeTenantId("tenant"),
  botId: makeBotId("bot"),
  deploymentId: makeDeploymentId("migration"),
  userId: makeUserId("admin-user"),
  conversationId: makeConversationId("dooragent-cutover"),
};
const ACTOR: MigrationActor = {
  scope: SCOPE,
  operator: { userId: SCOPE.userId, sessionId: "admin-session", requestId: "request-1" },
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DefaultDoorAgentMigrationService", () => {
  it("整批登记 action，按租约 apply，并在报告落盘后 ack outbox", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);

    const report = await service.apply(plan, APPROVAL);

    expect(mock.events).toEqual([
      "authorize:run-approval:2",
      "lease-actions",
      "issue:apply-user:admin-1",
      "apply:item-1:admin-1:action-1",
      "issue:apply-user:user-1",
      "apply:item-2:user-1:action-2",
      "issue:sync-credential:user-1",
      "sync:item-3:user-1",
      "lease-outbox",
      "ack:event-1",
      "ack:event-2",
    ]);
    expect(new Set(mock.itemApprovals)).toEqual(new Set(["item-1", "item-2", "item-3"]));
    expect(mock.itemApprovals).not.toContain(APPROVAL.approvalRef);
    expect(report.mode).toBe("apply");
    expect(report.status).toBe("complete");
    expect(report.counts).toEqual({ total: 2, migrated: 1, merged: 1, rejected: 0, resetRequired: 0 });
    expectSensitiveValuesRedacted(report);
    const actions = mock.authorizeImportRun.mock.calls[0]?.[0].actions ?? [];
    expect(actions.map((action) => action.sequence)).toEqual([1, 2]);
    expect(actions.every((action) => action.actionId === digestCanonical({
      runId: plan.runId,
      operation: action.operation,
      sequence: action.sequence,
      source: action.source,
      payloadDigest: action.payloadDigest,
    }))).toBe(true);
  });

  it("重复 apply 返回同一报告且不重复消费批准或写用户", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);

    const first = await service.apply(plan, APPROVAL);
    const second = await service.apply(plan, APPROVAL);

    expect(second).toEqual(first);
    expect(mock.authorizeImportRun).toHaveBeenCalledTimes(1);
    expect(mock.applyUserImport).toHaveBeenCalledTimes(2);
    expect(mock.syncCredential).toHaveBeenCalledTimes(1);
  });

  it("凭证补同步拒绝与原 run 不一致的冻结源", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);
    await service.apply(plan, APPROVAL);

    await expect(service.syncCredentials(plan.runId, {
      ...SOURCE,
      manifestDigest: "f".repeat(64),
    })).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("凭证补同步拒绝尚未完成的原 run", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    await expect(service.syncCredentials(plan.runId, SOURCE))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(mock.issueImportApproval).not.toHaveBeenCalled();
    expect(mock.syncCredential).not.toHaveBeenCalled();
  });

  it("凭证补同步允许当前有效管理员接管历史 complete run", async () => {
    const mock = createAuth();
    const stateStore = new MemoryMigrationRunStore();
    const original = createService(mock.auth, stateStore);
    const plan = await original.plan(await original.inspect(SOURCE), POLICY);
    await original.apply(plan, APPROVAL);
    const currentAdminId = makeUserId("current-admin");
    const currentAdmin = createService(mock.auth, stateStore, async () => undefined, {
      scope: { ...SCOPE, userId: currentAdminId },
      operator: { userId: currentAdminId, sessionId: "current-session", requestId: "current-request" },
    });

    await expect(currentAdmin.syncCredentials(plan.runId, SOURCE))
      .resolves.toMatchObject({ status: "complete" });
  });

  it("凭证补同步保留 Auth 的凭证状态冲突错误码", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);
    await service.apply(plan, APPROVAL);
    mock.syncCredential.mockRejectedValueOnce(new AuthImportError("CREDENTIAL_STATE_CONFLICT"));

    await expect(service.syncCredentials(plan.runId, SOURCE))
      .rejects.toMatchObject({
        code: "CREDENTIAL_STATE_CONFLICT",
        cause: expect.objectContaining({ code: "CREDENTIAL_STATE_CONFLICT" }),
      });
  });

  it("并发 apply 共享一个运行，不重复写用户", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);

    const [first, second] = await Promise.all([
      service.apply(plan, APPROVAL),
      service.apply(plan, APPROVAL),
    ]);

    expect(second).toEqual(first);
    expect(mock.authorizeImportRun).toHaveBeenCalledTimes(1);
    expect(mock.applyUserImport).toHaveBeenCalledTimes(2);
    expect(mock.syncCredential).toHaveBeenCalledTimes(1);
  });

  it("并发 apply 使用不同 cutover epoch 时拒绝共享运行", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);
    const started = deferred<void>();
    const release = deferred<void>();
    const authorize = mock.authorizeImportRun.getMockImplementation();
    mock.authorizeImportRun.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return authorize!(input);
    });

    const first = service.apply(plan, APPROVAL);
    await started.promise;
    await expect(service.apply(plan, {
      approvalRef: "other-approval",
      cutoverEpochId: "other-epoch",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    release.resolve();

    await expect(first).resolves.toMatchObject({ status: "complete" });
    expect(mock.authorizeImportRun).toHaveBeenCalledTimes(1);
  });

  it("调用 Auth 授权前持久化 cutover epoch intent", async () => {
    const mock = createAuth();
    const store = new MemoryMigrationRunStore();
    const service = createService(mock.auth, store);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);
    const authorize = mock.authorizeImportRun.getMockImplementation();
    mock.authorizeImportRun.mockImplementationOnce(async (input) => {
      expect(store.loadRun(plan.runId)).toMatchObject({
        phase: "planned",
        cutoverEpochId: APPROVAL.cutoverEpochId,
      });
      return authorize!(input);
    });

    await expect(service.apply(plan, APPROVAL)).resolves.toMatchObject({ status: "complete" });
  });

  it("apply-run 批准必须由调用方显式签发，apply 不会自签", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    const approval = await service.issueApplyApproval(plan, APPROVAL.cutoverEpochId);
    await service.apply(plan, approval);

    expect(approval).toEqual({
      approvalRef: "issued-run-approval",
      cutoverEpochId: APPROVAL.cutoverEpochId,
    });
    expect(mock.issueImportApproval.mock.calls.filter(([input]) => input.operation === "apply-run"))
      .toHaveLength(1);
    expect(mock.authorizeImportRun).toHaveBeenCalledWith(expect.objectContaining({
      approvalRef: "issued-run-approval",
      planDigest: plan.planDigest,
    }));
  });

  it("整批批准无效时零用户批准、零用户写入", async () => {
    const mock = createAuth();
    mock.authorizeImportRun.mockRejectedValueOnce(new AuthImportError("APPROVAL_INVALID"));
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);

    await expect(service.apply(plan, APPROVAL)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(mock.issueImportApproval).not.toHaveBeenCalled();
    expect(mock.applyUserImport).not.toHaveBeenCalled();
  });

  it("已中断信号在授权前拒绝", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);
    const controller = new AbortController();
    controller.abort();

    await expect(service.apply(plan, APPROVAL, controller.signal))
      .rejects.toMatchObject({ code: "IMPORT_ABORTED" });
    expect(mock.authorizeImportRun).not.toHaveBeenCalled();
  });

  it("reconcile 只按已知 run 查询并生成脱敏摘要", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);
    await service.apply(plan, APPROVAL);

    const report = await service.reconcile(plan.runId);

    expect(report).toMatchObject({ matched: 2, missing: 0, mismatched: 0, result: "matched" });
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.reconcileImport).toHaveBeenCalledTimes(1);
    await expect(service.reconcile("f".repeat(64))).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("rollback 使用独立 rollback-run 批准并绑定原运行", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const inventory = await service.inspect(SOURCE);
    const plan = await service.plan(inventory, POLICY);
    await service.apply(plan, APPROVAL);
    mock.issueImportApproval.mockResolvedValueOnce({
      approvalRef: "rollback-approval",
      expiresAt: "2026-08-24T00:15:00.000Z",
    });

    const rollbackApproval = await service.issueRollbackApproval(plan.runId);

    const report = await service.rollback(plan.runId, rollbackApproval);

    expect(mock.issueImportApproval).toHaveBeenCalledWith(expect.objectContaining({
      operation: "rollback-run",
      cutoverEpochId: APPROVAL.cutoverEpochId,
      runId: plan.runId,
      planId: plan.planId,
    }));
    expect(mock.rollbackImport).toHaveBeenCalledWith(expect.objectContaining({
      approvalRef: "rollback-approval",
      cutoverEpochId: APPROVAL.cutoverEpochId,
      runId: plan.runId,
      planId: plan.planId,
    }));
    expect(report).toMatchObject({ rolledBack: 2, retained: 0, rejected: 0, result: "complete" });
  });

  it("Auth 缺少 rollback guard 时保留资源且 run 仍为 complete", async () => {
    const mock = createAuth();
    mock.rollbackImport.mockResolvedValueOnce({
      rolledBack: 0,
      retained: 2,
      rejected: 2,
      reasonCode: "ROLLBACK_GUARD_UNAVAILABLE",
    });
    const store = new MemoryMigrationRunStore();
    const service = createService(mock.auth, store);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);
    await service.apply(plan, APPROVAL);
    const journal: WorkspaceRollbackJournal[] = [{
      source: {
        sourceSystem: "dooragent",
        sourceType: "workspace",
        sourceId: "user-1",
        sourceDigest: "e".repeat(64),
      },
      targetUserId: "existing-user",
      targetWorkspaceId: "workspace-1",
      role: "user",
      aggregate: {
        bytes: 0,
        directoryCount: 1,
        fileCount: 0,
        merkleRootSha256: "f".repeat(64),
        specialFileCount: 0,
        symlinkCount: 0,
        unreadableEntries: 0,
        unstableFiles: 0,
      },
      result: "merged",
      createdTarget: false,
      cutoverEpochId: APPROVAL.cutoverEpochId,
    }];
    const journalLease = store.claimRun(plan.runId, "journal-owner", 10, 30)!;
    store.saveReport(plan.runId, store.loadRun(plan.runId)!.report!, {
      ...journalLease,
      nowMs: 11,
    }, journal);
    store.releaseRun(plan.runId, { ...journalLease, nowMs: 12 });

    const report = await service.rollback(plan.runId, {
      approvalRef: "rollback-approval",
      cutoverEpochId: APPROVAL.cutoverEpochId,
    });

    expect(report).toMatchObject({
      rolledBack: 0,
      retained: 3,
      rejected: 2,
      result: "rejected",
      reasonCode: "ROLLBACK_GUARD_UNAVAILABLE",
    });
    expect(report.workspaces).toEqual([expect.objectContaining({
      source: journal[0]!.source,
      targetUserId: "existing-user",
      targetWorkspaceId: "workspace-1",
      result: "retained",
      reasonCode: "ROLLBACK_GUARD_UNAVAILABLE",
    })]);
    expect(report.workspaceCounts).toEqual({ total: 1, rolledBack: 0, retained: 1, rejected: 0 });
    expect(store.loadRun(plan.runId)).toMatchObject({ phase: "complete", rollback: null });
  });

  it("未执行或已回滚的 run 不签发 rollback 批准", async () => {
    const mock = createAuth();
    const service = createService(mock.auth);
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    await expect(service.issueRollbackApproval(plan.runId))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
    await service.apply(plan, APPROVAL);
    await service.rollback(plan.runId, {
      approvalRef: "rollback-approval",
      cutoverEpochId: APPROVAL.cutoverEpochId,
    });
    await expect(service.issueRollbackApproval(plan.runId))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("进程重启后恢复原 plan，并按原 cutover epoch reconcile/rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooragent-service-state-"));
    roots.push(root);
    const statePath = join(root, "migration-state.sqlite");
    const mock = createAuth();
    const first = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    const inventory = await first.inspect(SOURCE);
    const plan = await first.plan(inventory, POLICY);
    await first.apply(plan, APPROVAL);
    first.dispose();
    mock.dryRunUserImport.mockRejectedValue(new Error("不得按当前目标状态重新规划"));

    const second = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    const recovered = await second.plan(await second.inspect(SOURCE), POLICY);

    expect(recovered).toEqual(plan);
    await expect(second.reconcile(plan.runId)).resolves.toMatchObject({ result: "matched" });
    await expect(second.rollback(plan.runId, {
      approvalRef: "rollback-approval",
      cutoverEpochId: "other-epoch",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(second.rollback(plan.runId, {
      approvalRef: "rollback-approval",
      cutoverEpochId: APPROVAL.cutoverEpochId,
    })).resolves.toMatchObject({ result: "complete" });
    second.dispose();
  });

  it("重启使用同一 Scope 的新 session/request 时恢复原 run", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooragent-service-actor-"));
    roots.push(root);
    const statePath = join(root, "migration-state.sqlite");
    const mock = createAuth();
    const first = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    const plan = await first.plan(await first.inspect(SOURCE), POLICY);
    first.dispose();
    const resumedActor = structuredClone(ACTOR);
    resumedActor.operator.sessionId = "admin-session-resumed";
    resumedActor.operator.requestId = "request-resumed";

    const second = createService(
      mock.auth,
      new SqliteMigrationRunStore(statePath),
      async () => undefined,
      resumedActor,
    );

    await expect(second.plan(await second.inspect(SOURCE), POLICY)).resolves.toEqual(plan);
    second.dispose();
  });

  it("远端 authorize 成功但本地阶段落盘失败时可按原批准恢复", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooragent-service-authorize-"));
    roots.push(root);
    const statePath = join(root, "migration-state.sqlite");
    const mock = createAuth();
    const firstStore = new SqliteMigrationRunStore(statePath);
    vi.spyOn(firstStore, "markAuthorized").mockImplementationOnce(() => {
      throw new Error("simulated local checkpoint failure");
    });
    const first = createService(mock.auth, firstStore);
    const plan = await first.plan(await first.inspect(SOURCE), POLICY);

    await expect(first.apply(plan, APPROVAL)).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    first.dispose();

    const second = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    await expect(second.apply(plan, APPROVAL)).resolves.toMatchObject({ status: "complete" });
    expect(mock.authorizeImportRun).toHaveBeenCalledTimes(2);
    expect(mock.applyUserImport).toHaveBeenCalledTimes(2);
    second.dispose();
  });

  it("报告落盘后 ack 中断可在重启后从原 sequence 继续", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooragent-service-ack-"));
    roots.push(root);
    const statePath = join(root, "migration-state.sqlite");
    const mock = createAuth();
    mock.failNextAck("event-2");
    const first = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    const plan = await first.plan(await first.inspect(SOURCE), POLICY);

    await expect(first.apply(plan, APPROVAL)).rejects.toMatchObject({ code: "RUN_BUSY" });
    first.dispose();
    mock.expireOutboxLeases();

    const second = createService(mock.auth, new SqliteMigrationRunStore(statePath));
    await expect(second.apply(plan, APPROVAL)).resolves.toMatchObject({ status: "complete" });
    expect(mock.applyUserImport).toHaveBeenCalledTimes(2);
    expect(mock.events.filter((event) => event === "ack:event-1")).toHaveLength(1);
    expect(mock.events.filter((event) => event === "ack:event-2")).toHaveLength(2);
    second.dispose();
  });

  it("远端 ack 成功但本地 checkpoint 失败时重启不重复投递", async () => {
    const root = mkdtempSync(join(tmpdir(), "dooragent-service-checkpoint-"));
    roots.push(root);
    const statePath = join(root, "migration-state.sqlite");
    const mock = createAuth();
    const delivered: string[] = [];
    const firstStore = new SqliteMigrationRunStore(statePath);
    vi.spyOn(firstStore, "markOutboxAcked").mockImplementationOnce(() => {
      throw new Error("simulated local checkpoint failure");
    });
    const deliver = async (event: { eventId: string }) => { delivered.push(event.eventId); };
    const first = createService(mock.auth, firstStore, deliver);
    const plan = await first.plan(await first.inspect(SOURCE), POLICY);

    await expect(first.apply(plan, APPROVAL)).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    first.dispose();
    mock.expireOutboxLeases();

    const second = createService(mock.auth, new SqliteMigrationRunStore(statePath), deliver);
    await expect(second.apply(plan, APPROVAL)).resolves.toMatchObject({ status: "complete" });
    expect(delivered.filter((eventId) => eventId === "event-1")).toHaveLength(1);
    expect(delivered.filter((eventId) => eventId === "event-2")).toHaveLength(1);
    expect(mock.events.filter((event) => event === "ack:event-1")).toHaveLength(1);
    second.dispose();
  });

  it("Cordis 管理事件投递成功后才 ack Auth outbox", async () => {
    const mock = createAuth();
    const delivered: string[] = [];
    const service = createService(mock.auth, undefined, async (event) => {
      delivered.push(event.eventId);
      mock.events.push(`deliver:${event.eventId}`);
    });
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    await service.apply(plan, APPROVAL);

    expect(delivered).toEqual(["event-1", "event-2"]);
    expect(mock.events.indexOf("deliver:event-1")).toBeLessThan(mock.events.indexOf("ack:event-1"));
    expect(mock.events.indexOf("deliver:event-2")).toBeLessThan(mock.events.indexOf("ack:event-2"));
  });

  it("在 Cordis 投递前写入可恢复的 SQLite receipt", async () => {
    const mock = createAuth();
    const store = new MemoryMigrationRunStore();
    const delivered: string[] = [];
    const service = createService(mock.auth, store, async (event) => {
      delivered.push(event.eventId);
      expect(store.loadUserResultReceipt(event.eventId)?.event.eventId).toBe(event.eventId);
    });
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    await service.apply(plan, APPROVAL);

    expect(delivered).toEqual(["event-1", "event-2"]);
  });

  it("Cordis 管理事件投递失败时保留 Auth outbox 未 ack", async () => {
    const mock = createAuth();
    const service = createService(mock.auth, undefined, async (event) => {
      if (event.eventId === "event-2") throw new Error("consumer unavailable");
    });
    const plan = await service.plan(await service.inspect(SOURCE), POLICY);

    await expect(service.apply(plan, APPROVAL)).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });

    expect(mock.events).toContain("ack:event-1");
    expect(mock.events).not.toContain("ack:event-2");
  });
});

function createAuth() {
  const events: string[] = [];
  const itemApprovals: string[] = [];
  let actions: NonNullable<Parameters<AuthCapability["authorizeImportRun"]>[0]["actions"]> = [];
  const outbox: Array<Awaited<ReturnType<AuthCapability["leaseImportOutbox"]>>[number]> = [];
  let actionsLeased = false;
  let outboxLeased = false;
  let failingAck: string | null = null;
  const acked = new Set<string>();
  let item = 0;
  const dryRunUserImport = vi.fn(async (input: Parameters<AuthCapability["dryRunUserImport"]>[0]) =>
    authPlan(input.candidate));
  const authorizeImportRun = vi.fn(async (input: Parameters<AuthCapability["authorizeImportRun"]>[0]) => {
    actions = structuredClone(input.actions ?? []);
    events.push(`authorize:${input.approvalRef}:${actions.length}`);
    return { authorized: true as const };
  });
  const leaseImportActions = vi.fn(async () => {
    events.push("lease-actions");
    if (actionsLeased) return [];
    actionsLeased = true;
    return actions.map((action) => ({
      ...action,
      leaseToken: `action-${action.sequence}`,
      leaseExpiresAt: "2026-08-24T07:00:00.000Z",
    }));
  });
  const issueImportApproval = vi.fn(async (input: Parameters<AuthCapability["issueImportApproval"]>[0]) => {
    if (input.operation === "apply-run") {
      events.push("issue:apply-run:manifest");
      return { approvalRef: "issued-run-approval", expiresAt: "2026-08-24T07:00:00.000Z" };
    }
    item += 1;
    const approvalRef = `item-${item}`;
    itemApprovals.push(approvalRef);
    events.push(`issue:${input.operation}:${input.source.sourceId}`);
    return { approvalRef, expiresAt: "2026-08-24T07:00:00.000Z" };
  });
  const applyUserImport = vi.fn(async (input: Parameters<AuthCapability["applyUserImport"]>[0]) => {
    const lease = input.actionLease;
    if (!lease) throw new AuthImportError("ACTION_LEASE_INVALID");
    const action = actions.find((candidate) => candidate.actionId === lease.actionId);
    if (!action || lease.leaseToken !== `action-${action.sequence}`) {
      throw new AuthImportError("ACTION_LEASE_INVALID");
    }
    events.push(`apply:${input.approvalRef}:${input.source.sourceId}:${lease.leaseToken}`);
    const result = input.candidate.role === "admin"
      ? { result: "migrated" as const, userId: "new-admin", mappingCreated: true }
      : { result: "merged" as const, userId: "existing-user", mappingCreated: true };
    outbox.push({
      eventId: `event-${action.sequence}`,
      actionId: action.actionId,
      sequence: action.sequence,
      result: {
        operation: "apply-user",
        result: result.result,
        targetUserId: result.userId,
        reasonCode: null,
      },
      occurredAt: `2026-08-24T07:00:0${action.sequence}.000Z`,
      leaseToken: `outbox-${action.sequence}`,
      leaseExpiresAt: "2026-08-24T07:00:00.000Z",
    });
    return result;
  });
  const syncCredential = vi.fn(async (input: Parameters<AuthCapability["syncCredential"]>[0]) => {
    events.push(`sync:${input.approvalRef}:${input.source.sourceId}`);
    return { result: "synced" as const, userId: input.targetUserId, revokedSessionCount: 1 };
  });
  const leaseImportOutbox = vi.fn(async () => {
    events.push("lease-outbox");
    if (outboxLeased) return [];
    outboxLeased = true;
    return structuredClone(outbox.filter((event) => !acked.has(event.eventId)));
  });
  const ackImportOutbox = vi.fn(async (input: Parameters<AuthCapability["ackImportOutbox"]>[0]) => {
    events.push(`ack:${input.eventId}`);
    if (failingAck === input.eventId) {
      failingAck = null;
      throw new AuthImportError("ACTION_LEASE_INVALID");
    }
    acked.add(input.eventId);
    return { acked: true as const };
  });
  const listImportOutboxReceipts = vi.fn(async (
    input: Parameters<AuthCapability["listImportOutboxReceipts"]>[0],
  ) => outbox.filter((event) => event.sequence > input.afterSequence).map((event) => ({
    eventId: event.eventId,
    actionId: event.actionId,
    sequence: event.sequence,
    result: structuredClone(event.result),
    occurredAt: event.occurredAt,
    acknowledgedAt: acked.has(event.eventId) ? "2026-08-24T07:10:00.000Z" : null,
  })));
  const reconcileImport = vi.fn(async () => ({ matched: 2, missing: 0, mismatched: 0 }));
  const rollbackImport = vi.fn(async (): Promise<Awaited<ReturnType<AuthCapability["rollbackImport"]>>> => ({ rolledBack: 2, retained: 0, rejected: 0 }));
  const auth = {
    inspectCredential: vi.fn(), resolveUser: vi.fn(), claimResource: vi.fn(),
    dryRunUserImport, applyUserImport, authorizeImportRun, leaseImportActions,
    leaseImportOutbox, listImportOutboxReceipts, ackImportOutbox, reconcileImport, rollbackImport,
    syncCredential,
    issueImportApproval, revokeImportApproval: vi.fn(async () => ({ revoked: true as const })),
  } as unknown as AuthCapability;
  return { auth, events, itemApprovals, dryRunUserImport, authorizeImportRun,
    issueImportApproval, applyUserImport, syncCredential, leaseImportActions, leaseImportOutbox,
    ackImportOutbox, reconcileImport, rollbackImport,
    failNextAck: (eventId: string) => { failingAck = eventId; },
    expireOutboxLeases: () => { outboxLeased = false; } };
}

function expectSensitiveValuesRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  expect(serialized).not.toMatch(/scrypt:[a-f0-9]{32}:[a-f0-9]{128}/i);
  expect(serialized).not.toContain("/srv/workspaces/");
}

function createService(
  auth: AuthCapability,
  stateStore: MemoryMigrationRunStore | SqliteMigrationRunStore | undefined = new MemoryMigrationRunStore(),
  deliverUserResult: (event: { eventId: string }) => Promise<void> = async () => undefined,
  actor: MigrationActor = ACTOR,
): DefaultDoorAgentMigrationService {
  return new DefaultDoorAgentMigrationService(auth, actor, {
    readSource: vi.fn(async () => makeLoaded()),
    stateStore: stateStore ?? new MemoryMigrationRunStore(),
    deliverUserResult,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function authPlan(candidate: Parameters<AuthCapability["dryRunUserImport"]>[0]["candidate"]): AuthUserImportPlan {
  const credential = candidate.passwordEncoded
    ? { action: "reuse" as const, algorithm: "scrypt" as const, profile: "dooragent-scrypt-v1" as const }
    : { action: "reset_required" as const, reason: "CREDENTIAL_MISSING" };
  const common = { credential, candidateDigest: digestCanonical(candidate) };
  return candidate.role === "admin"
    ? { ...common, decision: "create" }
    : { ...common, decision: "merge", targetUserId: "existing-user" };
}

function makeLoaded(): LoadedDoorAgentSource {
  const records = [record("admin-1", "admin", "b"), record("user-1", "user", "c")];
  const users = records.map(({ sourceId, sourceDigest, role, status }) => ({ sourceId, sourceDigest, role, status }));
  const content = {
    sourceSystem: "dooragent" as const,
    snapshotDigest: SNAPSHOT_DIGEST,
    manifestVersion: 4,
    counts: [{ sourceType: "user" as const, count: users.length }],
    users,
  };
  return { inventory: { ...content, inventoryDigest: digestCanonical(content) }, records };
}

function record(sourceId: string, role: "admin" | "user", digest: string): DoorAgentUserRecord {
  return {
    sourceId,
    sourceDigest: digest.repeat(64),
    email: `${sourceId}@example.invalid`,
    displayName: sourceId,
    role,
    status: "active",
    passwordEncoded: `scrypt:${"d".repeat(32)}:${"e".repeat(128)}`,
    workspaceRoot: `/srv/workspaces/${sourceId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastLoginAt: null,
    userGroup: "default",
  };
}
