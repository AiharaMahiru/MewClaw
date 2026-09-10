import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresMigrationDatabase, runMigrations } from "dsh-lark-postgres-runtime";

import type { AuthImportContext, AuthImportRunAuthorizeInput } from "./capability.js";
import { hashOpaqueToken } from "./crypto.js";
import { DefaultAuthCapability } from "./import-service.js";
import { AUTH_IMPORT_MIGRATIONS } from "./import-migrations.js";
import { AUTH_MIGRATIONS } from "./migrations.js";
import { PgAuthImportPersistence, PostgresAuthImportStore } from "./postgres-import-store.js";

const databaseUrl = process.env.DSH_AUTH_POSTGRES_TEST_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const NOW = "2026-08-24T00:00:00.000Z";
const AFTER_LEASE_EXPIRY = "2026-08-24T00:02:00.000Z";
const DIGEST = "a".repeat(64);
const PLAN_DIGEST = "d".repeat(64);

describePostgres("PostgreSQL auth import approval transactions", () => {
  const schema = `auth_import_race_${randomUUID().replaceAll("-", "")}`;
  const adminUserId = randomUUID();
  const adminSessionId = randomUUID();
  let control: Pool;
  let database: Pool;
  let persistence: PgAuthImportPersistence;
  let capability: DefaultAuthCapability;
  let schemaCreated = false;
  let approvalSequence = 0;

  beforeAll(async () => {
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scopedUrl = scopedDatabaseUrl(databaseUrl!, schema);
    database = new Pool({ connectionString: scopedUrl });
    persistence = new PgAuthImportPersistence(scopedUrl);
    await persistence.migrate();
    await insertAdmin(database, adminUserId, adminSessionId);
    capability = new DefaultAuthCapability(new PostgresAuthImportStore(persistence), {
      approvalTtlMs: 60_000,
      createApprovalRef: () => `approval-${++approvalSequence}`,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await persistence?.close();
    await database?.end();
    if (schemaCreated) await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control?.end();
  });

  it("allows revoke and apply-run to commit at most one result", async () => {
    const context = runContext(adminUserId, adminSessionId, "race");
    const issued = await capability.issueImportApproval({
      ...context,
      operation: "apply-run",
      planDigest: PLAN_DIGEST,
      actions: [],
      cutoverEpochId: "cutover-race",
    });
    const authorization = runAuthorization(context, issued.approvalRef, "cutover-race");

    const results = await Promise.allSettled([
      capability.authorizeImportRun(authorization),
      capability.revokeImportApproval({ ...context, approvalRef: issued.approvalRef }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "APPROVAL_INVALID" });
    await expectApprovalHasOneTerminalState(database, issued.approvalRef);
  });

  it("rolls failed audit back and makes the committed run authorization idempotent", async () => {
    const context = runContext(adminUserId, adminSessionId, "rollback");
    const issued = await capability.issueImportApproval({
      ...context,
      operation: "apply-run",
      planDigest: PLAN_DIGEST,
      actions: [],
      cutoverEpochId: "cutover-rollback",
    });
    const authorization = runAuthorization(context, issued.approvalRef, "cutover-rollback");
    const removeFault = await installAuditFailure(database);

    try {
      await expect(capability.authorizeImportRun(authorization))
        .rejects.toThrow("forced import audit failure");
    } finally {
      await removeFault();
    }

    await expect(capability.authorizeImportRun(authorization))
      .resolves.toEqual({ authorized: true });
    await expect(capability.authorizeImportRun(authorization))
      .resolves.toEqual({ authorized: true });
    const audit = await database.query<{ count: string }>(
      "SELECT count(*) FROM auth_audit_log WHERE action = 'auth.import.run-authorized' AND request_id = $1",
      [context.operator.requestId],
    );
    expect(audit.rows[0]?.count).toBe("1");
    await expectApprovalHasOneTerminalState(database, issued.approvalRef);
  });

  it("rejects an idempotent run replay when its durable binding drifts", async () => {
    const context = runContext(adminUserId, adminSessionId, "binding-drift");
    const actions = [{
      actionId: "3".repeat(64),
      operation: "apply-user" as const,
      sequence: 1,
      source: userImportContext(context, "binding-drift").source,
      payloadDigest: "4".repeat(64),
    }];
    const issued = await capability.issueImportApproval({
      ...context,
      operation: "apply-run",
      planDigest: PLAN_DIGEST,
      actions,
      cutoverEpochId: "cutover-binding-drift",
    });
    const authorization = {
      ...runAuthorization(context, issued.approvalRef, "cutover-binding-drift"),
      actions,
    };
    await expect(capability.authorizeImportRun({
      ...authorization,
      actions: [{ ...actions[0]!, payloadDigest: "5".repeat(64) }],
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await capability.authorizeImportRun(authorization);

    await expect(capability.authorizeImportRun({
      ...authorization,
      actions: [{ ...authorization.actions[0]!, payloadDigest: "5".repeat(64) }],
    })).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    await expect(capability.authorizeImportRun({
      ...authorization,
      cutoverEpochId: "cutover-binding-drift-changed",
    })).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
  });

  it("reconciles all persisted mappings when the migration source is a manifest", async () => {
    const manifestContext = runContext(adminUserId, adminSessionId, "manifest-reconcile");
    const userContext: AuthImportContext = {
      ...manifestContext,
      source: {
        sourceSystem: "dooragent",
        sourceType: "user",
        sourceId: "source-user-reconcile",
        sourceDigest: DIGEST,
      },
    };
    const candidate = {
      email: "manifest-reconcile@example.com",
      displayName: "Manifest Reconcile",
      role: "user" as const,
      defaultMode: "lightweight" as const,
      status: "active" as const,
    };
    const plan = await capability.dryRunUserImport({ ...userContext, candidate });
    const actions = [{
      actionId: "2".repeat(64),
      operation: "apply-user" as const,
      sequence: 1,
      source: userContext.source,
      payloadDigest: plan.candidateDigest,
    }];
    const runApproval = await capability.issueImportApproval({
      ...manifestContext,
      operation: "apply-run",
      planDigest: PLAN_DIGEST,
      actions,
      cutoverEpochId: "cutover-manifest-reconcile",
    });
    await capability.authorizeImportRun({
      ...runAuthorization(manifestContext, runApproval.approvalRef, "cutover-manifest-reconcile"),
      actions,
    });
    await expect(capability.reconcileImport(manifestContext))
      .resolves.toEqual({ matched: 0, missing: 1, mismatched: 0 });
    const [lease] = await capability.leaseImportActions({
      ...manifestContext,
      cutoverEpochId: "cutover-manifest-reconcile",
      limit: 10,
      leaseMs: 60_000,
    });
    const approval = await capability.issueImportApproval({
      ...userContext,
      operation: "apply-user",
      candidateDigest: plan.candidateDigest,
      cutoverEpochId: "cutover-manifest-reconcile",
    });
    await capability.applyUserImport({
      ...userContext,
      candidate,
      approvalRef: approval.approvalRef,
      cutoverEpochId: "cutover-manifest-reconcile",
      actionLease: {
        actionId: lease!.actionId,
        leaseToken: lease!.leaseToken,
        payloadDigest: lease!.payloadDigest,
      },
    });

    await expect(capability.reconcileImport(manifestContext))
      .resolves.toEqual({ matched: 1, missing: 0, mismatched: 0 });
  });

  it("persists leased import actions and their result outbox atomically", async () => {
    const manifestContext = runContext(adminUserId, adminSessionId, "action-outbox");
    const userContext = userImportContext(manifestContext, "action-outbox");
    const candidate = userCandidate("action-outbox@example.com");
    const plan = await capability.dryRunUserImport({ ...userContext, candidate });
    const actions = [{
      actionId: "1".repeat(64),
      operation: "apply-user" as const,
      sequence: 1,
      source: userContext.source,
      payloadDigest: plan.candidateDigest,
    }];
    const runApproval = await capability.issueImportApproval({
      ...manifestContext,
      operation: "apply-run",
      planDigest: PLAN_DIGEST,
      actions,
      cutoverEpochId: "cutover-action-outbox",
    });
    const authorization = {
      ...runAuthorization(manifestContext, runApproval.approvalRef, "cutover-action-outbox"),
      actions,
    };
    await capability.authorizeImportRun(authorization);
    await expect(capability.authorizeImportRun(authorization))
      .resolves.toEqual({ authorized: true });

    const [lease] = await capability.leaseImportActions({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    });
    expect(lease).toMatchObject({ actionId: "1".repeat(64), operation: "apply-user", sequence: 1 });
    const itemApproval = await capability.issueImportApproval({
      ...userContext,
      operation: "apply-user",
      candidateDigest: plan.candidateDigest,
      cutoverEpochId: "cutover-action-outbox",
    });
    const removeFault = await installAuditFailure(database, "auth.import.user");
    try {
      await expect(capability.applyUserImport({
        ...userContext,
        candidate,
        approvalRef: itemApproval.approvalRef,
        cutoverEpochId: "cutover-action-outbox",
        actionLease: {
          actionId: lease!.actionId,
          leaseToken: lease!.leaseToken,
          payloadDigest: lease!.payloadDigest,
        },
      })).rejects.toThrow("forced import audit failure");
    } finally {
      await removeFault();
    }
    expect(await capability.leaseImportOutbox({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    })).toEqual([]);

    const resumed = new DefaultAuthCapability(new PostgresAuthImportStore(persistence), {
      now: () => AFTER_LEASE_EXPIRY,
    });
    const [resumedLease] = await resumed.leaseImportActions({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    });
    const resumedApproval = await resumed.issueImportApproval({
      ...userContext,
      operation: "apply-user",
      candidateDigest: plan.candidateDigest,
      cutoverEpochId: "cutover-action-outbox",
    });
    await resumed.applyUserImport({
      ...userContext,
      candidate,
      approvalRef: resumedApproval.approvalRef,
      cutoverEpochId: "cutover-action-outbox",
      actionLease: {
        actionId: resumedLease!.actionId,
        leaseToken: resumedLease!.leaseToken,
        payloadDigest: resumedLease!.payloadDigest,
      },
    });

    expect(await resumed.leaseImportActions({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    }))
      .toEqual([]);
    const [event] = await resumed.leaseImportOutbox({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    });
    expect(event).toMatchObject({
      actionId: "1".repeat(64),
      sequence: 1,
      result: { operation: "apply-user", result: "reset_required" },
      occurredAt: AFTER_LEASE_EXPIRY,
    });
    await resumed.ackImportOutbox({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      eventId: event!.eventId,
      leaseToken: event!.leaseToken,
    });
    await expect(resumed.listImportOutboxReceipts({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      afterSequence: 0,
      limit: 10,
    })).resolves.toEqual([{
      eventId: event!.eventId,
      actionId: event!.actionId,
      sequence: 1,
      result: event!.result,
      occurredAt: AFTER_LEASE_EXPIRY,
      acknowledgedAt: AFTER_LEASE_EXPIRY,
    }]);
    expect(await resumed.leaseImportOutbox({
      ...manifestContext,
      cutoverEpochId: "cutover-action-outbox",
      limit: 10,
      leaseMs: 60_000,
    }))
      .toEqual([]);
  });
});

describePostgres("PostgreSQL auth import schema upgrades", () => {
  it("adds credential approval and action binding after already-applied migrations", async () => {
    const schema = `auth_import_upgrade_${randomUUID().replaceAll("-", "")}`;
    const control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = scopedDatabaseUrl(databaseUrl!, schema);
    const database = new Pool({ connectionString: scopedUrl });
    let persistence: PgAuthImportPersistence | undefined;
    try {
      await runMigrations(createPostgresMigrationDatabase(database), [
        ...AUTH_MIGRATIONS,
        ...AUTH_IMPORT_MIGRATIONS.slice(0, -1),
      ]);
      const before = await database.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'auth_import_runs' AND column_name = 'actions_digest'",
      );
      expect(before.rowCount).toBe(0);
      const adminUserId = randomUUID();
      const adminSessionId = randomUUID();
      const context = runContext(adminUserId, adminSessionId, "legacy-upgrade");
      const actions = [{
        actionId: "6".repeat(64),
        operation: "apply-user" as const,
        sequence: 1,
        source: userImportContext(context, "legacy-upgrade").source,
        payloadDigest: "7".repeat(64),
      }];
      await insertAdmin(database, adminUserId, adminSessionId);
      await insertLegacyRun(database, context, actions[0]!);

      persistence = new PgAuthImportPersistence(scopedUrl);
      await persistence.migrate();
      const after = await database.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'auth_import_runs' AND column_name = 'actions_digest'",
      );
      expect(after.rows).toEqual([{ is_nullable: "NO" }]);
      const operationConstraint = await database.query<{ definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'auth_import_approvals'::regclass
          AND conname = 'auth_import_approvals_operation_check'
      `);
      expect(operationConstraint.rows[0]?.definition).toContain("sync-credential");
      const capability = new DefaultAuthCapability(new PostgresAuthImportStore(persistence), { now: () => NOW });
      const replay = {
        ...runAuthorization(context, "already-consumed", "cutover-legacy-upgrade"),
        actions,
      };
      await expect(capability.authorizeImportRun({
        ...replay,
        actions: [{ ...actions[0]!, payloadDigest: "8".repeat(64) }],
      })).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
      await expect(capability.authorizeImportRun(replay)).resolves.toEqual({ authorized: true });
      const upgraded = await database.query<{ actions_digest: string }>(
        "SELECT actions_digest FROM auth_import_runs WHERE run_id = $1",
        [context.runId],
      );
      expect(upgraded.rows[0]?.actions_digest).not.toBe("0".repeat(64));
    } finally {
      await persistence?.close();
      await database.end();
      await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await control.end();
    }
  });
});

function runContext(userId: string, sessionId: string, suffix: string): AuthImportContext {
  return {
    scope: {
      tenantId: "tenant" as never,
      botId: "bot" as never,
      deploymentId: "deployment" as never,
      userId: userId as never,
      conversationId: "migration" as never,
    },
    operator: { userId, sessionId, requestId: `request-${suffix}` },
    runId: `run-${suffix}`,
    planId: `plan-${suffix}`,
    snapshotDigest: DIGEST,
    source: {
      sourceSystem: "dooragent",
      sourceType: "manifest",
      sourceId: `manifest-${suffix}`,
      sourceDigest: DIGEST,
    },
  };
}

function runAuthorization(
  context: AuthImportContext,
  approvalRef: string,
  cutoverEpochId: string,
): AuthImportRunAuthorizeInput {
  return { ...context, approvalRef, cutoverEpochId, planDigest: PLAN_DIGEST, actions: [] };
}

function userImportContext(context: AuthImportContext, suffix: string): AuthImportContext {
  return {
    ...context,
    source: {
      sourceSystem: "dooragent",
      sourceType: "user",
      sourceId: `source-user-${suffix}`,
      sourceDigest: DIGEST,
    },
  };
}

function userCandidate(email: string) {
  return {
    email,
    displayName: "Import Action User",
    role: "user" as const,
    defaultMode: "lightweight" as const,
    status: "active" as const,
  };
}

async function insertAdmin(database: Pool, userId: string, sessionId: string): Promise<void> {
  await database.query(
    `INSERT INTO auth_users
     (id,email_normalized,display_name,role,status,default_mode,created_at,updated_at)
     VALUES ($1,$2,'Migration Admin','admin','active','full',$3,$3)`,
    [userId, `migration-${userId}@example.com`, NOW],
  );
  await database.query(
    `INSERT INTO auth_sessions
     (id,user_id,token_hash,created_at,expires_at,last_seen_at,revoked_at,ip_hash,user_agent_hash)
     VALUES ($1,$2,$3,$4,'2026-08-25T00:00:00.000Z',$4,NULL,NULL,NULL)`,
    [sessionId, userId, "f".repeat(64), NOW],
  );
}

async function insertLegacyRun(
  database: Pool,
  context: AuthImportContext,
  action: AuthImportRunAuthorizeInput["actions"][number],
): Promise<void> {
  const scopeDigest = createHash("sha256").update(JSON.stringify(Object.values(context.scope))).digest("hex");
  await database.query(
    `INSERT INTO auth_import_runs
     (run_id,plan_id,source_system,manifest_source_id,manifest_source_digest,snapshot_digest,
      plan_digest,cutover_epoch_id,scope_digest,operator_user_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [context.runId, context.planId, context.source.sourceSystem, context.source.sourceId,
      context.source.sourceDigest, context.snapshotDigest, PLAN_DIGEST, "cutover-legacy-upgrade",
      scopeDigest, context.operator.userId, NOW],
  );
  await database.query(
    `INSERT INTO auth_import_actions
     (run_id,action_id,sequence,operation,source_system,source_type,source_id,source_digest,payload_digest,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [context.runId, action.actionId, action.sequence, action.operation, action.source.sourceSystem,
      action.source.sourceType, action.source.sourceId, action.source.sourceDigest, action.payloadDigest, NOW],
  );
}

async function expectApprovalHasOneTerminalState(database: Pool, approvalRef: string): Promise<void> {
  const result = await database.query<{ consumed_at: Date | null; revoked_at: Date | null }>(
    "SELECT consumed_at, revoked_at FROM auth_import_approvals WHERE approval_hash = $1",
    [hashOpaqueToken(approvalRef)],
  );
  const row = result.rows[0];
  expect(row).toBeTruthy();
  expect(Number(row?.consumed_at !== null) + Number(row?.revoked_at !== null)).toBe(1);
}

async function installAuditFailure(
  database: Pool,
  action = "auth.import.run-authorized",
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `fail_import_audit_${suffix}`;
  const triggerName = `fail_import_audit_insert_${suffix}`;
  await database.query(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'forced import audit failure'; END IF; RETURN NEW; END $$`);
  await database.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON auth_audit_log FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
  return async () => {
    await database.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON auth_audit_log`);
    await database.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  };
}

function scopedDatabaseUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}
