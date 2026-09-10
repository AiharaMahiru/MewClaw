/**
 * pgweb 模块测试。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { describe, expect, it } from "vitest";

import { createRuntimePaths, loadLocalDatabaseConfig } from "./config.js";
import { PGWEB_ARCHIVE } from "./manifest.js";
import { buildPgwebArgs, buildPgwebEnv, getPgwebUrl } from "./pgweb.js";

describe("portable pgweb configuration", () => {
  it("pins the official Windows archive and runtime paths", () => {
    const paths = createRuntimePaths("D:/workspace/dsh-lark");

    expect(PGWEB_ARCHIVE.version).toBe("0.17.0");
    expect(PGWEB_ARCHIVE.sha256).toBe(
      "7471bb79175549622f90877f5aec69c20ec014b3d4b3df288c1121f8775728bc",
    );
    const runtimeSegment = process.platform === "win32"
      ? String.raw`var\postgres\runtime\pgweb-0.17.0`
      : "var/postgres/runtime/pgweb-0.17.0";
    expect(paths.pgwebRoot).toContain(runtimeSegment);
  });

  it("binds the panel to loopback without credentials in process arguments", () => {
    const config = loadLocalDatabaseConfig({ DATABASE_URL: "postgresql://local_user:secret@127.0.0.1:5432/local_db" });
    const args = buildPgwebArgs();

    expect(args).toEqual([
      "--bind",
      "127.0.0.1",
      "--listen",
      "8081",
      "--skip-open",
      "--no-ssh",
      "--lock-session",
    ]);
    expect(args.join(" ")).not.toContain(config.password);
    expect(buildPgwebEnv(config).PGWEB_DATABASE_URL).toBe(config.url);
    expect(getPgwebUrl()).toBe("http://127.0.0.1:8081");
  });
});
