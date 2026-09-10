import { describe, expect, it } from "vitest";

import { chromiumArgs, evaluateResult, sanitizedSpawnEnv } from "./cdp.js";

describe("Chromium 启动边界", () => {
  it("脚本错误单独分类且不泄露原文，undefined 可序列化", () => {
    expect(() => evaluateResult({ exceptionDetails: { text: "sensitive script" } })).toThrow(/页面脚本/);
    try { evaluateResult({ exceptionDetails: {} }); } catch (error) {
      expect(error).toMatchObject({ code: "BROWSER_SCRIPT_ERROR" });
      expect(String(error)).not.toContain("sensitive script");
    }
    expect(evaluateResult({ result: { type: "undefined" } })).toBeNull();
    expect(evaluateResult({ result: { value: 0 } })).toBe(0);
    expect(evaluateResult({ result: { value: false } })).toBe(false);
    expect(evaluateResult({ result: { unserializableValue: "123n" } })).toBe("123n");
  });
  it("只使用 remote-debugging-pipe 和独立 profile", () => {
    const args = chromiumArgs("/tmp/profile-a");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--remote-debugging-pipe");
    expect(args).toContain("--user-data-dir=/tmp/profile-a");
    expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).not.toContain("--no-sandbox");
  });

  it("净化子进程环境且不继承凭证", () => {
    const env = sanitizedSpawnEnv("/tmp/profile-a");
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/tmp/profile-a", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" });
    expect(env.WORKER_TOKEN).toBeUndefined();
  });
});
