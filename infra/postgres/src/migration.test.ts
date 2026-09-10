/**
 * migration 模块测试。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPostgresMigrationDatabase,
  runMigrations,
  type MigrationDatabase,
  type MigrationPool,
} from "./migration.js";

const databases: PGlite[] = [];

function database(pg: PGlite): MigrationDatabase {
  return {
    execute: async (sql) => { await pg.exec(sql); },
    transaction: (run) => pg.transaction(async (tx) => run({
      query: (sql, params) => tx.query(sql, params),
      execute: async (sql) => { await tx.exec(sql); },
    })),
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

describe("runMigrations", () => {
  it("records a checksum and remains idempotent", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const migrations = [{ version: "001_test", sql: "CREATE TABLE example (id integer PRIMARY KEY)" }];

    await runMigrations(database(pg), migrations);
    await runMigrations(database(pg), migrations);

    const records = await pg.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    expect(records.rows).toEqual([{
      version: "001_test",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
  });

  it("fails fast when an applied migration checksum changes", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    await runMigrations(database(pg), [{ version: "001_test", sql: "CREATE TABLE first (id integer)" }]);

    await expect(runMigrations(database(pg), [{
      version: "001_test",
      sql: "CREATE TABLE changed (id integer)",
    }])).rejects.toThrow(/checksum/i);
  });

  it("rejects an empty stored checksum instead of reapplying the version", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const migrations = [{ version: "001_test", sql: "CREATE TABLE first (id integer)" }];
    await runMigrations(database(pg), migrations);
    await pg.query("UPDATE schema_migrations SET checksum = '' WHERE version = '001_test'");

    await expect(runMigrations(database(pg), migrations)).rejects.toThrow(/checksum/i);
  });

  it("locks the migration table before inspecting or applying migrations", async () => {
    const statements: string[] = [];
    const fake: MigrationDatabase = {
      execute: async (sql) => { statements.push(sql); },
      transaction: async (run) => run({
        query: async (sql) => {
          statements.push(sql);
          return { rows: [] };
        },
        execute: async (sql) => { statements.push(sql); },
      }),
    };

    await runMigrations(fake, [{ version: "001_test", sql: "SELECT 1" }]);

    const advisoryIndex = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const createIndex = statements.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"));
    const lockIndex = statements.findIndex((sql) => sql.includes("LOCK TABLE schema_migrations"));
    const migrationIndex = statements.indexOf("SELECT 1");
    expect(advisoryIndex).toBeGreaterThan(-1);
    expect(advisoryIndex).toBeLessThan(createIndex);
    expect(createIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(lockIndex);
  });
});

describe("createPostgresMigrationDatabase", () => {
  it("commits and releases the pinned pool client", async () => {
    const statements: string[] = [];
    let released = false;
    const pool = fakePool(statements, () => { released = true; });
    const database = createPostgresMigrationDatabase(pool);

    await database.transaction(async (executor) => {
      await executor.execute("SELECT 1");
    });

    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(released).toBe(true);
  });

  it("rolls back and releases the client when the transaction fails", async () => {
    const statements: string[] = [];
    let released = false;
    const pool = fakePool(statements, () => { released = true; });
    const database = createPostgresMigrationDatabase(pool);

    await expect(database.transaction(async () => {
      throw new Error("migration failed");
    })).rejects.toThrow("migration failed");

    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toBe(true);
  });
});

function fakePool(statements: string[], release: () => void): MigrationPool {
  return {
    query: async () => ({ rows: [] }),
    connect: async () => ({
      query: async (sql) => {
        statements.push(sql);
        return { rows: [] };
      },
      release,
    }),
  };
}
