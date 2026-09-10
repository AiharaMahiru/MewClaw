/**
 * 网关附件落盘与暂存（lark-claw attachment-service + message-store 内存暂存
 * 语义平移）：下载流 → .uploads/<scopeKey>/<uuid>-<sha><ext> → 按会话暂存
 * （TTL + 上限）→ 下一次运行整体认领。
 *
 * storageKey 只是服务端状态引用，永不是授权证据：worker 物化侧按
 * Scope 归属 + SHA-256 双重校验。
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import { scopeKey, type RunAttachment, type Scope } from "dsh-lark-contracts";
import type { CdgBridge } from "dsh-cdg-bridge";

import { resolveGatewayAttachmentLimits } from "./attachment-config.js";

const MAX_EXTENSION_LENGTH = 16;

function safeFileName(value: string): string {
  const name = basename(value.trim().replaceAll("\\", "/"));
  if (!name || name === "." || name === "..") throw new Error("非法附件文件名");
  const sanitized = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  if (!sanitized) throw new Error("非法附件文件名");
  return sanitized.slice(0, 255);
}

function safeExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]+$/.test(extension) && extension.length <= MAX_EXTENSION_LENGTH + 1
    ? extension
    : "";
}

function unclaimedSourceName(scope: Scope, attachment: RunAttachment): string | undefined {
  const prefix = `${scopeKey(scope)}/`;
  if (!attachment.storageKey.startsWith(prefix)) return undefined;
  const name = attachment.storageKey.slice(prefix.length);
  if (!name || name === "." || name === ".." || name !== basename(name)) return undefined;
  return name;
}

export interface AttachmentSource {
  key: string;
  fileName: string;
}

export interface GatewayAttachmentOptions {
  /** .uploads 根（绝对路径；与 worker 共享）。 */
  uploadsRoot: string;
  maxBytes?: number | undefined;
  /** 暂存 TTL（默认 10 分钟）。 */
  ttlMs?: number | undefined;
  /** 每会话暂存上限（默认 10）。 */
  maxPending?: number | undefined;
  /** CDG 探测桥接；附件必须经其明确判定后才可接受。 */
  cdgBridge?: CdgBridge;
}

interface PendingEntry {
  attachment: RunAttachment;
  at: number;
}

/** 把 web ReadableStream 写入临时文件（大小上限 + 流式 SHA-256）。 */
async function streamToFile(stream: ReadableStream<Uint8Array>, path: string, maxBytes: number): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const writer = createWriteStream(path);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("附件超过大小上限");
      hash.update(value);
      await new Promise<void>((resolveWrite, rejectWrite) => {
        writer.write(Buffer.from(value), (error) => (error ? rejectWrite(error) : resolveWrite()));
      });
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      writer.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd()));
    });
    return { sha256: hash.digest("hex"), size };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    writer.destroy();
    await finished(writer).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class GatewayAttachments {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly cdgBridge: CdgBridge | undefined;
  private readonly pending = new Map<string, PendingEntry[]>();

  constructor(options: GatewayAttachmentOptions) {
    this.root = resolve(options.uploadsRoot);
    const limits = resolveGatewayAttachmentLimits(options);
    this.maxBytes = limits.maxBytes;
    this.ttlMs = limits.ttlMs;
    this.maxPending = limits.maxPending;
    this.cdgBridge = options.cdgBridge;
  }

  /** 下载流落盘 + CDG 探测，返回附件描述。 */
  async save(
    scope: Scope,
    source: AttachmentSource,
    stream: ReadableStream<Uint8Array>,
  ): Promise<RunAttachment> {
    const fileName = safeFileName(source.fileName);
    const directory = join(this.root, scopeKey(scope));
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const temporary = join(directory, `.uploading-${id}`);
    try {
      const { sha256, size } = await streamToFile(stream, temporary, this.maxBytes);
      if (!this.cdgBridge) throw new Error("CDG 附件检查服务不可用");
      const encryption = await this.cdgBridge.inspect(temporary) ? "cdg" : "none";
      const storedName = `${id}-${sha256}${safeExtension(fileName)}`;
      await rename(temporary, join(directory, storedName));
      return {
        id,
        fileName,
        mimeType: "application/octet-stream",
        sha256,
        size,
        encryption,
        storageKey: `${scopeKey(scope)}/${storedName}`,
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** 暂存（按会话；TTL 过期、超上限淘汰的未认领源文件一并清理）。 */
  async stage(scope: Scope, attachments: RunAttachment[]): Promise<void> {
    if (attachments.length === 0) return;
    const key = scopeKey(scope);
    const now = Date.now();
    const previous = this.pending.get(key) ?? [];
    const expired = previous.filter((entry) => now - entry.at > this.ttlMs);
    const entries = previous.filter((entry) => now - entry.at <= this.ttlMs);
    for (const attachment of attachments) entries.push({ attachment, at: now });
    const discarded: PendingEntry[] = [...expired];
    while (entries.length > this.maxPending) {
      const entry = entries.shift();
      if (entry) discarded.push(entry);
    }
    this.pending.set(key, entries);
    const retained = new Set(entries.map((entry) => entry.attachment.storageKey));
    await this.discard(scope, discarded
      .filter((entry) => !retained.has(entry.attachment.storageKey))
      .map((entry) => entry.attachment));
  }

  /** 认领（本次运行整体取走并清除；过期源文件不会传给 Worker）。 */
  async claim(scope: Scope): Promise<RunAttachment[]> {
    const key = scopeKey(scope);
    const now = Date.now();
    const previous = this.pending.get(key) ?? [];
    const entries = previous.filter((entry) => now - entry.at <= this.ttlMs);
    const expired = previous.filter((entry) => now - entry.at > this.ttlMs);
    this.pending.delete(key);
    await this.discard(scope, expired.map((entry) => entry.attachment));
    return entries.map((entry) => entry.attachment);
  }

  /** 仅删除本 scope 内、尚未交给 Worker 的已落盘源文件。 */
  async discard(scope: Scope, attachments: readonly RunAttachment[]): Promise<void> {
    const key = scopeKey(scope);
    const paths = new Set<string>();
    for (const attachment of attachments) {
      const name = unclaimedSourceName(scope, attachment);
      if (name) paths.add(join(this.root, key, name));
    }
    await Promise.all([...paths].map((path) => unlink(path).catch(() => undefined)));
  }
}
