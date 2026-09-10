/**
 * dsh-tool-mail 测试（SPEC mail.md §7）：三工具注册、参数校验、
 * scope 无关直连 ctx.mail、软确认提示段落。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply } from "./index.js";

interface RegisteredTool {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

function makeEnv() {
  const tools: RegisteredTool[] = [];
  const mail = {
    send: vi.fn(async () => ({ messageId: "<id-1@mail>" })),
    recent: vi.fn(async () => [{
      uid: 7, from: "张三 <z@x.example>", subject: "周报", date: "2026-08-16T01:00:00.000Z", seen: false,
    }]),
    read: vi.fn(async () => ({
      uid: 7, from: "张三 <z@x.example>", to: "我 <me@x.example>", subject: "周报",
      date: "2026-08-16T01:00:00.000Z", seen: false, body: "正文内容", attachments: ["a.pdf"],
    })),
  };
  const ctx = {
    mail,
    tools: { register: vi.fn((definition: RegisteredTool) => { tools.push(definition); return () => undefined; }) },
    systemPrompt: { section: vi.fn() },
  };
  apply(ctx as never, {});
  return { ctx, tools, mail };
}

let env: ReturnType<typeof makeEnv>;

beforeEach(() => {
  env = makeEnv();
});

describe("dsh-tool-mail", () => {
  it("注册三个工具与提示段（软确认声明）", () => {
    expect(env.tools.map((tool) => tool.name).sort()).toEqual(["mail_read", "mail_recent", "mail_send"]);
    expect(env.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ name: "tool:mail" }));
  });

  it("mail_send：非法地址拒绝；合法经 ctx.mail.send", async () => {
    const send = env.tools.find((tool) => tool.name === "mail_send")!;
    await expect(send.execute({ to: "bad", subject: "s", body: "b" }, {})).rejects.toThrow(/地址非法/);
    const result = await send.execute({ to: "dest@x.example", subject: "s", body: "b" }, {}) as { messageId: string };
    expect(result.messageId).toBe("<id-1@mail>");
    expect(env.mail.send).toHaveBeenCalledWith({ to: "dest@x.example", subject: "s", body: "b" });
  });

  it("mail_recent / mail_read：透传并回传结构", async () => {
    const recent = env.tools.find((tool) => tool.name === "mail_recent")!;
    const list = await recent.execute({ limit: 5 }, {}) as { messages: Array<{ uid: number }> };
    expect(env.mail.recent).toHaveBeenCalledWith({ limit: 5 });
    expect(list.messages[0]!.uid).toBe(7);
    await expect(recent.execute({ limit: 1.5 }, {})).rejects.toThrow(/limit/);
    await expect(recent.execute({ limit: 51 }, {})).rejects.toThrow(/limit/);

    const read = env.tools.find((tool) => tool.name === "mail_read")!;
    await expect(read.execute({ uid: 0 }, {})).rejects.toThrow(/uid/);
    await expect(read.execute({ uid: 9_007_199_254_740_992 }, {})).rejects.toThrow(/uid/);
    const message = await read.execute({ uid: 7 }, {}) as { subject: string; attachments: string[] };
    expect(message.subject).toBe("周报");
    expect(message.attachments).toEqual(["a.pdf"]);
  });

  it("enabled=false → 不注册", () => {
    const ctx = { mail: {}, tools: { register: vi.fn() }, systemPrompt: { section: vi.fn() } };
    apply(ctx as never, { enabled: false });
    expect(ctx.tools.register).not.toHaveBeenCalled();
  });
});
