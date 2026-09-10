import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";
import { apply, parseOpenArgs, parseScreenshotArgs, parseWaitArgs } from "./index.js";

const scope = {
  tenantId: makeTenantId("t"), botId: makeBotId("b"), deploymentId: makeDeploymentId("d"),
  userId: makeUserId("u"), conversationId: makeConversationId("c"),
};

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  output: { render: (args: unknown, value: unknown) => Array<{ text: string }> };
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

function makeEnv() {
  const tools: RegisteredTool[] = [];
  const page = { url: "https://example.com/", title: "Example" };
  const browser = {
    open: vi.fn(async () => page), snapshot: vi.fn(async () => ({ ...page, content: "button ref=e1", truncated: false })),
    click: vi.fn(async () => ({ clicked: true })), type: vi.fn(async () => ({ typed: true })), wait: vi.fn(async () => ({ waited: 100 })),
    evaluate: vi.fn(async () => ({ result: "ok", truncated: false })),
    console: vi.fn(async () => ({ entries: [], truncated: false })),
    network: vi.fn(async () => ({ entries: [], truncated: false })),
    screenshot: vi.fn(async () => ({ path: ".dsh/browser/page.png" })),
    close: vi.fn(async () => ({ closed: true })),
  };
  const ctx = {
    browser,
    larkScopeIndex: { get: vi.fn(() => scope) },
    tools: { register: vi.fn((definition: RegisteredTool) => { tools.push(definition); return () => undefined; }) },
    systemPrompt: { section: vi.fn(() => () => undefined) },
    effect: vi.fn((run: () => unknown) => { run(); return () => undefined; }),
  };
  apply(ctx as never, {});
  return { ctx, browser, tools };
}

let env: ReturnType<typeof makeEnv>;
const exec = { agent: { id: "session-1", session: { header: { cwd: "/workspace/user/project" } } } };

beforeEach(() => { env = makeEnv(); });

describe("dsh-tool-browser", () => {
  it("注册十个工具，模型 schema 不暴露 Scope、绝对工作区或 token", () => {
    expect(env.tools.map((tool) => tool.name)).toEqual([
      "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_wait",
      "browser_evaluate", "browser_console", "browser_network", "browser_screenshot", "browser_close",
    ]);
    const parameterNames = env.tools.flatMap((tool) => Object.keys(tool.parameters));
    expect(parameterNames).not.toEqual(expect.arrayContaining(["scope", "workspace", "token"]));
    expect(env.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ name: "tool:browser" }));
  });

  it("Scope 只取运行信封，截图 workspace 只取 session cwd", async () => {
    await env.tools.find((tool) => tool.name === "browser_open")!.execute({ url: "https://example.com" }, exec);
    expect(env.browser.open).toHaveBeenCalledWith({ scope, workspace: "/workspace/user/project", url: "https://example.com/" });
    await env.tools.find((tool) => tool.name === "browser_screenshot")!.execute({ filename: "page.png" }, exec);
    expect(env.browser.screenshot).toHaveBeenCalledWith({ scope, workspace: "/workspace/user/project", filename: "page.png" });
  });

  it("无 Scope 或无 cwd 时拒绝", async () => {
    env.ctx.larkScopeIndex.get = vi.fn(() => undefined) as never;
    await expect(env.tools[0]!.execute({ url: "https://example.com" }, exec)).rejects.toThrow(/Scope 信封/);
    env = makeEnv();
    const screenshot = env.tools.find((tool) => tool.name === "browser_screenshot")!;
    await expect(screenshot.execute({}, { agent: { id: "session-1", session: { header: {} } } })).rejects.toThrow(/workspace/);
  });

  it("参数边界拒绝凭证 URL、绝对路径和无条件等待", () => {
    expect(() => parseOpenArgs({ url: "https://u:p@example.com" })).toThrow(/无凭证/);
    expect(() => parseOpenArgs({ url: "file:///etc/passwd" })).toThrow(/HTTP/);
    expect(() => parseScreenshotArgs({ filename: "/tmp/a.png" })).toThrow(/相对/);
    expect(() => parseScreenshotArgs({ filename: "../a.png" })).toThrow(/相对/);
    expect(() => parseWaitArgs({})).toThrow(/至少提供/);
    expect(parseWaitArgs({ milliseconds: 1000, selector: "#ready" })).toEqual({ milliseconds: 1000, selector: "#ready" });
  });

  it("snapshot 渲染对模型输出实施硬上限", () => {
    const snapshot = env.tools.find((tool) => tool.name === "browser_snapshot")!;
    const rendered = snapshot.output.render({}, { url: "https://example.com", title: "t", content: "x".repeat(50_000), truncated: false })[0]!.text;
    expect(rendered.length).toBeLessThan(31_000);
    expect(rendered).toContain("输出已截断");
  });

  it("enabled=false 不注册", () => {
    const ctx = { effect: vi.fn(), tools: { register: vi.fn() }, systemPrompt: { section: vi.fn() } };
    apply(ctx as never, { enabled: false });
    expect(ctx.effect).not.toHaveBeenCalled();
  });
});
