import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";

import { ChromiumRuntime } from "./cdp.js";
import type { BrowserConfig } from "./config.js";
import { BrowserManager } from "./manager.js";
import { UrlPolicy, UrlPolicyError } from "./url-policy.js";
import { fileOperation, testing as cdgPaths } from "dsh-tool-cdg";

const run = process.env.DSH_BROWSER_E2E === "1" ? describe : describe.skip;

run("真实 Chromium", () => {
  let root = "";
  let workspace = "";
  let profileRoot = "";
  let baseUrl = "";
  let fixture: Server;
  let blockedRequests = 0;
  let popupRequests = 0;
  let manager: BrowserManager;

  const scope = {
    tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
    userId: makeUserId("user-e2e"), conversationId: makeConversationId("conversation"),
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-browser-e2e-"));
    workspace = join(root, "workspaces", "users", scope.userId, "project");
    profileRoot = join(root, "profiles");
    await mkdir(workspace, { recursive: true });
    fixture = createServer((req, res) => {
      if (req.url === "/delivery") {
        res.writeHead(200, { "content-type": "text/html" });
        void readFile(join(workspace, "delivery.html")).then(data => res.end(data), () => res.end("missing"));
        return;
      }
      if (req.url === "/blocked") {
        blockedRequests++;
        res.writeHead(200, { "content-type": "image/png" });
        return res.end("blocked");
      }
      if (req.url === "/api") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"ok":true}');
      }
      if (req.url === "/popup") {
        popupRequests++;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>popup</title>");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <title>Browser E2E</title>
        <input id="name" aria-label="name">
        <button id="run" onclick="const value = document.querySelector('#name').value; console.log('clicked', value); fetch('/api').then(() => { const done = document.createElement('p'); done.id = 'done'; done.textContent = value; document.body.append(done); })">Run</button>
        <button id="popup" onclick="window.open('/popup', '_blank')">Popup</button>
        <a id="popup-link" href="/popup" target="_blank">Popup link</a>
        <img src="/blocked" alt="blocked">
      `);
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

    const policy = new UrlPolicy();
    const productionResolve = policy.resolveAllowed.bind(policy);
    vi.spyOn(policy, "resolveAllowed").mockImplementation(async (input, topLevel) => {
      const url = new URL(input);
      if (url.origin === baseUrl) {
        if (url.pathname === "/blocked") throw new UrlPolicyError();
        return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
      }
      return productionResolve(input, topLevel);
    });
    const config = {
      workspaceRoot: join(root, "workspaces"), profileRoot, maxSessions: 2,
      idleTimeoutMs: 60_000, actionTimeoutMs: 10_000,
    } as BrowserConfig;
    manager = new BrowserManager(config, new ChromiumRuntime("/usr/bin/chromium", policy, 10_000, 100, 256 * 1024));
    await manager.initialize();
  });

  afterAll(async () => {
    await manager?.dispose();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("完成交互、诊断和截图，并清理独立 profile 与进程", async () => {
    expect(await profileProcessCount(profileRoot)).toBe(0);
    await expect(manager.execute(scope, { operation: "open", workspace, url: baseUrl })).resolves.toMatchObject({
      url: `${baseUrl}/`, title: "Browser E2E",
    });
    const snapshot = await manager.execute(scope, { operation: "snapshot" }) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      url: `${baseUrl}/`, title: "Browser E2E",
    });
    expect(snapshot.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '[data-dsh-ref="e1"]' }),
    ]));
    await manager.execute(scope, { operation: "type", selector: "#name", text: "MewClaw" });
    await manager.execute(scope, { operation: "click", selector: "#run" });
    await expect(manager.execute(scope, { operation: "wait", selector: "#done" })).resolves.toEqual({ found: true });
    await expect(manager.execute(scope, { operation: "evaluate", expression: "document.querySelector('#done').textContent" })).resolves.toBe("MewClaw");
    await expect(manager.execute(scope, { operation: "evaluate", expression: String.raw`(() => { const objects = ['1 0 obj', '20 0 obj']; return objects.map(o => /^(\d+) 0 obj/.exec(o)[1]); })()` })).resolves.toEqual(["1", "20"]);
    await expect(manager.execute(scope, { operation: "evaluate", expression: "void 0" })).resolves.toBeNull();
    await expect(manager.execute(scope, { operation: "evaluate", expression: "(() => { invalid syntax })()" })).rejects.toMatchObject({ code: "BROWSER_SCRIPT_ERROR" });
    expect(JSON.stringify(await manager.execute(scope, { operation: "console" }))).toContain("clicked");
    expect(JSON.stringify(await manager.execute(scope, { operation: "network" }))).toContain("/api");

    await expect(manager.execute(scope, { operation: "evaluate", expression: "(() => { const descriptor = Object.getOwnPropertyDescriptor(window, 'open'); return { native: /\\[native code\\]/.test(String(window.open)), configurable: descriptor?.configurable, writable: descriptor?.writable }; })()" }))
      .resolves.toEqual({ native: true, configurable: true, writable: true });
    await manager.execute(scope, { operation: "click", selector: "#popup" });
    await manager.execute(scope, { operation: "click", selector: "#popup-link" });
    await manager.execute(scope, { operation: "wait", milliseconds: 250 });
    await expect(manager.execute(scope, { operation: "evaluate", expression: "location.href" })).resolves.toBe(`${baseUrl}/`);
    expect(blockedRequests).toBe(0);
    expect(popupRequests).toBe(0);

    const shot = await manager.execute(scope, { operation: "screenshot", filename: "page.png" }) as { path: string };
    expect(shot.path).toBe(".dsh/browser/page.png");
    const screenshot = join(workspace, shot.path);
    expect((await stat(screenshot)).size).toBeGreaterThan(100);
    expect((await readFile(screenshot)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    // 实际截图经CDG包装导出后由Chromium解码，验证中文及内嵌图片而不依赖外链。
    await writeFile(join(workspace, "source.html"), '<html><body>中文交付<img src=".dsh/browser/page.png"></body></html>');
    await fileOperation({ action: "embed_images", path: "source.html", output_path: "delivery.html" }, {
      root: workspace,
      run: async argv => (await promisify(execFile)("/opt/dsh/runtime/cdgbridge/1.0.0/cdgbridge", argv)).stdout,
      file: path => cdgPaths.existingFile(workspace, path),
      existing: path => cdgPaths.existingPath(workspace, path),
      writable: path => cdgPaths.writablePath(workspace, path),
    });
    await manager.execute(scope, { operation: "open", workspace, url: `${baseUrl}/delivery` });
    await expect(manager.execute(scope, { operation: "evaluate", expression: "(async () => { const img = document.querySelector('img'); await img.decode(); return { text: document.body.textContent, embedded: img.src.startsWith('data:image/png;base64,'), width: img.naturalWidth }; })()" })).resolves.toMatchObject({ text: "中文交付", embedded: true, width: expect.any(Number) });
    await expect(manager.execute(scope, { operation: "evaluate", expression: "document.querySelector('img').naturalWidth > 0" })).resolves.toBe(true);

    await expect(manager.execute(scope, { operation: "close" })).resolves.toEqual({ closed: true });
    expect(await readdir(profileRoot)).toEqual([]);
    expect(await profileProcessCount(profileRoot)).toBe(0);
  }, 30_000);
});

const runPublic = process.env.DSH_BROWSER_PUBLIC_E2E === "1" ? describe : describe.skip;

runPublic("真实公网 Chromium", () => {
  it("使用生产 URL 策略打开公网 HTTPS，并拒绝 loopback", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-browser-public-e2e-"));
    const publicScope = {
      tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
      userId: makeUserId("user-public"), conversationId: makeConversationId("conversation"),
    };
    const workspace = join(root, "workspaces", "users", publicScope.userId, "project");
    const profileRoot = join(root, "profiles");
    await mkdir(workspace, { recursive: true });
    const config = {
      workspaceRoot: join(root, "workspaces"), profileRoot, maxSessions: 1,
      idleTimeoutMs: 60_000, actionTimeoutMs: 20_000,
    } as BrowserConfig;
    const manager = new BrowserManager(config, new ChromiumRuntime("/usr/bin/chromium", new UrlPolicy(), 20_000, 100, 256 * 1024));
    try {
      await manager.initialize();
      await expect(manager.execute(publicScope, { operation: "open", workspace, url: "https://example.com/" })).resolves.toMatchObject({
        url: "https://example.com/", title: "Example Domain",
      });
      await manager.execute(publicScope, { operation: "close" });
      await expect(manager.execute(publicScope, { operation: "open", workspace, url: "http://127.0.0.1/" }))
        .rejects.toMatchObject({ code: "BROWSER_FORBIDDEN" });
      expect(await readdir(profileRoot)).toEqual([]);
      expect(await profileProcessCount(profileRoot)).toBe(0);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

async function profileProcessCount(profileRoot: string): Promise<number> {
  const entries = await readdir("/proc");
  const matches = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    return command.includes(profileRoot) ? 1 as number : 0 as number;
  }));
  return matches.reduce((total, value) => total + value, 0);
}
