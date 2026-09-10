/**
 * 管理面上传落盘：原始字节体 → uploadsRoot/<scopeKey>/<uuid>-<sanitized>。
 *
 * 源文件持久保留（重索引的原始源）；文件名 sanitize（保留安全字符，
 * 去路径分隔符）；归属经 Provider 的 realpath 校验兜底。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { scopeKey, type Scope } from "dsh-lark-contracts";

const SAFE_NAME = /[^A-Za-z0-9._\-\u4e00-\u9fa5]/g;

/** 文件名 sanitize：非法字符 → "_"；空结果回退 "upload"。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(SAFE_NAME, "_").replace(/^\.+/, "");
  return cleaned || "upload";
}

/** 把上传字节落盘到 scope 归属目录，返回绝对路径。 */
export async function saveUpload(
  uploadsRoot: string,
  scope: Scope,
  fileName: string,
  content: Buffer,
): Promise<string> {
  const root = resolve(uploadsRoot);
  const dir = join(root, scopeKey(scope));
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${randomUUID()}-${sanitizeFileName(fileName)}`);
  await writeFile(target, content);
  return target;
}
