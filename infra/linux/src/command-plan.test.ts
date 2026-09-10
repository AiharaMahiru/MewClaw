import { describe, expect, it } from "vitest";

import {
  planPostgresRestore,
  planPostgresSnapshot,
  planSqliteSnapshot,
  planTreeArchive,
} from "./command-plan.js";

const DATABASE = {
  database: "dsh",
  host: "127.0.0.1" as const,
  port: 15432,
  user: "dsh",
};

describe("snapshot and restore command planning", () => {
  it("builds a custom-format PostgreSQL snapshot without credentials", () => {
    expect(
      planPostgresSnapshot({
        ...DATABASE,
        outputPath: "/var/lib/dsh/backups/run-1/postgres.dump",
        pgDumpPath: "/usr/bin/pg_dump",
      }),
    ).toEqual({
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "15432",
        "--username",
        "dsh",
        "--format=custom",
        "--file",
        "/var/lib/dsh/backups/run-1/postgres.dump",
        "dsh",
      ],
      executable: "/usr/bin/pg_dump",
      kind: "exec",
      requiredEnvironment: ["PGPASSFILE"],
    });
  });

  it("creates an isolated database before restoring", () => {
    expect(
      planPostgresRestore({
        ...DATABASE,
        createdbPath: "/usr/bin/createdb",
        inputPath: "/var/lib/dsh/backups/run-1/postgres.dump",
        pgRestorePath: "/usr/bin/pg_restore",
        restoreDatabase: "dsh_restore_run_1",
      }),
    ).toEqual([
      {
        args: [
          "--host",
          "127.0.0.1",
          "--port",
          "15432",
          "--username",
          "dsh",
          "--maintenance-db=postgres",
          "dsh_restore_run_1",
        ],
        executable: "/usr/bin/createdb",
        kind: "exec",
        requiredEnvironment: ["PGPASSFILE"],
      },
      {
        args: [
          "--host",
          "127.0.0.1",
          "--port",
          "15432",
          "--username",
          "dsh",
          "--dbname",
          "dsh_restore_run_1",
          "--exit-on-error",
          "/var/lib/dsh/backups/run-1/postgres.dump",
        ],
        executable: "/usr/bin/pg_restore",
        kind: "exec",
        requiredEnvironment: ["PGPASSFILE"],
      },
    ]);
  });

  it("plans SQLite online backup and bounded tree archives as argv", () => {
    expect(
      planSqliteSnapshot({
        outputPath: "/var/lib/dsh/backups/run-1/dooragent.sqlite",
        sourcePath: "/var/lib/dooragent/data/dooragent.sqlite",
        sqlitePath: "/usr/bin/sqlite3",
      }),
    ).toEqual({
      args: [
        "-cmd",
        ".timeout 5000",
        "/var/lib/dooragent/data/dooragent.sqlite",
        ".backup /var/lib/dsh/backups/run-1/dooragent.sqlite",
      ],
      executable: "/usr/bin/sqlite3",
      kind: "exec",
      requiredEnvironment: [],
    });
    expect(
      planTreeArchive({
        outputPath: "/var/lib/dsh/backups/run-1/workspaces.tar",
        sourceRoot: "/var/lib/dooragent/workspaces",
        tarPath: "/usr/bin/tar",
      }),
    ).toEqual({
      args: ["--create", "--file", "/var/lib/dsh/backups/run-1/workspaces.tar", "--directory", "/var/lib/dooragent/workspaces", "."],
      executable: "/usr/bin/tar",
      kind: "exec",
      requiredEnvironment: [],
    });
  });

  it("rejects command paths and identifiers that would need shell parsing", () => {
    expect(() =>
      planPostgresSnapshot({ ...DATABASE, outputPath: "/tmp/out.dump;touch x", pgDumpPath: "/usr/bin/pg_dump" }),
    ).toThrow(/safe absolute path/);
    expect(() =>
      planPostgresRestore({
        ...DATABASE,
        createdbPath: "/usr/bin/createdb",
        inputPath: "/tmp/input.dump",
        pgRestorePath: "/usr/bin/pg_restore",
        restoreDatabase: "dsh_restore;drop",
      }),
    ).toThrow(/database name/);
  });
});
