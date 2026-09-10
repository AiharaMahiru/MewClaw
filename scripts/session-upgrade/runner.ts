/** 仅接受固定摘要的离线副本，全部转换成功后才建立独占输出目录。 */
import { Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeRows } from "./decode.js";
import { migrateRows } from "./transform.js";

/** 计划只携带相对文件名和预先固定的源摘要。 */
export interface MigrationPlan { version: 1; entries: { relativePath: string; sourceSha256: string }[] }
/** 所有文件访问受显式根和资源上限约束。 */
export interface MigrationOptions { sourceRoot: string; outputRoot: string; plan: unknown; maxSourceBytes?: number; maxDecodedBytes?: number; maxEvents?: number }
const forbiddenRoots = ["/var/lib/dsh", "/opt/dsh/current", "/opt/dsh/releases"];
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

function plan(input: unknown): MigrationPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid plan");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "entries,version" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 3) throw new Error("invalid plan fields or count");
  const seen = new Set<string>();
  const entries = value.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid plan entry");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join() !== "relativePath,sourceSha256" || typeof item.relativePath !== "string" || typeof item.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceSha256)) throw new Error("invalid plan entry fields");
    const path = item.relativePath;
    if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..") || !/\.jsonl(?:\.zstd)?$/.test(path) || seen.has(path)) throw new Error("invalid or duplicate relative path");
    seen.add(path);
    return { relativePath: path, sourceSha256: item.sourceSha256 };
  });
  return { version: 1, entries };
}
async function safeExisting(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") throw new Error("absolute normalized non-root path required");
  if (await realpath(path) !== path) throw new Error("symlink paths are not allowed");
  for (const root of forbiddenRoots) {
    let actual = root;
    try { actual = await realpath(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (inside(root, path) || inside(actual, path)) throw new Error("production paths are not allowed");
  }
  return path;
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("source file type or size rejected");
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, null);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used !== stat.size) throw new Error("source changed while reading");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

/**
 * 在新目录写官方 v3，重新创建 Provider 读回验证；始终不写源树。
 * @param options 显式副本根、输出根、摘要计划和可选上限。
 * @returns 不含会话正文的摘要报告；失败不生成成功 manifest。
 */
export async function migrateCopies(options: MigrationOptions) {
  const limits = { source: options.maxSourceBytes ?? 33554432, decoded: options.maxDecodedBytes ?? 67108864, events: options.maxEvents ?? 200000 };
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid migration limits");
  const approved = plan(options.plan);
  const sourceRoot = await safeExisting(options.sourceRoot);
  if (!(await lstat(sourceRoot)).isDirectory()) throw new Error("source root must be a directory");
  const outputRoot = options.outputRoot;
  if (!isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot || inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot)) throw new Error("output root must be separate and absolute");
  await safeExisting(dirname(outputRoot));
  for (const root of forbiddenRoots) if (inside(root, outputRoot)) throw new Error("production output forbidden");
  try { await lstat(outputRoot); throw new Error("output already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const prepared = [];
  const ids = new Set<string>();
  for (const entry of approved.entries) {
    const path = await safeExisting(join(sourceRoot, entry.relativePath));
    if (!inside(sourceRoot, path)) throw new Error("source escapes root");
    const bytes = await readBounded(path, limits.source);
    if (hash(bytes) !== entry.sourceSha256) throw new Error("source hash mismatch");
    const result = migrateRows(decodeRows(bytes, path.endsWith(".zstd"), limits.decoded), limits.events);
    if (ids.has(result.artifact.header.id)) throw new Error("duplicate session id");
    ids.add(result.artifact.header.id);
    prepared.push({ entry, path, ...result });
  }
  await mkdir(outputRoot, { mode: 0o700 });
  const sessionsRoot = join(outputRoot, "sessions");
  const originalsRoot = join(outputRoot, "originals");
  await mkdir(sessionsRoot, { mode: 0o700 });
  await mkdir(originalsRoot, { mode: 0o700 });
  const writerContext = new Context();
  try {
    await writerContext.plugin(Jsonl, { root: sessionsRoot, compression: "zstd" });
    for (const item of prepared) {
      const writer = await writerContext.sessionPersistence.create(item.artifact.header as unknown as SessionHeader);
      try {
        await writer.append(item.artifact.events as unknown as SessionEvent[]);
        await writer.flush();
      } finally { await writer.close(); }
    }
  } finally { await writerContext.fiber.dispose(); }
  const readerContext = new Context();
  const reports = [];
  try {
    await readerContext.plugin(Jsonl, { root: sessionsRoot, compression: "zstd" });
    for (const [index, item] of prepared.entries()) {
      const reader = await readerContext.sessionPersistence.open(SessionId(item.artifact.header.id), "read");
      try {
        const restored = await reader.read();
        if (!isDeepStrictEqual(restored.events, item.artifact.events) || !isDeepStrictEqual(reader.header, item.artifact.header) || reader.inheritedEventCount !== item.artifact.inheritedEventCount) throw new Error("official persisted roundtrip mismatch");
      } finally { await reader.close(); }
      await safeExisting(item.path);
      if (hash(await readBounded(item.path, limits.source)) !== item.entry.sourceSha256) throw new Error("source changed after migration");
      const original = join(originalsRoot, `${index}${item.path.endsWith(".zstd") ? ".jsonl.zstd" : ".jsonl"}`);
      await copyFile(item.path, original, constants.COPYFILE_EXCL);
      const originalHandle = await open(original, "r+");
      try { await originalHandle.chmod(0o600); } finally { await originalHandle.close(); }
      if (hash(await readFile(original)) !== item.entry.sourceSha256) throw new Error("retained original hash mismatch");
      reports.push({ sessionTag: hash(Buffer.from(item.artifact.header.id)).slice(0, 12), sourceSha256: item.entry.sourceSha256, original: relative(outputRoot, original), targetVersion: 3, ...item.report });
    }
  } finally { await readerContext.fiber.dispose(); }
  // 全部输出读回结束后再次复核所有源，避免只核对前几项的早期状态。
  for (const item of prepared) if (hash(await readBounded(item.path, limits.source)) !== item.entry.sourceSha256) throw new Error("source changed before manifest");
  const artifacts = [];
  for (const name of (await readdir(sessionsRoot, { recursive: true })).sort()) {
    if (!name.endsWith(".jsonl.zstd")) continue;
    const bytes = await readFile(join(sessionsRoot, name));
    artifacts.push({ relativePath: join("sessions", name), sha256: hash(bytes), sizeBytes: bytes.length });
  }
  if (artifacts.length !== prepared.length) throw new Error("unexpected output artifact count");
  const manifest = { version: 1, status: "copy-verified", sourceRoot, reports, artifacts };
  await writeFile(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}
