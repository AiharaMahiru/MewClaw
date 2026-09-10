import type { MailSender } from "dsh-lark-auth";
import nodemailer from "nodemailer";
import { getCACertificates } from "node:tls";

import type { MailConfig } from "./config.js";

export function createMailSender(config: MailConfig, logger: (line: string) => void = console.log): MailSender {
  if (config.mode === "console") {
    return {
      async sendVerification(input) { logger(`[auth-mail] verification recipient=${input.to} code=${input.code}`); },
      async sendPasswordReset(input) { logger(`[auth-mail] password-reset recipient=${input.to} link=${input.token}`); },
    };
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // Windows 的生产 SMTP 根证书位于系统 CA；保留 Node 默认 CA，避免削弱 TLS 校验。
    tls: { ca: [...getCACertificates("default"), ...getCACertificates("system")] },
  });
  const send = async (to: string, displayName: string, subject: string, link: string): Promise<void> => {
    await transport.sendMail({ from: config.from, to, subject, text: `你好，${displayName}。\n\n请打开以下链接完成操作：\n${link}\n\n如果这不是你的操作，请忽略本邮件。` });
  };
  const sendVerification = async (to: string, displayName: string, code: string, expiresInMinutes: number): Promise<void> => {
    await transport.sendMail({ from: config.from, to, subject: "验证 MewClaw 邮箱", text: `你好，${displayName}。\n\n你的邮箱验证码是：${code}\n验证码 ${expiresInMinutes} 分钟内有效，且只能使用一次。\n\n如果这不是你的操作，请忽略本邮件。` });
  };
  return {
    sendVerification: (input) => sendVerification(input.to, input.displayName, input.code, input.expiresInMinutes),
    sendPasswordReset: (input) => send(input.to, input.displayName, "重置 MewClaw 密码", input.token),
  };
}
