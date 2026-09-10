import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { PodmanRuntime, type PodmanProcess } from "./podman.js";

class FakeProcess implements PodmanProcess {
  calls: string[][] = [];
  spawnCalls: string[][] = [];
  async run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push([...args]);
    return { code: 0, stdout: args[0] === "run" ? "container-id" : "", stderr: "" };
  }
  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    this.spawnCalls.push([...args]);
    return {} as ChildProcessWithoutNullStreams;
  }
}

describe("PodmanRuntime", () => {
  it("初始化失败区分rootless依赖，不泄露Podman原始诊断", async () => {
    const process = new FakeProcess();
    process.run = async () => ({ code: 1, stdout: "", stderr: "newuidmap: permission denied secret-path" });
    const runtime = new PodmanRuntime({ startupTimeoutMs: 1000 } as AppConfig, process);
    await expect(runtime.cleanupOrphans()).rejects.toThrow("ROOTLESS_INIT_REQUIRED");
    await expect(runtime.cleanupOrphans()).rejects.not.toThrow("secret-path");
  });
  it("以 rootless 兼容的最小权限参数启动 network=none 容器", async () => {
    const process = new FakeProcess();
    const runtime = new PodmanRuntime({
      startupTimeoutMs: 1_000,
      image: "preview@sha256:1234",
      resources: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 64 },
    } as AppConfig, process);
    await runtime.create({ id: "a".repeat(32), userId: "user-a", workspace: "/work/user-a/project", command: "node server.js", port: 3000 });
    const args = process.calls[0]!;
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--userns=keep-id:uid=10001,gid=10001", "--user=10001:10001",
      "--entrypoint", "/bin/bash",
      "--pids-limit", "64",
    ]));
    expect(args).toContain("/tmp:rw,nosuid,nodev,size=64m");
    expect(args.join(" ")).not.toContain("noexec");
    expect(args).toContain("type=bind,src=/work/user-a/project,dst=/workspace,rw");
    expect(args.slice(-3)).toEqual(["preview@sha256:1234", "-c", "node server.js"]);
  });

  it("probe 与 bridge 只依赖镜像已有 Node net.connect", async () => {
    const process = new FakeProcess();
    const runtime = new PodmanRuntime({
      startupTimeoutMs: 1_000,
      image: "preview@sha256:1234",
      resources: { cpus: 1, memoryMiB: 256, pids: 64, tmpfsMiB: 64 },
    } as AppConfig, process);
    await runtime.create({ id: "a".repeat(32), userId: "user-a", workspace: "/work/users/user-a", command: "node server.js", port: 3000 });
    runtime.bridge(`dsh-preview-${"a".repeat(32)}`, 3000);
    expect(process.calls[1]).toEqual(expect.arrayContaining(["exec", `dsh-preview-${"a".repeat(32)}`, "node", "-e"]));
    expect(process.spawnCalls[0]).toEqual(expect.arrayContaining(["exec", "-i", `dsh-preview-${"a".repeat(32)}`, "node", "-e"]));
    expect([...process.calls.flat(), ...process.spawnCalls.flat()]).not.toContain("socat");
  });

  it("只清理带专用 managed label 的孤儿容器", async () => {
    const process = new FakeProcess();
    process.run = async (args) => {
      process.calls.push([...args]);
      return args[0] === "ps"
        ? { code: 0, stdout: "one\ntwo\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const runtime = new PodmanRuntime({ startupTimeoutMs: 1_000 } as AppConfig, process);
    await runtime.cleanupOrphans();
    expect(process.calls).toEqual([
      ["ps", "-aq", "--filter", "label=io.dsh.preview.managed=true"],
      ["rm", "-f", "--time", "1", "one", "two"],
    ]);
  });

  it("容器回收失败时有界重试三次", async () => {
    const process = new FakeProcess();
    process.run = async (args) => {
      process.calls.push([...args]);
      return { code: 1, stdout: "", stderr: "busy" };
    };
    const runtime = new PodmanRuntime({ startupTimeoutMs: 1_000 } as AppConfig, process);
    await expect(runtime.remove("dsh-preview-test")).rejects.toMatchObject({ code: "PREVIEW_UNAVAILABLE" });
    expect(process.calls).toHaveLength(3);
  });
});
