import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const sqliteOpenHook = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined }));

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<{ DatabaseSync: typeof DatabaseSync }>();
  type ConstructorArgs = ConstructorParameters<typeof actual.DatabaseSync>;
  return {
    ...actual,
    DatabaseSync: class HookedDatabaseSync extends actual.DatabaseSync {
      constructor(...args: ConstructorArgs) {
        sqliteOpenHook.beforeOpen?.(String(args[0]));
        super(...args);
      }
    },
  };
});

import { readFrozenDoorAgentSource } from "./source.js";

const SHA256_HEX = "a".repeat(64);
const ROOT_MANIFEST = "manifest-v5.json";
const DOMAIN_PATHS = {
  auth: "auth/manifest.json",
  jsonl: "files/jsonl-manifest-v2.json",
  qdrant: "qdrant/manifest.json",
  source: "files/source-manifest-v3.json",
  sqlite: "sqlite/manifest.json",
  topology: "topology/manifest.json",
  workspaces: "files/workspaces-manifest-v2.json",
} as const;
const TABLES = [
  "billing_accounts",
  "billing_ledger",
  "billing_recharge_requests",
  "billing_usage_snapshots",
  "email_verification_codes",
  "runtime_invalidation_outbox_entries",
  "runtime_invalidation_outbox_meta",
  "sessions",
  "upload_storage_reservations",
  "user_preferences",
  "users",
] as const;

interface Fixture {
  root: string;
  manifestDigest: string;
}

const roots: string[] = [];

