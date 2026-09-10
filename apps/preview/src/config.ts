import { isAbsolute, resolve } from "node:path";

export interface PreviewResources {
  cpus: number;
  memoryMiB: number;
  pids: number;
  tmpfsMiB: number;
}

export interface AppConfig {
  host: "127.0.0.1";
  port: number;
  workerToken: string;
  publicBaseUrl: string;
  workspaceRoot: string;
  image: string;
  podmanPath: string;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
  maxSharesPerUser: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  resources: PreviewResources;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveAppConfig(env: Environment): AppConfig {
  const workspaceRoot = required(env.DSH_PREVIEW_WORKSPACE_ROOT, "DSH_PREVIEW_WORKSPACE_ROOT");
  if (!isAbsolute(workspaceRoot)) fail("DSH_PREVIEW_WORKSPACE_ROOT 必须为绝对路径");
  const image = required(env.DSH_PREVIEW_IMAGE ?? env.DSH_SANDBOX_IMAGE, "DSH_PREVIEW_IMAGE 或 DSH_SANDBOX_IMAGE");
  if (image.includes("@latest") || /:latest$/.test(image)) fail("Preview 镜像必须锁定版本");
  const defaultTtlMinutes = integer(env.DSH_PREVIEW_DEFAULT_TTL_MINUTES, 60, 1, 1_440, "DSH_PREVIEW_DEFAULT_TTL_MINUTES");
  const maxTtlMinutes = integer(env.DSH_PREVIEW_MAX_TTL_MINUTES, 1_440, 1, 10_080, "DSH_PREVIEW_MAX_TTL_MINUTES");
  if (defaultTtlMinutes > maxTtlMinutes) fail("默认 TTL 不得大于最大 TTL");
  return {
    host: "127.0.0.1",
    port: integer(env.DSH_PREVIEW_PORT, 13_082, 1, 65_535, "DSH_PREVIEW_PORT"),
    workerToken: required(env.WORKER_TOKEN, "WORKER_TOKEN"),
    publicBaseUrl: publicUrl(env.DSH_PREVIEW_PUBLIC_BASE_URL),
    workspaceRoot: resolve(workspaceRoot),
    image,
    podmanPath: env.DSH_PREVIEW_PODMAN_PATH === undefined
      ? "podman"
      : required(env.DSH_PREVIEW_PODMAN_PATH, "DSH_PREVIEW_PODMAN_PATH"),
    defaultTtlMinutes,
    maxTtlMinutes,
    maxSharesPerUser: integer(env.DSH_PREVIEW_MAX_SHARES_PER_USER, 3, 1, 20, "DSH_PREVIEW_MAX_SHARES_PER_USER"),
    startupTimeoutMs: integer(env.DSH_PREVIEW_STARTUP_TIMEOUT_MS, 15_000, 1_000, 60_000, "DSH_PREVIEW_STARTUP_TIMEOUT_MS"),
    requestTimeoutMs: integer(env.DSH_PREVIEW_REQUEST_TIMEOUT_MS, 30_000, 1_000, 120_000, "DSH_PREVIEW_REQUEST_TIMEOUT_MS"),
    maxConcurrentRequests: integer(env.DSH_PREVIEW_MAX_CONCURRENT_REQUESTS, 64, 1, 512, "DSH_PREVIEW_MAX_CONCURRENT_REQUESTS"),
    maxRequestBytes: integer(env.DSH_PREVIEW_MAX_REQUEST_BYTES, 10 * 1024 * 1024, 1_024, 50 * 1024 * 1024, "DSH_PREVIEW_MAX_REQUEST_BYTES"),
    resources: {
      cpus: decimal(env.DSH_PREVIEW_CPUS, 1, 0.1, 8, "DSH_PREVIEW_CPUS"),
      memoryMiB: integer(env.DSH_PREVIEW_MEMORY_MIB, 512, 64, 4_096, "DSH_PREVIEW_MEMORY_MIB"),
      pids: integer(env.DSH_PREVIEW_PIDS, 128, 16, 1_024, "DSH_PREVIEW_PIDS"),
      tmpfsMiB: integer(env.DSH_PREVIEW_TMPFS_MIB, 128, 16, 1_024, "DSH_PREVIEW_TMPFS_MIB"),
    },
  };
}

function publicUrl(value: string | undefined): string {
  const input = value === undefined ? "https://chat.rwr.ink" : value;
  let url: URL;
  try { url = new URL(input); } catch { fail("DSH_PREVIEW_PUBLIC_BASE_URL 非法"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) fail("DSH_PREVIEW_PUBLIC_BASE_URL 必须为无凭证、无路径的 HTTPS URL");
  return url.href.replace(/\/$/, "");
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || !value.trim()) fail(`${field} 未配置`);
  return value;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) fail(`${field} 必须为安全整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${field} 必须位于 ${min}..${max}`);
  return parsed;
}

function decimal(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) fail(`${field} 必须位于 ${min}..${max}`);
  return parsed;
}

function fail(message: string): never {
  throw new Error(`dsh-preview-app: ${message}`);
}
