import type { ExecPlan } from "./types.js";
import { assertPort, assertSafeAbsolutePath, isPathWithin } from "./validation.js";

const BACKUPS_ROOT = "/var/lib/dsh/backups";
const POSTGRES_PASSWORD_ENVIRONMENT = ["PGPASSFILE"] as const;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

interface DatabaseConnection {
  database: string;
  host: "127.0.0.1";
  port: number;
  user: string;
}

interface PostgresSnapshotInput extends DatabaseConnection {
  outputPath: string;
  pgDumpPath: string;
}

interface PostgresRestoreInput extends DatabaseConnection {
  createdbPath: string;
  inputPath: string;
  pgRestorePath: string;
  restoreDatabase: string;
}

interface SqliteSnapshotInput {
  outputPath: string;
  sourcePath: string;
  sqlitePath: string;
}

interface TreeArchiveInput {
  outputPath: string;
  sourceRoot: string;
  tarPath: string;
}

export function planPostgresSnapshot(input: PostgresSnapshotInput): ExecPlan {
  validateDatabaseConnection(input);
  const outputPath = assertBackupPath(input.outputPath, "outputPath");
  return command(input.pgDumpPath, [
    "--host", input.host,
    "--port", String(input.port),
    "--username", input.user,
    "--format=custom",
    "--file", outputPath,
    input.database,
  ], POSTGRES_PASSWORD_ENVIRONMENT);
}

export function planPostgresRestore(input: PostgresRestoreInput): readonly ExecPlan[] {
  validateDatabaseConnection(input);
  assertDatabaseName(input.restoreDatabase, "restore database name");
  const inputPath = assertBackupPath(input.inputPath, "inputPath");
  const connectionArgs = ["--host", input.host, "--port", String(input.port), "--username", input.user];
  return [
    command(
      input.createdbPath,
      [...connectionArgs, "--maintenance-db=postgres", input.restoreDatabase],
      POSTGRES_PASSWORD_ENVIRONMENT,
    ),
    command(
      input.pgRestorePath,
      [...connectionArgs, "--dbname", input.restoreDatabase, "--exit-on-error", inputPath],
      POSTGRES_PASSWORD_ENVIRONMENT,
    ),
  ];
}

export function planSqliteSnapshot(input: SqliteSnapshotInput): ExecPlan {
  const sourcePath = assertSafeAbsolutePath(input.sourcePath, "sourcePath");
  const outputPath = assertBackupPath(input.outputPath, "outputPath");
  return command(input.sqlitePath, [
    "-cmd",
    `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
    sourcePath,
    `.backup ${outputPath}`,
  ]);
}

export function planSqliteRestore(input: SqliteSnapshotInput): ExecPlan {
  const sourcePath = assertBackupPath(input.sourcePath, "sourcePath");
  const outputPath = assertSafeAbsolutePath(input.outputPath, "outputPath");
  return command(input.sqlitePath, [outputPath, `.restore ${sourcePath}`]);
}

export function planTreeArchive(input: TreeArchiveInput): ExecPlan {
  const sourceRoot = assertSafeAbsolutePath(input.sourceRoot, "sourceRoot");
  const outputPath = assertBackupPath(input.outputPath, "outputPath");
  return command(input.tarPath, ["--create", "--file", outputPath, "--directory", sourceRoot, "."]);
}

export function planTreeRestore(input: TreeArchiveInput): ExecPlan {
  const inputPath = assertBackupPath(input.outputPath, "inputPath");
  const targetRoot = assertSafeAbsolutePath(input.sourceRoot, "targetRoot");
  return command(input.tarPath, ["--extract", "--file", inputPath, "--directory", targetRoot, "--no-same-owner"]);
}

function command(
  executable: string,
  args: readonly string[],
  requiredEnvironment: readonly string[] = [],
): ExecPlan {
  return {
    args: [...args],
    executable: assertSafeAbsolutePath(executable, "executable"),
    kind: "exec",
    requiredEnvironment: [...requiredEnvironment],
  };
}

function validateDatabaseConnection(input: DatabaseConnection): void {
  if (input.host !== "127.0.0.1") throw new Error("database host must be loopback");
  assertPort(input.port, "database port");
  assertDatabaseName(input.user, "database user");
  assertDatabaseName(input.database, "database name");
}

function assertDatabaseName(value: string, label: string): string {
  if (!DATABASE_NAME_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertBackupPath(value: string, label: string): string {
  const path = assertSafeAbsolutePath(value, label);
  if (!isPathWithin(path, BACKUPS_ROOT)) throw new Error(`${label} must stay under the backups root`);
  return path;
}
