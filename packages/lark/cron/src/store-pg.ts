/**
 * pg 连接池（与 knowledge-postgres 的数据库适配同构——cron 独立依赖 pg，
 * 不与 knowledge 包耦合）。
 */
import { Pool, type QueryResultRow } from "pg";

import type { MigrationDatabase, MigrationQueryExecutor } from "dsh-lark-postgres-runtime";

import type { CronDatabase, CronQueryExecutor, CronQueryResult } from "./store.js";

/** pg 池实现（同时满足 infra 迁移器的 MigrationDatabase 契约）。 */
export class PgCronDatabase implements CronDatabase, MigrationDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<CronQueryResult<Row>> {
    return this.pool.query<Row>(sql, params);
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(run: (executor: CronQueryExecutor & MigrationQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor = {
        query: <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => client.query<Row>(sql, params),
        execute: async (sql: string) => { await client.query(sql); },
      } satisfies CronQueryExecutor & MigrationQueryExecutor;
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
