import { describe, expect, it } from "vitest";

import { resolveAppConfig } from "./config.js";

const REQUIRED = {
  WORKER_TOKEN: "test-token",
  DSH_PREVIEW_WORKSPACE_ROOT: "/srv/dsh/workspaces",
  DSH_PREVIEW_IMAGE: "registry.example/dsh-preview@sha256:1234",
};

describe("resolveAppConfig", () => {
  it("生成 SPEC 默认值且固定 loopback", () => {
    const config = resolveAppConfig(REQUIRED);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 13_082,
      defaultTtlMinutes: 60,
      maxTtlMinutes: 1_440,
      maxSharesPerUser: 3,
      requestTimeoutMs: 30_000,
      maxConcurrentRequests: 64,
      maxRequestBytes: 10 * 1024 * 1024,
      resources: { cpus: 1, memoryMiB: 512, pids: 128, tmpfsMiB: 128 },
    });
  });

  it("密钥、绝对工作区和锁定镜像缺失时 fail loud", () => {
    expect(() => resolveAppConfig({ ...REQUIRED, WORKER_TOKEN: "" })).toThrow(/WORKER_TOKEN/);
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_WORKSPACE_ROOT: "relative" })).toThrow(/绝对路径/);
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_IMAGE: "image:latest" })).toThrow(/锁定版本/);
  });

  it("未单配 Preview 镜像时复用已有锁定 sandbox 镜像", () => {
    const withoutPreviewImage = { ...REQUIRED, DSH_PREVIEW_IMAGE: undefined };
    expect(resolveAppConfig({ ...withoutPreviewImage, DSH_SANDBOX_IMAGE: "sandbox@sha256:abcd" }).image)
      .toBe("sandbox@sha256:abcd");
  });

  it("拒绝显式空值、非安全整数和非 HTTPS 公网 URL", () => {
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_PORT: "0" })).toThrow(/PORT/);
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_MAX_SHARES_PER_USER: "1.5" })).toThrow(/安全整数/);
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_MAX_CONCURRENT_REQUESTS: "513" })).toThrow(/MAX_CONCURRENT_REQUESTS/);
    expect(() => resolveAppConfig({ ...REQUIRED, DSH_PREVIEW_PUBLIC_BASE_URL: "http://chat.rwr.ink" })).toThrow(/HTTPS/);
  });
});
