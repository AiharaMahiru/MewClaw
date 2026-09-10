/**
 * M5b 干净环境演练代理（2/2）：备份 → 恢复回环。
 *
 * 便携 PG 的 pg_dump（custom 格式）→ 新建临时库 → pg_restore →
 * 行数核对（knowledge_documents + cron_jobs）→ 清理临时库。
 * PG 未运行时跳过（机制在 supervisor 的 ensurePostgres 保证生产环境恒有）。
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import {
  createRuntimePaths,
  loadLocalDatabaseConfig,
} from "../infra/postgres/dist/index.js";

const executeFile = promisify(execFile);

const repoRoot = process.cwd();
const config = process.env.DATABASE_URL?.trim()
  ? loadLocalDatabaseConfig(process.env)
  : undefined;
const runtimePaths = createRuntimePaths(repoRoot);

/** pg 二进制候选目录（迁移期排练：本仓库便携运行时或 lark-claw 运行时）。 */
function pgBinDir(): string | undefined {
  const candidates = [
    process.env.PG_BIN_DIR,
    join(runtimePaths.postgresRoot, "bin"),
    // lark-claw 便携运行时（迁移期并存；其 supervisor 在 5432 提供服务）。
    "D:\\AI\\lark-claw\\var\\postgres\\runtime\\postgresql-17.9-1\\bin",
  ].filter((value): value is string => Boolean(value));
  const exe = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
  for (const dir of candidates) {
    const path = join(dir, exe);
    if (!existsSync(path)) continue;
    try {
      // 同步可用性检查（skipIf 在收集期求值）。
      execFileSync(path, ["--version"], { windowsHide: true });
      return dir;
    } catch {
      // 尝试下一个候选。
    }
  }
  return undefined;
}

const binDir = pgBinDir();
const bin = (name: string) => join(binDir!, process.platform === "win32" ? `${name}.exe` : name);
const SNAPSHOT_CLOSE_TIMEOUT_MS = 5_000;
const TABLES = ["knowledge_documents", "cron_jobs"] as const;

type SourceCounts = Record<(typeof TABLES)[number], number>;

interface SourceSnapshot {
  counts: SourceCounts;
  name: string;
  process: ChildProcess;
}

let tempDir: string;
const restoreDatabase = `dsh_lark_restore_${Date.now().toString(36)}`;

afterAll(async () => {
  if (!binDir || !config) return;
  await executeFile(bin("dropdb"), [
    "--host", config.host, "--port", String(config.port),
    "--username", config.user, "--no-password", "--if-exists", restoreDatabase,
  ], { env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true }).catch(() => undefined);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function countRows(database: string, table: string): Promise<number> {
  if (!config) throw new Error("DATABASE_URL is required for backup/restore rehearsal");
  const { stdout } = await executeFile(bin("psql"), [
    "--host", config.host, "--port", String(config.port),
    "--username", config.user, "--no-password",
    "--tuples-only", "--no-align", "--command", `SELECT count(*) FROM ${table}`, database,
  ], { env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true });
  return Number.parseInt(String(stdout).trim(), 10) || 0;
}

function firstOutputLines(snapshotProcess: ChildProcess, count: number): Promise<string[]> {
  const output = snapshotProcess.stdout;
  if (!output) return Promise.reject(new Error("psql snapshot exporter has no stdout"));
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        lines.push(part.trim());
        if (lines.length === count) {
          cleanup();
          resolve(lines);
          return;
        }
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`psql snapshot exporter exited (${code})`)); };
    const cleanup = () => { snapshotProcess.off("error", onError); snapshotProcess.off("exit", onExit); output.off("data", onData); };
    output.on("data", onData);
    snapshotProcess.once("error", onError);
    snapshotProcess.once("exit", onExit);
  });
}

function parseSourceCounts(line: string): SourceCounts {
  const values = line.split("|").map((value) => Number.parseInt(value, 10));
  const documents = values[0];
  const cron = values[1];
  if (documents === undefined || cron === undefined || !Number.isSafeInteger(documents) || !Number.isSafeInteger(cron)) {
    throw new Error(`Invalid PostgreSQL snapshot counts: ${line}`);
  }
  return { knowledge_documents: documents, cron_jobs: cron };
}

async function exportSourceSnapshot(): Promise<SourceSnapshot> {
  if (!config) throw new Error("DATABASE_URL is required for backup/restore rehearsal");
  const snapshotProcess = spawn(bin("psql"), [
    "--host", config.host, "--port", String(config.port), "--username", config.user, "--no-password",
    "--tuples-only", "--no-align", "--quiet", "--set", "ON_ERROR_STOP=1", config.database,
  ], { env: { ...process.env, PGPASSWORD: config.password }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  try {
    snapshotProcess.stdin?.write([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
      "SELECT pg_export_snapshot();",
      `SELECT (SELECT count(*) FROM ${TABLES[0]}), (SELECT count(*) FROM ${TABLES[1]});`,
    ].join("\n") + "\n");
    const [name, counts] = await firstOutputLines(snapshotProcess, 2);
    if (!name || !counts) throw new Error("PostgreSQL snapshot exporter returned incomplete output");
    return { process: snapshotProcess, name, counts: parseSourceCounts(counts) };
  } catch (error) {
    snapshotProcess.kill();
    throw error;
  }
}

async function closeSourceSnapshot(snapshotProcess: ChildProcess): Promise<void> {
  if (snapshotProcess.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => snapshotProcess.once("close", () => resolve()));
  snapshotProcess.stdin?.end("ROLLBACK;\n\\q\n");
  const didClose = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), SNAPSHOT_CLOSE_TIMEOUT_MS)),
  ]);
  if (!didClose && snapshotProcess.kill()) await closed;
}

describe.skipIf(!binDir || !config)("备份恢复回环（M5b 演练代理）", () => {
  it("pg_dump → 临时库 restore → 导出快照行数一致", async () => {
    if (!config) throw new Error("DATABASE_URL is required for backup/restore rehearsal");
    tempDir = await mkdtemp(join(tmpdir(), "dsh-lark-backup-"));
    const dumpPath = join(tempDir, "backup.dump");

    // pg_dump 与源行数共用导出快照，避免并发写入导致“备份”和“当前库”比较失真。
    const source = await exportSourceSnapshot();
    try {
      await executeFile(bin("pg_dump"), [
        "--host", config.host, "--port", String(config.port),
        "--username", config.user, "--no-password", "--format=custom", `--snapshot=${source.name}`, "--file", dumpPath,
        config.database,
      ], { env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true });
    } finally {
      await closeSourceSnapshot(source.process);
    }

    // 恢复进临时库（先建库）。
    await executeFile(bin("createdb"), [
      "--host", config.host, "--port", String(config.port),
      "--username", config.user, "--no-password", restoreDatabase,
    ], { env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true });
    await executeFile(bin("pg_restore"), [
      "--host", config.host, "--port", String(config.port),
      "--username", config.user, "--no-password", "--exit-on-error", "--dbname", restoreDatabase, dumpPath,
    ], { env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true });

    // 核对：知识库与 cron 表与同一导出快照一致（其余 schema_migrations 等由 restore 全量保证）。
    for (const table of TABLES) {
      expect(await countRows(restoreDatabase, table)).toBe(source.counts[table]);
    }
  }, 180_000);
});
