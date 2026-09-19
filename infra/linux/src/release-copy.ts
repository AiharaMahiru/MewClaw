import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  dirnameRelative,
  normalizeRelative,
  pathExists,
  sha256File,
  sortEntries,
} from "./release-fs-utils.js";
import type { ReleaseContentEntry } from "./release-package.js";

// patches/ 是 pnpm patchedDependencies 的补丁文件根：暂存必须带上，
// 否则 frozen-lockfile 安装找不到补丁源。
const BUILD_STAGE_DIRS = ["apps", "infra", "packages", "patches", "presets", "scripts", "skills"] as const;
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

export interface CopyOptions {
  mode: "release" | "stage";
  sourceRoot: string;
  targetRoot: string;
}

export async function copySelectedRoots(options: CopyOptions): Promise<ReleaseContentEntry[]> {
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
