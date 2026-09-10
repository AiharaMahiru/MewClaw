import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { ProductionPackageLock } from "./types.js";

const BUILD_STAGE_DIRS = ["apps", "infra", "packages", "presets", "scripts", "skills"] as const;
const BUILD_STAGE_FILES = [
  "eslint.config.js",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.test.json",
] as const;
const RELEASE_STAGE_DIRS = [...BUILD_STAGE_DIRS, "node_modules"] as const;
const GLOBAL_EXCLUDES = new Set([
  ".artifacts",
  ".codex-tasks",
  ".data",
  ".git",
  ".pnpm-store",
  ".turbo",
  ".uploads",
  ".workspaces",
  "agent-presets-tia",
  "coverage",
  "var",
]);
const LINUX_RELEASE_EXCLUDES = ["infra/windows"] as const;
const STAGE_EXCLUDES = new Set(["dist", "node_modules"]);
const RELEASE_EXCLUDES = new Set([".cache"]);
const SECRET_EXTENSIONS = new Set([".crt", ".key", ".pem", ".p12", ".pfx"]);
const REQUIRED_RELEASE_PATHS = [
  "apps/admin-web/dist/index.html",
  "apps/admin/boot-check.overlay.yml",
  "apps/admin/dist/main.js",
  "apps/auth/dist/main.js",
  "apps/browser/dist/main.js",
  "apps/preview/dist/main.js",
  "apps/lark-gateway/dist/main.js",
  "apps/lark-worker/dist/main.js",
  "apps/lark-worker/full.overlay.yml",
  "apps/lark-worker/full-port0.overlay.yml",
  "apps/lark-worker/boot-check.overlay.yml",
  "apps/lark-worker/lightweight.overlay.yml",
  "apps/lark-worker/web-port0.overlay.yml",
  "apps/migration/dist/main.js",
  "infra/linux/overlays/admin.production.yml",
  "infra/linux/overlays/gateway.production.yml",
  "infra/linux/overlays/worker.production.yml",
  "infra/linux/systemd/dsh-browser.service",
  "infra/linux/systemd/dsh-preview.service",
  "infra/linux/systemd/dsh-podman-ready.service",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  "presets/lark-standard/preset.json",
  "packages/browser/browser/lib/index.js",
  "packages/browser/tool-browser/lib/index.js",
  "packages/lark/tool-cdg/lib/index.js",
  "scripts/validate-linux-release.mjs",
  "scripts/verify-dsh-brand.mjs",
  "skills/cdg-bridge/SKILL.md",
  "skills/trust-manifest.json",
  "skills/lark-browser/SKILL.md",
] as const;
const TAR_BLOCK_SIZE = 512;
const TAR_MODE_DIR = 0o755;
const TAR_MODE_FILE = 0o644;
const TAR_MTIME = 0;

export interface ReleaseCommand {
  argv: readonly string[];
  cwd: string;
}

export interface ReleaseContentEntry {
  kind: "directory" | "file";
  path: string;
  sha256?: string;
  size: number;
  sourcePath?: string;
}

export interface ReleaseContentManifest {
  schemaVersion: 1;
  createdAt: string;
  entries: readonly ReleaseContentEntry[];
  gitCommit: string;
  nodeVersion: string;
  pnpmVersion: string;
  releaseId: string;
}

export interface MaterializeReleaseOptions {
  buildRoot: string;
  createdAt: string;
  gitCommit: string;
  nodeVersion: string;
  pnpmVersion: string;
  releaseId: string;
  releaseRoot: string;
}

export interface ReleaseArchiveResult {
  entries: number;
  sha256: string;
}

interface CopyOptions {
  mode: "release" | "stage";
  sourceRoot: string;
  targetRoot: string;
}

interface TarEntry {
  kind: "directory" | "file";
  mode: number;
  path: string;
  size: number;
}

export function assertLockedBuildVersions(input: {
  nodeVersion: string;
  packageManager: string;
  pnpmVersion: string;
  productionLock: ProductionPackageLock;
}): void {
  const expectedNode = input.productionLock.runtimes[0]?.version;
  if (!expectedNode) throw new Error("production lock is missing the Node runtime");
  if (stripVersionPrefix(input.nodeVersion) !== expectedNode) {
    throw new Error(`Node version mismatch: expected ${expectedNode}, received ${input.nodeVersion}`);
  }
  const expectedPnpm = parsePackageManagerVersion(input.packageManager);
  if (input.pnpmVersion !== expectedPnpm) {
    throw new Error(`pnpm version mismatch: expected ${expectedPnpm}, received ${input.pnpmVersion}`);
  }
}

