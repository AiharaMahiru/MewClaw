import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSandboxConfig, type SandboxConfigInput } from "./config.js";

const input: SandboxConfigInput = {
  image: "registry.example/dsh-toolchain:2026-08-16",
  workspaceRoot: process.cwd(),
  resources: { cpus: 2, memoryMiB: 4096, pids: 256, tmpfsMiB: 512 },
};

/** 平台无关绝对路径（win32 下 /opt 不是绝对路径）。 */
const abs = (p: string): string => resolve(p);

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

  it("extraMounts 缺省为空", () => {
    expect(resolveSandboxConfig({
      image: input.image,
      workspaceRoot: input.workspaceRoot,
    }).extraMounts).toEqual([]);
  });

  it("extraMounts：绝对 source/target 接受", () => {
    const mounts = [{ source: abs("/opt/host/lib"), target: "/opt/dsh-ptc-runtime" }];
    expect(resolveSandboxConfig({ ...input, extraMounts: mounts }).extraMounts).toEqual(mounts);
  });

  it.each([
    [[{ source: "relative/lib", target: "/opt/x" }], "source"],
    [[{ source: abs("/opt/host/lib"), target: "relative" }], "target"],
    [[{ source: abs("/opt/host/lib"), target: "/" }], "target"],
    [[{ source: abs("/opt/host/lib"), target: "/workspace" }], "target"],
    [[{ source: abs("/opt/host/lib"), target: "/workspace/nested" }], "target"],
  ])("extraMounts 拒绝非法 %o", (extraMounts, field) => {
    expect(() => resolveSandboxConfig({ ...input, extraMounts })).toThrow(field);
  });
});
