import { describe, expect, it } from "vitest";

import { resolveMailConfig, resolveMailbox, resolveMailUid, resolveRecentLimit } from "./config.js";

describe("mail-imap 配置与请求边界", () => {
  it("disabled 时不要求未启用 Provider 的网络配置", () => {
    expect(resolveMailConfig({})).toEqual({ enabled: false });
  });

  it("enabled 时使用有限默认值并保留合法配置", () => {
    expect(resolveMailConfig({ enabled: true, host: " mail.example " })).toEqual({
      enabled: true,
      host: "mail.example",
      smtpPort: 465,
      imapPort: 993,
      defaultMailbox: "INBOX",
      bodyMaxChars: 20_000,
    });
    expect(resolveMailConfig({
      enabled: true,
      host: "mail.example",
      smtpPort: 587,
      imapPort: 143,
      defaultMailbox: "Archive",
      bodyMaxChars: 1,
    })).toMatchObject({ smtpPort: 587, imapPort: 143, defaultMailbox: "Archive", bodyMaxChars: 1 });
  });

  it.each([
    [{ enabled: true, host: "" }, "host"],
    [{ enabled: true, host: "mail.example", smtpPort: 0 }, "smtpPort"],
    [{ enabled: true, host: "mail.example", imapPort: 65_536 }, "imapPort"],
    [{ enabled: true, host: "mail.example", bodyMaxChars: 0 }, "bodyMaxChars"],
    [{ enabled: true, host: "mail.example", defaultMailbox: "  " }, "mailbox"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveMailConfig(config)).toThrow(field);
  });

  it("限制动态邮箱、列表数量和 UID", () => {
    expect(resolveMailbox(" Archive ", "INBOX")).toBe("Archive");
    expect(resolveRecentLimit(undefined)).toBe(10);
    expect(resolveRecentLimit(50)).toBe(50);
    expect(resolveMailUid(7)).toBe(7);
    expect(() => resolveMailbox(" ", "INBOX")).toThrow("mailbox");
    expect(() => resolveRecentLimit(1.5)).toThrow("limit");
    expect(() => resolveMailUid(0)).toThrow("uid");
    expect(() => resolveMailUid(9_007_199_254_740_992)).toThrow("uid");
  });
});