export function createLinuxBuildPlan(root: string): readonly ReleaseCommand[] {
  return [
    { argv: ["pnpm", "install", "--frozen-lockfile"], cwd: root },
    { argv: ["pnpm", "build"], cwd: root },
    { argv: ["pnpm", "build:admin-web"], cwd: root },
    { argv: ["node", "scripts/validate-linux-release.mjs"], cwd: root },
  ];
}

export async function stageWorkspaceForLinuxBuild(sourceRoot: string, stageRoot: string): Promise<void> {
  await mkdir(stageRoot, { recursive: true });
  await copySelectedRoots({ mode: "stage", sourceRoot, targetRoot: stageRoot });
}

export async function validateReleaseBuildRoot(root: string): Promise<void> {
  for (const relativePath of REQUIRED_RELEASE_PATHS) {
    await assertPathExists(root, relativePath);
  }
}

export async function materializeReleaseTree(options: MaterializeReleaseOptions): Promise<ReleaseContentManifest> {
  await mkdir(options.releaseRoot, { recursive: true });
  const entries = await copySelectedRoots({
    mode: "release",
    sourceRoot: options.buildRoot,
    targetRoot: options.releaseRoot,
  });
  await rewriteLinuxReleaseTypeScriptConfigs(options.releaseRoot, entries);
  const manifest = {
    schemaVersion: 1,
    createdAt: options.createdAt,
    entries,
    gitCommit: options.gitCommit,
    nodeVersion: stripVersionPrefix(options.nodeVersion),
    pnpmVersion: options.pnpmVersion,
    releaseId: options.releaseId,
  } satisfies ReleaseContentManifest;
  await writeManifest(options.releaseRoot, manifest);
  return manifest;
}

