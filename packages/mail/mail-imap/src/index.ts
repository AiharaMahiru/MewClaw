/**
 * dsh-mail-imap 插件入口（SPEC mail.md）：邮件能力缝 Provider。
 *
 * 发送 = nodemailer（SMTP over TLS 465）；收取 = imapflow + mailparser
 * （按需连接，摘要/正文拉取，不常驻、不标记已读）。错误信息脱敏账号与口令。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { ImapFlow } from "imapflow";
import type { ParsedMail } from "mailparser";
import z from "@deepseek-ai/schemastery";
import type { MailMessage, MailService, MailSummary } from "dsh-mail";

import { resolveMailConfig, resolveMailbox, resolveMailUid, resolveRecentLimit } from "./config.js";
import "dsh-mail";

export const name = "mail-imap";

export const inject = ["credentials"];

export interface Config {
  /** 是否启用（默认 false = 不挂载：mail 服务不提供，mail 工具随之不激活——可选能力语义）。 */
  enabled?: boolean;
  /** 邮件服务器主机（非密钥；bundle 经 !!js process.env.MAIL_HOST 注入）。 */
  host: string;
  /** SMTP 端口（默认 465，隐式 TLS）。 */
  smtpPort?: number;
  /** IMAP 端口（默认 993，隐式 TLS）。 */
  imapPort?: number;
  /** 账号凭证引用（EMAIL）。 */
  userEnv: string;
  /** 口令/应用专用密码凭证引用（PASSWORD）。 */
  passwordEnv: string;
  /** 默认邮箱（默认 INBOX）。 */
  defaultMailbox?: string;
  /** 正文截断（默认 20000 字符）。 */
  bodyMaxChars?: number;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  host: z.string(),
  smtpPort: z.number(),
  imapPort: z.number(),
  userEnv: z.string().required(),
  passwordEnv: z.string().required(),
  defaultMailbox: z.string(),
  bodyMaxChars: z.number(),
});

/** 纯文本优先；无 text 部分时 HTML 原文截断（标注）。 */
export function pickBody(message: Pick<ParsedMail, "text" | "html">, maxChars: number): string {
  const text = typeof message.text === "string" ? message.text : "";
  if (text.trim().length > 0) return text.slice(0, maxChars);
  const html = typeof message.html === "string" ? message.html
    : Array.isArray(message.html) ? message.html.join("") : "";
  if (html.trim().length > 0) return `[HTML 原文]\n${html.slice(0, maxChars)}`;
  return "（无正文）";
}

type AddressEntry = { name?: unknown; address?: unknown };

/** 地址对象 → 展示串（wire 边界：imapflow envelope 与 mailparser 形态并收）。 */
export function addressText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const items = (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
  return items.flatMap((item) => {
    const holder = (Array.isArray(item.value) ? item.value[0] : item) as AddressEntry | undefined;
    if (!holder) return [];
    const address = typeof holder.address === "string" ? holder.address : "";
    const name = typeof holder.name === "string" && holder.name ? holder.name : "";
    return [name ? `${name} <${address}>` : address];
  }).filter(Boolean).join(", ");
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveMailConfig(config);
  if (!resolved.enabled) return;
  const { host, smtpPort, imapPort, defaultMailbox, bodyMaxChars } = resolved;
  const user = (await ctx.credentials!.resolve(config.userEnv as CredentialRef))?.value ?? "";
  const password = (await ctx.credentials!.resolve(config.passwordEnv as CredentialRef))?.value ?? "";
  if (!user || !password) {
    throw new Error(`mail-imap: 凭证引用未配置（${config.userEnv}/${config.passwordEnv}）——口令绝不写入配置或日志`);
  }
  const redact = (text: string): string => text.replaceAll(password, "[REDACTED]").replaceAll(user, "[REDACTED]");
  const sendViaSmtp = async (to: string, subject: string, body: string): Promise<{ messageId: string }> => {
    const nodemailer = await import("nodemailer");
    const sender = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: true,
      auth: { user, pass: password },
    });
    try {
      const info = await sender.sendMail({ from: user, to, subject, text: body });
      return { messageId: info.messageId ?? "" };
    } finally {
      sender.close();
    }
  };

  /** IMAP 会话：连接即用即关；回调式窄化（测试可 vi.mock 动态导入）。 */
  const withImap = async <T>(mailbox: string, run: (client: ImapFlow) => Promise<T>): Promise<T> => {
    const { ImapFlow: Client } = await import("imapflow");
    const client: ImapFlow = new Client({
      host,
      port: imapPort,
      secure: true,
      auth: { user, pass: password },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await run(client);
    } finally {
      lock.release();
      await client.logout().catch(() => client.close());
    }
  };

  const service: MailService = {
    async send(input) {
      const to = input.to.trim();
      const subject = input.subject.trim();
      if (!to || !subject) throw new Error("收件人与主题不能为空");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`收件人地址非法：${to}`);
      try {
        return await sendViaSmtp(to, subject, input.body);
      } catch (error) {
        throw new Error(redact(`邮件发送失败：${error instanceof Error ? error.message : "unknown"}`));
      }
    },

    async recent(input) {
      const limit = resolveRecentLimit(input?.limit);
      try {
        return await withImap(resolveMailbox(input?.mailbox, defaultMailbox), async (client) => {
          const mailbox = client.mailbox;
          const total = mailbox && typeof mailbox.exists === "number" ? mailbox.exists : 0;
          const start = Math.max(1, total - limit + 1);
          const summaries: MailSummary[] = [];
          for await (const message of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
            const envelope = message.envelope;
            summaries.push({
              uid: message.uid,
              from: addressText(envelope?.from),
              subject: envelope?.subject ?? "（无主题）",
              date: (envelope?.date ?? new Date()).toISOString(),
              seen: message.flags?.has("\\Seen") ?? false,
            });
          }
          return summaries.sort((left, right) => right.uid - left.uid).slice(0, limit);
        });
      } catch (error) {
        throw new Error(redact(`邮件拉取失败：${error instanceof Error ? error.message : "unknown"}`));
      }
    },

    async read(input) {
      const uid = resolveMailUid(input.uid);
      try {
        return await withImap(resolveMailbox(input.mailbox, defaultMailbox), async (client): Promise<MailMessage> => {
          const found = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, source: true }, { uid: true });
          if (!found) throw new Error(`邮件不存在（uid ${uid}）`);
          const { simpleParser } = await import("mailparser");
          const parsed: ParsedMail = await simpleParser(found.source ?? Buffer.alloc(0));
          return {
            uid: found.uid,
            from: addressText(found.envelope?.from) || addressText(parsed.from),
            to: addressText(found.envelope?.to) || addressText(parsed.to),
            subject: found.envelope?.subject ?? parsed.subject ?? "（无主题）",
            date: (found.envelope?.date ?? parsed.date ?? new Date()).toISOString(),
            seen: found.flags?.has("\\Seen") ?? false,
            body: pickBody(parsed, bodyMaxChars),
            attachments: (parsed.attachments ?? []).map((item) => item.filename ?? "unnamed"),
          };
        });
      } catch (error) {
        throw new Error(redact(`邮件读取失败：${error instanceof Error ? error.message : "unknown"}`));
      }
    },
  };
  ctx.provide("mail", service);
}
