import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DoorAgentMigrationError } from "./errors.js";
import { createUserResultReceiptSchema } from "./migration-user-result-receipt.js";

const BUSY_TIMEOUT_MS = 5_000;
const STATE_SCHEMA_VERSION = 6;

export function openMigrationStateDatabase(input: string): DatabaseSync {
  const database = new DatabaseSync(secureStatePath(input));
  configureDatabase(database);
  migrateDatabase(database);
  return database;
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateDatabase(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as { user_version?: unknown };
  if (!Number.isSafeInteger(version.user_version)
    || Number(version.user_version) > STATE_SCHEMA_VERSION) invalid();
  database.exec("BEGIN IMMEDIATE");
  try {
    createRunTable(database);
    migrateRunColumns(database, Number(version.user_version));
    createUserResultReceiptSchema(database);
    database.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始失败。 */ }
    throw error;
  }
}

function createRunTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migration_runs (
      state_key TEXT PRIMARY KEY,
      run_id TEXT UNIQUE NOT NULL,
      actor_digest TEXT NOT NULL,
      source_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('planned','authorized','complete','rolled-back')),
      cutover_epoch_id TEXT,
      report_json TEXT,
      rollback_json TEXT,
      workspace_rollback_json TEXT,
      credential_sync_json TEXT,
      outbox_acked_sequence INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      lease_fence INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
}

function migrateRunColumns(database: DatabaseSync, version: number): void {
  if (version === 1) {
    database.exec("ALTER TABLE migration_runs ADD COLUMN outbox_acked_sequence INTEGER NOT NULL DEFAULT 0");
  }
  if (version === 1 || version === 2) {
    database.exec("ALTER TABLE migration_runs ADD COLUMN lease_fence INTEGER NOT NULL DEFAULT 0");
  }
  if (version < STATE_SCHEMA_VERSION && !hasColumn(database, "workspace_rollback_json")) {
    database.exec("ALTER TABLE migration_runs ADD COLUMN workspace_rollback_json TEXT");
  }
  if (version < STATE_SCHEMA_VERSION && !hasColumn(database, "credential_sync_json")) {
    database.exec("ALTER TABLE migration_runs ADD COLUMN credential_sync_json TEXT");
  }
}

function hasColumn(database: DatabaseSync, name: string): boolean {
  const rows = database.prepare("PRAGMA table_info(migration_runs)").all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === name);
}

function secureStatePath(input: string): string {
  if (!isAbsolute(input)) invalid();
  const path = resolve(input);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || resolve(realpathSync(parent)) !== parent) invalid();
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) invalid();
  chmodSync(path, 0o600);
  return path;
}

function invalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