async function rewriteLinuxReleaseTypeScriptConfigs(
  releaseRoot: string,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const rootConfigPath = join(releaseRoot, "tsconfig.json");
  if (await pathExists(rootConfigPath)) {
    const config = JSON.parse(await readFile(rootConfigPath, "utf8")) as {
      references?: Array<{ path?: string }>;
    };
    if (config.references) {
      config.references = config.references.filter((reference) => reference.path !== "infra/windows");
    }
    await rewriteManifestFile(releaseRoot, "tsconfig.json", config, entries);
  }

  const testConfigPath = join(releaseRoot, "tsconfig.test.json");
  if (await pathExists(testConfigPath)) {
    const config = JSON.parse(await readFile(testConfigPath, "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    delete config.compilerOptions?.paths?.["dsh-lark-service-runtime"];
    await rewriteManifestFile(releaseRoot, "tsconfig.test.json", config, entries);
  }
}

async function rewriteManifestFile(
  releaseRoot: string,
  relativePath: string,
  value: unknown,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const path = join(releaseRoot, relativePath);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await chmod(path, 0o644);
  const fileStats = await stat(path);
  const entry = entries.find((candidate) => candidate.kind === "file" && candidate.path === relativePath);
  if (!entry) throw new Error(`release manifest entry is missing for rewritten file: ${relativePath}`);
  entry.sha256 = await sha256File(path);
  entry.size = fileStats.size;
}

export async function writeReleaseArchive(releaseRoot: string, archivePath: string): Promise<ReleaseArchiveResult> {
  const directory = dirname(archivePath);
  await mkdir(directory, { recursive: true });
  const entries = await collectTarEntries(releaseRoot);
  const handle = await open(archivePath, "w");
  try {
    for (const entry of entries) {
      await writeTarHeader(handle, releaseRoot, entry);
      if (entry.kind === "file") await writeTarFile(handle, join(releaseRoot, entry.path), entry.size);
    }
    await handle.write(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  } finally {
    await handle.close();
  }
  return { entries: entries.length, sha256: await sha256File(archivePath) };
}

async function copySelectedRoots(options: CopyOptions): Promise<ReleaseContentEntry[]> {
  const copiedDirectories = new Set<string>();
  const entries: ReleaseContentEntry[] = [];
  const roots = options.mode === "stage" ? BUILD_STAGE_DIRS : RELEASE_STAGE_DIRS;
  for (const relativePath of BUILD_STAGE_FILES) {
    await copyRootFile(options, relativePath, copiedDirectories, entries);
  }
  for (const relativePath of roots) {
    await copyRootDirectory(options, relativePath, copiedDirectories, entries);
  }
  return sortEntries(entries);
}

async function copyRootFile(
  options: CopyOptions,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const sourcePath = join(options.sourceRoot, relativePath);
  if (!(await pathExists(sourcePath))) return;
  await copyMaterializedPath(options, sourcePath, join(options.targetRoot, relativePath), relativePath, copiedDirectories, entries);
}

async function copyRootDirectory(
  options: CopyOptions,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const sourcePath = join(options.sourceRoot, relativePath);
  if (!(await pathExists(sourcePath))) return;
  await copyMaterializedPath(options, sourcePath, join(options.targetRoot, relativePath), relativePath, copiedDirectories, entries);
}

async function copyMaterializedPath(
  options: CopyOptions,
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
  lineage = new Set<string>(),
): Promise<void> {
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.isSymbolicLink()) {
    await copySymlinkTarget(options, sourcePath, targetPath, relativePath, copiedDirectories, entries, lineage);
    return;
  }
  if (sourceInfo.isDirectory()) {
    await copyDirectory(options, sourcePath, targetPath, relativePath, copiedDirectories, entries, lineage);
    return;
  }
  if (sourceInfo.isFile()) {
    await copyRegularFile(options.sourceRoot, sourcePath, targetPath, relativePath, copiedDirectories, entries);
    return;
  }
  throw new Error(`unsupported special file in release tree: ${relativePath}`);
}

async function copySymlinkTarget(
  options: CopyOptions,
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
  lineage: Set<string>,
): Promise<void> {
  const resolvedPath = await realpath(sourcePath);
  assertInsideRoot(options.sourceRoot, resolvedPath, relativePath);
  if (lineage.has(resolvedPath)) throw new Error(`symlink cycle detected at ${relativePath}`);
  const nestedLineage = new Set(lineage);
  nestedLineage.add(resolvedPath);
  if (options.mode === "release" && isExecutableLinkPath(relativePath)) {
    await copyExecutableLinkWrapper(
      options.sourceRoot,
      targetPath,
      relativePath,
      resolvedPath,
      copiedDirectories,
      entries,
    );
    return;
  }
  await copyMaterializedPath(options, resolvedPath, targetPath, relativePath, copiedDirectories, entries, nestedLineage);
}

async function copyExecutableLinkWrapper(
  sourceRoot: string,
  targetPath: string,
  relativePath: string,
  resolvedPath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const sourceRelativePath = normalizeRelative(relative(sourceRoot, resolvedPath));
  const targetRelativePath = normalizeRelative(relative(dirname(relativePath), sourceRelativePath));
  const wrapper = [
    "#!/bin/sh",
    "set -eu",
    'script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `exec "$script_dir"/${shellQuote(targetRelativePath)} "$@"`,
    "",
  ].join("\n");
  await ensureDirectoryMaterialized(dirname(targetPath), dirnameRelative(relativePath), copiedDirectories, entries);
  await writeFile(targetPath, wrapper, { encoding: "utf8", mode: 0o755 });
  await chmod(targetPath, 0o755);
  const fileStats = await stat(targetPath);
  entries.push({
    kind: "file",
    path: normalizeRelative(relativePath),
    sha256: await sha256File(targetPath),
    size: fileStats.size,
    sourcePath: sourceRelativePath,
  });
}

async function copyDirectory(
  options: CopyOptions,
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
  lineage: Set<string>,
): Promise<void> {
  if (shouldSkipPath(relativePath, options.mode)) return;
  await ensureDirectoryMaterialized(targetPath, relativePath, copiedDirectories, entries);
  const children = await readdir(sourcePath, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelativePath = normalizeRelative(join(relativePath, child.name));
    if (shouldSkipPath(childRelativePath, options.mode)) continue;
    await copyMaterializedPath(
      options,
      join(sourcePath, child.name),
      join(targetPath, child.name),
      childRelativePath,
      copiedDirectories,
      entries,
      lineage,
    );
  }
}

async function copyRegularFile(
  sourceRoot: string,
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
): Promise<void> {
  await ensureDirectoryMaterialized(dirname(targetPath), dirnameRelative(relativePath), copiedDirectories, entries);
  const sourceStats = await stat(sourcePath);
  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, sourceStats.mode & 0o777);
  const fileStats = await stat(targetPath);
  entries.push({
    kind: "file",
    path: normalizeRelative(relativePath),
    sha256: await sha256File(targetPath),
    size: fileStats.size,
    sourcePath: normalizeRelative(relative(sourceRoot, sourcePath)),
  });
}

async function ensureDirectoryMaterialized(
  path: string,
  relativePath: string,
  copiedDirectories: Set<string>,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const normalized = normalizeRelative(relativePath);
  if (normalized === ".") return;
  const segments = normalized.split("/").filter(Boolean);
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (copiedDirectories.has(currentPath)) continue;
    await mkdir(join(pathRoot(path, normalized), currentPath), { recursive: true });
    copiedDirectories.add(currentPath);
    entries.push({ kind: "directory", path: currentPath, size: 0 });
  }
}

