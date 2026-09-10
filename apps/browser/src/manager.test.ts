import { mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import type { BrowserPage, BrowserRuntime } from "./cdp.js";
import type { BrowserConfig } from "./config.js";
import { BrowserManager } from "./manager.js";

const roots: string[] = [];
const scope = (user: string, conversation = "conversation"): Scope => ({
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId(user), conversationId: makeConversationId(conversation),
});

class FakePage implements BrowserPage {
  readonly opens: string[] = [];
  closed = false;
  async open(url: string) { this.opens.push(url); return { url }; }
  async snapshot() { return { nodes: [] }; }
  async click(selector: string) { return { selector }; }
  async type(selector: string, text: string) { return { selector, text }; }
  async wait(input: { selector?: string; milliseconds?: number }) { return input; }
  async evaluate(expression: string) { return expression; }
  logs(kind: "console" | "network") { return [{ kind }]; }
  async screenshot() { return Buffer.from("png"); }
  async close() { this.closed = true; }
}

class FakeRuntime implements BrowserRuntime {
  readonly pages: FakePage[] = [];
  readonly profiles: string[] = [];
  async launch(profile: string): Promise<BrowserPage> {
    this.profiles.push(profile);
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BrowserManager", () => {
  it("按完整 Scope 复用页面，不同会话使用独立 profile", async () => {
    const { manager, runtime, workspace } = await fixture();
    await manager.execute(scope("user-a", "a"), { operation: "open", workspace, url: "https://example.com" });
    await manager.execute(scope("user-a", "a"), { operation: "open", workspace, url: "https://example.org" });
    await manager.execute(scope("user-a", "b"), { operation: "open", workspace, url: "https://example.net" });
    expect(runtime.pages).toHaveLength(2);
    expect(runtime.pages[0]?.opens).toEqual(["https://example.com", "https://example.org"]);
    expect(new Set(runtime.profiles).size).toBe(2);
    await manager.dispose();
  });

  it("拒绝跨用户工作区和符号链接逃逸", async () => {
    const { manager, root, workspace } = await fixture();
    await expect(manager.execute(scope("user-b"), { operation: "open", workspace, url: "https://example.com" })).rejects.toMatchObject({ code: "BROWSER_FORBIDDEN" });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "users", "user-a", "escape"));
    await expect(manager.execute(scope("user-a"), { operation: "open", workspace: join(root, "users", "user-a", "escape"), url: "https://example.com" })).rejects.toMatchObject({ code: "BROWSER_FORBIDDEN" });
  });

  it("截图仅写入当前工作区 .dsh/browser 且禁止覆盖", async () => {
    const { manager, workspace } = await fixture();
    await manager.execute(scope("user-a"), { operation: "open", workspace, url: "https://example.com" });
    await expect(manager.execute(scope("user-a"), { operation: "screenshot", filename: "page.png" })).resolves.toEqual({ path: ".dsh/browser/page.png" });
    expect(await readFile(join(workspace, ".dsh", "browser", "page.png"), "utf8")).toBe("png");
    await expect(manager.execute(scope("user-a"), { operation: "screenshot", filename: "page.png" })).rejects.toMatchObject({ code: "BROWSER_CONFLICT" });
    await expect(manager.execute(scope("user-a"), { operation: "screenshot", filename: "../escape.png" })).rejects.toMatchObject({ code: "BROWSER_INVALID_INPUT" });
    await manager.dispose();
  });

  it("截图前重新校验工作区，拒绝会话建立后的符号链接替换", async () => {
    const { manager, root, workspace } = await fixture();
    await manager.execute(scope("user-a"), { operation: "open", workspace, url: "https://example.com" });
    const moved = `${workspace}-moved`;
    const outside = join(root, "outside-after-open");
    await mkdir(outside);
    await rename(workspace, moved);
    await symlink(outside, workspace);
    await expect(manager.execute(scope("user-a"), { operation: "screenshot", filename: "page.png" })).rejects.toMatchObject({ code: "BROWSER_FORBIDDEN" });
    await manager.dispose();
  });

  it("执行全局配额、关闭和空闲回收", async () => {
    vi.useFakeTimers();
    const { manager, runtime, workspace } = await fixture(1, 10_000);
    await manager.execute(scope("user-a"), { operation: "open", workspace, url: "https://example.com" });
    await expect(manager.execute(scope("user-a", "other"), { operation: "open", workspace, url: "https://example.org" })).rejects.toMatchObject({ code: "BROWSER_QUOTA" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(runtime.pages[0]?.closed).toBe(true);
    await expect(manager.execute(scope("user-a"), { operation: "snapshot" })).rejects.toMatchObject({ code: "BROWSER_NOT_OPEN" });
  });
});

async function fixture(maxSessions = 8, idleTimeoutMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "dsh-browser-manager-"));
  roots.push(root);
  const workspace = join(root, "users", "user-a", "project");
  const profileRoot = join(root, "profiles");
  await mkdir(workspace, { recursive: true });
  const runtime = new FakeRuntime();
  const manager = new BrowserManager({ workspaceRoot: root, profileRoot, maxSessions, idleTimeoutMs } as BrowserConfig, runtime);
  await manager.initialize();
  return { root, workspace, runtime, manager };
}
