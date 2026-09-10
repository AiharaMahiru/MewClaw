/**
 * 附件契约（SPEC contracts.md / uploads.md）：网关下载落盘后交给 worker 的
 * 附件描述。storageKey 是 .uploads 内的相对路径（scopeKey 前缀），
 * 永不是授权证据——worker 侧按 Scope 归属 + SHA-256 双重校验。
 */
export type AttachmentEncryption = "none" | "cdg";

export interface RunAttachment {
  /** 附件 id（UUID；网关落盘时生成）。 */
  id: string;
  /** 展示名（已 sanitize，≤255 字符，无路径分隔）。 */
  fileName: string;
  /** 平台上报 MIME（不可信；提取按扩展名重新判定）。 */
  mimeType: string;
  /** 内容 SHA-256（64 hex）。 */
  sha256: string;
  /** 字节数（0..上限的安全整数）。 */
  size: number;
  /** CDG 探测标记（网关保存时 inspect；无桥接 = none）。 */
  encryption: AttachmentEncryption;
  /** .uploads 内相对存储键（`<scopeKey>/<uuid>-<sha256><ext>`）。 */
  storageKey: string;
}

/** 单次运行附件上限（lark-claw MAX_RUN_ATTACHMENTS 语义保留）。 */
export const MAX_RUN_ATTACHMENTS = 10;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}\/[a-f0-9-]{36}-[a-f0-9]{64}(\.[a-z0-9]{1,16})?$/;

/** 存储键归属校验：必须携带 scopeKey 前缀（先验归属，realpath 复核在物化侧）。 */
export function attachmentStorageKeyBelongsToScope(scopeKeyValue: string, storageKey: string): boolean {
  return storageKey.startsWith(`${scopeKeyValue}/`);
}

/**
 * 解析附件描述（wire 边界；严格拒绝未知键/非法形态）。
 * 首个失败即返回；返回 undefined 表示结构非法（调用方决定丢弃或拒绝整个请求）。
 */
export function parseRunAttachment(input: unknown, scopeKeyValue: string): RunAttachment | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const allowed = new Set(["id", "fileName", "mimeType", "sha256", "size", "encryption", "storageKey"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return undefined;
  }
  const { id, fileName, mimeType, sha256, size, encryption, storageKey } = record;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return undefined;
  if (typeof fileName !== "string" || !fileName.trim()
    || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName)) return undefined;
  if (typeof mimeType !== "string" || !mimeType.trim() || mimeType.length > 128) return undefined;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (encryption !== "none" && encryption !== "cdg") return undefined;
  if (typeof storageKey !== "string" || !STORAGE_KEY_PATTERN.test(storageKey)
    || !attachmentStorageKeyBelongsToScope(scopeKeyValue, storageKey)) return undefined;
  return {
    id,
    fileName: fileName.trim(),
    mimeType,
    sha256,
    size,
    encryption,
    storageKey,
  };
}

/**
 * 解析附件数组（wire 边界；上限 MAX_RUN_ATTACHMENTS）。
 * 数组非法（超限/任一附件非法）返回 undefined——整个请求拒绝（fail closed）。
 */
export function parseRunAttachments(input: unknown, scopeKeyValue: string): RunAttachment[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_RUN_ATTACHMENTS) return undefined;
  const attachments: RunAttachment[] = [];
  for (const item of input) {
    const parsed = parseRunAttachment(item, scopeKeyValue);
    if (!parsed) return undefined;
    attachments.push(parsed);
  }
  return attachments;
}
