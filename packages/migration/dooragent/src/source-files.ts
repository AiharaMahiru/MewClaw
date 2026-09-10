import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { createHash } from "node:crypto";

import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";

const MAX_MANIFEST_BYTES = 1_048_576;

export interface ReadSourceFile {
  buffer: Buffer;
  digest: string;
  path: string;
}

export async function resolveSnapshotRoot(input: string): Promise<string> {
  if (!isAbsolute(input)) invalid();
  const lexical = resolve(input);
  const metadata = await lstat(lexical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  if (resolve(await realpath(lexical)) !== lexical) invalid();
  return lexical;
}

export async function readManifestFile(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<ReadSourceFile> {
  return readBoundedSourceFile(root, relativePath, MAX_MANIFEST_BYTES, signal);
}

export async function readBoundedSourceFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadSourceFile> {
  throwIfAborted(signal);
  const target = await validatePathChain(root, relativePath);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) invalid();
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || BigInt(buffer.byteLength) !== after.size) invalid();
    throwIfAborted(signal);
    return { buffer, digest: digestBuffer(buffer), path: target };
  } finally {
    await handle.close();
  }
}

export function parseJsonObject(file: ReadSourceFile): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(file.buffer.toString("utf8"));
  } catch {
    invalid();
  }
  if (!isRecord(value)) invalid();
  return value;
}

export function digestBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function validatePathChain(root: string, relativePath: string): Promise<string> {
  const segments = validateRelativePath(relativePath);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) invalid();
    const final = index === segments.length - 1;
    if (final ? !metadata.isFile() : !metadata.isDirectory()) invalid();
  }
  const escaped = relative(root, current);
  if (!escaped || escaped.startsWith(`..${sep}`) || escaped === ".." || isAbsolute(escaped)) invalid();
  return current;
}

function validateRelativePath(value: string): string[] {
  if (!value || value.includes("\\") || value.startsWith("/")) invalid();
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) invalid();
  return segments;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new DoorAgentMigrationError("SOURCE_DIGEST_MISMATCH");
}