afterEach(() => {
  sqliteOpenHook.beforeOpen = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readFrozenDoorAgentSource", () => {
  it("读取 final v5 冻结源并只公开脱敏 inventory", async () => {
    const fixture = createFixture();

    const loaded = await readFrozenDoorAgentSource(sourceInput(fixture));

    expect(loaded.inventory.counts).toEqual([{ sourceType: "user", count: 16 }]);
    expect(loaded.inventory.users).toHaveLength(16);
    expect(loaded.records).toHaveLength(16);
    expect(JSON.stringify(loaded.inventory)).not.toMatch(/@|scrypt:|workspace/i);
  });

  it.each([
    ["rehearsal kind/frozen status", "dooragent-source-freeze-aggregate", "frozen", true],
    ["final kind/derived status", "dooragent-source-freeze-final-aggregate", "frozen-with-derived-qdrant", true],
    ["rehearsal kind/final status", "dooragent-source-freeze-aggregate", "frozen-with-derived-qdrant", false],
    ["final kind/frozen status", "dooragent-source-freeze-final-aggregate", "frozen", false],
  ])("只接受精确的 %s 配对", async (_label, kind, status, accepted) => {
    const fixture = createFixture();
    const manifest = readJson(join(fixture.root, ROOT_MANIFEST));
    writeJson(join(fixture.root, ROOT_MANIFEST), { ...manifest, kind, status });

    const result = readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture)));
    if (accepted) {
      await expect(result).resolves.toMatchObject({ inventory: { manifestVersion: 5 } });
    } else {
      await expect(result).rejects.toMatchObject({ code: "SOURCE_NOT_FROZEN" });
    }
  });

  it.each([
    ["旧 manifest", { manifest_version: 3 }, "SOURCE_NOT_FROZEN"],
    ["非最终冻结", { final_freeze: false }, "SOURCE_NOT_FROZEN"],
    ["非 frozen 状态", { status: "manifested" }, "SOURCE_NOT_FROZEN"],
    ["存在 blocked domain", { blocked_domains: ["qdrant"] }, "SOURCE_NOT_FROZEN"],
    ["存在 drift domain", { drift_domains: ["source"] }, "SOURCE_NOT_FROZEN"],
  ])("拒绝%s", async (_label, patch, code) => {
    const fixture = createFixture();
    const manifest = readJson(join(fixture.root, ROOT_MANIFEST));
    writeJson(join(fixture.root, ROOT_MANIFEST), { ...manifest, ...patch });

    await expect(readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture))))
      .rejects.toMatchObject({ code });
  });

  it("拒绝跨 domain 路径替换", async () => {
    const fixture = createFixture();
    const manifest = readJson(join(fixture.root, ROOT_MANIFEST));
    const domains = manifest.domains as Record<string, Record<string, unknown>>;
    domains.auth = {
      ...domains.auth,
      manifest_relative_path: DOMAIN_PATHS.sqlite,
      manifest_sha256: sha256File(join(fixture.root, DOMAIN_PATHS.sqlite)),
    };
    writeJson(join(fixture.root, ROOT_MANIFEST), manifest);

    await expect(readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture))))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("拒绝 domain manifest 摘要漂移", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, DOMAIN_PATHS.auth), "{}\n");

    await expect(readFrozenDoorAgentSource(sourceInput(fixture)))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("要求 Qdrant 是唯一 derived/discarded domain", async () => {
    const fixture = createFixture();
    const manifest = readJson(join(fixture.root, ROOT_MANIFEST));
    const domains = manifest.domains as Record<string, Record<string, unknown>>;
    domains.qdrant = { ...domains.qdrant, status: "frozen" };
    writeJson(join(fixture.root, ROOT_MANIFEST), manifest);

    await expect(readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture))))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("拒绝没有 discarded Qdrant 重建契约的 final freeze", async () => {
    const fixture = createFixture();
    writeJson(join(fixture.root, DOMAIN_PATHS.qdrant), {
      kind: "qdrant-fixture",
      status: "derived",
      migration_disposition: "discarded",
      rebuild_strategy: "copy-vectors",
    });
    sealRootManifest(fixture.root);

    await expect(readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture))))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("拒绝 symlink 目录，即使内容摘要未变化", async () => {
    const fixture = createFixture();
    const external = mkdtempSync(join(tmpdir(), "dooragent-external-"));
    roots.push(external);
    mkdirSync(join(external, "auth"));
    writeFileSync(join(external, "auth", "manifest.json"), readFileSync(join(fixture.root, DOMAIN_PATHS.auth)));
    writeFileSync(join(external, "auth", "users.sqlite"), readFileSync(join(fixture.root, "auth/users.sqlite")));
    rmSync(join(fixture.root, "auth"), { recursive: true });
    symlinkSync(join(external, "auth"), join(fixture.root, "auth"), "junction");

    await expect(readFrozenDoorAgentSource(sourceInput(fixture)))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it.each([
    ["schema 摘要", (manifest: AuthManifest) => { manifest.schema_sha256 = SHA256_HEX; }],
    ["users 计数", (manifest: AuthManifest) => { manifest.table_counts.users = 15; }],
    ["quick_check", (manifest: AuthManifest) => { manifest.snapshot.quick_check = "failed"; }],
    ["journal mode", (manifest: AuthManifest) => { manifest.snapshot.journal_mode = "wal"; }],
  ])("拒绝 Auth SQLite %s不一致", async (_label, mutate) => {
    const fixture = createFixture();
    const path = join(fixture.root, DOMAIN_PATHS.auth);
    const manifest = readJson(path) as unknown as AuthManifest;
    mutate(manifest);
    writeJson(path, manifest);
    sealRootManifest(fixture.root);

    await expect(readFrozenDoorAgentSource(sourceInput(refreshDigest(fixture))))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("拒绝显式 manifest 摘要不匹配", async () => {
    const fixture = createFixture();

    await expect(readFrozenDoorAgentSource({
      ...sourceInput(fixture),
      manifestDigest: "f".repeat(64),
    })).rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  it("校验后源路径被替换时仍只读取已验证字节", async () => {
    const fixture = createFixture();
    const sourcePath = join(fixture.root, "auth/users.sqlite");
    const replacementPath = join(fixture.root, "auth/replacement.sqlite");
    copyFileSync(sourcePath, replacementPath);
    updateFirstEmail(replacementPath, "attacker@example.invalid");
    let sourcePathReopened = false;
    sqliteOpenHook.beforeOpen = (openedPath) => {
      if (openedPath !== sourcePath) return;
      sourcePathReopened = true;
      copyFileSync(replacementPath, sourcePath);
    };

    const loaded = await readFrozenDoorAgentSource(sourceInput(fixture));

    expect(sourcePathReopened).toBe(false);
    expect(loaded.records[0]?.email).toBe("user-0@example.invalid");
  });
});

interface AuthManifest {
  schema_sha256: string;
  sqlite_user_version: number;
  table_counts: Record<string, number>;
  snapshot: {
    journal_mode: string;
    quick_check: string;
    relative_path: string;
    sha256: string;
    size_bytes: number;
  };
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dooragent-source-"));
  roots.push(root);
  for (const relative of Object.values(DOMAIN_PATHS)) mkdirSync(dirname(join(root, relative)), { recursive: true });
  const databasePath = join(root, "auth/users.sqlite");
  createAuthDatabase(databasePath);
  const authManifest = buildAuthManifest(databasePath);
  writeJson(join(root, DOMAIN_PATHS.auth), authManifest);
  for (const [domain, relative] of Object.entries(DOMAIN_PATHS)) {
    if (domain === "auth") continue;
    const body = domain === "qdrant"
      ? { kind: "qdrant-fixture", status: "derived", migration_disposition: "discarded",
        rebuild_strategy: "reingest-from-facts" }
      : domain === "workspaces"
        ? buildWorkspaceManifest(authManifest.snapshot.sha256)
        : { kind: `${domain}-fixture`, status: "frozen" };
    writeJson(join(root, relative), body);
  }
  sealRootManifest(root);
  return { root, manifestDigest: sha256File(join(root, ROOT_MANIFEST)) };
}

function buildWorkspaceManifest(authSnapshotSha256: string): Record<string, unknown> {
  const aggregate = {
    bytes: 0,
    directory_count: 16,
    file_count: 0,
    merkle_root_sha256: "a".repeat(64),
    special_file_count: 0,
    symlink_count: 0,
    unreadable_entries: 0,
    unstable_files: 0,
  };
  const roots = Array.from({ length: 16 }, (_, index) => ({
    root_path_sha256: sha256Text(`/srv/workspaces/user-${index}`),
    status: "manifested",
    aggregate,
    evidence: {
      directory_exists: true,
      directory_uid_matches_runtime: true,
      is_directory: true,
      non_overlapping: true,
      not_wide_system_root: true,
      symlink_chain_absent: true,
      unique_auth_reference: true,
      user_id_is_path_component: true,
    },
  }));
  return {
    kind: "dooragent-workspace-live-aggregate",
    manifest_version: 3,
    merkle_algorithm: "sha256-canonical-leaves-path-digest-order-duplicate-last",
    path_disclosure: "sha256-only",
    status: "manifested",
    semantics: "live-aggregate-not-final-freeze-or-restorable-copy",
    source_auth_snapshot_sha256: authSnapshotSha256,
    workspace: {
      referenced_root_count: roots.length,
      manifested_root_count: roots.length,
      missing_count: 0,
      rejected_root_count: 0,
      roots,
      aggregate: {
        ...aggregate,
        directory_count: aggregate.directory_count * roots.length,
      },
    },
    uploads: {},
  };
}

function createAuthDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        user_group TEXT NOT NULL
      );
    `);
    for (const table of TABLES) {
      if (table !== "users") database.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY);`);
    }
    const insert = database.prepare(`
      INSERT INTO users (
        id, email, name, password_hash, role, status, workspace_root,
        created_at, updated_at, last_login_at, user_group
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 16; index += 1) {
      insert.run(
        `dooragent-user-${index.toString().padStart(2, "0")}`,
        `user-${index}@example.invalid`,
        `User ${index}`,
        `scrypt:${"a".repeat(32)}:${"b".repeat(128)}`,
        index < 3 ? "admin" : "user",
        "active",
        `/srv/workspaces/user-${index}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        null,
        "default",
      );
    }
  } finally {
    database.close();
  }
}

