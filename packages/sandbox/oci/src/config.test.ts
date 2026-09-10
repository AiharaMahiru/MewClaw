import { describe, expect, it } from "vitest";

import { resolveSandboxConfig, type SandboxConfigInput } from "./config.js";

const input: SandboxConfigInput = {
  image: "registry.example/dsh-toolchain:2026-08-16",
  workspaceRoot: process.cwd(),
  resources: { cpus: 2, memoryMiB: 4096, pids: 256, tmpfsMiB: 512 },
};

describe("OCI 沙箱配置边界", () => {
  it("缺省使用有界 storage quota 和资源默认", () => {
    expect(resolveSandboxConfig({
      image: input.image,
      workspaceRoot: input.workspaceRoot,
    })).toMatchObject({
      network: "none",
      storageLimitBytes: 3 * 1024 ** 3,
      resources: { cpus: 2, memoryMiB: 4096, pids: 256, tmpfsMiB: 512 },
    });
  });

  it.each([
    [{ storageLimitBytes: 0 }, "storageLimitBytes"],
    [{ storageLimitBytes: -1 }, "storageLimitBytes"],
    [{ storageLimitBytes: 1.5 }, "storageLimitBytes"],
    [{ storageLimitBytes: Number.NaN }, "storageLimitBytes"],
    [{ workspaceRoot: "" }, "workspaceRoot"],
    [{ workspaceRoot: "relative/workspace" }, "workspaceRoot"],
    [{ podmanPath: "" }, "podmanPath"],
    [{ network: "" }, "network"],
    [{ resources: { ...input.resources!, memoryMiB: 1.5 } }, "resources.memoryMiB"],
    [{ resources: { ...input.resources!, pids: 1.5 } }, "resources.pids"],
    [{ resources: { ...input.resources!, tmpfsMiB: 0 } }, "resources.tmpfsMiB"],
  ])("拒绝非法 %o", (override, field) => {
    expect(() => resolveSandboxConfig({ ...input, ...override })).toThrow(field);
  });
});
