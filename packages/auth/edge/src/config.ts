import { resolve } from "node:path";

export interface AuthEdgeConfig {
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  workerBaseUrl: string;
  previewBaseUrl?: string;
  publicOrigin: string;
  adminBaseUrl?: string;
  workerToken?: string;
  adminToken?: string;
  pairingToken?: string;
  /** 用户私有模型 Profile 的独立 AES-256-GCM 主密钥，绝不复用系统凭据。 */
  userModelEncryptionKey: string;
  databaseUrl: string;
  trustedOrigins: readonly string[];
  sessionCookieSecure: boolean;
  userWorkspaceRoot: string;
  adminWorkspaceRoot: string;
  requestBodyLimit: number;
  /** 桌面二进制同步使用独立有界体积，不扩大普通 RPC 限制。 */
  desktopBodyLimit?: number;
  /** 默认开启；显式关闭仅用于不提供模型的隔离环境。 */
  promptAudit?: { enabled: boolean; timeoutMs: number; maxConcurrent: number };
  mail: MailConfig;
  feishu?: FeishuConfig;
}

export interface MailConfig {
  mode: "smtp" | "console";
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

const DEFAULT_BODY_LIMIT = 128 * 1024;
export const DEFAULT_PREVIEW_URL = "http://127.0.0.1:13082";

export function resolveAuthConfig(environment: Record<string, string | undefined>): AuthEdgeConfig {
  const databaseUrl = required(environment.AUTH_DATABASE_URL || environment.DATABASE_URL, "AUTH_DATABASE_URL");
  const port = positivePort(environment.AUTH_PORT, 3080);
  const secure = environment.AUTH_COOKIE_SECURE === "true";
  const origins = split(environment.AUTH_TRUSTED_ORIGINS || `http://127.0.0.1:${port}`).map((origin) => normalizeOrigin(origin, "AUTH_TRUSTED_ORIGINS"));
  const requestedMailMode = environment.AUTH_MAIL_MODE?.trim().toLowerCase();
  if (requestedMailMode && requestedMailMode !== "smtp" && requestedMailMode !== "console") throw new Error("AUTH_MAIL_MODE 必须是 smtp 或 console");
  // 认证邮件默认复用项目已有的邮件组；无邮件组时保留本地 console 模式。
  const mailHost = environment.AUTH_SMTP_HOST || environment.MAIL_HOST;
  const mailUser = environment.AUTH_SMTP_USER || environment.EMAIL;
  const mailPassword = environment.AUTH_SMTP_PASSWORD || environment.PASSWORD;
  const mailFrom = environment.AUTH_MAIL_FROM || mailUser;
  const hasMailGroup = Boolean(mailHost || mailUser || mailPassword || mailFrom);
  const mode: MailConfig["mode"] = requestedMailMode === "console" ? "console" : requestedMailMode === "smtp" || hasMailGroup ? "smtp" : "console";
  const mail: MailConfig = {
    mode,
    port: positivePort(environment.AUTH_SMTP_PORT || environment.SMTP_SSL_PORT, 465),
    secure: environment.AUTH_SMTP_SECURE !== "false",
    ...(mailHost ? { host: mailHost } : {}),
    ...(mailUser ? { user: mailUser } : {}),
    ...(mailPassword ? { password: mailPassword } : {}),
    ...(mailFrom ? { from: mailFrom } : {}),
  };
  if (mode === "smtp" && (!mail.host || !mail.user || !mail.password || !mail.from)) throw new Error("AUTH_MAIL_MODE=smtp 时必须配置 AUTH_SMTP_*，或复用 MAIL_HOST/SMTP_SSL_PORT/EMAIL/PASSWORD 邮件组");
  const feishu = environment.FEISHU_APP_ID && environment.FEISHU_APP_SECRET && environment.FEISHU_OAUTH_REDIRECT_URI
    ? {
        appId: environment.FEISHU_APP_ID,
        appSecret: environment.FEISHU_APP_SECRET,
        redirectUri: environment.FEISHU_OAUTH_REDIRECT_URI,
        authorizeUrl: environment.FEISHU_OAUTH_AUTHORIZE_URL || "https://open.feishu.cn/open-apis/authen/v1/authorize",
        tokenUrl: environment.FEISHU_OAUTH_TOKEN_URL || "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
        userInfoUrl: environment.FEISHU_OAUTH_USERINFO_URL || "https://open.feishu.cn/open-apis/authen/v1/user_info",
      }
    : undefined;
  const publicOrigin = normalizeOrigin(environment.AUTH_PUBLIC_ORIGIN || origins[0] || `http://127.0.0.1:${port}`, "AUTH_PUBLIC_ORIGIN");
  if (!origins.includes(publicOrigin)) throw new Error("AUTH_PUBLIC_ORIGIN 必须包含在 AUTH_TRUSTED_ORIGINS 中");
  if (new URL(publicOrigin).protocol === "https:" && !secure) throw new Error("HTTPS 公共 Origin 必须启用 AUTH_COOKIE_SECURE=true");
  const result: AuthEdgeConfig = {
    host: environment.AUTH_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
    port,
    workerBaseUrl: internalUrl(environment.DSH_WEB_INTERNAL_URL || "http://127.0.0.1:3081", "DSH_WEB_INTERNAL_URL"),
    previewBaseUrl: internalUrl(environment.PREVIEW_URL || DEFAULT_PREVIEW_URL, "PREVIEW_URL"),
    publicOrigin,
    databaseUrl,
    trustedOrigins: origins,
    sessionCookieSecure: secure,
    userWorkspaceRoot: resolve(environment.AUTH_USER_WORKSPACE_ROOT || ".workspaces/auth/users"),
    adminWorkspaceRoot: resolve(environment.AUTH_ADMIN_WORKSPACE_ROOT || ".workspaces/auth/admin"),
    requestBodyLimit: boundedInteger(environment.AUTH_BODY_LIMIT, DEFAULT_BODY_LIMIT, 1024, 4 * 1024 * 1024),
    desktopBodyLimit: boundedInteger(environment.AUTH_DESKTOP_BODY_LIMIT, 8 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    promptAudit: {
      enabled: auditEnabled(environment.AUTH_PROMPT_AUDIT_ENABLED),
      timeoutMs: boundedInteger(environment.AUTH_PROMPT_AUDIT_TIMEOUT_MS, 15_000, 100, 60_000),
      maxConcurrent: boundedInteger(environment.AUTH_PROMPT_AUDIT_MAX_CONCURRENT, 4, 1, 32),
    },
    userModelEncryptionKey: required(environment.AUTH_USER_MODEL_ENCRYPTION_KEY, "AUTH_USER_MODEL_ENCRYPTION_KEY"),
    mail,
  };
  if (environment.AUTH_ADMIN_URL) result.adminBaseUrl = internalUrl(environment.AUTH_ADMIN_URL, "AUTH_ADMIN_URL");
  if (environment.WORKER_TOKEN) result.workerToken = environment.WORKER_TOKEN;
  if (environment.ADMIN_TOKEN) result.adminToken = environment.ADMIN_TOKEN;
  if (environment.AUTH_PAIRING_TOKEN) result.pairingToken = environment.AUTH_PAIRING_TOKEN;
  if (feishu) result.feishu = feishu;
  return result;
}

function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} 未配置`); return value.trim(); }
function auditEnabled(value: string | undefined): boolean {
  if (value !== undefined && value !== "true" && value !== "false") throw new Error("AUTH_PROMPT_AUDIT_ENABLED 必须是 true 或 false");
  return value !== "false";
}
function split(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function positivePort(value: string | undefined, fallback: number): number { const result = Number(value || fallback); if (!Number.isSafeInteger(result) || result < 1 || result > 65535) throw new Error("端口配置无效"); return result; }
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number { if (!value) return fallback; const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("认证请求体上限无效"); return result; }
function internalUrl(value: string, name: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} URL 无效`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} 必须使用 HTTP(S)`);
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) throw new Error(`${name} 必须指向 loopback`);
  if (parsed.username || parsed.password) throw new Error(`${name} 不得包含凭证`);
  return parsed.toString().replace(/\/$/, "");
}
function normalizeOrigin(value: string, name: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} 包含无效 Origin`); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${name} 必须是纯 HTTP(S) Origin`);
  return parsed.origin;
}
