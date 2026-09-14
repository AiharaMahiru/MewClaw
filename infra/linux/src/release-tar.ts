import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { open } from "node:fs/promises";

import { normalizeRelative } from "./release-fs-utils.js";

const TAR_BLOCK_SIZE = 512;
const TAR_MODE_DIR = 0o755;
const TAR_MODE_FILE = 0o644;
const TAR_MTIME = 0;

export { TAR_BLOCK_SIZE };

export interface TarEntry {
  kind: "directory" | "file";
  mode: number;
  path: string;
  size: number;
}

export async function collectTarEntries(root: string): Promise<TarEntry[]> {
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

export async function writeTarHeader(handle: Awaited<ReturnType<typeof open>>, root: string, entry: TarEntry): Promise<void> {
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

export async function writeTarFile(handle: Awaited<ReturnType<typeof open>>, path: string, size: number): Promise<void> {
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
