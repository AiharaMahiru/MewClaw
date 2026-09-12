/** 从已运行 release 构建主题增量候选；不切换 current、不改服务、不读取数据目录。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [baseArg, outputArg] = process.argv.slice(2);
assert.ok(baseArg && outputArg, "用法：node scripts/prepare-theme-release.mjs <base-release> <新候选绝对路径>");
const base = await realpath(baseArg);
const output = resolve(outputArg);
assert.equal(dirname(output), resolve(dirname(base), "../prepared"), "候选必须位于同一部署根的 prepared 目录");
const plugin = "dsh-lark-liquid-glass";
const baseManifest = JSON.parse(await readFile(join(base, ".dsh-release-manifest.json"), "utf8"));
// 原子创建目录：已有候选不能被覆盖。
await mkdir(output);
for (const entry of await readdir(base)) await cp(join(base, entry), join(output, entry), { recursive: true, errorOnExist: true, force: false });
const overlay = "infra/linux/overlays/worker.production.yml";
const manifests = baseManifest.entries.filter((entry) => entry.kind === "file" && (
  ["package.json", "apps/lark-worker/package.json", "packages/bundle/web/package.json"].includes(entry.path)
  || entry.path.endsWith("/node_modules/dsh-lark-web-bundle/package.json") || entry.path === "node_modules/dsh-lark-web-bundle/package.json"
)).map((entry) => entry.path);
for (const path of manifests) {
  const value = JSON.parse(await readFile(join(output, path), "utf8"));
  value.dependencies[plugin] = "workspace:*";
  if (path === "package.json") {
    const sourcePackage = JSON.parse(await readFile(join(source, path), "utf8"));
    value.pnpm.peerDependencyRules = sourcePackage.pnpm.peerDependencyRules;
  }
  await writeFile(join(output, path), JSON.stringify(value, null, 2) + "\n");
}
const sourceLock = YAML.parse(await readFile(join(source, "pnpm-lock.yaml"), "utf8"));
const lock = YAML.parse(await readFile(join(output, "pnpm-lock.yaml"), "utf8"));
for (const importer of [".", "apps/lark-worker", "packages/bundle/web"]) {
  assert.ok(sourceLock.importers[importer].dependencies[plugin], `源码锁文件缺少 ${importer} 主题依赖`);
  lock.importers[importer].dependencies[plugin] = sourceLock.importers[importer].dependencies[plugin];
}
lock.importers["packages/ui/liquid-glass"] = sourceLock.importers["packages/ui/liquid-glass"];
for (const section of ["packages", "snapshots"]) {
  for (const [name, value] of Object.entries(sourceLock[section])) if (name.startsWith("liquid-glass-react@")) lock[section][name] = value;
}
await writeFile(join(output, "pnpm-lock.yaml"), YAML.stringify(lock));
const sourceOverlay = await readFile(join(source, overlay), "utf8");
const baseOverlay = YAML.parse(await readFile(join(base, overlay), "utf8"));
const themeRows = YAML.parse(sourceOverlay);
const withoutTheme = (rows) => rows.filter((row) => !row.insert?.some((item) => item.name === plugin));
assert.deepEqual(withoutTheme(themeRows), withoutTheme(baseOverlay), "生产 overlay 存在范围外改动");
await cp(join(source, overlay), join(output, overlay));
const runtimeFilter = (path) => !path.includes("/node_modules/") && !path.includes("/tests") && !path.includes("/__snapshots__") && !path.endsWith(".test.ts");
for (const destination of ["packages/ui/liquid-glass", `node_modules/${plugin}`]) {
  await cp(join(source, "packages/ui/liquid-glass"), join(output, destination), { recursive: true, filter: runtimeFilter });
}
await cp(join(source, "node_modules/liquid-glass-react"), join(output, "node_modules/liquid-glass-react"), { recursive: true, dereference: true });

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [];
async function scan(directory, prefix = "") {
  for (const name of (await readdir(directory)).sort()) {
    if (!prefix && name === ".dsh-release-manifest.json") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const full = join(directory, name);
    const stat = await lstat(full);
    if (stat.isDirectory()) { entries.push({ kind: "directory", path, size: 0 }); await scan(full, path); }
    else {
      assert.ok(stat.isFile(), `候选包含非普通文件 ${path}`);
      const bytes = await readFile(full);
      entries.push({ kind: "file", path, size: bytes.length, sha256: hash(bytes) });
    }
  }
}
await scan(output);
const old = new Map(baseManifest.entries.map((entry) => [entry.path, entry]));
const allowed = new Set([...manifests, "pnpm-lock.yaml", overlay]);
const changes = [];
for (const entry of entries) {
  const previous = old.get(entry.path);
  if (previous?.sha256 === entry.sha256 && previous?.kind === entry.kind) continue;
  assert.ok(allowed.has(entry.path) || /^(packages\/ui(?:\/|$)|node_modules\/(?:dsh-lark-liquid-glass|liquid-glass-react)(?:\/|$))/u.test(entry.path), `范围外内容变化或旧 manifest 漂移：${entry.path}`);
  changes.push(entry.path);
}
const present = new Set(entries.map((entry) => entry.path));
assert.ok(baseManifest.entries.every((entry) => present.has(entry.path)), "候选丢失现有文件");
const manifest = {
  ...baseManifest, releaseId: basename(output), createdAt: new Date().toISOString(), entries,
  baseReleaseId: baseManifest.releaseId,
  themeDelta: { sourceRoot: source, sourceState: "uncommitted", paths: changes, sha256: hash(JSON.stringify(entries.filter((entry) => changes.includes(entry.path)))) },
};
await writeFile(join(output, ".dsh-release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ candidate: output, baseReleaseId: baseManifest.releaseId, changedPaths: changes, officialAndOtherFilesUnchanged: true }, null, 2));
