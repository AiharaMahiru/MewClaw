/**
 * 服务环境变量组装。
 * 来源：lark-claw packages/service-runtime（整体平移，M0）。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type Environment = Record<string, string | undefined>;

interface ServiceEnvironmentOptions {
  generate?: () => string;
  root?: string;
  fileExists?: (path: string) => boolean;
}

function generateInternalToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createServiceEnvironment(
  source: Environment,
  options: ServiceEnvironmentOptions = {},
): Environment {
  const generate = options.generate ?? generateInternalToken;
  const workerToken = source.WORKER_TOKEN?.trim() || generate();
  const configuredBridge = source.CDG_BRIDGE_PATH?.trim();
  const managedBridge = resolve(options.root ?? process.cwd(), "var/services/cdgbridge.exe");
  const fileExists = options.fileExists ?? existsSync;
  const bridgePath = configuredBridge || (fileExists(managedBridge) ? managedBridge : undefined);
  const environment: Environment = { ...source, WORKER_TOKEN: workerToken };
  delete environment.CDG_BRIDGE_PATH;
  if (bridgePath) environment.CDG_BRIDGE_PATH = bridgePath;
  if (source.DSH_AUTH_ENABLED === "true") {
    const webPort = source.DSH_WEB_INTERNAL_PORT?.trim() || "3081";
    const adminPort = source.ADMIN_PORT?.trim() || "8791";
    const authPort = source.AUTH_PORT?.trim() || "3080";
    environment.DSH_WEB_INTERNAL_PORT = webPort;
    environment.DSH_WEB_INTERNAL_URL = source.DSH_WEB_INTERNAL_URL?.trim() || `http://127.0.0.1:${webPort}`;
    environment.AUTH_ADMIN_URL = source.AUTH_ADMIN_URL?.trim() || `http://127.0.0.1:${adminPort}`;
    environment.AUTH_TRUSTED_ORIGINS = source.AUTH_TRUSTED_ORIGINS?.trim() || `http://127.0.0.1:${authPort}`;
    environment.AUTH_PAIRING_ENDPOINT = source.AUTH_PAIRING_ENDPOINT?.trim() || `http://127.0.0.1:${authPort}/internal/pairing/start`;
    environment.AUTH_PAIRING_TOKEN = source.AUTH_PAIRING_TOKEN?.trim() || workerToken;
  }
  return environment;
}
