/**
 * 会话日志保留策略（M5）：删除早于 N 天的 var/sessions 日志文件。
 * 用法：node scripts/retain-sessions.mjs [days=30]
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const days = Number.parseInt(process.argv[2] ?? "30", 10);
if (!Number.isInteger(days) || days < 1) {
  console.error("用法：node scripts/retain-sessions.mjs [days>=1]");
  process.exit(1);
}

const root = join(repoRoot, "var", "sessions");
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
let removed = 0;
let kept = 0;

let entries;
try {
  entries = await readdir(root);
} catch {
  console.log("var/sessions 不存在，无需保留策略。");
  process.exit(0);
}

for (const name of entries) {
  if (!name.endsWith(".jsonl")) continue;
  const path = join(root, name);
  try {
    const info = await stat(path);
    if (info.mtimeMs < cutoff) {
      await rm(path, { force: true });
      removed += 1;
    } else {
      kept += 1;
    }
  } catch {
    // 竞态删除容忍。
  }
}
console.log(`会话保留：删除 ${removed} 个（>${days} 天），保留 ${kept} 个。`);
