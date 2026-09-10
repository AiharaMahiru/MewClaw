import type { QueryResultRow } from "pg";

import type { StoredCommandResult } from "./command-journal.js";
import type {
  CanonicalUserQueryExecutor,
} from "./database.js";
import { sha256 } from "./internal.js";
import type {
  BindingId,
  CanonicalUserId,
  CanonicalUserOutboxEvent,
  IdentityNamespace,
  PrincipalId,
} from "./types.js";

export interface PrincipalRow extends QueryResultRow {
  principal_id: string;
  canonical_user_id: string | null;
  created_at: Date | string;
}

export interface BindingRow extends QueryResultRow {
  binding_id: string;
  tenant_id: string;
  bot_id: string;
  deployment_id: string;
  subject: string;
  principal_id: string;
  canonical_user_id: string | null;
  version: string | number;
  valid_from: Date | string;
  valid_to: Date | string | null;
  event_id: string;
}

export interface CommandRow extends QueryResultRow {
  event_id: string;
  command_digest: string;
  result_json: unknown;
}

export interface PrincipalInsertInput {
  principalId: PrincipalId;
  namespace: IdentityNamespace;
  canonicalUserId: CanonicalUserId | null;
  occurredAt: string;
}

export interface BindingInsertInput {
  bindingId: BindingId;
  namespace: IdentityNamespace;
  subject: string;
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  version: number;
  eventId: string;
  occurredAt: string;
}

export interface CommandInsertInput {
  eventId: string;
  digest: string;
  result: StoredCommandResult;
  completedAt: string;
}

const ACTIVE_BINDING_SQL = `SELECT * FROM canonical_user_bindings
  WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND provider = 'feishu'
    AND subject = $4 AND valid_to IS NULL FOR UPDATE`;

export async function lockEvent(executor: CanonicalUserQueryExecutor, eventId: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`canonical-user:event:${eventId}`]);
}

export async function lockIdentity(executor: CanonicalUserQueryExecutor, key: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`canonical-user:${sha256(key)}`]);
}

export async function findActive(
  executor: CanonicalUserQueryExecutor,
  namespace: IdentityNamespace,
  subject: string,
): Promise<BindingRow | undefined> {
  const result = await executor.query<BindingRow>(ACTIVE_BINDING_SQL, [...namespaceValues(namespace), subject]);
  return result.rows[0];
}

export async function findCommand(
  executor: CanonicalUserQueryExecutor,
  eventId: string,
): Promise<CommandRow | undefined> {
  const result = await executor.query<CommandRow>(
    "SELECT event_id, command_digest, result_json FROM canonical_user_commands WHERE event_id = $1",
    [eventId],
  );
  return result.rows[0];
}

export async function insertPrincipal(
  executor: CanonicalUserQueryExecutor,
  input: PrincipalInsertInput,
): Promise<void> {
  await executor.query(
    `INSERT INTO canonical_user_principals
     (principal_id, tenant_id, bot_id, deployment_id, kind, canonical_user_id, created_at, claimed_at)
     VALUES ($1,$2,$3,$4,'feishu-provisional',$5,$6,$7)`,
    [input.principalId, ...namespaceValues(input.namespace), input.canonicalUserId,
      input.occurredAt, input.canonicalUserId ? input.occurredAt : null],
  );
}

export async function insertBinding(
  executor: CanonicalUserQueryExecutor,
  input: BindingInsertInput,
): Promise<void> {
  await executor.query(
    `INSERT INTO canonical_user_bindings
     (binding_id, tenant_id, bot_id, deployment_id, provider, subject, principal_id, canonical_user_id, version, valid_from, valid_to, event_id)
     VALUES ($1,$2,$3,$4,'feishu',$5,$6,$7,$8,$9,NULL,$10)`,
    [input.bindingId, ...namespaceValues(input.namespace), input.subject, input.principalId,
      input.canonicalUserId, input.version, input.occurredAt, input.eventId],
  );
}

export async function insertOutbox(
  executor: CanonicalUserQueryExecutor,
  event: CanonicalUserOutboxEvent,
  digest: string,
): Promise<void> {
  await executor.query(
    `INSERT INTO canonical_user_outbox
     (event_id,event_type,outcome,command_digest,tenant_id,bot_id,deployment_id,binding_id,principal_id,canonical_user_id,binding_version,subject_digest,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [event.eventId, event.eventType, event.outcome, digest, ...namespaceValues(event.namespace),
      event.bindingId, event.principalId, event.canonicalUserId, event.bindingVersion, event.subjectDigest, event.occurredAt],
  );
}

export async function insertCommand(
  executor: CanonicalUserQueryExecutor,
  input: CommandInsertInput,
): Promise<void> {
  await executor.query(
    `INSERT INTO canonical_user_commands (event_id,command_digest,result_json,completed_at)
     VALUES ($1,$2,$3::jsonb,$4)`,
    [input.eventId, input.digest, JSON.stringify(input.result), input.completedAt],
  );
}

export function namespaceValues(namespace: IdentityNamespace): string[] {
  return [namespace.tenantId, namespace.botId, namespace.deploymentId];
}

export function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("canonical-user: PostgreSQL returned invalid version");
  return parsed;
}

export function precedes(occurredAt: string, validFrom: Date | string): boolean {
  const boundary = new Date(validFrom).getTime();
  if (!Number.isFinite(boundary)) throw new Error("invalid PostgreSQL interval timestamp");
  return new Date(occurredAt).getTime() < boundary;
}
