import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import { readBoundedSourceFile, type ReadSourceFile } from "./source-files.js";
import type { DoorAgentRole, DoorAgentStatus, DoorAgentUserRecord } from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PASSWORD = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DATABASE_BYTES = 536_870_912;
const EXPECTED_USERS = 16;
const EXPECTED_ADMINS = 3;
const TABLES = [
  "billing_accounts", "billing_ledger", "billing_recharge_requests",
  "billing_usage_snapshots", "email_verification_codes", "runtime_invalidation_outbox_entries",
  "runtime_invalidation_outbox_meta", "sessions", "upload_storage_reservations",
  "user_preferences", "users",
] as const;
const USER_COLUMNS = [
  ["id", "TEXT", 0, 1], ["email", "TEXT", 1, 0], ["name", "TEXT", 1, 0],
  ["password_hash", "TEXT", 1, 0], ["role", "TEXT", 1, 0], ["status", "TEXT", 1, 0],
  ["workspace_root", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0], ["last_login_at", "TEXT", 0, 0],
  ["user_group", "TEXT", 1, 0],
] as const;

export async function readAuthUsers(
  root: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DoorAgentUserRecord[]> {
  validateAuthManifest(manifest);
  const snapshot = manifest.snapshot as Record<string, unknown>;
  const file = await readBoundedSourceFile(root, snapshot.relative_path as string, MAX_DATABASE_BYTES, signal);
  verifySnapshotFile(file, snapshot);
  return readAndVerifyDatabase(file.buffer, manifest, signal);
}

function validateAuthManifest(value: Record<string, unknown>): void {
  if (value.kind !== "dooragent-auth-rehearsal-snapshot"
    || value.manifest_version !== 1
    || value.backup_method !== "sqlite3.Connection.backup") invalid();
  if (!isIso(value.created_at_utc) || !isIso(value.completed_at_utc)) invalid();
  if (typeof value.source_boot_id !== "string" || !BOOT_ID.test(value.source_boot_id)) invalid();
  if (typeof value.source_commit !== "string" || !SOURCE_COMMIT.test(value.source_commit)) invalid();
  if (typeof value.sqlite_version !== "string" || !value.sqlite_version) invalid();
  if (!SHA256_HEX.test(text(value.schema_sha256)) || !safeInteger(value.sqlite_user_version)) invalid();
  validateSnapshot(value.snapshot);
  validateTableCounts(value.table_counts);
}

function validateSnapshot(value: unknown): void {
  if (!isRecord(value)) invalid();
  if (value.relative_path !== "auth/users.sqlite" || value.quick_check !== "ok") invalid();
  if (String(value.journal_mode).toLowerCase() !== "delete") invalid();
  if (!SHA256_HEX.test(text(value.sha256)) || !positiveInteger(value.size_bytes)) invalid();
}

function validateTableCounts(value: unknown): void {
  if (!isRecord(value) || !sameKeys(value, TABLES)) invalid();
  for (const table of TABLES) {
    if (!IDENTIFIER.test(table) || !safeInteger(value[table]) || Number(value[table]) < 0) invalid();
  }
  if (value.users !== EXPECTED_USERS) invalid();
}

function verifySnapshotFile(file: ReadSourceFile, snapshot: Record<string, unknown>): void {
  if (file.digest !== snapshot.sha256 || file.buffer.byteLength !== snapshot.size_bytes) invalid();
}

async function readAndVerifyDatabase(
  bytes: Buffer,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DoorAgentUserRecord[]> {
  throwIfAborted(signal);
  const directory = await mkdtemp(join(tmpdir(), "dsh-dooragent-auth-"));
  const path = join(directory, "verified.sqlite");
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    return queryVerifiedDatabase(path, manifest, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function queryVerifiedDatabase(
  path: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): DoorAgentUserRecord[] {
  const database = new DatabaseSync(path, { readOnly: true, returnArrays: true });
  try {
    verifyDatabaseMetadata(database, manifest);
    const records = readUserRows(database);
    validateUserSet(records);
    throwIfAborted(signal);
    return records;
  } finally {
    database.close();
  }
}

function verifyDatabaseMetadata(database: DatabaseSync, manifest: Record<string, unknown>): void {
  if (scalar(database, "PRAGMA quick_check") !== "ok") invalid();
  if (String(scalar(database, "PRAGMA journal_mode")).toLowerCase() !== "delete") invalid();
  if (Number(scalar(database, "PRAGMA user_version")) !== manifest.sqlite_user_version) invalid();
  if (schemaDigest(database) !== manifest.schema_sha256) invalid();
  if (!sameUserColumns(arrayRows(database.prepare("PRAGMA table_info(users)").all()))) invalid();
  verifyCounts(database, manifest.table_counts as Record<string, unknown>);
}

function schemaDigest(database: DatabaseSync): string {
  const rows = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  ).all();
  return createHash("sha256").update(asciiJson(rows), "utf8").digest("hex");
}

function verifyCounts(database: DatabaseSync, expected: Record<string, unknown>): void {
  for (const table of TABLES) {
    const actual = Number(scalar(database, `SELECT COUNT(*) FROM "${table}"`));
    if (actual !== expected[table]) invalid();
  }
}

function sameUserColumns(rows: unknown[][]): boolean {
  if (rows.length !== USER_COLUMNS.length) return false;
  return rows.every((row, index) => {
    const expected = USER_COLUMNS[index];
    return expected !== undefined && row[1] === expected[0] && row[2] === expected[1]
      && row[3] === expected[2] && row[5] === expected[3];
  });
}

function readUserRows(database: DatabaseSync): DoorAgentUserRecord[] {
  const rows = arrayRows(database.prepare(`
    SELECT id, email, name, password_hash, role, status, workspace_root,
           created_at, updated_at, last_login_at, user_group
    FROM users ORDER BY id
  `).all());
  return rows.map(toUserRecord);
}

function toUserRecord(row: unknown[]): DoorAgentUserRecord {
  if (row.length !== 11 || row.some((value, index) => index !== 9 && typeof value !== "string")) invalid();
  const [sourceId, rawEmail, displayName, passwordEncoded, role, status, workspaceRoot,
    createdAt, updatedAt, lastLoginAt, userGroup] = row as [string, string, string, string, string,
      string, string, string, string, string | null, string];
  if (!isRole(role) || !isStatus(status)) invalid();
  const email = rawEmail.trim().toLowerCase();
  validateUserFields({ sourceId, email, displayName, passwordEncoded, role, status, workspaceRoot,
    createdAt, updatedAt, lastLoginAt, userGroup });
  const publicFields = { sourceId, role, status };
  return { ...publicFields, sourceDigest: digestCanonical(row), email, displayName, passwordEncoded,
    workspaceRoot, createdAt, updatedAt, lastLoginAt, userGroup };
}

function validateUserFields(user: Omit<DoorAgentUserRecord, "sourceDigest">): void {
  if (!bounded(user.sourceId, 256) || !bounded(user.email, 320) || !user.email.includes("@")) invalid();
  if (!bounded(user.displayName.trim(), 120) || !PASSWORD.test(user.passwordEncoded)) invalid();
  if (user.role !== "admin" && user.role !== "user") invalid();
  if (user.status !== "active") invalid();
  if (!bounded(user.workspaceRoot, 4096) || !bounded(user.userGroup, 256)) invalid();
  if (!isIso(user.createdAt) || !isIso(user.updatedAt) || (user.lastLoginAt !== null && !isIso(user.lastLoginAt))) invalid();
}

function validateUserSet(records: DoorAgentUserRecord[]): void {
  if (records.length !== EXPECTED_USERS) invalid();
  if (records.filter((record) => record.role === "admin").length !== EXPECTED_ADMINS) invalid();
  for (const key of ["sourceId", "email", "workspaceRoot"] as const) {
    if (new Set(records.map((record) => record[key])).size !== records.length) invalid();
  }
}

function scalar(database: DatabaseSync, sql: string): unknown {
  const row: unknown = database.prepare(sql).get();
  if (!Array.isArray(row) || row.length !== 1) invalid();
  return row[0];
}

function arrayRows(value: unknown): unknown[][] {
  if (!Array.isArray(value) || value.some((row) => !Array.isArray(row))) invalid();
  return value;
}

function isRole(value: string): value is DoorAgentRole {
  return value === "admin" || value === "user";
}

function isStatus(value: string): value is DoorAgentStatus {
  return value === "active" || value === "disabled";
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function positiveInteger(value: unknown): boolean {
  return safeInteger(value) && Number(value) > 0;
}

function bounded(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new DoorAgentMigrationError("SOURCE_DIGEST_MISMATCH");
}
