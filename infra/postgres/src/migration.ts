/**
 * 数据库迁移执行。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { createHash } from "node:crypto";

const CREATE_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;
const LOCK_MIGRATIONS_ADVISORY_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:schema-migrations', 0))";
const LOCK_MIGRATIONS_TABLE_SQL = "LOCK TABLE schema_migrations IN EXCLUSIVE MODE";

export interface Migration {
  version: string;
  sql: string;
}

export interface MigrationQueryResult {
  rows: unknown[];
}

export interface MigrationQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
  execute(sql: string): Promise<void>;
}

export interface MigrationDatabase {
  execute(sql: string): Promise<void>;
  transaction<T>(run: (executor: MigrationQueryExecutor) => Promise<T>): Promise<T>;
}

export interface MigrationPoolClient {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
  release(): void;
}

export interface MigrationPool {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
  connect(): Promise<MigrationPoolClient>;
}

/** 将 pg 连接池适配为迁移器契约，确保事务始终固定在同一连接。 */
export function createPostgresMigrationDatabase(pool: MigrationPool): MigrationDatabase {
  return {
    execute: async (sql) => { await pool.query(sql); },
    transaction: (run) => runPoolTransaction(pool, run),
  };
}

async function runPoolTransaction<T>(
  pool: MigrationPool,
  run: (executor: MigrationQueryExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run({
      query: (sql, params) => client.query(sql, params),
      execute: async (sql) => { await client.query(sql); },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function appliedChecksum(rows: unknown[]): string | undefined {
  const row = rows[0];
  if (!row || typeof row !== "object" || !("checksum" in row)) return undefined;
  return typeof row.checksum === "string" ? row.checksum : undefined;
}

export async function runMigrations(
  database: MigrationDatabase,
  migrations: readonly Migration[],
): Promise<void> {
  const versions = new Set(migrations.map((migration) => migration.version));
  if (versions.size !== migrations.length) throw new Error("Migration versions must be unique");
  await database.transaction(async (executor) => {
    // 先锁住跨 Provider 的迁移临界区，再创建共享表，避免 catalog 竞态。
    await executor.query(LOCK_MIGRATIONS_ADVISORY_SQL);
    await executor.execute(CREATE_MIGRATIONS_TABLE_SQL);
    await executor.query(LOCK_MIGRATIONS_TABLE_SQL);
    for (const migration of migrations) {
      const expected = checksum(migration.sql);
      const result = await executor.query(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      const applied = appliedChecksum(result.rows);
      if (applied !== undefined && applied !== expected) {
        throw new Error(`Migration checksum mismatch: ${migration.version}`);
      }
      if (applied !== undefined) continue;
      await executor.execute(migration.sql);
      await executor.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, expected],
      );
    }
  });
}
