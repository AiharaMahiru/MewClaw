import { describe, expect, it } from "vitest";

import { resolveBrowserConfig } from "./config.js";

const base = {
  DSH_BROWSER_TOKEN: "test-token",
  DSH_BROWSER_WORKSPACE_ROOT: "/var/lib/dsh/workspaces",
  DSH_BROWSER_STATE_ROOT: "/var/lib/dsh/browser",
};

describe("resolveBrowserConfig", () => {
  it("应用安全默认值并固定 loopback", () => {
    expect(resolveBrowserConfig(base)).toMatchObject({
      host: "127.0.0.1",
      port: 13_083,
      chromiumPath: "/usr/bin/chromium",
      profileRoot: "/var/lib/dsh/browser/profiles",
      maxSessions: 8,
      idleTimeoutMs: 600_000,
      maxScreenshotCount: 100,
      maxScreenshotBytes: 100 * 1024 * 1024,
    });
  });

  it("缺少令牌或使用相对目录时 fail loud", () => {
    expect(() => resolveBrowserConfig({ ...base, DSH_BROWSER_TOKEN: "" })).toThrow("未配置");
    expect(() => resolveBrowserConfig({ ...base, DSH_BROWSER_STATE_ROOT: "browser" })).toThrow("必须为绝对路径");
  });

  it("拒绝越界的会话数与超时", () => {
    expect(() => resolveBrowserConfig({ ...base, DSH_BROWSER_MAX_SESSIONS: "0" })).toThrow("安全整数");
    expect(() => resolveBrowserConfig({ ...base, DSH_BROWSER_IDLE_TIMEOUT_MS: "9999" })).toThrow("60000");
  });
});
