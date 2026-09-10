import { isAbsolute, resolve } from "node:path";

export interface BrowserConfig {
  host: "127.0.0.1";
  port: number;
  bearerToken: string;
  chromiumPath: string;
  workspaceRoot: string;
  profileRoot: string;
  maxSessions: number;
  idleTimeoutMs: number;
  actionTimeoutMs: number;
  maxRequestBytes: number;
  maxResultBytes: number;
  maxLogEntries: number;
  maxScreenshotCount: number;
  maxScreenshotBytes: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveBrowserConfig(env: Environment): BrowserConfig {
  const workspaceRoot = absolute(env.DSH_BROWSER_WORKSPACE_ROOT, "DSH_BROWSER_WORKSPACE_ROOT");
  const stateRoot = absolute(env.DSH_BROWSER_STATE_ROOT, "DSH_BROWSER_STATE_ROOT");
  const profileRoot = resolve(stateRoot, "profiles");
  return {
    host: "127.0.0.1",
    port: integer(env.DSH_BROWSER_PORT, 13_083, 1, 65_535, "DSH_BROWSER_PORT"),
    bearerToken: required(env.DSH_BROWSER_TOKEN ?? env.WORKER_TOKEN, "DSH_BROWSER_TOKEN 或 WORKER_TOKEN"),
    chromiumPath: absolute(env.DSH_BROWSER_CHROMIUM_PATH ?? "/usr/bin/chromium", "DSH_BROWSER_CHROMIUM_PATH"),
    workspaceRoot,
    profileRoot,
    maxSessions: integer(env.DSH_BROWSER_MAX_SESSIONS, 8, 1, 32, "DSH_BROWSER_MAX_SESSIONS"),
    idleTimeoutMs: integer(env.DSH_BROWSER_IDLE_TIMEOUT_MS, 10 * 60_000, 60_000, 60 * 60_000, "DSH_BROWSER_IDLE_TIMEOUT_MS"),
    actionTimeoutMs: integer(env.DSH_BROWSER_ACTION_TIMEOUT_MS, 30_000, 1_000, 120_000, "DSH_BROWSER_ACTION_TIMEOUT_MS"),
    maxRequestBytes: integer(env.DSH_BROWSER_MAX_REQUEST_BYTES, 256 * 1024, 1_024, 2 * 1024 * 1024, "DSH_BROWSER_MAX_REQUEST_BYTES"),
    maxResultBytes: integer(env.DSH_BROWSER_MAX_RESULT_BYTES, 512 * 1024, 1_024, 4 * 1024 * 1024, "DSH_BROWSER_MAX_RESULT_BYTES"),
    maxLogEntries: integer(env.DSH_BROWSER_MAX_LOG_ENTRIES, 200, 10, 2_000, "DSH_BROWSER_MAX_LOG_ENTRIES"),
    maxScreenshotCount: integer(env.DSH_BROWSER_MAX_SCREENSHOTS, 100, 1, 1_000, "DSH_BROWSER_MAX_SCREENSHOTS"),
    maxScreenshotBytes: integer(env.DSH_BROWSER_MAX_SCREENSHOT_BYTES, 100 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024, "DSH_BROWSER_MAX_SCREENSHOT_BYTES"),
  };
}

function absolute(value: string | undefined, field: string): string {
  const input = required(value, field);
  if (!isAbsolute(input)) fail(`${field} 必须为绝对路径`);
  return resolve(input);
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

function fail(message: string): never {
  throw new Error(`dsh-browser-app: ${message}`);
}
