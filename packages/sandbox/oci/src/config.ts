/**
 * OCI 沙箱配置解析（SPEC sandbox-oci.md §3/§6）。
 *
 * 安全不变量：
 * - 镜像必须是固定标签或 digest（`latest` 拒绝——可变镜像不可审计）；
 * - 网络默认关闭（none），bridge 是显式配置动作；
 * - 本地逃逸开关（localInsecure）在生产配置中一律拒绝（fail closed at load）。
 */
import { isAbsolute, resolve } from "node:path";

export type SandboxNetworkMode = "none" | "bridge";

export interface ResolvedSandboxConfig {
  image: string;
  podmanPath: string;
  network: SandboxNetworkMode;
  resources: { cpus: number; memoryMiB: number; pids: number; tmpfsMiB: number };
  /** 工作区根（绝对路径）。 */
  workspaceRoot: string;
  /** 每 quota 用户存储上限（字节，默认 3 GiB）。 */
  storageLimitBytes: number;
}

export interface SandboxConfigInput {
  image: string;
  podmanPath?: string;
  /** 网络模式（白名单校验在 resolve 内：none/bridge；缺省 none）。 */
  network?: string;
  resources?: { cpus: number; memoryMiB: number; pids: number; tmpfsMiB: number };
  workspaceRoot: string;
  storageLimitBytes?: number;
}

export class SandboxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigurationError";
  }
}

const WINDOWS_PODMAN = "C:\\Program Files\\RedHat\\Podman\\podman.exe";
const DEFAULT_STORAGE_LIMIT_BYTES = 3 * 1024 ** 3;

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SandboxConfigurationError(`${name} 必须是正数`);
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SandboxConfigurationError(`${name} 必须是正安全整数`);
  }
  return value;
}

function resolveWorkspaceRoot(value: string): string {
  if (!value.trim() || !isAbsolute(value)) {
    throw new SandboxConfigurationError("workspaceRoot 必须是非空绝对路径");
  }
  return resolve(value);
}

function resolvePodmanPath(value: string | undefined): string {
  if (value === undefined) return process.platform === "win32" ? WINDOWS_PODMAN : "podman";
  if (!value.trim()) throw new SandboxConfigurationError("podmanPath 配置后不得为空");
  return value;
}

function resolveStorageLimit(value: number | undefined): number {
  const storageLimitBytes = positiveSafeInteger(value ?? DEFAULT_STORAGE_LIMIT_BYTES, "storageLimitBytes");
  if (storageLimitBytes > DEFAULT_STORAGE_LIMIT_BYTES) {
    throw new SandboxConfigurationError(`storageLimitBytes 不得超过 ${DEFAULT_STORAGE_LIMIT_BYTES}`);
  }
  return storageLimitBytes;
}

/** 镜像不可变：固定标签（非 latest）或 sha256 digest。 */
function immutableImage(image: string): boolean {
  if (/^[^\s]+@sha256:[a-f0-9]{64}$/i.test(image)) return true;
  const segment = image.slice(image.lastIndexOf("/") + 1);
  return segment.includes(":") && !segment.toLowerCase().endsWith(":latest");
}

export function resolveSandboxConfig(input: SandboxConfigInput): ResolvedSandboxConfig {
  if (!immutableImage(input.image)) {
    throw new SandboxConfigurationError("镜像必须使用固定标签或 digest（latest 拒绝）");
  }
  const network = input.network ?? "none";
  if (network !== "none" && network !== "bridge") {
    throw new SandboxConfigurationError("network 必须是 none 或 bridge");
  }
  const podmanPath = resolvePodmanPath(input.podmanPath);
  const resources = {
    cpus: positiveNumber(input.resources?.cpus ?? 2, "resources.cpus"),
    memoryMiB: positiveSafeInteger(input.resources?.memoryMiB ?? 4096, "resources.memoryMiB"),
    pids: positiveSafeInteger(input.resources?.pids ?? 256, "resources.pids"),
    tmpfsMiB: positiveSafeInteger(input.resources?.tmpfsMiB ?? 512, "resources.tmpfsMiB"),
  };
  return {
    image: input.image,
    podmanPath,
    network,
    resources,
    workspaceRoot: resolveWorkspaceRoot(input.workspaceRoot),
    storageLimitBytes: resolveStorageLimit(input.storageLimitBytes),
  };
}
