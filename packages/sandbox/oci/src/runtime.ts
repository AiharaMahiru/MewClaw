/**
 * SubprocessRuntime 的容器实现 + SandboxProvider confine 透传（SPEC sandbox-oci.md §2）。
 *
 * spawn → `podman exec`（惰性 provision 每 cwd 一个容器）；stdin/out/err 按
 * spec.stdio 直通或收集（有界尾部 + 可选 spill）；terminate 走 SIGTERM →
 * grace → SIGKILL 升级。confine 透传（容器即边界）：podman 未就绪 →
 * SandboxUnavailableError（fail closed）。
 */
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PassThrough } from "node:stream";

import type { Context } from "@deepseek-ai/cordis";
import { SandboxProvider, SandboxUnavailableError, type ConfinedArgv, type SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import {
  SubprocessRuntime,
  type SubprocessCollectedOutputs,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import type { ResolvedSandboxConfig } from "./config.js";
import type { OciContainerRuntime, ProvisionedContainer } from "./container.js";

const MAX_TERMINATE_GRACE_MS = 2_147_483_647; // 与 MAX_TIMER_DELAY_MS 对齐上限。

/** 镜像内固定的 ripgrep 路径；宿主 npm 路径不能直接交给 podman exec。 */
const CONTAINER_RIPGREP = "/usr/bin/rg";
const PACKAGED_RIPGREP = /(?:^|[\\/])node_modules[\\/]@vscode[\\/]ripgrep(?:-(?:darwin-arm64|darwin-x64|linux-arm|linux-arm64|linux-ia32|linux-ppc64|linux-riscv64|linux-s390x|linux-x64|win32-arm64|win32-ia32|win32-x64))?[\\/]bin[\\/]rg(?:\.exe)?$/i;

/**
 * 把已知的 DSH 打包 ripgrep 载体映射到 OCI 执行世界。
 *
 * `dsh-tool-fs-search` 传入的是宿主 Node 进程可见的绝对路径，而 OCI
 * 容器只应执行镜像内的工具。只匹配 @vscode/ripgrep 的精确包布局，
 * 不把任意宿主绝对路径或模型参数转换成容器路径。
 */
export function normalizeOciArgv(argv: readonly string[]): string[] {
  const executable = argv[0];
  if (executable !== undefined && PACKAGED_RIPGREP.test(executable)) {
    return [CONTAINER_RIPGREP, ...argv.slice(1)];
  }
  return [...argv];
}

/** 有界收集器：内存尾部窗口 + 可选全量 spill 文件；偏移读非消耗。 */
class BoundedCollector implements SubprocessOutputReader {
  private buffer = "";
  private totalBytes = 0;
  private spill: WriteStream | undefined;
  private spillBytes = 0;

  constructor(
    /** 内存尾部窗口（字节）。 */
    private readonly maxBytes: number,
    /** 全量 spill 上限；省略则不 spill。 */
    private readonly spillMaxBytes?: number,
  ) {
    if (spillMaxBytes !== undefined) {
      this.spill = createWriteStream(join(tmpdir(), `dsh-lark-oci-${randomUUID()}.spill`));
    }
  }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    this.buffer = (this.buffer + chunk.toString("utf8")).slice(-this.maxBytes);
    if (this.spill && this.spillBytes <= this.spillMaxBytes!) {
      this.spillBytes += chunk.length;
      if (this.spillBytes <= this.spillMaxBytes!) {
        this.spill.write(chunk);
      } else {
        // 超出 spill 上限：不完整 spill 不可信，丢弃并关闭。
        this.spill.destroy();
        this.spill = undefined;
      }
    }
  }

  /** 进程退出后关闭 spill。 */
  close(): void {
    this.spill?.end();
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const end = this.totalBytes;
    if (fromByte >= end) return { text: "", nextOffset: end, lossy: false };
    const head = Math.max(0, end - this.buffer.length);
    const lossy = fromByte < head;
    const start = lossy ? head : fromByte;
    return {
      text: this.buffer.slice(start - head),
      nextOffset: end,
      lossy,
      ...(lossy && this.spill ? { spillPath: String(this.spill.path) } : {}),
    };
  }
}

interface ContainerBinding {
  container: ProvisionedContainer;
  /** 容器内 cwd（/workspace 相对，正斜杠）。 */
  containerCwd: string;
}

export class OciSubprocessRuntime extends SubprocessRuntime {
  private readonly core: OciContainerRuntime;
  private readonly config: ResolvedSandboxConfig;
  private readonly containers = new Map<string, Promise<ContainerBinding>>();

  constructor(ctx: Context, core: OciContainerRuntime, config: ResolvedSandboxConfig) {
    super(ctx);
    this.core = core;
    this.config = config;
  }

  /** 惰性 provision：按宿主 cwd 找/建容器（每 scope 工作区一个容器，名字稳定）。 */
  private bindingFor(cwd: string): Promise<ContainerBinding> {
    const existing = this.containers.get(cwd);
    if (existing) return existing;
    const binding = (async () => {
      const sandboxId = createHash("sha256").update(cwd).digest("hex");
      const container = await this.core.provision(sandboxId, sandboxId, cwd);
      const local = relative(container.workspace, cwd);
      const containerCwd = local === "" || local.startsWith("..") || local.startsWith(`\\`)
        ? "/workspace"
        : `/workspace/${local.split("\\").join("/")}`;
      return { container, containerCwd };
    })();
    this.containers.set(cwd, binding);
    return binding;
  }

  async resolveExecutable(command: string): Promise<string> {
    if (PACKAGED_RIPGREP.test(command)) return CONTAINER_RIPGREP;
    // 裸名交给容器内 PATH（镜像工具链负责）；相对含分隔符路径拒绝。
    if ((command.includes("/") || command.includes("\\")) && !command.startsWith("/")) {
      throw new Error(`相对执行路径不受支持（${command}）`);
    }
    return command;
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    let child: ChildProcess | undefined;
    let terminated = false;
    let killTimer: NodeJS.Timeout | undefined;

    // 收集器先建（collected 字段只读，不能后赋值）。
    const stdoutCollector = typeof spec.stdio.stdout === "object"
      ? new BoundedCollector(spec.stdio.stdout.maxBytes, spec.stdio.stdout.spill?.maxBytes)
      : undefined;
    const stderrCollector = typeof spec.stdio.stderr === "object"
      ? new BoundedCollector(spec.stdio.stderr.maxBytes, spec.stdio.stderr.spill?.maxBytes)
      : undefined;
    const collected: SubprocessCollectedOutputs = {
      ...(stdoutCollector ? { stdout: stdoutCollector } : {}),
      ...(stderrCollector ? { stderr: stderrCollector } : {}),
    };

    const outcome = new Promise<SubprocessOutcome>((resolve, reject) => {
      void this.bindingFor(spec.cwd)
        .then((binding) => {
          const args = this.core.execArgs(
            binding.container.name,
            normalizeOciArgv(spec.argv),
            binding.containerCwd,
            spec.env,
            spec.stdio.stdin !== "ignore",
          );
          const stdio: ["pipe" | "ignore" | "inherit", "pipe" | "ignore" | "inherit", "pipe" | "ignore" | "inherit"] = [
            spec.stdio.stdin === "ignore" ? "ignore" : "pipe",
            spec.stdio.stdout === "inherit" ? "inherit" : "pipe",
            spec.stdio.stderr === "inherit" ? "inherit" : "pipe",
          ];
          child = spawnProcess(this.config.podmanPath, args, { windowsHide: true, stdio });

          child.once("error", (error) => reject(error));
          child.once("close", (code, signal) => {
            if (killTimer) clearTimeout(killTimer);
            stdoutCollector?.close();
            stderrCollector?.close();
            resolve({ exitCode: code, signal: signal as NodeJS.Signals | null });
          });

          // stdin 批次写入（{ data } 形态：写后关闭）。
          if (typeof spec.stdio.stdin === "object" && "data" in spec.stdio.stdin) {
            child.stdin?.end(spec.stdio.stdin.data);
          }
          // stdin 管道：把 handle 暴露的 Writable 转接给 child.stdin。
          if (spec.stdio.stdin === "pipe") {
            stdinStream?.pipe(child.stdin!);
          }
          // 输出管道：child.stdout/stderr → handle 暴露的 Readable。
          if (spec.stdio.stdout === "pipe" && stdoutStream) {
            child.stdout!.pipe(stdoutStream);
          }
          if (spec.stdio.stderr === "pipe" && stderrStream) {
            child.stderr!.pipe(stderrStream);
          }
          // 收集模式：有界缓冲。
          if (stdoutCollector) {
            child.stdout!.on("data", (chunk: Buffer) => stdoutCollector.push(chunk));
          }
          if (stderrCollector) {
            child.stderr!.on("data", (chunk: Buffer) => stderrCollector.push(chunk));
          }
        })
        .catch(reject);
    });

    const stdinStream = spec.stdio.stdin === "pipe" ? new PassThrough() : undefined;
    const stdoutStream = spec.stdio.stdout === "pipe" ? new PassThrough() : undefined;
    const stderrStream = spec.stdio.stderr === "pipe" ? new PassThrough() : undefined;

    const terminate = (): void => {
      if (terminated || !child || child.exitCode !== null) return;
      terminated = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child?.kill("SIGKILL");
      }, Math.min(spec.graceMs, MAX_TERMINATE_GRACE_MS));
    };
    if (spec.signal) {
      spec.signal.addEventListener("abort", terminate, { once: true });
    }

    return {
      stdin: spec.stdio.stdin === "pipe" ? (stdinStream as Writable) : undefined,
      stdout: spec.stdio.stdout === "pipe" ? (stdoutStream as Readable) : undefined,
      stderr: spec.stdio.stderr === "pipe" ? (stderrStream as Readable) : undefined,
      collected,
      done: outcome,
      terminate,
      async waitForExit(signal) {
        if (!signal) return outcome.then(() => true);
        const aborted = new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        return Promise.race([outcome.then(() => true), aborted]);
      },
    };
  }

  async spawnTerminal(): Promise<never> {
    throw new Error("OCI 沙箱不支持终端进程原语（spawnTerminal）");
  }

  /** 服务停用：清全部容器（rm --force --ignore）。 */
  dispose(): void {
    void this.core.dispose();
  }
}

/** SandboxProvider：容器即边界，confine 透传；podman 未就绪 fail closed。 */
export class OciSandbox extends SandboxProvider {
  private ready = false;

  constructor(ctx: Context, core: OciContainerRuntime) {
    super(ctx);
    void (async () => {
      try {
        await core.probe();
        this.ready = true;
      } catch {
        this.ready = false;
      }
    })();
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (!this.ready) {
      throw new SandboxUnavailableError(policy.mode, "podman 不可用（OCI 沙箱未就绪）");
    }
    return {
      argv: [...argv],
      enforcement: "full",
      // 容器只读根/挂载边界产生的拒绝特征（消费方据以判定"拒绝=禁锢生效"）。
      denialSignatures: ["read-only file system", "permission denied", "operation not permitted"],
      runnerFailureRules: [],
    };
  }
}