function pathRoot(path: string, relativePath: string): string {
  const depth = relativePath === "." ? 0 : relativePath.split("/").filter(Boolean).length;
  let current = path;
  for (let index = 0; index < depth; index += 1) current = dirname(current);
  return current;
}

function shouldSkipPath(relativePath: string, mode: CopyOptions["mode"]): boolean {
  const normalized = normalizeRelative(relativePath);
  if (normalized === ".") return false;
  if (mode === "release" && LINUX_RELEASE_EXCLUDES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => GLOBAL_EXCLUDES.has(segment))) return true;
  if (segments.some((segment) => segment.startsWith(".env"))) return true;
  if (segments.some((segment) => SECRET_EXTENSIONS.has(fileExtension(segment)))) return true;
  if (mode === "stage" && segments.some((segment) => STAGE_EXCLUDES.has(segment))) return true;
  if (mode === "release" && segments.some((segment) => RELEASE_EXCLUDES.has(segment))) return true;
  return false;
}

function isExecutableLinkPath(relativePath: string): boolean {
  const segments = normalizeRelative(relativePath).split("/");
  return segments.includes("node_modules") && segments.some((segment) => segment === ".bin" || segment === "bin");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index);
}

function assertInsideRoot(root: string, candidate: string, relativePath: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`symlink target for ${relativePath} resolves outside the staging root`);
}