function updateFirstEmail(path: string, email: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE users SET email = ? WHERE id = ?")
      .run(email, "dooragent-user-00");
  } finally {
    database.close();
  }
}

function buildAuthManifest(databasePath: string): AuthManifest & Record<string, unknown> {
  const database = new DatabaseSync(databasePath, { readOnly: true, returnArrays: true });
  try {
    const schemaRows = database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
    ).all();
    const tableCounts = Object.fromEntries(TABLES.map((table) => [
      table,
      Number(firstColumn(database, `SELECT COUNT(*) FROM "${table}"`)),
    ]));
    return {
      backup_method: "sqlite3.Connection.backup",
      completed_at_utc: "2026-08-24T00:00:00.000Z",
      created_at_utc: "2026-08-24T00:00:00.000Z",
      kind: "dooragent-auth-rehearsal-snapshot",
      manifest_version: 1,
      schema_sha256: sha256Text(JSON.stringify(schemaRows)),
      snapshot: {
        journal_mode: String(firstColumn(database, "PRAGMA journal_mode")),
        quick_check: String(firstColumn(database, "PRAGMA quick_check")),
        relative_path: "auth/users.sqlite",
        sha256: sha256File(databasePath),
        size_bytes: readFileSync(databasePath).byteLength,
      },
      source_boot_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      source_commit: "b".repeat(40),
      sqlite_user_version: Number(firstColumn(database, "PRAGMA user_version")),
      sqlite_version: "3.50.4",
      table_counts: tableCounts,
    };
  } finally {
    database.close();
  }
}

function firstColumn(database: DatabaseSync, sql: string): unknown {
  const row: unknown = database.prepare(sql).get();
  if (!Array.isArray(row) || row.length !== 1) throw new Error("fixture query shape invalid");
  return row[0];
}

function sealRootManifest(root: string): void {
  const domains = Object.fromEntries(Object.entries(DOMAIN_PATHS).map(([domain, relative]) => [domain, {
    manifest_relative_path: relative,
    manifest_sha256: sha256File(join(root, relative)),
    restorable: domain === "auth" || domain === "sqlite",
    status: domain === "qdrant" ? "derived" : "frozen",
  }]));
  writeJson(join(root, ROOT_MANIFEST), {
    blocked_domains: [],
    created_at_utc: "2026-08-24T00:00:00.000Z",
    discarded_domains: ["qdrant"],
    domains,
    drift_domains: [],
    final_freeze: true,
    kind: "dooragent-source-freeze-aggregate",
    manifest_version: 5,
    status: "frozen",
    supersedes_manifest_sha256: "d".repeat(64),
  });
}

function sourceInput(fixture: Fixture) {
  return {
    snapshotPath: fixture.root,
    manifestPath: ROOT_MANIFEST,
    manifestDigest: fixture.manifestDigest,
  } as const;
}

function refreshDigest(fixture: Fixture): Fixture {
  return { ...fixture, manifestDigest: sha256File(join(fixture.root, ROOT_MANIFEST)) };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "w" });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
