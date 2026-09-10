/** 飞书应用的独立持久化面；JSON记录中仅保存AEAD密文，不保存App Secret。 */
import type { Pool } from "pg";
import type { UserModelEncryptedSecret } from "./user-model-crypto.js";

export interface BotRecord {
  userId: string;
  id: string;
  appId: string;
  domain: "https://open.feishu.cn" | "https://open.larksuite.com";
  authorizedOpenIds: string[];
  secret: UserModelEncryptedSecret;
  enabled: boolean;
  revision: number;
  updatedAt: string;
}
export interface FeishuBotStore {
  get(userId: string): Promise<BotRecord | undefined>;
  list(): Promise<BotRecord[]>;
  save(record: BotRecord, expectedRevision: number): Promise<boolean>;
}
export class MemoryFeishuBotStore implements FeishuBotStore {
  readonly records = new Map<string, BotRecord>();
  async get(userId: string): Promise<BotRecord | undefined> { const row = this.records.get(userId); return row && structuredClone(row); }
  async list(): Promise<BotRecord[]> { return structuredClone([...this.records.values()]); }
  async save(record: BotRecord, expectedRevision: number): Promise<boolean> {
    if ((this.records.get(record.userId)?.revision ?? 0) !== expectedRevision) return false;
    if ([...this.records.values()].some(row => row.userId !== record.userId && row.appId === record.appId)) return false;
    this.records.set(record.userId, structuredClone(record)); return true;
  }
}
export class PostgresFeishuBotStore implements FeishuBotStore {
  constructor(private readonly pool: Pool) {}
  async get(userId: string): Promise<BotRecord | undefined> {
    const result = await this.pool.query<{ record: BotRecord }>("SELECT record FROM auth_feishu_bots WHERE user_id=$1", [userId]);
    return result.rows[0]?.record;
  }
  async list(): Promise<BotRecord[]> {
    const result = await this.pool.query<{ record: BotRecord }>("SELECT record FROM auth_feishu_bots b JOIN auth_users u ON b.user_id=u.id WHERE u.status='active'");
    return result.rows.map(row => row.record);
  }
  async save(record: BotRecord, expectedRevision: number): Promise<boolean> {
    try {
      const result = expectedRevision === 0
        ? await this.pool.query("INSERT INTO auth_feishu_bots(user_id,app_id,revision,record) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [record.userId, record.appId, record.revision, record])
        : await this.pool.query("UPDATE auth_feishu_bots SET app_id=$2,revision=$3,record=$4 WHERE user_id=$1 AND revision=$5", [record.userId, record.appId, record.revision, record, expectedRevision]);
      return result.rowCount === 1;
    } catch (cause) {
      if ((cause as { code?: string }).code === "23505") return false;
      throw cause;
    }
  }
}
