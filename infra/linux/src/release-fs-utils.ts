import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { ReleaseContentEntry } from "./release-package.js";

export async function assertPathExists(root: string, relativePath: string): Promise<void> {
  if (!(await pathExists(join(root, relativePath)))) {
    throw new Error(`required release path is missing: ${relativePath}`);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function normalizeRelative(path: string): string {
  const normalized = path.split(sep).join("/");
  return normalized === "" ? "." : normalized;
}

export function dirnameRelative(path: string): string {
  const normalized = normalizeRelative(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

export async function sha256File(path: string): Promise<string> {
  const source = await readFile(path);
  return createHash("sha256").update(source).digest("hex");
}

export function sortEntries(entries: readonly ReleaseContentEntry[]): ReleaseContentEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}

export function parsePackageManagerVersion(value: string): string {
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) throw new Error("packageManager must pin pnpm with an exact x.y.z version");
  return match[1]!;
}

export function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}
