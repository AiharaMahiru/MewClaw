/**
 * 容器生命周期核心（lark-claw oci-sandbox-provider 语义保留，M2 移植）。
 *
 * 安全不变量（SPEC sandbox-oci.md §6）：
 * - 容器名自生成（sandboxId 哈希），非根用户、读根文件系统、cap-drop 全部、
 *   no-new-privileges、CPU/内存/PID/tmpfs 上限、仅挂载 scope 工作区、默认断网；
 * - 清理固定走 `podman rm --force --ignore <name>`（execFile 数组参数，
 *   不经 shell），且必须在 finally 执行；
 * - 环境变量按白名单注入，密钥绝不注入；
 * - Windows 9P 无 Unix 模式位：DOTNET_CLI_HOME/NUGET_PACKAGES 置于 /tmp tmpfs。
 */
import { execFile, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ResolvedSandboxConfig } from "./config.js";

const executeFile = promisify(execFile);
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_USER_NAMESPACE = "--userns=keep-id:uid=10001,gid=10001";
const CLEANUP_TIMEOUT_MS = 30_000;
const EXECUTION_ENV_ALLOWLIST = new Set(["NO_COLOR", "TERM", "PAGER", "GIT_PAGER"]);

function executionEnvironmentArgs(env?: NodeJS.ProcessEnv): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => {
    if (value === undefined || !EXECUTION_ENV_ALLOWLIST.has(key)) return [];
    return [`--env=${key}=${value}`];
  });
}

export interface ProvisionedContainer {
  /** 容器名（podman --name）。 */
  name: string;
  /** 工作区宿主绝对路径（已 realpath 校验）。 */
  workspace: string;
  /** 该 scope 的存储配额（字节；供环境变量注入）。 */
  workspaceLimitBytes: number;
  /** 幂等清理（rm --force --ignore，finally 用）。 */
  cleanup(): Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

/** 容器名：dsh-lark-<slug>-<hash10>（自生成，可审计）。 */
export function containerName(sandboxId: string): string {
  const slug = sandboxId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const digest = createHash("sha256").update(sandboxId).digest("hex").slice(0, 10);
  return `dsh-lark-${slug.slice(0, 31) || "scope"}-${digest}`;
}

/** podman run 安全参数（读根、降权、禁提权、资源上限、网络、非根用户）。 */
export function securityArgs(config: ResolvedSandboxConfig, name: string): string[] {
  const network = config.network === "none" ? ["--network=none"] : [];
  return [
    "run", "-d", "--rm", `--name=${name}`, "--read-only",
    "--cap-drop=all", "--security-opt=no-new-privileges", ...network,
    `--pids-limit=${config.resources.pids}`,
    `--memory=${config.resources.memoryMiB}m`,
    `--cpus=${config.resources.cpus}`,
    CONTAINER_USER_NAMESPACE, "--user=10001:10001", `--workdir=${CONTAINER_WORKSPACE}`,
    "--entrypoint=/bin/sh",
  ];
}

/** 环境白名单（密钥绝不注入；Windows 9P 约束：dotnet/nuget 缓存入 /tmp）。 */
export function environmentArgs(workspaceLimitBytes: number): string[] {
  return [
    "--env=HOME=/workspace/.sandbox-home",
    "--env=NPM_CONFIG_BIN_LINKS=false",
    "--env=NPM_CONFIG_CACHE=/tmp/npm-cache",
    "--env=SANDBOX_NPM_CACHE_SEED=/opt/dsh-lark/npm-cache",
    "--env=UV_CACHE_DIR=/workspace/.cache/uv",
    "--env=CARGO_HOME=/workspace/.cache/cargo",
    "--env=DOTNET_CLI_HOME=/tmp/dotnet",
    "--env=NUGET_PACKAGES=/tmp/nuget-packages",
    "--env=UseAppHost=false",
    "--env=DOTNET_CLI_TELEMETRY_OPTOUT=1",
    "--env=DOTNET_NOLOGO=1",
    "--env=DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
    `--env=SANDBOX_WORKSPACE_LIMIT_BYTES=${workspaceLimitBytes}`,
  ];
}

export interface OciContainerOptions {
  config: ResolvedSandboxConfig;
  /** 命令执行注入点（测试用 mock；缺省用真实 podman）。 */
  runFile?: (file: string, args: string[], options?: ExecFileOptions) => Promise<unknown>;
  /** 配额分配回调（测试注入；缺省固定上限）。 */
  allocateQuota?: (quotaId: string, workspace: string) => Promise<number>;
  /** 告警面（缺省 console.warn）。 */
  logger?: { warn(message: string): void };
}

export class OciContainerRuntime {
  private readonly options: Required<OciContainerOptions>;
  /** 已 provision 的容器名（dispose 时逐一清理）。 */
  private readonly provisioned = new Set<string>();

