import { describe, it, expect, vi } from "vitest";
import { MemoryAuthStore } from "./memory-store.js";
import { UserModelCrypto } from "./user-model-crypto.js";
import { FeishuBotService } from "./feishu-bots.js";
import { deterministicSessionIdForScope, parseScope } from "dsh-lark-contracts";

const draft = { expectedRevision: 0, appId: "cli_1234567890abcdef", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test_user"], appSecret: "not-a-real-secret" };
async function fixture() {
  const store = new MemoryAuthStore();
  const user = await store.createUser({ email: "a@test.invalid", displayName: "test", status: "active", now: new Date().toISOString() });
  const other = await store.createUser({ email: "b@test.invalid", displayName: "test", status: "active", now: new Date().toISOString() });
  const crypto = new UserModelCrypto(Buffer.alloc(32, 8).toString("base64"));
  return { store, user, other, crypto, service: new FeishuBotService(store, crypto) };
}
describe("账号机器人凭证与资源隔离", () => {
  it("公共投影和落盘不含明文；不同owner不读到配置，仍拒绝重复App", async () => {
    const { service, user, other, store, crypto } = await fixture();
    const result = await service.save(user.id, draft);
    expect(JSON.stringify(result)).not.toContain(draft.appSecret);
    expect(JSON.stringify(await store.feishuBots.get(user.id))).not.toContain(draft.appSecret);
    expect(await service.read(other.id)).toBeNull();
    await expect(service.save(other.id, draft)).rejects.toMatchObject({ status: 409 });
    await expect(service.save(other.id, { ...draft, appId: "cli_abcdef1234567890" })).resolves.toMatchObject({ enabled: false });
    const saved = (await store.feishuBots.get(user.id))!;
    expect(() => crypto.decrypt(saved.secret, { userId: other.id, profileId: `feishu:${saved.id}`, revision: 1 })).toThrow();
  });
  it("拒绝前端owner及私网域；并发保存不覆盖；保留密钥重封装", async () => {
    const { service, user, store } = await fixture();
    await expect(service.save(user.id, { ...draft, userId: "other" })).rejects.toMatchObject({ status: 400 });
    await expect(service.save(user.id, { ...draft, domain: "http://127.0.0.1" })).rejects.toMatchObject({ status: 400 });
    await service.save(user.id, draft);
    const old = (await store.feishuBots.get(user.id))!;
    await expect(service.save(user.id, draft)).rejects.toMatchObject({ status: 409 });
    await service.save(user.id, { ...draft, expectedRevision: 1, appSecret: "" });
    expect((await store.feishuBots.get(user.id))!.secret).not.toEqual(old.secret);
  });
  it("校验只去官方地址且不跟随重定向，脱敏上游错误", async () => {
    const { service, user } = await fixture(); await service.save(user.id, draft);
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: "fake-token" })).mockResolvedValueOnce(Response.json({ code: 0, bot: { app_name: "测试机器人" } }));
    expect(await service.test(user.id, 1, request)).toEqual({ botName: "测试机器人" });
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
    request.mockRejectedValue(new Error(draft.appSecret));
    await expect(service.test(user.id, 1, request)).rejects.toMatchObject({ code: "BOT_CHECK_FAILED", message: "BOT_CHECK_FAILED" });
  });
  it("只有启用实例匹配的Scope能注册owner资源，禁用或封号拒绝", async () => {
    const { service, store, user, other } = await fixture(); await service.save(user.id, draft);
    const row = (await store.feishuBots.get(user.id))!;
    // 只用于测试运行态；生产启用必须通过官方凭证检查。
    store.feishuBots.records.set(user.id, { ...row, enabled: true });
    const scope = { tenantId: user.id, botId: row.appId, deploymentId: row.id, userId: "ou_test_user", conversationId: "oc_test_chat" };
    await service.claim(user.id, 1, scope, 0);
    const parsed = parseScope(scope); if (!parsed.ok) throw Error("scope");
    expect(await store.findResource("session", deterministicSessionIdForScope(parsed.value, 0))).toMatchObject({ userId: user.id });
    await expect(service.claim(user.id, 1, { ...scope, tenantId: other.id }, 0)).rejects.toMatchObject({ status: 403 });
    await expect(service.claim(user.id, 1, { ...scope, userId: "ou_unknown" }, 0)).rejects.toMatchObject({ status: 403 });
    expect(await service.runtime()).toHaveLength(1);
    store.users.set(user.id, { ...user, status: "disabled" });
    expect(await service.runtime()).toEqual([]);
    await expect(service.claim(user.id, 1, scope, 0)).rejects.toMatchObject({ status: 403 });
  });
});
