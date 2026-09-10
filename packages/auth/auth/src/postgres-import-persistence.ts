import { createHash, randomUUID } from "node:crypto";

import { createPostgresMigrationDatabase, runMigrations } from "dsh-lark-postgres-runtime";
import { Pool, type QueryResultRow } from "pg";

import {
  AuthImportError,
  type AuthImportActionDefinition,
  type AuthImportActionLeaseBinding,
  type AuthImportActionResult,
  type AuthImportOutboxReceipt,
  type AuthImportSource,
  type AuthOperator,
  type AuthWriteContext,
} from "./capability.js";
import { hashOpaqueToken } from "./crypto.js";
import { AUTH_IMPORT_MIGRATIONS } from "./import-migrations.js";
import type {
  AuthApprovalBinding,
  PersistApprovalInput,
  PersistApprovalRevocationInput,
  PersistImportLeaseInput,
  PersistImportOutboxAckInput,
  PersistImportOutboxReceiptInput,
  PersistReconcileInput,
  PersistResourceClaimInput,
  PersistRunAuthorizationInput,
  PersistUserImportInput,
} from "./import-service.js";
import { throwIfAborted } from "./import-service.js";
import { AUTH_MIGRATIONS } from "./migrations.js";
import type {
  AuthImportPersistence,
  AuthImportReader,
  AuthImportTransaction,
  BoundImportAction,
  ImportOutboxRecord,
  ImportAuditRecord,
} from "./postgres-import-store.js";
import {
  mappingFromRow,
  resourceFromRow,
  userFromRow,
  type AuthImportMapping,
  type PersistedAuthUser,
  type PersistedResource,
} from "./postgres-import-rows.js";

const IMPORT_POOL_MAX_CONNECTIONS = 10;

