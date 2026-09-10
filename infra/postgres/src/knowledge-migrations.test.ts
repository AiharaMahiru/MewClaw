import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_MIGRATIONS,
  runKnowledgeMigrations,
} from "./knowledge-migrations.js";
import type { MigrationDatabase } from "./migration.js";

describe("knowledge PostgreSQL bootstrap migrations", () => {
  it("keeps the migration order and schema in the runtime source", () => {
    expect(KNOWLEDGE_MIGRATIONS.map(({ version }) => version)).toEqual([
      "knowledge/001_knowledge",
      "knowledge/002_document_creator",
      "knowledge/003_ingestion_jobs",
    ]);
    expect(KNOWLEDGE_MIGRATIONS[0].sql).toContain("CREATE TABLE IF NOT EXISTS knowledge_bases");
    expect(KNOWLEDGE_MIGRATIONS[2].sql).toContain("CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs");
  });

  it("applies runtime migrations through the shared lock and checksum table", async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const database: MigrationDatabase = {
      execute: async (sql) => { statements.push({ sql }); },
      transaction: async (run) => run({
        query: async (sql, params) => {
          statements.push(params ? { sql, params } : { sql });
          return { rows: [] };
        },
        execute: async (sql) => { statements.push({ sql }); },
      }),
    };

    await runKnowledgeMigrations(database);

    expect(statements[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(statements.some(({ sql }) => sql.includes("schema_migrations"))).toBe(true);
    expect(statements.filter(({ sql }) => sql.startsWith("INSERT INTO schema_migrations")))
      .toHaveLength(KNOWLEDGE_MIGRATIONS.length);
    expect(statements.some(({ sql }) => sql.includes("skills/rag/migrations"))).toBe(false);
  });
});
