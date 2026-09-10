/**
 * 运行时接线测试（SPEC sandbox-oci.md §8 unit 部分）：
 * mock node:child_process 的 spawn，覆盖 spawn 流管道、收集缓冲、
 * terminate 升级、confine 透传与未就绪 fail closed。
 */
import { PassThrough } from "node:stream";

import { Context } from "@deepseek-ai/cordis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSandboxConfig } from "./config.js";
import { OciContainerRuntime } from "./container.js";
import { normalizeOciArgv, OciSandbox, OciSubprocessRuntime } from "./runtime.js";

beforeEach(() => {
  // 清跨用例残留（spawnMock 调用会让 waitFor 被旧调用骗过）。
  vi.clearAllMocks();
  spawnMock.mockReset();
});

// mock child_process.spawn（保留 execFile 原样——container 核心用它注入 runFile，测试不触发）。
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<{ execFile: unknown; spawn: unknown }>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

function makeChild() {
  const child = {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    exitCode: null as number | null,
  };
  return child;
}

const workspaceRoot = process.platform === "win32"
  ? "D:/AI/dsh/.workspaces"
  : "/tmp";

const config = resolveSandboxConfig({
  image: "localhost/dsh-lark-sandbox:1.0.0",
  workspaceRoot,
});

/** 真实 cordis Context（Service 构造需要符号键注册面）。 */
function fakeCtx(): Context {
  return new Context();
}

describe("OciSubprocessRuntime.spawn", () => {
  it("把 DSH 打包 ripgrep 映射到容器内固定路径", () => {
    const packaged = "/opt/dsh/releases/r5/node_modules/@deepseek-ai/dsh-tool-fs-search/node_modules/@vscode/ripgrep/bin/rg";
    const platformPackaged = "/opt/dsh/source/node_modules/@vscode/ripgrep-linux-x64/bin/rg";
    expect(normalizeOciArgv([packaged, "--no-config", "--files"])).toEqual([
      "/usr/bin/rg", "--no-config", "--files",
    ]);
    expect(normalizeOciArgv([platformPackaged, "--no-config", "--files"])).toEqual([
      "/usr/bin/rg", "--no-config", "--files",
    ]);
    expect(normalizeOciArgv(["/tmp/rg", "--files"])).toEqual(["/tmp/rg", "--files"]);
  });

  it("spawn 使用容器 ripgrep，不把宿主路径传给 podman", async () => {
    const runFile = vi.fn(async () => undefined);
    const core = new OciContainerRuntime({ config, runFile });
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const runtime = new OciSubprocessRuntime(fakeCtx(), core, config);
    const packaged = "/opt/dsh/source/node_modules/@vscode/ripgrep-linux-x64/bin/rg";
    const handle = runtime.spawn({
      argv: [packaged, "--no-config", "--files"],
      cwd: workspaceRoot,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: 5000,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("/usr/bin/rg");
    expect(args).not.toContain(packaged);
    child.once.mock.calls.find(([event]) => event === "close")![1](0, null);
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it("成功路径：podman exec 参数正确，close 结算 outcome", async () => {
    const runFile = vi.fn(async () => undefined);
    const core = new OciContainerRuntime({ config, runFile });
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const runtime = new OciSubprocessRuntime(fakeCtx(), core, config);
    const spec = {
      argv: ["bash", "-c", "echo hi"],
      cwd: workspaceRoot,
      stdio: { stdin: "ignore" as const, stdout: "pipe" as const, stderr: "pipe" as const },
      graceMs: 5000,
    };
    const handle = runtime.spawn(spec);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const [file, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(file).toContain("podman");
    expect(args[0]).toBe("exec");
    expect(args).toContain("bash");

    // 模拟子进程输出与退出。
    child.stdout.write("hi\n");
    child.once.mock.calls.find(([event]) => event === "close")![1](0, null);
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
    expect(handle.pid).toBe(4242);
  });

  it("收集模式：有界尾部读（readFrom 偏移非消耗）", async () => {
    const runFile = vi.fn(async () => undefined);
    const core = new OciContainerRuntime({ config, runFile });
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const runtime = new OciSubprocessRuntime(fakeCtx(), core, config);
    const handle = runtime.spawn({
      argv: ["bash", "-c", "echo out"],
      cwd: workspaceRoot,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 1024 },
        stderr: "pipe",
      },
      graceMs: 5000,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.write("out-1\n");
    const first = handle.collected.stdout!.readFrom(0);
    expect(first.text).toBe("out-1\n");
    expect(first.lossy).toBe(false);
    // 第二次从同一偏移读：独立读者互不消耗。
    expect(handle.collected.stdout!.readFrom(0).text).toBe("out-1\n");
    // 追加后从 nextOffset 续读。
    child.stdout.write("out-2\n");
    const second = handle.collected.stdout!.readFrom(first.nextOffset);
    expect(second.text).toBe("out-2\n");
  });

  it("terminate：SIGTERM → grace → SIGKILL 升级", async () => {
    vi.useFakeTimers();
    try {
      const runFile = vi.fn(async () => undefined);
      const core = new OciContainerRuntime({ config, runFile });
      const child = makeChild();
      spawnMock.mockReturnValue(child);
      const runtime = new OciSubprocessRuntime(fakeCtx(), core, config);
      const handle = runtime.spawn({
        argv: ["bash", "-c", "sleep"],
        cwd: workspaceRoot,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        graceMs: 1000,
      });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      handle.terminate();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(1100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      // 幂等：再次 terminate 无动作。
      handle.terminate();
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawnTerminal 拒绝（容器不支持终端原语）", async () => {
    const core = new OciContainerRuntime({ config, runFile: vi.fn(async () => undefined) });
    const runtime = new OciSubprocessRuntime(fakeCtx(), core, config);
    await expect(runtime.spawnTerminal()).rejects.toThrow(/终端/);
  });
});

describe("OciSandbox.confine", () => {
  it("未就绪（podman 探活失败）→ SandboxUnavailableError", () => {
    const core = new OciContainerRuntime({
      config,
      runFile: vi.fn(async () => {
        throw new Error("podman not found");
      }),
    });
    const sandbox = new OciSandbox(fakeCtx(), core);
    expect(() => sandbox.confine(["bash"], { mode: "workspace-write", workspaceRoot: "." }))
      .toThrowError(/podman 不可用/);
  });

  it("就绪后透传 argv 并声明 full enforcement", async () => {
    const core = new OciContainerRuntime({ config, runFile: vi.fn(async () => undefined) });
    const sandbox = new OciSandbox(fakeCtx(), core);
    await vi.waitFor(() => {
      const result = (() => {
        try {
          return sandbox.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: "." });
        } catch {
          return undefined;
        }
      })();
      expect(result).toBeDefined();
    });
    const result = sandbox.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: "." });
    expect(result.argv).toEqual(["bash", "-c", "x"]);
    expect(result.enforcement).toBe("full");
    expect(result.denialSignatures.length).toBeGreaterThan(0);
  });
});
