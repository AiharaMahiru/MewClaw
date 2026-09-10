/**
 * pgweb 管理工具（启动/停止/健康检查）。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { type LocalDatabaseConfig, type RuntimePaths } from "./config.js";
import { getPostgresStatus } from "./lifecycle.js";
import { runProcess } from "./process.js";

const PGWEB_HOST = "127.0.0.1";
const PGWEB_PORT = 8081;
const START_TIMEOUT_MS = 15_000;

export interface PgwebStatus {
  installed: boolean;
  running: boolean;
  url: string;
}

export function buildPgwebArgs(): string[] {
  return [
    "--bind",
    PGWEB_HOST,
    "--listen",
    String(PGWEB_PORT),
    "--skip-open",
    "--no-ssh",
    "--lock-session",
  ];
}

export function buildPgwebEnv(config: LocalDatabaseConfig): NodeJS.ProcessEnv {
  return { ...process.env, PGWEB_DATABASE_URL: config.url };
}

export function getPgwebUrl(): string {
  return `http://${PGWEB_HOST}:${PGWEB_PORT}`;
}

export async function startPgweb(
  paths: RuntimePaths,
  config: LocalDatabaseConfig,
): Promise<void> {
  await access(pgwebExe(paths));
  if ((await getPgwebStatus(paths)).running) return;
  const postgres = await getPostgresStatus(paths, config);
  if (!postgres.running || !postgres.vectorVersion) {
    throw new Error("Portable PostgreSQL must be running before pgweb starts");
  }
  const pid = await spawnPgweb(paths, config);
  await writeFile(paths.pgwebPidPath, `${pid}\n`);
  try {
    await waitForPgweb(paths, pid);
  } catch (error) {
    await stopOwnedProcess(paths, pid);
    throw error;
  }
}

export async function stopPgweb(paths: RuntimePaths): Promise<void> {
  const pid = await readPid(paths);
  if (pid === null) return;
  await stopOwnedProcess(paths, pid);
  await unlink(paths.pgwebPidPath).catch(() => undefined);
}

export async function getPgwebStatus(paths: RuntimePaths): Promise<PgwebStatus> {
  const installed = await exists(pgwebExe(paths));
  const pid = await readPid(paths);
  const owned = pid !== null && (await isOwnedProcess(paths, pid));
  const running = owned && (await isHealthy());
  return { installed, running, url: getPgwebUrl() };
}

async function spawnPgweb(paths: RuntimePaths, config: LocalDatabaseConfig): Promise<number> {
  await mkdir(dirname(paths.pgwebLogPath), { recursive: true });
  const log = await open(paths.pgwebLogPath, "a");
  try {
    const child = spawn(pgwebExe(paths), buildPgwebArgs(), {
      detached: true,
      env: buildPgwebEnv(config),
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("pgweb did not report a process ID");
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}

async function waitForPgweb(paths: RuntimePaths, pid: number): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isOwnedProcess(paths, pid))) throw new Error("pgweb exited during startup");
    if (await isHealthy()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`pgweb did not become ready at ${getPgwebUrl()}`);
}

async function stopOwnedProcess(paths: RuntimePaths, pid: number): Promise<void> {
  if (!(await isOwnedProcess(paths, pid))) return;
  process.kill(pid);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isOwnedProcess(paths, pid))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("pgweb did not stop within five seconds");
}

async function isOwnedProcess(paths: RuntimePaths, pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const expected = pgwebExe(paths).replaceAll("'", "''");
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    `if ($p -and $p.ExecutablePath -eq '${expected}') { exit 0 }`,
    "exit 1",
  ].join("; ");
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 5_000 },
  );
  return result.exitCode === 0;
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(getPgwebUrl(), { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function readPid(paths: RuntimePaths): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(paths.pgwebPidPath, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pgwebExe(paths: RuntimePaths): string {
  return resolve(paths.pgwebRoot, "pgweb.exe");
}
