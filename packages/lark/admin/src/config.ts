import z from "@deepseek-ai/schemastery";

import type { ControlPlaneConfig, ControlTargetConfig } from "./control-plane.js";

const MEBIBYTE_BYTES = 1024 * 1024;
const MIN_UPLOAD_BYTES = 1;
const MIN_RUN_LIMIT = 1;
const MAX_RUN_LIMIT = 100;
const DECIMAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * MEBIBYTE_BYTES;
export const DEFAULT_RUN_LIMIT = 8;

interface IntegerBounds {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const UPLOAD_BYTES_BOUNDS: IntegerBounds = {
  field: "maxUploadBytes",
  fallback: DEFAULT_MAX_UPLOAD_BYTES,
  minimum: MIN_UPLOAD_BYTES,
  maximum: DEFAULT_MAX_UPLOAD_BYTES,
};

const RUN_LIMIT_BOUNDS: IntegerBounds = {
  field: "defaultRunLimit",
  fallback: DEFAULT_RUN_LIMIT,
  minimum: MIN_RUN_LIMIT,
  maximum: MAX_RUN_LIMIT,
};

export interface Config {
  /** 管理身份（tenant/bot/deployment/user）；conversation 固定 admin-console。 */
  identity: {
    tenantId: string;
    botId: string;
    deploymentId: string;
    adminUserId: string;
  };
  /** 摄入源根目录（绝对路径；必须与 knowledge Provider 的 uploadsRoot 一致）。 */
  uploadsRoot: string;
  /** admin-web 静态目录（绝对路径）。 */
  webRoot?: string;
  /** 摄入单文件上限（默认 100 MiB，与 Provider 上限一致）。 */
  maxUploadBytes?: number;
  /** admin Bearer 令牌凭证引用（env 变量名）；必填，缺失 fail loud。 */
  adminTokenEnv: string;
  /** 摄入任务列表默认条数（默认 8）。 */
  defaultRunLimit?: number;
  /** 可选的只读 worker 观察面；完整校验与请求限制见 webui.md。 */
  controlPlane?: ControlPlaneConfig;
}

export interface AdminLimits {
  maxUploadBytes: number;
  defaultRunLimit: number;
}

function resolveBoundedInteger(value: number | undefined, bounds: IntegerBounds): number {
  if (value === undefined) return bounds.fallback;
  if (Number.isSafeInteger(value) && value >= bounds.minimum && value <= bounds.maximum) return value;
  throw new Error(
    `lark-admin: ${bounds.field} 配置必须为 ${bounds.minimum}..${bounds.maximum} 的安全整数`,
  );
}

/** 装载期固定两个 Provider 查询边界，零值也不允许静默回退。 */
export function resolveAdminLimits(config: Pick<Config, "maxUploadBytes" | "defaultRunLimit">): AdminLimits {
  return {
    maxUploadBytes: resolveBoundedInteger(config.maxUploadBytes, UPLOAD_BYTES_BOUNDS),
    defaultRunLimit: resolveBoundedInteger(config.defaultRunLimit, RUN_LIMIT_BOUNDS),
  };
}

/** 请求参数只接受规范十进制，非法输入不扩大已校验的默认查询范围。 */
export function parseIngestionRunLimit(value: string | null, fallback: number): number {
  if (!value || !DECIMAL_POSITIVE_INTEGER.test(value)) return fallback;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_RUN_LIMIT ? limit : fallback;
}

const ControlTargetSchema: z<ControlTargetConfig> = z.object({
  id: z.string().required(),
  label: z.string().required(),
  scope: z.object({
    tenantId: z.string().required(),
    botId: z.string().required(),
    deploymentId: z.string().required(),
    userId: z.string().required(),
    conversationId: z.string().required(),
  }).required(),
  defaultGeneration: z.number(),
});

const ControlPlaneSchema: z<ControlPlaneConfig> = z.object({
  workerBaseUrl: z.string().required(),
  workerTokenEnv: z.string().required(),
  requestTimeoutMs: z.number(),
  targets: z.array(ControlTargetSchema).required(),
});

export const Config: z<Config> = z.object({
  identity: z.object({
    tenantId: z.string().required(),
    botId: z.string().required(),
    deploymentId: z.string().required(),
    adminUserId: z.string().required(),
  }),
  uploadsRoot: z.string().required(),
  webRoot: z.string(),
  maxUploadBytes: z.number(),
  adminTokenEnv: z.string().required(),
  defaultRunLimit: z.number(),
  // Schemastery 的 object 缺省会归一为 {}；nullable 分支保留未配置状态。
  controlPlane: z.union([z.never(), ControlPlaneSchema]),
});