interface ImportQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export class PgAuthImportPersistence implements AuthImportPersistence {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: IMPORT_POOL_MAX_CONNECTIONS });
  }

  async migrate(): Promise<void> {
    await runMigrations(
      createPostgresMigrationDatabase(this.pool),
      [...AUTH_MIGRATIONS, ...AUTH_IMPORT_MIGRATIONS],
    );
  }

  read<T>(run: (reader: AuthImportReader) => Promise<T>): Promise<T> {
    return run(new PgImportAccessor(this.pool));
  }

  async transaction<T>(
    run: (transaction: AuthImportTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(new PgImportAccessor(client));
      throwIfAborted(signal);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

class PgImportAccessor implements AuthImportTransaction {
  constructor(private readonly executor: ImportQueryExecutor) {}

  async assertOperator(operator: AuthOperator, now: string): Promise<void> {
    const result = await this.executor.query(
      `SELECT 1 FROM auth_sessions session
       JOIN auth_users users ON users.id = session.user_id
       WHERE session.id = $1 AND session.user_id = $2 AND session.revoked_at IS NULL
         AND session.expires_at > $3 AND users.status = 'active' AND users.role = 'admin'`,
      [operator.sessionId, operator.userId, now],
    );
    if (!result.rowCount) throw new AuthImportError("IMPORT_NOT_AUTHORIZED");
  }

  async consumeApproval(
    input: AuthWriteContext,
    approval: AuthApprovalBinding,
    now: string,
  ): Promise<void> {
    const result = await this.executor.query(
      `UPDATE auth_import_approvals SET consumed_at = $15
       WHERE approval_hash = $1 AND operator_user_id = $2 AND run_id = $3 AND plan_id = $4
         AND source_system = $5 AND source_type = $6 AND source_id = $7 AND source_digest = $8
         AND operator_session_id = $9 AND scope_digest = $10 AND operation = $11
         AND payload_digest = $12 AND snapshot_digest = $13 AND cutover_epoch_id = $14
         AND expires_at > $15 AND revoked_at IS NULL AND consumed_at IS NULL
       RETURNING 1`,
      [hashOpaqueToken(input.approvalRef), input.operator.userId, input.runId, input.planId,
        input.source.sourceSystem, input.source.sourceType, input.source.sourceId,
        input.source.sourceDigest, input.operator.sessionId, approval.scopeDigest,
        approval.operation, approval.payloadDigest, approval.snapshotDigest,
        approval.cutoverEpochId, now],
    );
    if (!result.rowCount) throw new AuthImportError("APPROVAL_INVALID");
  }

  async insertApproval(input: PersistApprovalInput, now: string): Promise<void> {
    const result = await this.executor.query(
      `INSERT INTO auth_import_approvals
       (approval_hash,operator_user_id,operator_session_id,run_id,plan_id,source_system,
        source_type,source_id,source_digest,scope_digest,operation,payload_digest,
        snapshot_digest,cutover_epoch_id,expires_at,revoked_at,consumed_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,NULL,$16)
       ON CONFLICT (approval_hash) DO NOTHING`,
      [input.approvalHash, input.operator.userId, input.operator.sessionId,
        input.runId, input.planId, input.source.sourceSystem, input.source.sourceType,
        input.source.sourceId, input.source.sourceDigest, input.scopeDigest, input.operation,
        input.payloadDigest, input.snapshotDigest, input.cutoverEpochId, input.expiresAt, now],
    );
    if (!result.rowCount) throw new AuthImportError("APPROVAL_INVALID");
  }

  async revokeApproval(input: PersistApprovalRevocationInput, now: string): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE auth_import_approvals SET revoked_at = $1
       WHERE approval_hash = $2 AND operator_user_id = $3 AND operator_session_id = $4
         AND run_id = $5 AND plan_id = $6 AND source_system = $7 AND source_type = $8
         AND source_id = $9 AND source_digest = $10 AND scope_digest = $11
         AND snapshot_digest = $12 AND expires_at > $13
         AND revoked_at IS NULL AND consumed_at IS NULL`,
      [now, input.approvalHash, input.operator.userId, input.operator.sessionId,
        input.runId, input.planId, input.source.sourceSystem, input.source.sourceType,
        input.source.sourceId, input.source.sourceDigest, input.scopeDigest,
        input.snapshotDigest, now],
    );
    return Boolean(result.rowCount);
  }

  async lockImportKey(key: string): Promise<void> {
    const encodedKey = createHash("sha256").update(key).digest("hex");
    await this.executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [encodedKey]);
  }

  async findMapping(source: AuthImportSource): Promise<AuthImportMapping | undefined> {
    const result = await this.executor.query<Row>(
      `SELECT * FROM auth_import_mappings
       WHERE source_system = $1 AND source_type = $2 AND source_id = $3`,
      [source.sourceSystem, source.sourceType, source.sourceId],
    );
    return result.rows[0] ? mappingFromRow(result.rows[0]) : undefined;
  }

  async findUserByEmail(email: string): Promise<PersistedAuthUser | undefined> {
    const result = await this.executor.query<Row>(
      "SELECT * FROM auth_users WHERE email_normalized = $1",
      [email],
    );
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async findUserById(userId: string): Promise<PersistedAuthUser | undefined> {
    const result = await this.executor.query<Row>("SELECT * FROM auth_users WHERE id = $1", [userId]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async lockUserById(userId: string): Promise<PersistedAuthUser | undefined> {
    const result = await this.executor.query<Row>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [userId]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async findResource(
    resourceType: "session" | "workspace",
    resourceId: string,
  ): Promise<PersistedResource | undefined> {
    const result = await this.executor.query<Row>(
      "SELECT resource_type, resource_id, user_id FROM auth_resources WHERE resource_type = $1 AND resource_id = $2",
      [resourceType, resourceId],
    );
    return result.rows[0] ? resourceFromRow(result.rows[0]) : undefined;
  }

  async listMappings(runId: string, planId: string, sourceSystem: string): Promise<AuthImportMapping[]> {
    const result = await this.executor.query<Row>(
      `SELECT * FROM auth_import_mappings
       WHERE run_id = $1 AND plan_id = $2 AND source_system = $3
       ORDER BY created_at, source_type, source_id`,
      [runId, planId, sourceSystem],
    );
    return result.rows.map(mappingFromRow);
  }

  async listRunActions(input: PersistReconcileInput): Promise<AuthImportActionDefinition[] | undefined> {
    const run = await this.executor.query(
      `SELECT 1 FROM auth_import_runs
       WHERE run_id = $1 AND plan_id = $2 AND source_system = $3
         AND manifest_source_id = $4 AND manifest_source_digest = $5
         AND snapshot_digest = $6 AND scope_digest = $7`,
      runBinding(input),
    );
    if (!run.rowCount) return undefined;
    const result = await this.executor.query<Row>(
      "SELECT * FROM auth_import_actions WHERE run_id = $1 ORDER BY sequence",
      [input.runId],
    );
    return result.rows.map(actionFromRow);
  }

  async insertRunActions(input: PersistRunAuthorizationInput, now: string): Promise<void> {
    await this.executor.query(
      `INSERT INTO auth_import_runs
       (run_id,plan_id,source_system,manifest_source_id,manifest_source_digest,snapshot_digest,
        plan_digest,actions_digest,cutover_epoch_id,scope_digest,operator_user_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [input.runId, input.planId, input.source.sourceSystem, input.source.sourceId,
        input.source.sourceDigest, input.snapshotDigest, input.planDigest,
        input.actionsDigest, input.cutoverEpochId, input.approval.scopeDigest,
        input.operator.userId, now],
    );
    for (const action of input.actions) await this.insertAction(input.runId, action, now);
  }

  async findImportRun(input: PersistRunAuthorizationInput): Promise<"missing" | "match" | "conflict"> {
    const exact = await this.executor.query(
      `SELECT 1 FROM auth_import_runs WHERE run_id = $1 AND plan_id = $2
       AND source_system = $3 AND manifest_source_id = $4 AND manifest_source_digest = $5
       AND snapshot_digest = $6 AND plan_digest = $7 AND actions_digest = $8
       AND cutover_epoch_id = $9 AND scope_digest = $10 AND operator_user_id = $11`,
      [input.runId, input.planId, input.source.sourceSystem, input.source.sourceId,
        input.source.sourceDigest, input.snapshotDigest, input.planDigest, input.actionsDigest,
        input.cutoverEpochId, input.approval.scopeDigest, input.operator.userId],
    );
    if (exact.rowCount) return "match";
    const legacy = await this.executor.query(
      `SELECT 1 FROM auth_import_runs WHERE run_id = $1 AND plan_id = $2
       AND source_system = $3 AND manifest_source_id = $4 AND manifest_source_digest = $5
       AND snapshot_digest = $6 AND plan_digest = $7 AND actions_digest = repeat('0', 64)
       AND cutover_epoch_id = $8 AND scope_digest = $9 AND operator_user_id = $10`,
      [input.runId, input.planId, input.source.sourceSystem, input.source.sourceId,
        input.source.sourceDigest, input.snapshotDigest, input.planDigest, input.cutoverEpochId,
        input.approval.scopeDigest, input.operator.userId],
    );
    if (legacy.rowCount) {
      const actions = await this.executor.query<Row>(
        "SELECT * FROM auth_import_actions WHERE run_id = $1 ORDER BY sequence",
        [input.runId],
      );
      if (JSON.stringify(actions.rows.map(actionFromRow)) !== JSON.stringify(input.actions)) return "conflict";
      const upgraded = await this.executor.query(
        `UPDATE auth_import_runs SET actions_digest = $2
         WHERE run_id = $1 AND actions_digest = repeat('0', 64)`,
        [input.runId, input.actionsDigest],
      );
      return upgraded.rowCount ? "match" : "conflict";
    }
    const existing = await this.executor.query("SELECT 1 FROM auth_import_runs WHERE run_id = $1", [input.runId]);
    return existing.rowCount ? "conflict" : "missing";
  }

  async listLeaseableActions(
    input: PersistImportLeaseInput,
    now: string,
  ): Promise<AuthImportActionDefinition[]> {
    const result = await this.executor.query<Row>(
      `SELECT actions.* FROM auth_import_actions actions
       JOIN auth_import_runs runs ON runs.run_id = actions.run_id
       WHERE ${runWhere("runs")}
         AND (actions.status = 'pending'
           OR (actions.status = 'leased' AND actions.lease_expires_at <= $9))
       ORDER BY actions.sequence LIMIT $10 FOR UPDATE OF actions SKIP LOCKED`,
      [...leaseBinding(input), now, input.limit],
    );
    return result.rows.map(actionFromRow);
  }

  async leaseImportAction(
    runId: string,
    actionId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void> {
    const result = await this.executor.query(
      `UPDATE auth_import_actions SET status = 'leased', lease_token_hash = $3,
       lease_expires_at = $4, attempts = attempts + 1 WHERE run_id = $1 AND action_id = $2`,
      [runId, actionId, tokenHash, expiresAt],
    );
    if (!result.rowCount) throw new AuthImportError("ACTION_LEASE_INVALID");
  }

  async bindImportAction(
    input: PersistUserImportInput | PersistResourceClaimInput,
    lease: AuthImportActionLeaseBinding,
    operation: "apply-user" | "claim-resource",
    payloadDigest: string,
    now: string,
  ): Promise<BoundImportAction> {
    const result = await this.executor.query<Row>(
      `SELECT actions.run_id, actions.action_id, actions.sequence FROM auth_import_actions actions
       JOIN auth_import_runs runs ON runs.run_id = actions.run_id
       WHERE runs.run_id = $1 AND runs.plan_id = $2 AND runs.source_system = $3
         AND runs.snapshot_digest = $4 AND runs.cutover_epoch_id = $5 AND runs.scope_digest = $6
         AND actions.action_id = $7 AND actions.operation = $8 AND actions.source_type = $9
         AND actions.source_id = $10 AND actions.source_digest = $11 AND actions.payload_digest = $12
         AND actions.status = 'leased' AND actions.lease_token_hash = $13
         AND actions.lease_expires_at > $14 FOR UPDATE OF actions`,
      [input.runId, input.planId, input.source.sourceSystem, input.snapshotDigest,
        input.cutoverEpochId, input.approval.scopeDigest, lease.actionId, operation,
        input.source.sourceType, input.source.sourceId, input.source.sourceDigest,
        payloadDigest, hashOpaqueToken(lease.leaseToken), now],
    );
    const row = result.rows[0];
    if (!row) throw new AuthImportError("ACTION_LEASE_INVALID");
    return { runId: text(row.run_id), actionId: text(row.action_id), sequence: integer(row.sequence) };
  }

  async completeImportAction(
    action: BoundImportAction,
    result: AuthImportActionResult,
    now: string,
  ): Promise<void> {
    const payload = JSON.stringify(result);
    const completed = await this.executor.query(
      `UPDATE auth_import_actions SET status = 'completed', result_json = $4::jsonb,
       completed_at = $5, lease_token_hash = NULL, lease_expires_at = NULL
      WHERE run_id = $1 AND action_id = $2 AND sequence = $3 AND status = 'leased'`,
      [action.runId, action.actionId, action.sequence, payload, now],
    );
    if (!completed.rowCount) throw new AuthImportError("ACTION_LEASE_INVALID");
    await this.executor.query(
      `INSERT INTO auth_import_outbox
       (event_id,run_id,action_id,sequence,result_json,created_at)
       SELECT $1,run_id,action_id,sequence,$2::jsonb,$3 FROM auth_import_actions
       WHERE run_id = $4 AND action_id = $5 AND sequence = $6`,
      [randomUUID(), payload, now, action.runId, action.actionId, action.sequence],
    );
  }

  async listLeaseableOutbox(input: PersistImportLeaseInput, now: string): Promise<ImportOutboxRecord[]> {
    const result = await this.executor.query<Row>(
      `SELECT outbox.* FROM auth_import_outbox outbox
       JOIN auth_import_runs runs ON runs.run_id = outbox.run_id
       WHERE ${runWhere("runs")} AND outbox.acked_at IS NULL
         AND (outbox.lease_token_hash IS NULL OR outbox.lease_expires_at <= $9)
       ORDER BY outbox.sequence LIMIT $10 FOR UPDATE OF outbox SKIP LOCKED`,
      [...leaseBinding(input), now, input.limit],
    );
    return result.rows.map(outboxFromRow);
  }

  async listOutboxReceipts(input: PersistImportOutboxReceiptInput): Promise<AuthImportOutboxReceipt[]> {
    const result = await this.executor.query<Row>(
      `SELECT outbox.* FROM auth_import_outbox outbox
       JOIN auth_import_runs runs ON runs.run_id = outbox.run_id
       WHERE ${runWhere("runs")} AND outbox.sequence > $9
       ORDER BY outbox.sequence LIMIT $10`,
      [...leaseBinding(input), input.afterSequence, input.limit],
    );
    return result.rows.map(outboxReceiptFromRow);
  }

  async leaseOutboxEvent(eventId: string, tokenHash: string, expiresAt: string): Promise<void> {
    const result = await this.executor.query(
      `UPDATE auth_import_outbox SET lease_token_hash = $2, lease_expires_at = $3,
       attempts = attempts + 1 WHERE event_id = $1 AND acked_at IS NULL`,
      [eventId, tokenHash, expiresAt],
    );
    if (!result.rowCount) throw new AuthImportError("ACTION_LEASE_INVALID");
  }

  async ackOutboxEvent(
    input: PersistImportOutboxAckInput,
    tokenHash: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE auth_import_outbox outbox SET acked_at = $10
       FROM auth_import_runs runs
       WHERE outbox.event_id = $9 AND outbox.run_id = runs.run_id AND ${runWhere("runs")}
         AND outbox.acked_at IS NULL AND outbox.lease_token_hash = $11
         AND outbox.lease_expires_at > $10`,
      [...leaseBinding(input), input.eventId, now, tokenHash],
    );
    return Boolean(result.rowCount);
  }

  private async insertAction(
    runId: string,
    action: AuthImportActionDefinition,
    now: string,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO auth_import_actions
       (run_id,action_id,sequence,operation,source_system,source_type,source_id,
        source_digest,payload_digest,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [runId, action.actionId, action.sequence, action.operation, action.source.sourceSystem,
        action.source.sourceType, action.source.sourceId, action.source.sourceDigest,
        action.payloadDigest, now],
    );
  }

  async createUser(candidate: Parameters<AuthImportTransaction["createUser"]>[0], now: string): Promise<PersistedAuthUser | undefined> {
    const result = await this.executor.query<Row>(
      `INSERT INTO auth_users
       (id,email_normalized,display_name,role,status,default_mode,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (email_normalized) DO NOTHING RETURNING *`,
      [randomUUID(), candidate.email, candidate.displayName, candidate.role,
        candidate.status, candidate.defaultMode, now],
    );
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async setPassword(userId: string, encoded: string, now: string): Promise<void> {
    await this.executor.query(
      `INSERT INTO auth_password_credentials (user_id,encoded,updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE
       SET encoded = EXCLUDED.encoded, updated_at = EXCLUDED.updated_at`,
      [userId, encoded, now],
    );
  }

  async getPassword(userId: string): Promise<{ encoded: string } | undefined> {
    const result = await this.executor.query<Row>(
      "SELECT encoded FROM auth_password_credentials WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const encoded = result.rows[0]?.encoded;
    return typeof encoded === "string" ? { encoded } : undefined;
  }

  async revokeUserSessions(userId: string, now: string): Promise<number> {
    const result = await this.executor.query(
      "UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
      [userId, now],
    );
    return result.rowCount ?? 0;
  }

  async createResource(
    resourceType: "session" | "workspace",
    resourceId: string,
    userId: string,
    resourcePath: string | null,
    now: string,
  ): Promise<boolean> {
    const result = await this.executor.query(
      `INSERT INTO auth_resources (resource_type,resource_id,user_id,resource_path,created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (resource_type,resource_id) DO NOTHING`,
      [resourceType, resourceId, userId, resourcePath, now],
    );
    return Boolean(result.rowCount);
  }

  async insertMapping(mapping: AuthImportMapping): Promise<void> {
    await this.executor.query(
      `INSERT INTO auth_import_mappings
       (source_system,source_type,source_id,source_digest,run_id,plan_id,target_type,target_id,
        target_user_id,result,reason_code,created_target,created_at,rolled_back_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [mapping.sourceSystem, mapping.sourceType, mapping.sourceId, mapping.sourceDigest,
        mapping.runId, mapping.planId, mapping.targetType, mapping.targetId, mapping.targetUserId,
        mapping.result, mapping.reasonCode, mapping.createdTarget, mapping.createdAt, mapping.rolledBackAt],
    );
  }

  async writeAudit(record: ImportAuditRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO auth_audit_log
       (action,user_id,request_id,ip_hash,user_agent_hash,metadata,created_at)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5)`,
      [record.action, record.userId, record.requestId, record.metadata, record.createdAt],
    );
  }
}

type Row = Record<string, unknown> & QueryResultRow;

function runBinding(input: PersistReconcileInput): unknown[] {
  return [input.runId, input.planId, input.source.sourceSystem, input.source.sourceId,
    input.source.sourceDigest, input.snapshotDigest, input.scopeDigest];
}

function leaseBinding(
  input: PersistImportLeaseInput | PersistImportOutboxAckInput | PersistImportOutboxReceiptInput,
): unknown[] {
  return [...runBinding(input), input.cutoverEpochId];
}

function runWhere(alias: string): string {
  return `${alias}.run_id = $1 AND ${alias}.plan_id = $2 AND ${alias}.source_system = $3
    AND ${alias}.manifest_source_id = $4 AND ${alias}.manifest_source_digest = $5
    AND ${alias}.snapshot_digest = $6 AND ${alias}.scope_digest = $7
    AND ${alias}.cutover_epoch_id = $8`;
}

function actionFromRow(row: Row): AuthImportActionDefinition {
  return {
    actionId: text(row.action_id),
    operation: row.operation === "claim-resource" ? "claim-resource" : "apply-user",
    sequence: integer(row.sequence),
    source: {
      sourceSystem: text(row.source_system),
      sourceType: text(row.source_type) as AuthImportSource["sourceType"],
      sourceId: text(row.source_id),
      sourceDigest: text(row.source_digest),
    },
    payloadDigest: text(row.payload_digest),
  };
}

function outboxFromRow(row: Row): ImportOutboxRecord {
  return {
    eventId: text(row.event_id),
    actionId: text(row.action_id),
    sequence: integer(row.sequence),
    result: actionResult(row.result_json),
    occurredAt: instant(row.created_at),
  };
}

function outboxReceiptFromRow(row: Row): AuthImportOutboxReceipt {
  return {
    ...outboxFromRow(row),
    acknowledgedAt: row.acked_at ? instant(row.acked_at) : null,
  };
}

function actionResult(value: unknown): AuthImportActionResult {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid auth import outbox result");
  const result = parsed as Record<string, unknown>;
  const targetUserId = nullableResultText(result.targetUserId);
  const reasonCode = nullableResultText(result.reasonCode);
  if (result.operation === "apply-user"
    && (result.result === "migrated" || result.result === "merged"
      || result.result === "rejected" || result.result === "reset_required")) {
    return { operation: "apply-user", result: result.result, targetUserId, reasonCode };
  }
  if (result.operation === "claim-resource"
    && (result.result === "claimed" || result.result === "unchanged" || result.result === "rejected")) {
    const targetResourceId = nullableResultText(result.targetResourceId);
    return { operation: "claim-resource", result: result.result, targetUserId, targetResourceId, reasonCode };
  }
  throw new Error("invalid auth import outbox result");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid auth import integer");
  return parsed;
}

function instant(value: unknown): string {
  return new Date(text(value)).toISOString();
}

function nullableResultText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("invalid auth import outbox text");
  return value;
}
