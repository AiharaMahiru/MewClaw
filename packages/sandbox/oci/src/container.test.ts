/**
 * 配置与容器核心测试（SPEC sandbox-oci.md §8 unit 部分）：
 * 配置校验（latest 拒绝/正数/网络白名单）、容器名派生、参数构造、
 * 工作区逃逸拒绝、清理不变式。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import { resolveSandboxConfig, SandboxConfigurationError } from "./config.js";
import { containerName, environmentArgs, OciContainerRuntime, securityArgs } from "./container.js";

/** 每次测试用独立临时工作区根（provision 需要 realpath 存在）。 */
let workspaceRoot: string | undefined;

async function tempConfig(): Promise<ReturnType<typeof resolveSandboxConfig>> {
  workspaceRoot = await mkdtemp(join(tmpdir(), "dsh-lark-oci-"));
  return resolveSandboxConfig({
    image: "localhost/dsh-lark-sandbox:1.0.0",
    workspaceRoot,
  });
}

afterEach(async () => {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  }
});

const config = resolveSandboxConfig({
  image: "localhost/dsh-lark-sandbox:1.0.0",
  workspaceRoot: process.cwd(),
});

describe("resolveSandboxConfig", () => {
  it("latest 标签拒绝；固定标签与 digest 接受", () => {
    expect(() => resolveSandboxConfig({ image: "img:latest", workspaceRoot: process.cwd() }))
      .toThrowError(SandboxConfigurationError);
    expect(() => resolveSandboxConfig({ image: "img@sha256:" + "a".repeat(64), workspaceRoot: process.cwd() }))
      .not.toThrow();
    expect(config.image).toBe("localhost/dsh-lark-sandbox:1.0.0");
  });

  it("资源必须为正数；storage 上限封顶", () => {
    expect(() => resolveSandboxConfig({ image: config.image, workspaceRoot: process.cwd(), resources: { cpus: 0, memoryMiB: 1, pids: 1, tmpfsMiB: 1 } }))
      .toThrowError(/正数/);
    expect(() => resolveSandboxConfig({ image: config.image, workspaceRoot: process.cwd(), storageLimitBytes: 4 * 1024 ** 3 }))
      .toThrowError(/不得超过/);
  });

  it("网络默认 none（安全不变量）", () => {
    expect(config.network).toBe("none");
    expect(resolveSandboxConfig({ image: config.image, workspaceRoot: process.cwd(), network: "bridge" }).network).toBe("bridge");
  });
});

describe("containerName", () => {
  it("自生成可审计名（dsh-lark- 前缀 + 哈希尾）", () => {
    const name = containerName("scope-abc");
    expect(name).toMatch(/^dsh-lark-scope-abc-[0-9a-f]{10}$/);
    expect(containerName("!!非法 名称!!")).toMatch(/^dsh-lark-scope-[0-9a-f]{10}$/);
    // 不同 id 不同名；同 id 稳定。
    expect(containerName("a")).not.toBe(containerName("b"));
    expect(containerName("a")).toBe(containerName("a"));
  });
});

describe("securityArgs / environmentArgs", () => {
  it("安全参数：读根、cap-drop、no-new-privileges、断网、非根", () => {
    const args = securityArgs(config, "dsh-lark-test-123");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=all");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--network=none");
    expect(args).toContain("--user=10001:10001");
    expect(args).toContain("--pids-limit=256");
  });

  it("环境白名单：密钥绝不注入（无任何 API_KEY 类条目）", () => {
    const args = environmentArgs(1024);
    expect(args.some((arg) => /KEY|SECRET|TOKEN/i.test(arg))).toBe(false);
    expect(args).toContain("--env=DOTNET_CLI_HOME=/tmp/dotnet");
    expect(args).toContain("--env=NUGET_PACKAGES=/tmp/nuget-packages");
  });
});

describe("OciContainerRuntime", () => {
  const mockRun = () => vi.fn(async (_file?: unknown, _args?: unknown, _options?: unknown) => undefined);

  it("工作区逃逸拒绝（根外路径）", async () => {
    const cfg = await tempConfig();
    const runtime = new OciContainerRuntime({ config: cfg, runFile: mockRun() });
    await expect(runtime.provision("scope-1", "quota-1", join(tmpdir(), "elsewhere")))
      .rejects.toThrow(/超出配置的工作区根/);
  });

  it("provision 成功：exec 参数含挂载与镜像；cleanup 走 rm --force --ignore", async () => {
    const cfg = await tempConfig();
    const runFile = mockRun();
    const runtime = new OciContainerRuntime({ config: cfg, runFile });
    const handle = await runtime.provision("scope-1", "quota-1", cfg.workspaceRoot);
    expect(handle.name).toMatch(/^dsh-lark-scope-1-/);
    const runArgs = runFile.mock.calls[0]![1] as string[];
    expect(runArgs).toContain("--read-only");
    expect(runArgs).toContain("sleep infinity");
    // 挂载参数是 "--mount" + 值两个元素。
    const mountIndex = runArgs.indexOf("--mount");
    expect(mountIndex).toBeGreaterThan(-1);
    expect(runArgs[mountIndex + 1]).toMatch(/^type=bind,source=/);

    await handle.cleanup();
    const cleanupArgs = runFile.mock.calls[1]![1] as string[];
    expect(cleanupArgs).toEqual(["rm", "--force", "--ignore", handle.name]);
  });

  it("execArgs：仅透传白名单展示变量，拒绝密钥、DSH 与宿主路径变量", async () => {
    const cfg = await tempConfig();
    const runtime = new OciContainerRuntime({ config: cfg, runFile: mockRun() });
    const args = runtime.execArgs("c1", ["bash", "-c", "echo hi"], "/workspace", {
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      OPENAI_API_KEY: "not-a-real-secret",
      DSH_SESSION_ID: "session-123",
      CLAUDE_PROJECT_DIR: "D:/host/project",
    });
    expect(args).toEqual([
      "exec", "-i", "--workdir=/workspace",
      "--env=NO_COLOR=1", "--env=TERM=dumb", "--env=PAGER=cat", "--env=GIT_PAGER=cat",
      "c1", "bash", "-c", "echo hi",
    ]);
  });

  it("stdin: ignore 时不保持 Podman exec 的 -i，避免搜索工具误读空管道", async () => {
    const cfg = await tempConfig();
    const runtime = new OciContainerRuntime({ config: cfg, runFile: mockRun() });
    expect(runtime.execArgs("c1", ["rg", "needle"], "/workspace", undefined, false))
      .toEqual(["exec", "--workdir=/workspace", "c1", "rg", "needle"]);
  });

  it("dispose：清理全部已 provision 容器（吞错不吞审计）", async () => {
    const cfg = await tempConfig();
    const runFile = mockRun();
    const runtime = new OciContainerRuntime({ config: cfg, runFile });
    const first = await runtime.provision("scope-1", "quota-1", cfg.workspaceRoot);
    const second = await runtime.provision("scope-2", "quota-2", cfg.workspaceRoot);
    await runtime.dispose();
    const cleanupCalls = runFile.mock.calls.filter((call) => (call[1] as string[])[0] === "rm");
    expect(cleanupCalls).toHaveLength(2);
    expect(cleanupCalls.map((call) => (call[1] as string[])[3])).toEqual([first.name, second.name]);
  });
});