  constructor(options: OciContainerOptions) {
    this.options = {
      runFile: (file, args, execOptions) => executeFile(file, args, execOptions),
      allocateQuota: async () => options.config.storageLimitBytes,
      logger: { warn: (message: string) => console.warn(message) },
      ...options,
    };
  }

  private exec(args: string[]): Promise<unknown> {
    return this.options.runFile(this.options.config.podmanPath, args, {
      timeout: CLEANUP_TIMEOUT_MS,
      windowsHide: true,
    });
  }

  /** 幂等清理（rm --force --ignore；容错吞错不吞审计）。 */
  private async cleanup(name: string): Promise<void> {
    await this.exec(["rm", "--force", "--ignore", name]);
  }

  /**
   * provision：校验工作区在工作区根内（realpath 双重校验防符号链接逃逸），
   * 派生容器名，起一个后台睡眠容器（exec 目标），返回含 cleanup 的句柄。
   */
  async provision(sandboxId: string, quotaId: string, requested: string): Promise<ProvisionedContainer> {
    const config = this.options.config;
    const resolvedRequest = resolve(requested);
    if (!isWithin(config.workspaceRoot, resolvedRequest)) {
      throw new Error("工作区超出配置的工作区根");
    }
    const [root, workspace] = await Promise.all([
      realpath(config.workspaceRoot),
      realpath(resolvedRequest),
    ]);
    if (!isWithin(root, workspace)) {
      throw new Error("工作区超出配置的工作区根（realpath）");
    }
    const name = containerName(sandboxId);
    const workspaceLimitBytes = await this.options.allocateQuota(quotaId, workspace);
    const args = [
      ...securityArgs(config, name),
      ...environmentArgs(workspaceLimitBytes),
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${config.resources.tmpfsMiB}m`,
      "--mount", `type=bind,source=${workspace},target=${CONTAINER_WORKSPACE},rw`,
      config.image,
      "-c", "sleep infinity",
    ];
    await this.exec(args);
    this.provisioned.add(name);
    return {
      name,
      workspace,
      workspaceLimitBytes,
      cleanup: async () => {
        await this.cleanup(name);
        this.provisioned.delete(name);
      },
    };
  }

  /** 探活：podman info 成功即运行时就绪（confine 透传的 fail-closed 依据）。 */
  async probe(): Promise<void> {
    await this.exec(["info"]);
  }

  /**
   * exec 参数：仅传递无敏感展示变量；容器内以指定 cwd 执行 argv（不 shell
   * 解释）。只有调用方确实需要 stdin 管道时才保留 `-i`，否则像 ripgrep
   * 这类默认搜索 cwd 的命令会误把关闭的 stdin 当成搜索输入。
   */
  execArgs(
    name: string,
    argv: readonly string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    keepStdin = true,
  ): string[] {
    const envArgs = executionEnvironmentArgs(env);
    return ["exec", ...(keepStdin ? ["-i"] : []), `--workdir=${cwd}`, ...envArgs, name, ...argv];
  }

  /** 停用：清理全部已 provision 容器（finally 语义；清后验证，残留重试一次）。 */
  async dispose(): Promise<void> {
    const names = [...this.provisioned];
    this.provisioned.clear();
    for (const name of names) {
      await this.cleanup(name).catch(() => undefined);
    }
    // 零残留验证：任何残留（rm 超时/上游忙）→ 再清一轮（有界，不吞审计）。
    const remaining = await this.remainingContainers();
    const leftovers = remaining.filter((name) => names.includes(name));
    for (const name of leftovers) {
      await this.cleanup(name).catch((error: unknown) => {
        const warn = this.options.logger?.warn ?? ((message: string) => console.warn(message));
        warn(`sandbox-oci: 残留容器清理失败（${name}）：${error instanceof Error ? error.message : "unknown"}`);
      });
    }
  }

  /** 列出现存容器名（残留验证用）。 */
  private async remainingContainers(): Promise<string[]> {
    const result = await this.options.runFile(this.options.config.podmanPath, [
      "ps", "-a", "--format", "{{.Names}}",
    ], {
      timeout: CLEANUP_TIMEOUT_MS,
      windowsHide: true,
    }).catch(() => undefined);
    const stdout = (result as { stdout?: Buffer | string } | undefined)?.stdout;
    if (!stdout) return [];
    return String(stdout).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  }
}
