/** 记忆图 PostgreSQL 访问层：连接池、参数化查询和事务。 */
import { Pool, type QueryResultRow } from "pg";

export interface MemoryQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
  execute(sql: string): Promise<void>;
}

export interface MemoryDatabase extends MemoryQueryExecutor {
  transaction<T>(run: (executor: MemoryQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgMemoryDatabase implements MemoryDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) {
    return this.pool.query<Row>(sql, params as unknown[] | undefined);
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(run: (executor: MemoryQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        query: (sql, params) => client.query(sql, params as unknown[] | undefined),
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
