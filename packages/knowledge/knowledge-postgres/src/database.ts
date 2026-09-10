/**
 * 数据库访问层：连接池 + 事务（lark-claw PgKnowledgeDatabase 平移）。
 *
 * 事务语义：BEGIN → 回调 → COMMIT；异常 ROLLBACK 后重抛；连接始终归还。
 */
import { Pool, type QueryResultRow } from "pg";

import type { MigrationDatabase, MigrationQueryExecutor } from "dsh-lark-postgres-runtime";

export interface KnowledgeQueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
}

export interface KnowledgeQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<KnowledgeQueryResult<Row>>;
  execute(sql: string): Promise<void>;
}

export interface KnowledgeDatabase extends KnowledgeQueryExecutor {
  transaction<T>(run: (executor: KnowledgeQueryExecutor) => Promise<T>): Promise<T>;
}

/** pg 连接池实现（同时满足 infra 迁移器的 MigrationDatabase 契约）。 */
export class PgKnowledgeDatabase implements KnowledgeDatabase, MigrationDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
    return this.pool.query<Row>(sql, params);
  }

  async execute(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(run: (executor: KnowledgeQueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 兼容别名（供 MigrationDatabase 消费方直读）。 */
export type MigrationExecutor = MigrationQueryExecutor;
