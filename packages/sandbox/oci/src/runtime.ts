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
import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Duplex as DuplexStream, PassThrough } from "node:stream";

import type { Context } from "@deepseek-ai/cordis";
import { SandboxProvider, SandboxUnavailableError, type ConfinedArgv, type SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import {
  SubprocessRuntime,
  type SubprocessCollectedOutputs,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalEnvironment,
} from "@deepseek-ai/dsh-subprocess";
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from "@deepseek-ai/dsh-subprocess/control";

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
    // provision 失败（如残留冲突重试仍败）不得毒化缓存：逐出后下个 spawn 重试。
    void binding.catch(() => {
      if (this.containers.get(cwd) === binding) this.containers.delete(cwd);
    });
    return binding;
  }

  /** 容器执行世界是 Linux/bash——与镜像固定工具链一致。 */
  async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return { platform: "posix", defaultShell: "/bin/bash" };
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

    const wantsControl = spec.stdio.control === "pipe";
    // 标记名由控制通道启动协议保留，消费方不得占用（与宿主实现同契约）。
    if (spec.env && Object.entries(spec.env).some(([key, value]) => key.toUpperCase() === SUBPROCESS_CONTROL_ENV && value !== undefined)) {
      throw new Error(`${SUBPROCESS_CONTROL_ENV} is reserved for subprocess control-channel setup`);
    }

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

    // 控制通道桥：handle 同步返回而 child 异步产生——先造双向桥，
    // spawn 落定后把桥两端接到 child.stdio[fd7]（--preserve-fds 透传）。
    const controlToChild = wantsControl ? new PassThrough() : undefined;
    const controlFromChild = wantsControl ? new PassThrough() : undefined;
    const control = controlToChild && controlFromChild
      ? DuplexStream.from({ writable: controlToChild, readable: controlFromChild })
      : undefined;
    // fd7 的宿主端是 socketpair，容器端经 conmon 复制持有——podman exec 客户端
    // 退出或终止都不会带动它 EOF。不显式断开则两侧互等成死锁：容器进程等宿主
    // 关通道（hostClosed），'close' 事件等 stdio[7] EOF，handle.done 永不落定。
    let childControl: DuplexStream | undefined;
    const settleControl = (error?: Error) => {
      if (childControl) {
        // 先 FIN（对端按协议收 hostClosed）再强关——双保险应对容器进程
        // 不消费通道的场景。收尾路径不向调用方抛错。
        try {
          childControl.end();
          childControl.destroy();
        } catch { /* 关闭尽力而为 */ }
        childControl = undefined;
      }
      if (error) controlToChild?.destroy(error);
      else controlToChild?.end();
      if (error) controlFromChild?.destroy(error);
      else controlFromChild?.end();
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
            wantsControl,
          );
          const stdio: Array<"pipe" | "ignore" | "inherit" | number> = [
            spec.stdio.stdin === "ignore" ? "ignore" : "pipe",
            spec.stdio.stdout === "inherit" ? "inherit" : "pipe",
            spec.stdio.stderr === "inherit" ? "inherit" : "pipe",
          ];
          // fd3..fd6 用 /dev/null 占位，控制管道固定落 fd7（--preserve-fds 序号透传）。
          let devNullFd: number | undefined;
          if (wantsControl) {
            devNullFd = openSync(devNull, "r");
            while (stdio.length < SUBPROCESS_CONTROL_FD) stdio.push(devNullFd);
            stdio.push("pipe");
          }
          child = spawnProcess(this.config.podmanPath, args, { windowsHide: true, stdio });
          // 占位 fd 已被 child 继承，宿主副本立即归还。
          if (devNullFd !== undefined) closeSync(devNullFd);

          child.once("error", (error) => {
            settleControl(error);
            reject(error);
          });
          child.once("exit", () => {
            // podman exec 客户端一死，exec 会话由 conmon 续命：主动断开 fd7，
            // 让容器内进程观察到控制通道关闭并退出，'close' 才有机会触发。
            settleControl();
          });
          child.once("close", (code, signal) => {
            if (killTimer) clearTimeout(killTimer);
            stdoutCollector?.close();
            stderrCollector?.close();
            settleControl();
            resolve({ exitCode: code, signal: signal as NodeJS.Signals | null });
          });

          // 控制管道两端接通：写侧进 child fd7，读侧回 handle。
          // （ChildProcess.stdio 类型只声明到 fd4，fd7 是 --preserve-fds 语义位。）
          childControl = (child.stdio as unknown as Array<Readable | Writable | null | undefined> | undefined)?.[SUBPROCESS_CONTROL_FD] as DuplexStream | undefined;
          if (wantsControl && childControl) {
            // 容器端 abrupt close/reset 也要落到桥的收尾上，不能让 socket
            // 'error' 成为无人认领的 unhandled error。
            childControl.on("error", (cause) => settleControl(cause instanceof Error ? cause : new Error(String(cause))));
            controlToChild!.pipe(childControl as Writable);
            childControl.pipe(controlFromChild!);
          }

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
        .catch((error) => {
          // provision 失败时 child 从未产生：控制桥也要收尾，读者不能悬空。
          settleControl(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        });
    });

    const stdinStream = spec.stdio.stdin === "pipe" ? new PassThrough() : undefined;
    const stdoutStream = spec.stdio.stdout === "pipe" ? new PassThrough() : undefined;
    const stderrStream = spec.stdio.stderr === "pipe" ? new PassThrough() : undefined;

    const terminate = (): void => {
      if (terminated || !child || child.exitCode !== null) return;
      terminated = true;
      // 先断开控制通道：容器内 PTC 引导进程以 fd7 关闭为宿主终止信号
      // （run_code 协议的 hostClosed），仅杀 podman exec 客户端够不到
      // conmon 托管的 exec 进程。
      settleControl();
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
      // fd7 控制通道经 --preserve-fds 进容器（PTC run_code 工具回调用路）；
      // 未请求时仍是 undefined（与宿主实现同契约）。
      control,
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
  private readonly ready: Promise<boolean>;

  constructor(ctx: Context, core: OciContainerRuntime) {
    super(ctx);
    this.ready = core.probe().then(() => true, () => false);
  }

  // 0.1.6 起 confine 为可取消异步：先等 podman 探测落定再判定，
  // 消除探测在途时调用的假阴性拒绝；signal 命中即按取消契约抛出。
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted();
    if (!(await this.ready)) {
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
