import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import YAML from "yaml";

/** 返回根清单声明的补丁映射。 */
export function manifestPatches(manifest) {
  const value = manifest?.pnpm?.patchedDependencies;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 返回锁文件声明的补丁映射。 */
export function lockfilePatches(lockfile) {
  const value = lockfile?.patchedDependencies;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 校验补丁仅来自迁移期显式清单，并保持 manifest/lockfile 对称。 */
export function verifyPatchPolicy(manifest, lockfile, allowlist) {
  const failures = [];
  const allowed = new Set(allowlist);
  const manifestEntries = manifestPatches(manifest);
  const lockEntries = lockfilePatches(lockfile);
  const manifestKeys = Object.keys(manifestEntries).sort();
  const lockKeys = Object.keys(lockEntries).sort();

  for (const key of manifestKeys) {
    if (!allowed.has(key)) failures.push(`禁止的 patchedDependency: ${key}`);
    if (!(key in lockEntries)) failures.push(`lockfile 缺少 patchedDependency: ${key}`);
  }
  for (const key of lockKeys) {
    if (!allowed.has(key)) failures.push(`锁文件包含禁止的 patchedDependency: ${key}`);
    if (!(key in manifestEntries)) failures.push(`manifest 缺少 patchedDependency: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in manifestEntries) || !(key in lockEntries)) failures.push(`迁移期补丁清单与安装状态不一致: ${key}`);
  }
  return [...new Set(failures)];
}

async function main() {
  const root = process.cwd();
  const [manifestSource, lockSource, allowlistSource] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8"),
    readFile(resolve(root, "scripts/official-integrity-allowlist.json"), "utf8"),
  ]);
  const failures = verifyPatchPolicy(
    JSON.parse(manifestSource),
    YAML.parse(lockSource),
    JSON.parse(allowlistSource),
  );
  if (failures.length > 0) {
    console.error("[verify-official-integrity] 官方依赖完整性门禁失败：");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  const count = JSON.parse(allowlistSource).length;
  console.log(`[verify-official-integrity] 通过；迁移期补丁豁免 ${count} 项`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
