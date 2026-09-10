/**
 * trust-manifest 生成器（SPEC skills.md §2）：唯一更新入口。
 *
 * 按 skill-trust 的摘要算法（相对路径排序、SHA-256(相对路径 + NUL + 内容)）
 * 计算每个技能目录摘要并更新 skills/trust-manifest.json。手工改 digest 会
 * 在预检时 fail closed——这正是供应链纪律的目的。
 *
 * 用法：node scripts/trust-manifest.mjs
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillMetadata } from "../packages/skill/skill-trust/metadata.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const skillsRoot = join(repoRoot, "skills");
const manifestPath = join(skillsRoot, "trust-manifest.json");

function safeRelative(root, path) {
  const local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`) || local.startsWith(sep)) return null;
  return local;
}

/** 递归收集目录内普通文件（相对路径 → 绝对路径）；符号链接/逃逸拒绝。 */
async function collectFiles(root) {
  const files = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const local = safeRelative(root, path);
      if (local === null) throw new Error(`路径逃逸：${path}`);
      if (entry.isSymbolicLink()) throw new Error(`符号链接禁止：${path}`);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isFile()) files.set(local, path);
    }
  }
  return files;
}

/** 目录摘要（与 skill-trust 的 digestDirectory 逐字节同算法）。 */
async function digestDirectory(root) {
  const hash = createHash("sha256");
  const files = await collectFiles(root);
  for (const local of [...files.keys()].sort()) {
    hash.update(local);
    hash.update("\0");
    hash.update(await readFile(files.get(local)));
  }
  return hash.digest("hex");
}

const entries = await readdir(skillsRoot, { withFileTypes: true });
const skills = {};
for (const entry of entries) {
  if (entry.isSymbolicLink()) throw new Error(`符号链接禁止：${join(skillsRoot, entry.name)}`);
  if (!entry.isDirectory()) continue;
  const skillRoot = join(skillsRoot, entry.name);
  const digest = await digestDirectory(skillRoot);
  const metadata = parseSkillMetadata(await readFile(join(skillRoot, "SKILL.md"), "utf8"));
  skills[entry.name] = {
    version: metadata.version,
    digest,
    capabilities: metadata.capabilities,
  };
}

await writeFile(manifestPath, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`, "utf8");
console.log(`trust-manifest 已更新：${Object.keys(skills).join(", ")}`);
