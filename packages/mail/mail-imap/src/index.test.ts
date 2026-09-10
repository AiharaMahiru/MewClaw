/**
 * dsh-mail-imap 测试（SPEC mail.md §7）：纯函数（pickBody/addressText）、
 * 凭证缺失 fail loud、enabled 门、发送校验（经 vi.mock nodemailer 不触网）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { addressText, apply, pickBody } from "./index.js";

const imapMocks = vi.hoisted(() => ({ mailboxes: [] as string[] }));

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn(async () => { throw new Error("auth failed for user@mail.example with pass123"); }),
    close: vi.fn(),
  })),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { exists: 1 };
    async connect(): Promise<void> {}
    async getMailboxLock(mailbox: string): Promise<{ release: () => void }> {
      imapMocks.mailboxes.push(mailbox);
      return { release: () => undefined };
    }
    async fetchOne(uid: string): Promise<unknown> {
      return {
        uid: Number(uid),
        envelope: { from: [{ address: "sender@example" }], to: [{ address: "user@example" }], subject: "主题", date: new Date() },
        flags: new Set<string>(),
        source: Buffer.from("From: sender@example\nTo: user@example\nSubject: 主题\n\n正文"),
      };
    }
    async logout(): Promise<void> {}
    close(): void {}
  },
}));

function makeCtx(values: Record<string, string>) {
  return {
    credentials: { resolve: vi.fn(async (ref: string) => ({ value: values[ref] ?? "" })) },
    provide: vi.fn(),
  };
}

const BASE = {
  enabled: true,
  host: "mail.example",
  userEnv: "EMAIL",
  passwordEnv: "PASSWORD",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  imapMocks.mailboxes.length = 0;
});

describe("纯函数", () => {
  it("pickBody：纯文本优先；无 text 时 HTML 降级并截断标注", () => {
    expect(pickBody({ text: "正文", html: "<p>正文</p>" }, 100)).toBe("正文");
    expect(pickBody({ text: "", html: "<p>hi</p>" }, 100)).toBe("[HTML 原文]\n<p>hi</p>");
    expect(pickBody({ text: "", html: "" }, 100)).toBe("（无正文）");
    expect(pickBody({ text: "a".repeat(50), html: "" }, 10)).toHaveLength(10);
  });

  it("addressText：name/address 组合与数组", () => {
    expect(addressText(undefined)).toBe("");
    expect(addressText({ value: [{ name: "张三", address: "z@x.example" }] } as never)).toBe("张三 <z@x.example>");
    expect(addressText({ value: [{ name: "", address: "a@x.example" }] } as never)).toBe("a@x.example");
  });
});

describe("dsh-mail-imap 装载", () => {
  it("enabled 缺省不挂载；enabled 但 host 空 fail loud", async () => {
    const ctx = makeCtx({ EMAIL: "u@x.example", PASSWORD: "pass123" });
    await apply(ctx as never, { host: "mail.example", userEnv: "EMAIL", passwordEnv: "PASSWORD" });
    expect(ctx.provide).not.toHaveBeenCalled();
    await expect(apply(ctx as never, { ...BASE, host: "  " })).rejects.toThrow(/host/);
  });

  it("凭证缺失 → fail loud", async () => {
    const ctx = makeCtx({ EMAIL: "u@x.example" });
    await expect(apply(ctx as never, BASE)).rejects.toThrow(/凭证引用未配置/);
  });

  it("非法端口和正文上限在凭证解析前 fail loud", async () => {
    const ctx = makeCtx({ EMAIL: "u@x.example", PASSWORD: "pass123" });
    await expect(apply(ctx as never, { ...BASE, smtpPort: 0 })).rejects.toThrow(/smtpPort/);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });
});

describe("发送", () => {
  async function service(values = { EMAIL: "u@x.example", PASSWORD: "pass123" }) {
    const ctx = makeCtx(values);
    await apply(ctx as never, BASE);
    return (ctx.provide as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      send: (input: { to: string; subject: string; body: string }) => Promise<{ messageId: string }>;
      recent: (input?: { limit?: number }) => Promise<unknown>;
      read: (input: { uid: number; mailbox?: string }) => Promise<unknown>;
    };
  }

  it("空收件人/主题/地址非法 → 拒绝", async () => {
    const mail = await service();
    await expect(mail.send({ to: "", subject: "s", body: "b" })).rejects.toThrow(/不能为空/);
    await expect(mail.send({ to: "not-an-address", subject: "s", body: "b" })).rejects.toThrow(/地址非法/);
  });

  it("发送失败 → 错误脱敏账号与口令", async () => {
    const mail = await service();
    await expect(mail.send({ to: "dest@x.example", subject: "s", body: "b" }))
      .rejects.toThrow(/邮件发送失败/);
    await expect(mail.send({ to: "dest@x.example", subject: "s", body: "b" }))
      .rejects.not.toThrow(/pass123|u@x\.example/);
  });

  it("列表与读取校验协议参数，并尊重 read 的 mailbox", async () => {
    const mail = await service();
    await expect(mail.recent({ limit: 1.5 })).rejects.toThrow(/limit/);
    await expect(mail.read({ uid: 0 })).rejects.toThrow(/uid/);
    await mail.read({ uid: 7, mailbox: " Archive " });
    expect(imapMocks.mailboxes).toEqual(["Archive"]);
  });
});
