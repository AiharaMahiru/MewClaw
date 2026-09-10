import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAuthStore } from "./postgres-store.js";
import { PgAuthImportPersistence } from "./postgres-import-persistence.js";
import type { CommitFeishuPairingInput } from "./types.js";

const databaseUrl = process.env.DSH_AUTH_POSTGRES_TEST_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const NOW = "2026-08-24T00:00:00.000Z";

describePostgres("PostgresAuthStore administrator invariants", () => {
  const schema = `auth_admin_race_${randomUUID().replaceAll("-", "")}`;
  let control: Pool;
  let schemaCreated = false;
  let store: PostgresAuthStore;
  let importPersistence: PgAuthImportPersistence;

  beforeAll(async () => {
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scopedUrl = scopedDatabaseUrl(databaseUrl!, schema);
    store = new PostgresAuthStore(scopedUrl);
    await store.migrate();
    importPersistence = new PgAuthImportPersistence(scopedUrl);
    await importPersistence.migrate();
  });

  afterAll(async () => {
    await importPersistence?.close();
    await store?.close();
    if (schemaCreated) await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control?.end();
  });

  it("serializes concurrent disables and preserves one active administrator", async () => {
    const first = await store.createUser({ email: "pg-admin-1@example.com", displayName: "First", status: "active", now: NOW });
    const second = await store.createUser({ email: "pg-admin-2@example.com", displayName: "Second", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [second.id]);

    const results = await Promise.all([
      store.updateUserForAdmin(first.id, { status: "disabled" }, NOW),
      store.updateUserForAdmin(second.id, { status: "disabled" }, NOW),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["last-admin", "updated"]);
    expect((await store.listUsers()).filter((user) => user.role === "admin" && user.status === "active")).toHaveLength(1);
  });

  it("demotes an administrator only while another active administrator remains", async () => {
    const first = await store.createUser({ email: "pg-role-1@example.com", displayName: "First", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'user', default_mode = 'lightweight' WHERE role = 'admin'");
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [first.id]);
    await expect(store.updateUserForAdmin(first.id, { role: "user" }, NOW)).resolves.toEqual({ status: "last-admin" });
    const second = await store.createUser({ email: "pg-role-2@example.com", displayName: "Second", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [second.id]);

    await expect(store.updateUserForAdmin(first.id, { role: "user" }, NOW)).resolves.toMatchObject({
      status: "updated",
      user: { role: "user", defaultMode: "lightweight" },
    });
  });

  it("removes only workspace resources bound to one DoorAgent import run", async () => {
    const admin = await store.createUser({ email: "pg-cleanup-admin@example.com", displayName: "Admin", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [admin.id]);
    const owner = await store.createUser({ email: "pg-cleanup-owner@example.com", displayName: "Owner", status: "active", now: NOW });
    const session = await store.createSession({ userId: admin.id, tokenHash: "c".repeat(64), createdAt: NOW, expiresAt: "2026-08-25T00:00:00.000Z", ipHash: null, userAgentHash: null });
    const runId = `cleanup-${randomUUID()}`;
    const sourceId = `workspace-${randomUUID()}`;
    const resourceId = randomUUID();
    const retainedSourceId = `workspace-${randomUUID()}`;
    const retainedResourceId = randomUUID();
    await store.saveResource({ resourceType: "workspace", resourceId, userId: owner.id, resourcePath: "/var/lib/dsh/workspaces/imported", createdAt: NOW });
    await store.saveResource({ resourceType: "workspace", resourceId: retainedResourceId, userId: owner.id, resourcePath: "/var/lib/dsh/workspaces/native", createdAt: NOW });
    await store.pool.query(`
      INSERT INTO auth_import_mappings
        (source_system,source_type,source_id,source_digest,run_id,plan_id,target_type,
         target_id,target_user_id,result,reason_code,created_target,created_at,rolled_back_at)
      VALUES
        ('dooragent','workspace',$1,$2,$3,$4,'workspace',$5,$6,'claimed',NULL,true,$7,NULL),
        ('dooragent','workspace',$8,$9,$3,$4,'workspace',$10,$6,'unchanged',NULL,false,$7,NULL)
    `, [
      sourceId,
      "d".repeat(64),
      runId,
      "e".repeat(64),
      resourceId,
      owner.id,
      NOW,
      retainedSourceId,
      "f".repeat(64),
      retainedResourceId,
    ]);

    await expect(store.purgeImportedWorkspaceResources({
      runId,
      operatorUserId: admin.id,
      operatorSessionId: session.id,
      requestId: "cleanup-test",
      now: NOW,
    })).resolves.toBe(1);
    await expect(store.findResource("workspace", resourceId)).resolves.toBeUndefined();
    await expect(store.findResource("workspace", retainedResourceId)).resolves.toMatchObject({ resourceId: retainedResourceId });
    const mappings = await store.pool.query(
      "SELECT source_id, rolled_back_at FROM auth_import_mappings WHERE source_id = ANY($1)",
      [[sourceId, retainedSourceId]],
    );
    expect(mappings.rows.find((row) => row.source_id === sourceId)?.rolled_back_at).not.toBeNull();
    expect(mappings.rows.find((row) => row.source_id === retainedSourceId)?.rolled_back_at).toBeNull();
  });

  it("rejects workspace cleanup without a live administrator session", async () => {
    const admin = await store.createUser({ email: "pg-cleanup-denied@example.com", displayName: "Admin", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [admin.id]);

    await expect(store.purgeImportedWorkspaceResources({
      runId: `cleanup-${randomUUID()}`,
      operatorUserId: admin.id,
      operatorSessionId: randomUUID(),
      requestId: "cleanup-denied-test",
      now: NOW,
    })).rejects.toThrow("IMPORT_NOT_AUTHORIZED");
  });

  it("rolls back workspace cleanup when an imported resource is missing", async () => {
    const admin = await store.createUser({ email: "pg-cleanup-conflict@example.com", displayName: "Admin", status: "active", now: NOW });
    await store.pool.query("UPDATE auth_users SET role = 'admin', default_mode = 'full' WHERE id = $1", [admin.id]);
    const owner = await store.createUser({ email: "pg-cleanup-conflict-owner@example.com", displayName: "Owner", status: "active", now: NOW });
    const session = await store.createSession({ userId: admin.id, tokenHash: "f".repeat(64), createdAt: NOW, expiresAt: "2026-08-25T00:00:00.000Z", ipHash: null, userAgentHash: null });
    const sourceId = `workspace-${randomUUID()}`;
    const runId = `cleanup-${randomUUID()}`;
    await store.pool.query(`
      INSERT INTO auth_import_mappings
        (source_system,source_type,source_id,source_digest,run_id,plan_id,target_type,
         target_id,target_user_id,result,reason_code,created_target,created_at,rolled_back_at)
      VALUES ('dooragent','workspace',$1,$2,$3,$4,'workspace',$5,$6,'claimed',NULL,true,$7,NULL)
    `, [sourceId, "a".repeat(64), runId, "b".repeat(64), randomUUID(), owner.id, NOW]);

    await expect(store.purgeImportedWorkspaceResources({
      runId,
      operatorUserId: admin.id,
      operatorSessionId: session.id,
      requestId: "cleanup-conflict-test",
      now: NOW,
    })).rejects.toThrow("WORKSPACE_CLEANUP_CONFLICT");
    const retained = await store.pool.query("SELECT rolled_back_at FROM auth_import_mappings WHERE source_id = $1", [sourceId]);
    expect(retained.rows[0]?.rolled_back_at).toBeNull();
  });

  it("recovers an account atomically without deleting other users", async () => {
    const target = await store.createUser({ email: "pg-recovery-target@example.com", displayName: "Target", status: "active", now: NOW });
    const other = await store.createUser({ email: "pg-recovery-other@example.com", displayName: "Other", status: "active", now: NOW });
    const session = await store.createSession({ userId: target.id, tokenHash: "a".repeat(64), createdAt: NOW, expiresAt: "2026-08-25T00:00:00.000Z", ipHash: null, userAgentHash: null });
    const recovered = await store.recoverAdminAccount(target.id, "scrypt$16384$8$1$AQ$Ag", NOW);

    expect(recovered).toMatchObject({ user: { id: target.id, role: "admin", status: "active", defaultMode: "full" }, revokedSessionCount: 1 });
    expect((await store.findUserById(other.id))?.status).toBe("active");
    expect((await store.listSessions()).find((item) => item.id === session.id)?.revokedAt).toBe(NOW);
    expect((await store.getPassword(target.id))?.encoded).toBe("scrypt$16384$8$1$AQ$Ag");
  });

  it.each([
    { stage: "identity", table: "auth_identities" },
    { stage: "session-resource", table: "auth_resources" },
    { stage: "web-session", table: "auth_sessions" },
  ] as const)("rolls back the pairing transaction when $stage persistence fails", async ({ stage, table }) => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = await store.createUser({ email: `${stage}-${suffix}@example.com`, displayName: stage, status: "active", now: NOW });
    const openId = `ou_${suffix}`;
    const sessionId = `session-${suffix}`;
    const input = pairingInput(suffix, user.id);
    await store.issueFeishuPairingToken({ tokenHash: input.tokenHash, openId, sessionId, expiresAt: "2026-08-25T00:00:00.000Z", consumedAt: null });
    const baselineSessions = (await store.listSessions()).length;
    const removeFault = await installInsertFailure(store, table, suffix);

    try {
      await expect(store.commitFeishuPairing(input)).rejects.toThrow("forced pairing failure");
    } finally {
      await removeFault();
    }

    expect(await store.findFeishuPairingToken(input.tokenHash, NOW)).toBeTruthy();
    expect(await store.findIdentity("feishu", openId)).toBeUndefined();
    expect(await store.findResource("session", sessionId)).toBeUndefined();
    expect(await store.listSessions()).toHaveLength(baselineSessions);
    await expect(store.commitFeishuPairing(input)).resolves.toMatchObject({ status: "paired", user: { id: user.id } });
  });

  it("commits one pairing when the same token is confirmed concurrently", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = await store.createUser({ email: `pair-race-${suffix}@example.com`, displayName: "Pair race", status: "active", now: NOW });
    const input = pairingInput(suffix, user.id);
    await store.issueFeishuPairingToken({ tokenHash: input.tokenHash, openId: `ou_${suffix}`, sessionId: `session-${suffix}`, expiresAt: "2026-08-25T00:00:00.000Z", consumedAt: null });
    const baselineSessions = (await store.listSessions()).length;

    const results = await Promise.all([store.commitFeishuPairing(input), store.commitFeishuPairing(input)]);

    expect(results.map((result) => result.status).sort()).toEqual(["failed", "paired"]);
    expect(await store.listSessions()).toHaveLength(baselineSessions + 1);
    expect(await store.findFeishuPairingToken(input.tokenHash, NOW)).toBeUndefined();
  });

  it("keeps the token and rolls back new identity state on pairing conflicts", async () => {
    const ownerSuffix = randomUUID().replaceAll("-", "");
    const otherSuffix = randomUUID().replaceAll("-", "");
    const owner = await store.createUser({ email: `owner-${ownerSuffix}@example.com`, displayName: "Owner", status: "active", now: NOW });
    const other = await store.createUser({ email: `other-${otherSuffix}@example.com`, displayName: "Other", status: "active", now: NOW });
    const claimedOpenId = `ou_${ownerSuffix}`;
    await store.createIdentity({ provider: "feishu", subject: claimedOpenId, unionId: null, userId: owner.id, createdAt: NOW });
    const identityInput = pairingInput(ownerSuffix, other.id);
    await store.issueFeishuPairingToken({ tokenHash: identityInput.tokenHash, openId: claimedOpenId, sessionId: null, expiresAt: "2026-08-25T00:00:00.000Z", consumedAt: null });

    await expect(store.commitFeishuPairing(identityInput)).resolves.toEqual({ status: "identity-conflict" });
    expect(await store.findFeishuPairingToken(identityInput.tokenHash, NOW)).toBeTruthy();

    const sessionId = `session-${otherSuffix}`;
    await store.saveResource({ resourceType: "session", resourceId: sessionId, userId: owner.id, resourcePath: null, createdAt: NOW });
    const sessionInput = pairingInput(otherSuffix, other.id);
    const newOpenId = `ou_${otherSuffix}`;
    await store.issueFeishuPairingToken({ tokenHash: sessionInput.tokenHash, openId: newOpenId, sessionId, expiresAt: "2026-08-25T00:00:00.000Z", consumedAt: null });

    await expect(store.commitFeishuPairing(sessionInput)).resolves.toEqual({ status: "session-conflict" });
    expect(await store.findFeishuPairingToken(sessionInput.tokenHash, NOW)).toBeTruthy();
    expect(await store.findIdentity("feishu", newOpenId)).toBeUndefined();
  });
});

function scopedDatabaseUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

function pairingInput(suffix: string, userId: string): CommitFeishuPairingInput {
  return {
    tokenHash: suffix.repeat(2),
    currentUserId: userId,
    now: NOW,
    sessionTokenHash: suffix.split("").reverse().join("").repeat(2),
    sessionExpiresAt: "2026-08-25T00:00:00.000Z",
    ipHash: null,
    userAgentHash: null,
  };
}

async function installInsertFailure(store: PostgresAuthStore, table: string, suffix: string): Promise<() => Promise<void>> {
  const functionName = `fail_pairing_${suffix}`;
  const triggerName = `fail_pairing_insert_${suffix}`;
  await store.pool.query(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced pairing failure'; END $$`);
  await store.pool.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
  return async () => {
    await store.pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON ${table}`);
    await store.pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  };
}
