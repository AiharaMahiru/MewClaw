import { describe, expect, it } from "vitest";
import { resolveClientConfig } from "./config.js";

describe("dsh-browser 配置", () => {
  it("默认使用 loopback daemon 与 WORKER_TOKEN 凭证引用", () => {
    expect(resolveClientConfig({})).toEqual({
      browserBaseUrl: "http://127.0.0.1:13083",
      tokenEnv: "WORKER_TOKEN",
      requestTimeoutMs: 30_000,
    });
  });

  it("拒绝公网、localhost、路径、凭证和越界超时", () => {
    for (const value of ["https://chat.rwr.ink", "http://localhost:13083", "http://127.0.0.1:13083/api", "http://u:p@127.0.0.1:13083"]) {
      expect(() => resolveClientConfig({ browserBaseUrl: value })).toThrow(/browserBaseUrl/);
    }
    expect(() => resolveClientConfig({ requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/);
    expect(() => resolveClientConfig({ tokenEnv: " " })).toThrow(/tokenEnv/);
  });
});
