/**
 * 本地数据库配置与运行时路径解析。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { resolve } from "node:path";

export const POSTGRES_VERSION = "17.9-1";
export const PGVECTOR_VERSION = "0.8.1";
export const PGWEB_VERSION = "0.17.0";
const DEFAULT_PORT = 5432;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

export interface LocalDatabaseConfig {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RuntimePaths {
  root: string;
  downloadsRoot: string;
  archivePath: string;
  postgresRoot: string;
  dataRoot: string;
  buildRoot: string;
  logPath: string;
  pgwebArchivePath: string;
  pgwebRoot: string;
  pgwebLogPath: string;
  pgwebPidPath: string;
}

export function loadLocalDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalDatabaseConfig {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  const parsed = parseDatabaseUrl(value);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_PORT;
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error("Portable PostgreSQL requires localhost or 127.0.0.1");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_URL contains an invalid port");
  }
  if (!user || !password || !DATABASE_NAME_PATTERN.test(database)) {
    throw new Error("DATABASE_URL requires a user, password, and simple database name");
  }
  return { url: value, host: parsed.hostname, port, user, password, database };
}

export function redactDatabaseUrl(config: LocalDatabaseConfig): string {
  return `postgresql://${encodeURIComponent(config.user)}@${config.host}:${config.port}/${config.database}`;
}

export function buildPostgresServerOptions(config: LocalDatabaseConfig): string {
  return `-p ${config.port} -h 127.0.0.1`;
}

export function buildCreatedbArgs(config: LocalDatabaseConfig): string[] {
  return [
    "-h",
    "127.0.0.1",
    "-p",
    String(config.port),
    "-U",
    config.user,
    "--maintenance-db=postgres",
    config.database,
  ];
}

export function createRuntimePaths(repositoryRoot: string): RuntimePaths {
  const root = resolve(repositoryRoot, "var/postgres");
  const downloadsRoot = resolve(root, "downloads");
  return {
    root,
    downloadsRoot,
    archivePath: resolve(downloadsRoot, `postgresql-${POSTGRES_VERSION}-windows-x64-binaries.zip`),
    postgresRoot: resolve(root, `runtime/postgresql-${POSTGRES_VERSION}`),
    dataRoot: resolve(root, "data"),
    buildRoot: resolve(root, "build"),
    logPath: resolve(root, "logs/postgres.log"),
    pgwebArchivePath: resolve(downloadsRoot, `pgweb-${PGWEB_VERSION}-windows-amd64.zip`),
    pgwebRoot: resolve(root, `runtime/pgweb-${PGWEB_VERSION}`),
    pgwebLogPath: resolve(root, "logs/pgweb.log"),
    pgwebPidPath: resolve(root, "pgweb.pid"),
  };
}

function parseDatabaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use postgresql:// or postgres://");
  }
  return parsed;
}
