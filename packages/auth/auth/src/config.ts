import z from "@deepseek-ai/schemastery";

import {
  DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS,
  MAX_AUTH_IMPORT_APPROVAL_TTL_MS,
  MIN_AUTH_IMPORT_APPROVAL_TTL_MS,
} from "./capability.js";

export interface Config {
  /** PostgreSQL 连接串的凭证引用；配置只保存引用名。 */
  databaseUrlEnv: string;
  /** 凭证回滚加密密钥的凭证引用；不得复用数据库或服务 Token。 */
  credentialRollbackKeyEnv: string;
  /** 凭证回滚加密文件目录；目录和文件由 Provider 设置最小权限。 */
  credentialRollbackPath: string;
  /** 新签发迁移批准的有效期。 */
  approvalTtlMs: number;
}

export const Config: z<Config> = z.object({
  databaseUrlEnv: z.string().required(),
  credentialRollbackKeyEnv: z.string().required(),
  credentialRollbackPath: z.string().required(),
  approvalTtlMs: z.natural()
    .min(MIN_AUTH_IMPORT_APPROVAL_TTL_MS)
    .max(MAX_AUTH_IMPORT_APPROVAL_TTL_MS)
    .default(DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS),
});
