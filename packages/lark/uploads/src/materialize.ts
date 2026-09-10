/**
 * 附件物化（lark-claw upload-store.materialize 语义平移）：
 * 源文件（.uploads 内）→ 归属/摘要校验 → CDG 解密或复制 → 工作区目标。
 * storageKey 永不是授权证据：scopeKey 前缀 + realpath 包含 + SHA-256 复核。
 */
import { constants, copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { scopeKey, type RunAttachment, type Scope } from "dsh-lark-contracts";
import type { CdgBridge } from "dsh-cdg-bridge";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function resolveMaxBytes(value: number | undefined): number {
  const maxBytes = value === undefined ? DEFAULT_MAX_BYTES : value;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error(`附件大小上限必须是 1..${DEFAULT_MAX_BYTES} 的安全整数`);
  }
  return maxBytes;
}

function assertInside(root: string, candidate: string, message: string): void {
  const child = relative(root, candidate);
  if (!child || isAbsolute(child) || child === ".."
    || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(message);
  }
}

/** 安全文件名（路径分隔与控制字符替换；lark-claw safeFileName 语义）。 */
export function safeFileName(value: string): string {
  const name = basename(value.trim().replaceAll("\\", "/"));
  if (!name || name === "." || name === "..") throw new Error("非法附件文件名");
  const sanitized = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  if (!sanitized) throw new Error("非法附件文件名");
  return sanitized.slice(0, 255);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface UploadMaterializerOptions {
  /** .uploads 根（绝对路径；与网关落盘根一致）。 */
  uploadsRoot: string;
  /** 单附件大小上限（默认 100 MiB）。 */
  maxBytes?: number;
  /** CDG 桥接（未配置实例 = 明文语义）。 */
  cdgBridge?: CdgBridge;
}

export interface MaterializedAttachment {
  attachment: RunAttachment;
  /** 工作区内的绝对路径。 */
  path: string;
}

/**
 * 物化一个附件到工作区 uploads/<id>/<safeName>：
 * 解析源 → 摘要复核 → 解密/复制 → 落盘摘要复核。
 * 任一步失败抛错（附件是运行主题 → 运行失败）。
 */
export async function materializeAttachment(
  options: UploadMaterializerOptions,
  scope: Scope,
  attachment: RunAttachment,
  workspace: string,
): Promise<MaterializedAttachment> {
  const root = resolve(options.uploadsRoot);
  const maxBytes = resolveMaxBytes(options.maxBytes);

  // 归属：storageKey 必须带本 scope 前缀，且解析后仍位于 .uploads 内。
  const keyScope = scopeKey(scope);
  if (!attachment.storageKey.startsWith(`${keyScope}/`)) {
    throw new Error("附件不属于当前 scope");
  }
  const sourceCandidate = resolve(root, ...attachment.storageKey.split("/"));
  assertInside(root, sourceCandidate, "附件路径逃逸上传根目录");
  const [rootPath, sourcePath, info] = await Promise.all([
    realpath(root),
    realpath(sourceCandidate),
    lstat(sourceCandidate),
  ]);
  assertInside(rootPath, sourcePath, "附件路径逃逸上传根目录");
  if (!info.isFile()) throw new Error("附件源不是常规文件");
  if (info.size > maxBytes) throw new Error("附件超过大小上限");
  if (await sha256File(sourcePath) !== attachment.sha256) throw new Error("附件摘要与声明不符");

  const directory = resolve(workspace, "uploads", attachment.id);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, safeFileName(attachment.fileName));
  assertInside(resolve(workspace), destination, "物化目标逃逸工作区");
  const [workspacePath, directoryPath] = await Promise.all([
    realpath(workspace),
    realpath(directory),
  ]);
  assertInside(workspacePath, directoryPath, "物化目录逃逸工作区");

  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    if (attachment.encryption === "cdg") {
      if (!options.cdgBridge) throw new Error("附件为 CDG 加密但桥接未配置");
      await options.cdgBridge.decrypt(sourcePath, temporary);
    } else {
      await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  if (attachment.encryption !== "cdg" && await sha256File(destination) !== attachment.sha256) {
    throw new Error("物化后摘要不符");
  }
  return { attachment, path: destination };
}
