import { randomUUID } from "node:crypto";
import { parseScope, deterministicSessionIdForScope } from "dsh-lark-contracts";
import type { AuthStore } from "./types.js";
import type { BotRecord } from "./feishu-bot-store.js";
import type { UserModelCrypto } from "./user-model-crypto.js";

export class FeishuBotError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type BotState = "connected" | "reconnecting" | "failed" | "unknown" | "disabled";
export interface BotPublic {
  id: string; appId: string; domain: BotRecord["domain"]; authorizedOpenIds: string[];
  secretConfigured: true; enabled: boolean; revision: number; updatedAt: string; state: BotState;
}
export interface BotRuntime extends Omit<BotRecord, "secret"> { appSecret: string }
export interface BotDraft { expectedRevision: number; appId: string; domain: BotRecord["domain"]; authorizedOpenIds: string[]; appSecret?: string }

/** Auth拥有凭证解密；公共响应只做显式投影，绝不spread内部record。 */
export class FeishuBotService {
  readonly #states = new Map<string, { revision: number; state: BotState; at: number }>();
  constructor(private readonly store: AuthStore, private readonly crypto: UserModelCrypto | undefined) {}
  private cipher(): UserModelCrypto { if (!this.crypto) throw new FeishuBotError(503, "BOT_STORAGE_UNAVAILABLE"); return this.crypto; }
  private binding(row: BotRecord) { return { userId: row.userId, profileId: `feishu:${row.id}`, revision: row.revision }; }
  private public(row: BotRecord): BotPublic {
    const status = this.#states.get(row.userId);
    const state = !row.enabled ? "disabled" : status?.revision === row.revision && Date.now() - status.at < 30_000 ? status.state : "unknown";
    return { id: row.id, appId: row.appId, domain: row.domain, authorizedOpenIds: [...row.authorizedOpenIds], secretConfigured: true, enabled: row.enabled, revision: row.revision, updatedAt: row.updatedAt, state };
  }
  async read(userId: string): Promise<BotPublic | null> { const row = await this.store.feishuBots.get(userId); return row ? this.public(row) : null; }
  async save(userId: string, input: unknown): Promise<BotPublic> {
    const draft = parseBotDraft(input);
    const old = await this.store.feishuBots.get(userId);
    if ((old?.revision ?? 0) !== draft.expectedRevision) throw new FeishuBotError(409, "BOT_CONFIG_CONFLICT");
    if (old?.enabled) throw new FeishuBotError(409, "BOT_DISCONNECT_FIRST");
    const secret = draft.appSecret || (old && old.appId === draft.appId && old.domain === draft.domain ? this.cipher().decrypt(old.secret, this.binding(old)) : "");
    if (!secret) throw new FeishuBotError(400, "BOT_SECRET_REQUIRED");
    const id = old?.id ?? randomUUID(); const revision = draft.expectedRevision + 1;
    const row: BotRecord = { userId, id, appId: draft.appId, domain: draft.domain, authorizedOpenIds: draft.authorizedOpenIds, enabled: false, revision, updatedAt: new Date().toISOString(), secret: this.cipher().encrypt(secret, { userId, profileId: `feishu:${id}`, revision }) };
    if (!await this.store.feishuBots.save(row, draft.expectedRevision)) throw new FeishuBotError(409, "BOT_CONFIG_CONFLICT");
    await this.audit(userId, "feishu-bot-saved");
    return this.public(row);
  }
  private async require(userId: string, revision: number): Promise<BotRecord> {
    const row = await this.store.feishuBots.get(userId);
    if (!row) throw new FeishuBotError(404, "BOT_NOT_CONFIGURED");
    if (row.revision !== revision) throw new FeishuBotError(409, "BOT_CONFIG_CONFLICT");
    return row;
  }
  async test(userId: string, revision: number, request: typeof fetch = fetch): Promise<{ botName: string }> {
    const row = await this.require(userId, revision);
    const secret = this.cipher().decrypt(row.secret, this.binding(row));
    try {
      const token = await request(`${row.domain}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: row.appId, app_secret: secret }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      const data = await token.json() as { code?: number; tenant_access_token?: string };
      if (!token.ok || data.code !== 0 || typeof data.tenant_access_token !== "string" || !data.tenant_access_token) throw new Error("invalid");
      const bot = await request(`${row.domain}/open-apis/bot/v3/info`, { headers: { authorization: `Bearer ${data.tenant_access_token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      const info = await bot.json() as { code?: number; bot?: { app_name?: string } };
      if (!bot.ok || info.code !== 0 || !info.bot) throw new Error("invalid");
      await this.require(userId, revision);
      return { botName: typeof info.bot.app_name === "string" ? info.bot.app_name.slice(0, 120) : "飞书机器人" };
    } catch (cause) {
      if (cause instanceof FeishuBotError) throw cause;
      throw new FeishuBotError(400, "BOT_CHECK_FAILED");
    }
  }
  async setEnabled(userId: string, revision: number, enabled: boolean): Promise<BotPublic> {
    const old = await this.require(userId, revision);
    if (enabled) await this.test(userId, revision);
    const row = { ...old, enabled, revision: revision + 1, updatedAt: new Date().toISOString() };
    row.secret = this.cipher().encrypt(this.cipher().decrypt(old.secret, this.binding(old)), this.binding(row));
    if (!await this.store.feishuBots.save(row, revision)) throw new FeishuBotError(409, "BOT_CONFIG_CONFLICT");
    await this.audit(userId, enabled ? "feishu-bot-enable" : "feishu-bot-disable");
    return this.public(row);
  }
  async runtime(): Promise<BotRuntime[]> {
    const rows = await this.store.feishuBots.list();
    const result: BotRuntime[] = [];
    for (const row of rows) {
      if (!row.enabled || (await this.store.findUserById(row.userId))?.status !== "active") continue;
      const { secret, ...rest } = row;
      result.push({ ...rest, appSecret: this.cipher().decrypt(secret, this.binding(row)) });
    }
    return result;
  }
  async report(userId: string, revision: number, state: BotState): Promise<void> {
    const row = await this.store.feishuBots.get(userId);
    if (row?.revision === revision) this.#states.set(userId, { revision, state, at: Date.now() });
  }
  private async audit(userId: string, action: string): Promise<void> {
    await this.store.audit({ action, userId, requestId: randomUUID(), ipHash: null, userAgentHash: null, createdAt: new Date().toISOString() });
  }
  /** 运行前由内部可信网关注册资源；Scope必须对应当前启用实例及其授权用户。 */
  async claim(userId: string, revision: number, input: unknown, generation: number): Promise<void> {
    const row = await this.require(userId, revision);
    const parsed = parseScope(input);
    if (!row.enabled || (await this.store.findUserById(userId))?.status !== "active" || !parsed.ok || parsed.value.tenantId !== userId || parsed.value.botId !== row.appId || parsed.value.deploymentId !== row.id || !row.authorizedOpenIds.includes(parsed.value.userId) || !Number.isSafeInteger(generation) || generation < 0) throw new FeishuBotError(403, "BOT_SCOPE_DENIED");
    const sessionId = deterministicSessionIdForScope(parsed.value, generation);
    if (!await this.store.saveResource({ resourceType: "session", resourceId: sessionId, userId, resourcePath: null, createdAt: new Date().toISOString() })) throw new FeishuBotError(409, "BOT_SESSION_CONFLICT");
  }
}

export function parseBotDraft(input: unknown): BotDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FeishuBotError(400, "INVALID_BOT_CONFIG");
  const b = input as Record<string, unknown>;
  if (Object.keys(b).some(k => !["expectedRevision", "appId", "domain", "authorizedOpenIds", "appSecret"].includes(k)) || !Number.isSafeInteger(b.expectedRevision) || (b.expectedRevision as number) < 0 || typeof b.appId !== "string" || !/^cli_[0-9a-f]{16}$/i.test(b.appId) || !["https://open.feishu.cn", "https://open.larksuite.com"].includes(b.domain as string) || !Array.isArray(b.authorizedOpenIds) || b.authorizedOpenIds.length < 1 || b.authorizedOpenIds.length > 100 || b.authorizedOpenIds.some(id => typeof id !== "string" || !/^ou_[a-zA-Z0-9_]{3,128}$/.test(id)) || (b.appSecret !== undefined && (typeof b.appSecret !== "string" || b.appSecret.length > 256 || /\s/.test(b.appSecret)))) throw new FeishuBotError(400, "INVALID_BOT_CONFIG");
  return { expectedRevision: b.expectedRevision as number, appId: b.appId.toLowerCase(), domain: b.domain as BotDraft["domain"], authorizedOpenIds: [...new Set(b.authorizedOpenIds as string[])], ...(b.appSecret ? { appSecret: b.appSecret as string } : {}) };
}
