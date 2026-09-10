/**
 * 真实 Podman e2e（SPEC sandbox-oci.md §8 e2e/security）：
 * 轻量镜像（alpine 固定标签）验证 provision → exec → 输出 → 断网断言 →
 * 清理零残留。podman 不可用自动跳过（CI 无运行时环境）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSandboxConfig } from "./config.js";
import { containerName, OciContainerRuntime } from "./container.js";
import { OciSubprocessRuntime } from "./runtime.js";

const executeFile = promisify(execFile);

const PODMAN = process.platform === "win32" ? "C:\\Program Files\\RedHat\\Podman\\podman.exe" : "podman";

/** 探活：podman info 成功才运行本套件。 */
async function podmanAvailable(): Promise<boolean> {
  try {
    await executeFile(PODMAN, ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function collect(handle: { done: Promise<{ exitCode: number | null }>; collected: { stdout?: { readFrom(offset: number): { text: string } } } }): Promise<{ text: string; exitCode: number | null }> {
  const outcome = await handle.done;
  return { text: handle.collected.stdout?.readFrom(0).text ?? "", exitCode: outcome.exitCode };
}

let workspace: string | undefined;

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe.skipIf(!(await podmanAvailable()))("真实 Podman e2e", () => {
  it("provision → exec 输出 → dispose 零残留", async () => {
    workspace = await mkdtemp(join(tmpdir(), "dsh-lark-oci-e2e-"));
    const config = resolveSandboxConfig({
      image: "docker.io/library/alpine:3.20",
      podmanPath: PODMAN,
      workspaceRoot: workspace,
    });
    const core = new OciContainerRuntime({ config });
    const runtime = new OciSubprocessRuntime(new Context(), core, config);
    const expectedContainerName = containerName(createHash("sha256").update(workspace).digest("hex"));

    // 镜像可能需拉取：预拉（一次性成本）。
    await executeFile(PODMAN, ["pull", "docker.io/library/alpine:3.20"], { timeout: 300_000 });

    const handle = runtime.spawn({
      argv: ["sh", "-c", "echo hello-oci"],
      cwd: workspace,
      stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: "pipe" },
      graceMs: 5000,
    });
    const result = await collect(handle);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("hello-oci");

    // 断网断言：network=none → busybox wget 失败（非零退出）。
    const blocked = runtime.spawn({
      argv: ["sh", "-c", "wget -q -T 3 http://example.com"],
      cwd: workspace,
      stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: "pipe" },
      graceMs: 10_000,
    });
    const blockedResult = await collect(blocked);
    expect(blockedResult.exitCode).not.toBe(0);

    // 清理零残留：dispose 后无 dsh-lark- 容器。
    await core.dispose();
    const ps = await executeFile(PODMAN, ["ps", "-a", "--format", "{{.Names}}"]);
    const names = String(ps.stdout).split(/\r?\n/).filter(Boolean);
    // 共享 Podman 主机可能有其他 scope 的容器；只验证本次运行拥有的句柄。
    expect(names).not.toContain(expectedContainerName);
  }, 600_000);
});
