import { Pool, type QueryResultRow } from "pg";

import type { MigrationDatabase, MigrationQueryExecutor } from "dsh-lark-postgres-runtime";

export interface BillingQueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount?: number | null;
}

export interface BillingQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<BillingQueryResult<Row>>;
  execute(sql: string): Promise<void>;
}

export interface BillingDatabase extends BillingQueryExecutor {
  transaction<T>(run: (executor: BillingQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgBillingDatabase implements BillingDatabase, MigrationDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<BillingQueryResult<Row>> {
    return this.pool.query<Row>(sql, params);
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(run: (executor: BillingQueryExecutor & MigrationQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor = {
        query: <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => client.query<Row>(sql, params),
        execute: async (sql: string) => { await client.query(sql); },
      } satisfies BillingQueryExecutor & MigrationQueryExecutor;
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
