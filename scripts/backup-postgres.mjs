/**
 * 便携 PG 备份（M5）：pg_dump 到 var/services/backups/，保留最近 4 份。
 * 用法：node scripts/backup-postgres.mjs
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRuntimePaths,
  loadLocalDatabaseConfig,
} from "../infra/postgres/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const backupsRoot = join(repoRoot, "var", "services", "backups");
const KEEP = 4;

const runtimePaths = createRuntimePaths(repoRoot);
const config = loadLocalDatabaseConfig(process.env);

/** pg 二进制候选目录（便携运行时或迁移期 lark-claw 运行时）。 */
function pgBinDir() {
  const candidates = [
    process.env.PG_BIN_DIR,
    join(runtimePaths.postgresRoot, "bin"),
    "D:\\AI\\lark-claw\\var\\postgres\\runtime\\postgresql-17.9-1\\bin",
  ].filter(Boolean);
  const exe = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
  return candidates.find((dir) => existsSync(join(dir, exe)));
}

const binDir = pgBinDir();
if (!binDir) {
  console.error("未找到 pg_dump：先 pnpm postgres:install，或用 PG_BIN_DIR 指定。");
  process.exit(1);
}
const pgDump = join(binDir, process.platform === "win32" ? "pg_dump.exe" : "pg_dump");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(backupsRoot, `backup-${stamp}.sql`);

await mkdir(backupsRoot, { recursive: true });
await new Promise((resolvePromise, rejectPromise) => {
  execFile(pgDump, [
    "--host", config.host,
    "--port", String(config.port),
    "--username", config.user,
    "--no-password",
    "--format=custom",
    "--file", target,
    config.database,
  ], {
    env: { ...process.env, PGPASSWORD: config.password },
    windowsHide: true,
  }, (error) => (error ? rejectPromise(error) : resolvePromise()));
});
console.log(`备份完成：${target}`);

// 保留最近 KEEP 份。
const entries = (await readdir(backupsRoot))
  .filter((name) => name.startsWith("backup-") && name.endsWith(".sql"))
  .sort();
while (entries.length > KEEP) {
  const oldest = entries.shift();
  await rm(join(backupsRoot, oldest), { force: true });
  console.log(`清理旧备份：${oldest}`);
}
