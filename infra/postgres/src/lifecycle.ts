/**
 * 数据库进程启停与健康检查。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Pool } from "pg";

import {
  buildCreatedbArgs,
  buildPostgresServerOptions,
  type LocalDatabaseConfig,
  type RuntimePaths,
} from "./config.js";
import { runKnowledgeMigrations } from "./knowledge-migrations.js";
import { createPostgresMigrationDatabase } from "./migration.js";
import { runChecked, runProcess } from "./process.js";
import { waitForReady } from "./readiness.js";

const START_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;
const READY_RETRY_DELAY_MS = 250;

export interface RuntimeStatus {
  installed: boolean;
  initialized: boolean;
  running: boolean;
  vectorVersion: string | null;
}

export async function startPostgres(
  paths: RuntimePaths,
  config: LocalDatabaseConfig,
): Promise<void> {
  await access(binary(paths, "postgres.exe"));
  await initializeDatabase(paths, config);
  if (!(await isOwnedServerRunning(paths))) {
    await mkdir(dirname(paths.logPath), { recursive: true });
    await runChecked(
      binary(paths, "pg_ctl.exe"),
      ["-D", paths.dataRoot, "-l", paths.logPath, "-o", buildPostgresServerOptions(config), "start", "-w", "-t", "60"],
      { env: postgresEnv(config), timeoutMs: START_TIMEOUT_MS, completeOnExit: true },
    );
  }
  await waitForReady(
    async () => (await runProcess(
      binary(paths, "psql.exe"),
      connectionArgs(config, "postgres", ["-Atqc", "SELECT 1"]),
      { env: postgresEnv(config), timeoutMs: READY_RETRY_DELAY_MS },
    )).exitCode === 0,
    { timeoutMs: READY_TIMEOUT_MS, retryDelayMs: READY_RETRY_DELAY_MS },
  );
  await ensureApplicationDatabase(paths, config);
  await applyKnowledgeMigrations(config);
}

export async function stopPostgres(paths: RuntimePaths): Promise<void> {
  if (!(await isOwnedServerRunning(paths))) return;
  await runChecked(
    binary(paths, "pg_ctl.exe"),
    ["-D", paths.dataRoot, "stop", "-m", "fast", "-w", "-t", "60"],
    { timeoutMs: START_TIMEOUT_MS },
  );
}

export async function getPostgresStatus(
  paths: RuntimePaths,
  config: LocalDatabaseConfig,
): Promise<RuntimeStatus> {
  const installed = await exists(binary(paths, "postgres.exe"));
  const initialized = await exists(resolve(paths.dataRoot, "PG_VERSION"));
  if (!installed || !initialized || !(await isOwnedServerRunning(paths))) {
    return { installed, initialized, running: false, vectorVersion: null };
  }
  const query = await runProcess(
    binary(paths, "psql.exe"),
    connectionArgs(config, config.database, ["-Atqc", "SELECT extversion FROM pg_extension WHERE extname = 'vector'"]),
    { env: postgresEnv(config) },
  );
  return {
    installed,
    initialized,
    running: true,
    vectorVersion: query.exitCode === 0 ? query.stdout.trim() || null : null,
  };
}

async function initializeDatabase(
  paths: RuntimePaths,
  config: LocalDatabaseConfig,
): Promise<void> {
  if (await exists(resolve(paths.dataRoot, "PG_VERSION"))) return;
  await mkdir(paths.dataRoot, { recursive: true });
  const passwordPath = resolve(paths.root, ".initdb-password");
  await writeFile(passwordPath, config.password, { mode: 0o600 });
  try {
    await runChecked(binary(paths, "initdb.exe"), [
      "-D",
      paths.dataRoot,
      "--username",
      config.user,
      "--pwfile",
      passwordPath,
      "--encoding=UTF8",
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
    ]);
  } finally {
    await unlink(passwordPath).catch(() => undefined);
  }
}

async function ensureApplicationDatabase(
  paths: RuntimePaths,
  config: LocalDatabaseConfig,
): Promise<void> {
  const query = await runChecked(
    binary(paths, "psql.exe"),
    connectionArgs(config, "postgres", ["-Atqc", `SELECT 1 FROM pg_database WHERE datname = '${config.database}'`]),
    { env: postgresEnv(config) },
  );
  if (query.stdout.trim() === "1") return;
  await runChecked(
    binary(paths, "createdb.exe"),
    buildCreatedbArgs(config),
    { env: postgresEnv(config) },
  );
}

async function applyKnowledgeMigrations(
  config: LocalDatabaseConfig,
): Promise<void> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });
  try {
    await runKnowledgeMigrations(createPostgresMigrationDatabase(pool));
  } finally {
    await pool.end();
  }
}

async function isOwnedServerRunning(paths: RuntimePaths): Promise<boolean> {
  if (!(await exists(resolve(paths.dataRoot, "PG_VERSION")))) return false;
  const result = await runProcess(binary(paths, "pg_ctl.exe"), ["-D", paths.dataRoot, "status"]);
  return result.exitCode === 0;
}

function connectionArgs(
  config: LocalDatabaseConfig,
  database: string,
  extra: readonly string[],
): string[] {
  return ["-h", "127.0.0.1", "-p", String(config.port), "-U", config.user, "-d", database, ...extra];
}

function postgresEnv(config: LocalDatabaseConfig): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: config.password };
}

function binary(paths: RuntimePaths, name: string): string {
  return resolve(paths.postgresRoot, "bin", name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
