/**
 * dsh-tool-mail 插件入口（SPEC mail.md §2）：邮件能力缝 Consumer。
 * mail_send（发送前复述确认——软确认在提示词层）/ mail_recent / mail_read。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import type {} from "dsh-mail";

import "dsh-mail";

export const name = "tool-mail";

export const inject = ["mail", "systemPrompt", "tools"];

export interface Config {
  /** 是否注册工具（默认 true）。 */
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
});

const MAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECENT_LIMIT_MAX = 50;

function parseRecentLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > RECENT_LIMIT_MAX) {
    throw new Error(`mail_recent: limit 必须是 1..${RECENT_LIMIT_MAX} 的安全整数`);
  }
  return value;
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;

  ctx.systemPrompt.section({
    name: "tool:mail",
    order: 125,
    text:
      "Use mail tools to manage the user's mailbox: mail_recent lists recent messages, mail_read fetches one, "
      + "mail_send sends plain text from the user's own account. Before mail_send, restate recipient and subject "
      + "to the user and send only after they have effectively asked for it in this conversation.",
  });

  ctx.tools.register(defineTool({
    name: "mail_send",
    description: "Send a plain-text email from the user's configured mailbox.",
    parameters: {
      to: { type: "string", required: true, description: "Recipient email address." },
      subject: { type: "string", required: true, description: "Email subject." },
      body: { type: "string", required: true, description: "Plain-text body." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          messageId: { type: "string", required: true },
          to: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `邮件已发送至 ${(value as { to: string }).to}（${(value as { messageId: string }).messageId || "已投递"}）`,
      }],
    },
    async execute(args) {
      const input = args as { to?: unknown; subject?: unknown; body?: unknown };
      const to = typeof input.to === "string" ? input.to.trim() : "";
      const subject = typeof input.subject === "string" ? input.subject.trim() : "";
      const body = typeof input.body === "string" ? input.body : "";
      if (!MAIL_ADDRESS.test(to)) throw new Error(`mail_send: 收件人地址非法（${to}）`);
      const result = await ctx.mail!.send({ to, subject, body });
      return { messageId: result.messageId, to };
    },
  }));

  ctx.tools.register(defineTool({
    name: "mail_recent",
    description: "List recent emails (summaries: uid, from, subject, date).",
    parameters: {
      limit: { type: "number", description: "How many messages (default 10, max 50)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          messages: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                uid: { type: "number", required: true },
                from: { type: "string", required: true },
                subject: { type: "string", required: true },
                date: { type: "string", required: true },
                seen: { type: "boolean", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: (value as { messages: Array<{ uid: number; from: string; subject: string; date: string }> }).messages
          .map((message) => `- [${message.uid}] ${message.from}：${message.subject}（${message.date}）`)
          .join("\n") || "（无邮件）",
      }],
    },
    async execute(args) {
      const input = args as { limit?: unknown };
      const limit = parseRecentLimit(input.limit);
      const messages = await ctx.mail!.recent(limit === undefined ? undefined : { limit });
      return { messages };
    },
  }));

  ctx.tools.register(defineTool({
    name: "mail_read",
    description: "Read one email by uid (from mail_recent).",
    parameters: {
      uid: { type: "number", required: true, description: "Message uid from mail_recent." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          uid: { type: "number", required: true },
          from: { type: "string", required: true },
          to: { type: "string", required: true },
          subject: { type: "string", required: true },
          date: { type: "string", required: true },
          body: { type: "string", required: true },
          attachments: { type: "array", items: { type: "string" }, required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `${(value as { subject: string }).subject}\n${(value as { from: string }).from} → ${(value as { to: string }).to}（${(value as { date: string }).date}）\n\n${(value as { body: string }).body}`,
      }],
    },
    async execute(args) {
      const input = args as { uid?: unknown };
      if (typeof input.uid !== "number" || !Number.isSafeInteger(input.uid) || input.uid <= 0) {
        throw new Error("mail_read: uid 必须是正整数");
      }
      return await ctx.mail!.read({ uid: input.uid });
    },
  }));
}
