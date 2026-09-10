/**
 * service-environment 模块测试。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { describe, expect, it, vi } from "vitest";

import { createServiceEnvironment } from "./service-environment.js";

describe("createServiceEnvironment", () => {
  it("generates one internal token without mutating the supervisor environment", () => {
    const source = { PATH: "bin" };
    const generate = vi.fn(() => "generated-worker-token");

    const service = createServiceEnvironment(source, {
      generate,
      root: "C:/repo",
      fileExists: () => false,
    });

    expect(service).toEqual({
      PATH: "bin",
      WORKER_TOKEN: "generated-worker-token",
    });
    expect(source).toEqual({ PATH: "bin" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("preserves an explicit token and never generates or exposes another value", () => {
    const generate = vi.fn(() => "unused-token");

    const service = createServiceEnvironment(
      { WORKER_TOKEN: " configured-token " },
      { generate, root: "C:/repo", fileExists: () => false },
    );

    expect(service.WORKER_TOKEN).toBe("configured-token");
    expect(generate).not.toHaveBeenCalled();
    expect(Object.keys(service)).toEqual(["WORKER_TOKEN"]);
  });

  it("derives the loopback pairing endpoint and token only when auth is enabled", () => {
    const service = createServiceEnvironment({ DSH_AUTH_ENABLED: "true", WORKER_TOKEN: "worker-token" }, { root: "C:/repo", fileExists: () => false });
    expect(service.AUTH_PAIRING_ENDPOINT).toBe("http://127.0.0.1:3080/internal/pairing/start");
    expect(service.AUTH_PAIRING_TOKEN).toBe("worker-token");
  });
});
