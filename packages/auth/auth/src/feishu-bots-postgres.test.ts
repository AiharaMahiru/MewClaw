import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { PostgresAuthStore } from "./postgres-store.js";
import { UserModelCrypto } from "./user-model-crypto.js";
import { FeishuBotService } from "./feishu-bots.js";

const url = process.env.DSH_BOT_POSTGRES_TEST_URL;
describe.skipIf(!url)("账号机器人真实PostgreSQL", () => {
  it("新增迁移幂等、密文跨连接持久化、并发和App唯一约束", async () => {
    if (!url || !new URL(url).pathname.includes("test")) throw Error("test database required");
    const schema = `bot_test_${randomUUID().replaceAll("-", "")}`;
    const control = new Pool({ connectionString: url });
    await control.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(url); scoped.searchParams.set("options", `-c search_path=${schema},public`);
    const store = new PostgresAuthStore(scoped.toString());
    const crypto = new UserModelCrypto(Buffer.alloc(32, 9).toString("base64"));
    try {
      await store.migrate(); await store.migrate();
      const now = new Date().toISOString();
      const a = await store.createUser({ email: "pg-a@test.invalid", displayName: "A", status: "active", now });
      const b = await store.createUser({ email: "pg-b@test.invalid", displayName: "B", status: "active", now });
      const service = new FeishuBotService(store, crypto);
      const draft = { expectedRevision: 0, appId: "cli_1234567890abcdef", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test"], appSecret: "fake-pg-secret" };
      const results = await Promise.allSettled([service.save(a.id, draft), service.save(b.id, draft)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rows = await store.feishuBots.list(); expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(draft.appSecret);
      const owner = rows[0]!.userId;
      const conflict = await Promise.allSettled([service.save(owner, { ...draft, expectedRevision: 1 }), service.save(owner, { ...draft, expectedRevision: 1 })]);
      expect(conflict.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const reopened = new PostgresAuthStore(scoped.toString());
      try { expect((await reopened.feishuBots.get(owner))?.revision).toBe(2); } finally { await reopened.close(); }
      const tables = await store.pool.query("SELECT to_regclass('auth_users') AS users,to_regclass('auth_resources') AS resources");
      expect(tables.rows[0]).toMatchObject({ users: "auth_users", resources: "auth_resources" });
    } finally {
      await store.close(); crypto.close();
      await control.query(`DROP SCHEMA "${schema}" CASCADE`); await control.end();
    }
  });
});
