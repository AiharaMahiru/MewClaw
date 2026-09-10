export interface MailConfigInput {
  enabled?: boolean;
  host?: string;
  smtpPort?: number;
  imapPort?: number;
  defaultMailbox?: string;
  bodyMaxChars?: number;
}

export type ResolvedMailConfig =
  | { enabled: false }
  | {
    enabled: true;
    host: string;
    smtpPort: number;
    imapPort: number;
    defaultMailbox: string;
    bodyMaxChars: number;
  };

const DEFAULT_SMTP_PORT = 465;
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_BODY_MAX = 20_000;
const MAX_BODY_CHARS = 20_000;
const MAX_MAILBOX_CHARS = 255;
const RECENT_DEFAULT = 10;
const RECENT_MAX = 50;

function resolvePort(value: number | undefined, field: string, fallback: number): number {
  const port = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`mail-imap: ${field} must be an integer in [1, 65535]`);
  }
  return port;
}

function resolveBodyMaxChars(value: number | undefined): number {
  const bodyMaxChars = value === undefined ? DEFAULT_BODY_MAX : value;
  if (!Number.isSafeInteger(bodyMaxChars) || bodyMaxChars < 1 || bodyMaxChars > MAX_BODY_CHARS) {
    throw new Error(`mail-imap: bodyMaxChars must be an integer in [1, ${MAX_BODY_CHARS}]`);
  }
  return bodyMaxChars;
}

/** 归一化并限制 IMAP mailbox 名，避免空白或异常长值直接进入协议边界。 */
export function resolveMailbox(value: string | undefined, fallback = DEFAULT_MAILBOX): string {
  const mailbox = (value === undefined ? fallback : value).trim();
  if (!mailbox || mailbox.length > MAX_MAILBOX_CHARS) throw new Error("mail-imap: mailbox is invalid");
  return mailbox;
}

/** 服务边界接受最近邮件数量，只允许 1..50 的安全整数。 */
export function resolveRecentLimit(value: unknown): number {
  if (value === undefined) return RECENT_DEFAULT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > RECENT_MAX) {
    throw new Error(`mail-imap: recent limit must be an integer in [1, ${RECENT_MAX}]`);
  }
  return value;
}

/** UID 不是自由 IMAP 查询语法，只允许正安全整数。 */
export function resolveMailUid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("mail-imap: uid must be a positive safe integer");
  }
  return value;
}

/** disabled 时不解析未启用 Provider 的连接配置；enabled 时全部 fail loud。 */
export function resolveMailConfig(input: MailConfigInput): ResolvedMailConfig {
  if (input.enabled !== true) return { enabled: false };
  const host = input.host?.trim() ?? "";
  if (!host || host.length > 253) throw new Error("mail-imap: host is required when enabled");
  return {
    enabled: true,
    host,
    smtpPort: resolvePort(input.smtpPort, "smtpPort", DEFAULT_SMTP_PORT),
    imapPort: resolvePort(input.imapPort, "imapPort", DEFAULT_IMAP_PORT),
    defaultMailbox: resolveMailbox(input.defaultMailbox),
    bodyMaxChars: resolveBodyMaxChars(input.bodyMaxChars),
  };
}
