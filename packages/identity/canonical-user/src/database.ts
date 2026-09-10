import { Pool, type QueryResultRow } from "pg";

import type { MigrationDatabase, MigrationQueryExecutor } from "dsh-lark-postgres-runtime";

export interface CanonicalUserQueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount?: number | null;
}

export interface CanonicalUserQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<CanonicalUserQueryResult<Row>>;
  execute(sql: string): Promise<void>;
}

export const CANONICAL_USER_TRANSACTION_EXECUTOR = Symbol("dsh-canonical-user.transaction-executor");

export interface CanonicalUserTransactionExecutor extends CanonicalUserQueryExecutor {
  readonly [CANONICAL_USER_TRANSACTION_EXECUTOR]: true;
}

export interface CanonicalUserDatabase extends CanonicalUserQueryExecutor, MigrationDatabase {
  transaction<T>(run: (executor: CanonicalUserTransactionExecutor & MigrationQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgCanonicalUserDatabase implements CanonicalUserDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<CanonicalUserQueryResult<Row>> {
    return this.pool.query<Row>(sql, params);
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(run: (executor: CanonicalUserTransactionExecutor & MigrationQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor = {
        [CANONICAL_USER_TRANSACTION_EXECUTOR]: true,
        query: <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => client.query<Row>(sql, params),
        execute: async (sql: string) => { await client.query(sql); },
      } satisfies CanonicalUserTransactionExecutor & MigrationQueryExecutor;
      const result = await run(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
