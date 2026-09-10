import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import type { WorkspaceAggregate } from "./types.js";

const CHUNK_BYTES = 1024 * 1024;
const EMPTY_TREE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface WorkspaceCopyResult {
  result: "migrated" | "merged";
  audit: WorkspaceTreeAudit;
}

export interface WorkspaceTreeAudit {
  bytes: number;
  directoryCount: number;
  fileCount: number;
  merkleRootSha256: string;
  specialFileCount: number;
  symlinkCount: number;
}

export interface WorkspaceRollbackTreeResult {
  result: "rolled-back" | "retained" | "rejected";
  reasonCode: string | null;
}

export async function copyWorkspaceTree(
  sourceRoot: string,
  targetRoot: string,
  expected: WorkspaceAggregate,
  signal?: AbortSignal,
): Promise<WorkspaceCopyResult> {
  const source = await canonicalRoot(sourceRoot);
  const target = resolveAbsolute(targetRoot);
  if (source === target) fail("TARGET_CONFLICT");
  const sourceAudit = await auditWorkspaceTree(source, signal, source);
  assertExpected(sourceAudit, expected);
  const temp = `${target}.dsh-migration-${randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  try {
    const existing = await existingAudit(target, source, signal);
    if (existing && sameAudit(existing, sourceAudit)) return { result: "merged", audit: existing };
    if (existing && !isEmpty(existing)) fail("TARGET_CONFLICT");
    await mkdir(temp, { recursive: false, mode: 0o700 });
    await copyTree(source, temp, signal);
    const copied = await auditWorkspaceTree(temp, signal, source);
    if (!sameAudit(copied, sourceAudit)) fail("CONTENT_DIGEST_MISMATCH");
    if (existing) await rm(target, { recursive: true, force: false });
    await rename(temp, target);
    return { result: "migrated", audit: copied };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function rollbackWorkspaceTree(
  sourceRoot: string,
  targetRoot: string,
  expected: WorkspaceAggregate,
  signal?: AbortSignal,
): Promise<WorkspaceRollbackTreeResult> {
  const guard = await checkWorkspaceRollbackGuard(sourceRoot, targetRoot, expected, signal);
  if (guard.result !== "rolled-back") return guard;
  return removeWorkspaceTree(targetRoot);
}

export async function checkWorkspaceRollbackGuard(
  sourceRoot: string,
  targetRoot: string,
  expected: WorkspaceAggregate,
  signal?: AbortSignal,
): Promise<WorkspaceRollbackTreeResult> {
  let source: string;
  try {
    source = await canonicalRoot(sourceRoot);
  } catch (error) {
    return { result: "rejected", reasonCode: rollbackReason(error, "ROLLBACK_SOURCE_UNAVAILABLE") };
  }
  let target: string;
  try {
    target = await canonicalRoot(targetRoot);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return { result: "rejected", reasonCode: "ROLLBACK_TARGET_MISSING" };
    return { result: "rejected", reasonCode: rollbackReason(error, "ROLLBACK_TARGET_UNSAFE") };
  }
  try {
    throwIfAborted(signal);
    const actual = await auditWorkspaceTree(target, signal, source);
    if (!sameAudit(actual, expected)) return { result: "rejected", reasonCode: "ROLLBACK_TARGET_CHANGED" };
    return { result: "rolled-back", reasonCode: null };
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return { result: "rejected", reasonCode: "ROLLBACK_TARGET_MISSING" };
    if (error instanceof DoorAgentMigrationError && error.code === "IMPORT_ABORTED") throw error;
    return { result: "rejected", reasonCode: rollbackReason(error, "ROLLBACK_TARGET_CHANGED") };
  }
}

export async function removeWorkspaceTree(targetRoot: string): Promise<WorkspaceRollbackTreeResult> {
  try {
    const target = await canonicalRoot(targetRoot);
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return { result: "rejected", reasonCode: "ROLLBACK_TARGET_UNSAFE" };
    }
    await rm(target, { recursive: true, force: false });
    return { result: "rolled-back", reasonCode: null };
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return { result: "rejected", reasonCode: "ROLLBACK_TARGET_MISSING" };
    return { result: "rejected", reasonCode: rollbackReason(error, "ROLLBACK_DELETE_FAILED") };
  }
}

export async function auditWorkspaceTree(
  root: string,
  signal?: AbortSignal,
  namespaceRoot = root,
): Promise<WorkspaceTreeAudit> {
  const canonical = await canonicalRoot(root);
  const namespace = await canonicalRoot(namespaceRoot);
  const files: Array<{ digest: string; path: string; size: number }> = [];
  const totals = { bytes: 0, directoryCount: 1, fileCount: 0, specialFileCount: 0, symlinkCount: 0 };
  await walk(canonical, "", files, totals, signal);
  if (totals.symlinkCount > 0 || totals.specialFileCount > 0) {
    fail("UNSUPPORTED_FILE_TYPE", `symlinks=${totals.symlinkCount};special=${totals.specialFileCount}`);
  }
  return { ...totals, merkleRootSha256: merkleRoot(files, namespace) };
}

async function walk(
  root: string,
  prefix: string,
  files: Array<{ digest: string; path: string; size: number }>,
  totals: { bytes: number; directoryCount: number; fileCount: number; specialFileCount: number; symlinkCount: number },
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, ...relativePath.split("/"));
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) { totals.symlinkCount += 1; continue; }
    if (metadata.isDirectory()) {
      totals.directoryCount += 1;
      await walk(root, relativePath, files, totals, signal);
      continue;
    }
    if (!metadata.isFile()) { totals.specialFileCount += 1; continue; }
    const content = await hashStableFile(path, signal);
    totals.bytes += content.size;
    totals.fileCount += 1;
    files.push({ digest: content.digest, path: relativePath.replaceAll(sep, "/"), size: content.size });
  }
}

async function copyTree(source: string, target: string, signal?: AbortSignal): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal);
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile()) fail("UNSUPPORTED_FILE_TYPE");
    if (metadata.isDirectory()) {
      await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await copyTree(sourcePath, targetPath, signal);
    } else await copyFile(sourcePath, targetPath, signal);
  }
}

async function copyFile(source: string, target: string, signal?: AbortSignal): Promise<void> {
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile()) fail("UNSUPPORTED_FILE_TYPE");
    let offset = 0;
    while (true) {
      throwIfAborted(signal);
      const read = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      await targetHandle.write(buffer, 0, read.bytesRead);
      offset += read.bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameStat(before, after) || after.size !== BigInt(offset)) fail("CONTENT_DIGEST_MISMATCH");
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
  }
}

async function hashStableFile(path: string, signal?: AbortSignal): Promise<{ digest: string; size: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const hash = createHash("sha256");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("UNSUPPORTED_FILE_TYPE");
    let offset = 0;
    while (true) {
      throwIfAborted(signal);
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after) || after.size !== BigInt(offset)) fail("CONTENT_DIGEST_MISMATCH");
    return { digest: hash.digest("hex"), size: offset };
  } finally {
    await handle.close();
  }
}

async function canonicalRoot(value: string): Promise<string> {
  const root = resolveAbsolute(value);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolve(await realpath(root)) !== root) fail("PATH_ESCAPE");
  return root;
}

async function existingAudit(
  path: string,
  namespaceRoot: string,
  signal?: AbortSignal,
): Promise<WorkspaceTreeAudit | undefined> {
  try { return await auditWorkspaceTree(path, signal, namespaceRoot); }
  catch (error) { if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") return undefined; throw error; }
}

function assertExpected(actual: WorkspaceTreeAudit, expected: WorkspaceAggregate): void {
  if (expected.symlinkCount !== 0 || expected.specialFileCount !== 0) fail("UNSUPPORTED_FILE_TYPE");
  if (actual.bytes !== expected.bytes || actual.directoryCount !== expected.directoryCount
    || actual.fileCount !== expected.fileCount || actual.merkleRootSha256 !== expected.merkleRootSha256) {
    fail("CONTENT_DIGEST_MISMATCH");
  }
}

function merkleRoot(
  files: Array<{ digest: string; path: string; size: number }>,
  namespaceRoot: string,
): string {
  if (files.length === 0) return EMPTY_TREE_DIGEST;
  const namespace = createHash("sha256").update(Buffer.from(namespaceRoot, "utf8")).digest();
  let level = files.map((file) => {
      const relativePathSha256 = createHash("sha256")
        .update(Buffer.concat([namespace, Buffer.from([0]), Buffer.from(file.path, "utf8")]))
        .digest("hex");
      const leafDigest = createHash("sha256").update(canonicalJson({
        content_sha256: file.digest,
        relative_path_sha256: relativePathSha256,
        size_bytes: file.size,
        type: "file",
      }), "utf8").digest("hex");
      return { leafDigest, relativePathSha256 };
    }).sort((left, right) => left.relativePathSha256.localeCompare(right.relativePathSha256)
      || left.leafDigest.localeCompare(right.leafDigest)).map((leaf) => leaf.leafDigest);
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1] ?? level[index]!;
      next.push(createHash("sha256").update(Buffer.from(level[index]! + right, "hex")).digest("hex"));
    }
    level = next;
  }
  return level[0]!;
}

function sameAudit(left: WorkspaceTreeAudit, right: WorkspaceTreeAudit): boolean {
  return left.bytes === right.bytes && left.directoryCount === right.directoryCount
    && left.fileCount === right.fileCount && left.merkleRootSha256 === right.merkleRootSha256
    && left.symlinkCount === right.symlinkCount && left.specialFileCount === right.specialFileCount;
}

function isEmpty(value: WorkspaceTreeAudit): boolean {
  return value.bytes === 0 && value.fileCount === 0 && value.directoryCount === 1
    && value.symlinkCount === 0 && value.specialFileCount === 0;
}

function sameStat(left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }, right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function resolveAbsolute(value: string): string {
  if (!isAbsolute(value)) fail("PATH_ESCAPE");
  return resolve(value);
}

function rollbackReason(error: unknown, fallback: string): string {
  if (error instanceof DoorAgentMigrationError && error.code === "PATH_ESCAPE") {
    return "ROLLBACK_TARGET_UNSAFE";
  }
  if (nodeCode(error) === "ENOENT") return "ROLLBACK_TARGET_MISSING";
  return fallback;
}

function nodeCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
}

function fail(
  code: "PATH_ESCAPE" | "CONTENT_DIGEST_MISMATCH" | "UNSUPPORTED_FILE_TYPE" | "TARGET_CONFLICT",
  message: string = code,
): never {
  throw new DoorAgentMigrationError(code, message);
}
