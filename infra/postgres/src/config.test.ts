/**
 * config 模块测试。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCreatedbArgs,
  buildPostgresServerOptions,
  createRuntimePaths,
  loadLocalDatabaseConfig,
  redactDatabaseUrl,
} from "./config.js";

describe("portable PostgreSQL configuration", () => {
  it("requires an explicit credential-bearing database URL", () => {
    expect(() => loadLocalDatabaseConfig({})).toThrow("DATABASE_URL is required");
  });

  it("accepts localhost and keeps credentials out of labels", () => {
    const value = "postgresql://local_user:secret-value@localhost:5544/local_db";
    const config = loadLocalDatabaseConfig({ DATABASE_URL: value });

    expect(config.password).toBe("secret-value");
    expect(redactDatabaseUrl(config)).toBe("postgresql://local_user@localhost:5544/local_db");
  });

  it("rejects remote database URLs for portable lifecycle commands", () => {
    expect(() =>
      loadLocalDatabaseConfig({
        DATABASE_URL: "postgresql://user:password@database.example.com:5432/app",
      }),
    ).toThrow(/localhost or 127\.0\.0\.1/);
  });
});

describe("portable PostgreSQL command construction", () => {
  it("builds loopback-only server options", () => {
    const config = loadLocalDatabaseConfig({ DATABASE_URL: "postgresql://local_user:secret@127.0.0.1:5432/lark_claw" });

    expect(buildPostgresServerOptions(config)).toBe("-p 5432 -h 127.0.0.1");
  });

  it("builds createdb arguments without psql-only database flags", () => {
    const config = loadLocalDatabaseConfig({ DATABASE_URL: "postgresql://lark_claw:secret@127.0.0.1:5432/lark_claw" });

    expect(buildCreatedbArgs(config)).toEqual([
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "lark_claw",
      "--maintenance-db=postgres",
      "lark_claw",
    ]);
  });

  it("keeps generated files under var/postgres", () => {
    const root = resolve("D:/workspace/dsh-lark");
    const paths = createRuntimePaths(root);

    expect(paths.root).toBe(resolve(root, "var/postgres"));
    expect(paths.postgresRoot).toBe(resolve(root, "var/postgres/runtime/postgresql-17.9-1"));
    expect(paths.dataRoot).toBe(resolve(root, "var/postgres/data"));
  });
});
