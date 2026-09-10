import type { Scope } from "dsh-lark-contracts";

/** 不可枚举的公开分享标识；wire 边界必须经 parsePreviewId。 */
declare const previewIdBrand: unique symbol;
export type PreviewId = string & { readonly [previewIdBrand]: true };

export interface PreviewDescriptor {
  id: PreviewId;
  url: string;
  createdAt: string;
  expiresAt: string;
  port: number;
}

/** Preview Definition。工具包只依赖此接口，不感知 daemon 实现。 */
export interface PreviewService {
  publish(input: {
    scope: Scope;
    workspace: string;
    command: string;
    port: number;
    ttlMinutes?: number;
  }): Promise<PreviewDescriptor>;
  list(scope: Scope): Promise<readonly PreviewDescriptor[]>;
  revoke(scope: Scope, id: string): Promise<void>;
  dispose(): Promise<void>;
}

export type PreviewErrorCode =
  | "PREVIEW_INVALID_INPUT"
  | "PREVIEW_FORBIDDEN"
  | "PREVIEW_QUOTA"
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_UPSTREAM";

export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string = code) {
    super(message);
    this.name = "PreviewError";
  }
}

export function parsePreviewId(value: unknown): PreviewId | undefined {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
    ? value as PreviewId
    : undefined;
}
