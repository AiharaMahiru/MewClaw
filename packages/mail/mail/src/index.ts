/**
 * dsh-mail 能力缝 Definition（SPEC mail.md）：MailService 契约 + 类型 +
 * Context 合并。纯类型包，无运行时依赖；Provider（dsh-mail-imap）与
 * Consumer（dsh-tool-mail）分置。
 */
import "@deepseek-ai/cordis";

/** 最近邮件摘要（列表用）。 */
export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  /** ISO 时刻（服务器时区归一由 Provider 负责）。 */
  date: string;
  seen: boolean;
}

/** 单封邮件（读取用；附件仅文件名）。 */
export interface MailMessage extends MailSummary {
  to: string;
  /** 纯文本优先；无 text 部分时 HTML 原文截断（Provider 标注）。 */
  body: string;
  attachments: string[];
}

/** 发送输入。 */
export interface MailSendInput {
  to: string;
  subject: string;
  body: string;
}

export interface MailService {
  /** 发送纯文本邮件（发件人 = 配置账号）；返回投递 message id。 */
  send(input: MailSendInput): Promise<{ messageId: string }>;
  /** 最近邮件摘要（默认 10 封，上限 50；按需 IMAP 拉取，不标记已读）。 */
  recent(input?: { limit?: number; mailbox?: string }): Promise<MailSummary[]>;
  /** 读取单封（uid + mailbox）。 */
  read(input: { uid: number; mailbox?: string }): Promise<MailMessage>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 邮件能力缝（worker 宿主面；Provider = dsh-mail-imap）。 */
    mail?: MailService;
  }
}