async function writeManifest(root: string, manifest: ReleaseContentManifest): Promise<void> {
  const path = join(root, ".dsh-release-manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function collectTarEntries(root: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  await walkTarEntries(root, ".", entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkTarEntries(root: string, relativePath: string, entries: TarEntry[]): Promise<void> {
  const path = relativePath === "." ? root : join(root, relativePath);
  const sourceInfo = await lstat(path);
  if (sourceInfo.isSymbolicLink()) throw new Error(`release archive cannot include symlinks: ${relativePath}`);
  if (sourceInfo.isDirectory()) {
    if (relativePath !== ".") entries.push({ kind: "directory", mode: TAR_MODE_DIR, path: normalizeRelative(relativePath), size: 0 });
    const children = await readdir(path);
    for (const child of children.sort((left, right) => left.localeCompare(right))) {
      await walkTarEntries(root, relativePath === "." ? child : join(relativePath, child), entries);
    }
    return;
  }
  if (!sourceInfo.isFile()) throw new Error(`release archive cannot include special files: ${relativePath}`);
  entries.push({ kind: "file", mode: sourceInfo.mode & 0o777, path: normalizeRelative(relativePath), size: sourceInfo.size });
}

async function writeTarHeader(handle: Awaited<ReturnType<typeof open>>, root: string, entry: TarEntry): Promise<void> {
  const name = entry.kind === "directory" ? `${entry.path}/` : entry.path;
  if (!canWriteUstarPath(name)) {
    const paxRecord = createPaxPathRecord(name);
    await handle.write(createTarHeader({ kind: "file", mode: TAR_MODE_FILE, path: "PaxHeaders.0/path", size: paxRecord.length }, {
      name: "PaxHeaders.0/path",
      typeFlag: "x",
    }));
    await writeTarPayload(handle, paxRecord);
    await handle.write(createTarHeader(entry, {
      name: entry.kind === "directory" ? "pax-entry/" : "pax-entry",
    }));
  } else {
    await handle.write(createTarHeader(entry));
  }
  if (entry.kind === "directory") return;
  const target = join(root, entry.path);
  const info = await lstat(target);
  if (!info.isFile()) throw new Error(`tar source drifted while archiving: ${entry.path}`);
}

async function writeTarFile(handle: Awaited<ReturnType<typeof open>>, path: string, size: number): Promise<void> {
  const source = await readFile(path);
  if (source.length !== size) throw new Error(`tar source size changed while archiving: ${path}`);
  await writeTarPayload(handle, source);
}

async function writeTarPayload(handle: Awaited<ReturnType<typeof open>>, payload: Buffer): Promise<void> {
  await handle.write(payload);
  const remainder = payload.length % TAR_BLOCK_SIZE;
  if (remainder > 0) await handle.write(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
}

function createTarHeader(entry: TarEntry, options: { name?: string; typeFlag?: string } = {}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  const name = options.name ?? (entry.kind === "directory" ? `${entry.path}/` : entry.path);
  writeTarPath(header, name);
  writeTarOctal(header, 100, 8, entry.kind === "directory" ? TAR_MODE_DIR : entry.mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.kind === "directory" ? 0 : entry.size);
  writeTarOctal(header, 136, 12, TAR_MTIME);
  header.fill(0x20, 148, 156);
  header[156] = (options.typeFlag ?? (entry.kind === "directory" ? "5" : "0")).charCodeAt(0);
  header.write("ustar", 257, "ascii");
  header.write("00", 263, "ascii");
  writeTarOctal(header, 148, 8, tarChecksum(header));
  return header;
}

function writeTarPath(header: Buffer, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= 100) {
    encoded.copy(header, 0);
    return;
  }
  const splitIndex = findUstarPathSplit(value);
  if (splitIndex === null) throw new Error(`tar path is too long: ${value}`);
  const prefix = Buffer.from(value.slice(0, splitIndex), "utf8");
  const suffix = Buffer.from(value.slice(splitIndex + 1), "utf8");
  suffix.copy(header, 0);
  prefix.copy(header, 345);
}

function canWriteUstarPath(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 100 || findUstarPathSplit(value) !== null;
}

function findUstarPathSplit(value: string): number | null {
  let splitIndex = value.lastIndexOf("/");
  while (splitIndex > 0) {
    const prefix = Buffer.from(value.slice(0, splitIndex), "utf8");
    const suffix = Buffer.from(value.slice(splitIndex + 1), "utf8");
    if (prefix.length <= 155 && suffix.length <= 100) break;
    splitIndex = value.lastIndexOf("/", splitIndex - 1);
  }
  return splitIndex > 0 ? splitIndex : null;
}

function createPaxPathRecord(value: string): Buffer {
  const valueBytes = Buffer.from(value, "utf8");
  let length = valueBytes.length + Buffer.byteLength(" path=\n", "utf8") + 1;
  while (true) {
    const nextLength = valueBytes.length + Buffer.byteLength(" path=\n", "utf8") + String(length).length;
    if (nextLength === length) return Buffer.concat([
      Buffer.from(`${length} path=`, "ascii"),
      valueBytes,
      Buffer.from("\n", "ascii"),
    ]);
    length = nextLength;
  }
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  const encoded = Buffer.from(`${octal}\0`, "ascii");
  encoded.copy(header, offset);
}

function tarChecksum(header: Buffer): number {
  return header.reduce((total, value) => total + value, 0);
}

function parsePackageManagerVersion(value: string): string {
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) throw new Error("packageManager must pin pnpm with an exact x.y.z version");
  return match[1]!;
}

function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

async function assertPathExists(root: string, relativePath: string): Promise<void> {
  if (!(await pathExists(join(root, relativePath)))) {
    throw new Error(`required release path is missing: ${relativePath}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelative(path: string): string {
  const normalized = path.split(sep).join("/");
  return normalized === "" ? "." : normalized;
}

function dirnameRelative(path: string): string {
  const normalized = normalizeRelative(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

async function sha256File(path: string): Promise<string> {
  const source = await readFile(path);
  return createHash("sha256").update(source).digest("hex");
}

function sortEntries(entries: readonly ReleaseContentEntry[]): ReleaseContentEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}
