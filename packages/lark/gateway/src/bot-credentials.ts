import { CredentialProvider, type CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";

/** 单机器人只读凭证Provider；不向实例开放部署全局凭证或其他账号的值。 */
export class BotCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: ReadonlyMap<string, string>) { super(ctx); }
  async resolve(ref: CredentialRef) { const value = this.values.get(ref); return value ? { value, source: "account-bot" } : undefined; }
  async describe(ref: CredentialRef) { return { configured: this.values.has(ref), writable: false, source: "account-bot" }; }
  async set(): Promise<never> { throw new Error("BOT_CREDENTIALS_READ_ONLY"); }
  async unset(): Promise<never> { throw new Error("BOT_CREDENTIALS_READ_ONLY"); }
  async readRecord() { return undefined; }
  async describeRecord() { return { configured: false, writable: false }; }
  async listRecords() { return []; }
  async modifyRecord(): Promise<never> { throw new Error("BOT_CREDENTIALS_READ_ONLY"); }
  async deleteRecord(): Promise<never> { throw new Error("BOT_CREDENTIALS_READ_ONLY"); }
}
