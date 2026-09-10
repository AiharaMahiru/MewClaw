import { describe, expect, it } from "vitest";

import { resolveAuthConfig } from "./config.js";

const base = {
  AUTH_DATABASE_URL: "postgres://auth",
  AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3080/",
  AUTH_PUBLIC_ORIGIN: "http://127.0.0.1:3080/",
  AUTH_USER_MODEL_ENCRYPTION_KEY: "A".repeat(43),
};

describe("resolveAuthConfig", () => {
  it("旧部署机器人环境不再保留App或自动生成账号配置，OAuth保持独立", () => {
    expect(resolveAuthConfig({ ...base, LARK_APP_ID: "cli_1234567890abcdef", LARK_APP_SECRET: "fake-old-secret" })).toEqual(resolveAuthConfig(base));
  });
  it("默认开启审计并严格校验开关和资源限制", () => {
    expect(resolveAuthConfig(base).promptAudit).toEqual({ enabled: true, timeoutMs: 15_000, maxConcurrent: 4 });
    expect(resolveAuthConfig({ ...base, AUTH_PROMPT_AUDIT_ENABLED: "false" }).promptAudit?.enabled).toBe(false);
    expect(() => resolveAuthConfig({ ...base, AUTH_PROMPT_AUDIT_ENABLED: "FALSE" })).toThrow("AUTH_PROMPT_AUDIT_ENABLED");
    expect(() => resolveAuthConfig({ ...base, AUTH_PROMPT_AUDIT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => resolveAuthConfig({ ...base, AUTH_PROMPT_AUDIT_MAX_CONCURRENT: "100" })).toThrow();
  });
  it("normalizes browser origins and derives loopback upstreams", () => {
    const config = resolveAuthConfig({ ...base, DSH_WEB_INTERNAL_PORT: "3081", AUTH_ADMIN_URL: "http://127.0.0.1:8791/" });
    expect(config.publicOrigin).toBe("http://127.0.0.1:3080");
    expect(config.trustedOrigins).toEqual(["http://127.0.0.1:3080"]);
    expect(config.workerBaseUrl).toBe("http://127.0.0.1:3081");
    expect(config.previewBaseUrl).toBe("http://127.0.0.1:13082");
    expect(config.adminBaseUrl).toBe("http://127.0.0.1:8791");
  });

  it("fails closed when the public origin is not trusted or HTTPS cookies are disabled", () => {
    expect(() => resolveAuthConfig({ ...base, AUTH_PUBLIC_ORIGIN: "http://localhost:3080" })).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => resolveAuthConfig({ ...base, AUTH_TRUSTED_ORIGINS: "https://example.test", AUTH_PUBLIC_ORIGIN: "https://example.test" })).toThrow("AUTH_COOKIE_SECURE");
  });

  it("rejects non-loopback Worker and Admin upstreams", () => {
    expect(() => resolveAuthConfig({ ...base, DSH_WEB_INTERNAL_URL: "https://worker.example.test" })).toThrow("DSH_WEB_INTERNAL_URL");
    expect(() => resolveAuthConfig({ ...base, AUTH_ADMIN_URL: "https://admin.example.test" })).toThrow("AUTH_ADMIN_URL");
    expect(() => resolveAuthConfig({ ...base, PREVIEW_URL: "https://preview.example.test" })).toThrow("PREVIEW_URL");
  });

  it("要求独立的用户模型加密主密钥", () => {
    const withoutKey = { ...base, AUTH_USER_MODEL_ENCRYPTION_KEY: undefined };
    expect(() => resolveAuthConfig(withoutKey)).toThrow("AUTH_USER_MODEL_ENCRYPTION_KEY");
  });

  it("automatically reuses the existing project mail group for auth SMTP", () => {
    const config = resolveAuthConfig({
      ...base,
      MAIL_HOST: "smtp.example.test",
      SMTP_SSL_PORT: "465",
      EMAIL: "robot@example.test",
      PASSWORD: "app-password",
    });
    expect(config.mail).toMatchObject({
      mode: "smtp",
      host: "smtp.example.test",
      port: 465,
      secure: true,
      user: "robot@example.test",
      password: "app-password",
      from: "robot@example.test",
    });
  });

  it("allows local console mail to override configured SMTP", () => {
    const config = resolveAuthConfig({
      ...base,
      AUTH_MAIL_MODE: "console",
      MAIL_HOST: "smtp.example.test",
      EMAIL: "robot@example.test",
      PASSWORD: "app-password",
    });
    expect(config.mail.mode).toBe("console");
  });
});
