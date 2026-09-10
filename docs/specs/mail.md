# dsh-mail SPEC（邮件能力缝：SMTP 发送 + IMAP 收取管理）

## 1 目的与边界

模型可用的个人邮箱面：发送（SMTP）、最近邮件列表与单封读取（IMAP，按需拉取，无后台轮询守护）。对应用户 `.env` 邮件组（`MAIL_HOST`/`SMTP_SSL_PORT`/`IMAPS_PORT`/`EMAIL`/`PASSWORD`）。凭据是用户自己的邮箱账号——**授权用户 Scope 即授权以其账号收发**（个人机器人语义，SPEC 明示该信任边界）。

## 2 能力缝结构

| 角色 | 包 | 职责 |
| --- | --- | --- |
| Definition | `dsh-mail` | `MailService` 契约 + 类型 + Context 合并（纯类型，无依赖） |
| Provider | `dsh-mail-imap` | nodemailer（SMTP 发送）+ imapflow（IMAP list/read）实现 |
| Consumer | `dsh-tool-mail` | `mail_send` / `mail_recent` / `mail_read` 三个模型工具 |

依赖预算：Node 标准库无 SMTP 客户端与 IMAP 协议实现——`nodemailer` 与 `imapflow`（同作者维护、纯 JS）是最小充分依赖，批准引入。

## 3 服务契约

```ts
interface MailService {  // ctx.mail
  /** 发送纯文本邮件（发件人 = 配置账号）。返回投递 message id。 */
  send(input: { to: string; subject: string; body: string }): Promise<{ messageId: string }>
  /** 最近邮件摘要（按需 IMAP 拉取；默认 10 封，上限 50）。 */
  recent(input?: { limit?: number; mailbox?: string }): Promise<MailSummary[]>
  /** 读取单封（uid + mailbox）正文（纯文本优先，HTML 降级为原文截断）。 */
  read(input: { uid: number; mailbox?: string }): Promise<MailMessage>
}

interface MailSummary { uid: number; from: string; subject: string; date: string; seen: boolean }
interface MailMessage extends MailSummary { to: string; body: string; attachments: string[] }  // attachments 仅文件名
```

## 4 配置契约（Provider）

```ts
interface Config {
  enabled?: boolean              // 默认 false；false 时 Provider 不挂载
  host: string                 // MAIL_HOST（非密钥，bundle 经 !!js 注入）
  smtpPort?: number            // 默认 465，1..65535（SMTP_SSL_PORT）
  imapPort?: number            // 默认 993，1..65535（IMAPS_PORT）
  userEnv: string              // EMAIL（凭证引用）
  passwordEnv: string          // PASSWORD（凭证引用，应用专用密码）
  defaultMailbox?: string      // 默认 INBOX，非空且最多 255 字符
  bodyMaxChars?: number        // 正文截断（默认 20000，1..20000）
}
```

`enabled !== true` 时不会读取该 Provider 的凭证或连接配置；一旦启用，host、端口、
邮箱名与正文预算在凭证解析前校验。只有字段缺省时取默认，显式零值、负数、小数、
不安全或超范围数值均 fail loud。

## 5 行为契约

- 发送：SMTP over TLS（465 implicit）；拒绝空收件人/主题；投递失败 fail loud（错误脱敏账号口令）。
- 拉取：`recent` 只取摘要头（uid/from/subject/date/seen），不标记已读；`read` 按其传入的 mailbox 取正文，纯文本优先，HTML 无 text 部分时原文截断 + 标注。`recent.limit` 只接受 1..50 的安全整数，UID 必须为正安全整数，邮箱名先规范化再进入 IMAP 协议边界。
- 一切错误信息脱敏（user/password 出现即替换 `[REDACTED]`）。
- V1 边界：附件只列文件名不下载；不发送附件；无后台推送（收取按需）。

## 6 安全与信任

- 口令只经凭证引用；绝不入日志/事件/卡片/模型输出。
- `mail_send` 是外发动作：工具描述要求模型在发送前向用户复述收件人与主题确认（软确认，提示词层）；硬门（userQuestions 审批）留待需要时立项。
- IMAP 连接按请求建立即关（无连接常驻）。

## 7 测试契约

`unit`：脱敏、摘要 wire 映射、正文截断与 HTML 降级、参数校验（空收件人拒绝、limit 上限）；发送/拉取经依赖注入 mock（nodemailer/imapflow 不触网）。

## 8 迁移映射

新能力（lark-claw 无邮件实现；`.env` 邮件组为本 SPEC 首个消费方）。

## 9 行为变化

无前序行为；记录：`SMTP_STARTTLS_PORT`（587 显式 STARTTLS）暂不消费——465 隐式 TLS 覆盖主流邮箱，需要时加 `smtpSecure: false` + 587 支持。
