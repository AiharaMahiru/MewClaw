import { renameSync } from "node:fs";
import { appendFile, mkdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const FATAL_MESSAGE_LIMIT = 512;

export interface SupervisorPaths {
  adminEntry: string;
  adminLog: string;
  authEntry: string;
  authLog: string;
  gatewayEntry: string;
  gatewayLog: string;
  root: string;
  serviceRoot: string;
  status: string;
  stopRequest: string;
  supervisorLog: string;
  workerEntry: string;
  workerLog: string;
}

export function servicePaths(inputRoot: string): SupervisorPaths {
  const root = resolve(inputRoot);
  const serviceRoot = resolve(root, "var/services");
  return {
    adminEntry: resolve(root, "apps/admin/dist/main.js"),
    adminLog: resolve(serviceRoot, "admin.log"),
    authEntry: resolve(root, "apps/auth/dist/main.js"),
    authLog: resolve(serviceRoot, "auth.log"),
    gatewayEntry: resolve(root, "apps/lark-gateway/dist/main.js"),
    gatewayLog: resolve(serviceRoot, "gateway.log"),
    root,
    serviceRoot,
    status: resolve(serviceRoot, "status.json"),
    stopRequest: resolve(serviceRoot, "stop.request"),
    supervisorLog: resolve(serviceRoot, "supervisor.log"),
    workerEntry: resolve(root, "apps/lark-worker/dist/main.js"),
    workerLog: resolve(serviceRoot, "worker.log"),
  };
}

export async function rotateLog(path: string): Promise<void> {
  const size = await stat(path).then((value) => value.size).catch(() => 0);
  if (size < LOG_ROTATE_BYTES) return;
  const previous = `${path}.1`;
  await unlink(previous).catch(() => undefined);
  renameSync(path, previous);
}

export async function appendSupervisorFatal(root: string, error: unknown): Promise<void> {
  const paths = servicePaths(root);
  await mkdir(paths.serviceRoot, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    phase: "fatal",
    type: error instanceof Error ? error.name : typeof error,
    message: sanitizeFatalMessage(error),
  });
  await appendFile(paths.supervisorLog, `${line}\n`, "utf8");
}

function sanitizeFatalMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FATAL_MESSAGE_LIMIT);
}
