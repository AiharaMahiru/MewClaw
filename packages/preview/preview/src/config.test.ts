import { describe, expect, it } from "vitest";

import { resolveClientConfig } from "./config.js";

describe("resolveClientConfig", () => {
  it("仅在 undefined 时应用默认值", () => {
    expect(resolveClientConfig({ tokenEnv: "WORKER_TOKEN" })).toEqual({
      previewBaseUrl: "http://127.0.0.1:13082",
      tokenEnv: "WORKER_TOKEN",
      requestTimeoutMs: 30_000,
    });
    expect(() => resolveClientConfig({ tokenEnv: "WORKER_TOKEN", requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/);
  });

  it("拒绝非 loopback、带路径或带凭证的 daemon URL", () => {
    for (const value of ["https://chat.rwr.ink", "http://localhost:13082", "http://127.0.0.1:13082/api", "http://u:p@127.0.0.1:13082"]) {
      expect(() => resolveClientConfig({ tokenEnv: "WORKER_TOKEN", previewBaseUrl: value })).toThrow(/previewBaseUrl/);
    }
  });
});
