import { describe, expect, it } from "vitest";

import { Config, parseIngestionRunLimit, resolveAdminLimits } from "./config.js";

function parseUnchecked(input: unknown) {
  return Config(input as never);
}

describe("admin configuration limits", () => {
  it("uses documented defaults and preserves valid values", () => {
    expect(resolveAdminLimits({})).toEqual({
      maxUploadBytes: 100 * 1024 * 1024,
      defaultRunLimit: 8,
    });
    expect(resolveAdminLimits({ maxUploadBytes: 1, defaultRunLimit: 100 })).toEqual({
      maxUploadBytes: 1,
      defaultRunLimit: 100,
    });
  });

  it("rejects invalid upload and list configuration at startup", () => {
    expect(() => resolveAdminLimits({ maxUploadBytes: 0 })).toThrow(/maxUploadBytes/);
    expect(() => resolveAdminLimits({ maxUploadBytes: 1.5 })).toThrow(/maxUploadBytes/);
    expect(() => resolveAdminLimits({ maxUploadBytes: 100 * 1024 * 1024 + 1 })).toThrow(/maxUploadBytes/);
    expect(() => resolveAdminLimits({ defaultRunLimit: 0 })).toThrow(/defaultRunLimit/);
    expect(() => resolveAdminLimits({ defaultRunLimit: 8.5 })).toThrow(/defaultRunLimit/);
    expect(() => resolveAdminLimits({ defaultRunLimit: 101 })).toThrow(/defaultRunLimit/);
  });

  it("accepts only bounded decimal request limits", () => {
    expect(parseIngestionRunLimit(null, 8)).toBe(8);
    expect(parseIngestionRunLimit("3", 8)).toBe(3);
    expect(parseIngestionRunLimit("100", 8)).toBe(100);

    for (const value of ["0", "01", "-1", "1.5", "1e2", "0x10", " 3", "101", "999999999999999999999"]) {
      expect(parseIngestionRunLimit(value, 8)).toBe(8);
    }
  });

  it("keeps the observation plane disabled when its configuration is omitted", () => {
    const base = {
      identity: {
        tenantId: "tenant",
        botId: "bot",
        deploymentId: "deployment",
        adminUserId: "user",
      },
      uploadsRoot: "/uploads",
      adminTokenEnv: "ADMIN_TOKEN",
    };

    expect(Config(base).controlPlane).toBeUndefined();
    expect(() => parseUnchecked({ ...base, controlPlane: {} })).toThrow(/controlPlane/);
    expect(Config({
      ...base,
      controlPlane: {
        workerBaseUrl: "http://127.0.0.1:8787",
        workerTokenEnv: "WORKER_TOKEN",
        targets: [],
      },
    }).controlPlane).toMatchObject({ workerBaseUrl: "http://127.0.0.1:8787" });
  });
});
