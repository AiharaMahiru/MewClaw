import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { parseFleetBots, startBot, type BotInstance, type FleetBot } from "./bot-runtime.js";

export const name = "lark-account-bot-fleet";
export const inject = ["credentials", "larkRunClient", "cdgBridge"];
export interface Config { authEndpoint: string; tokenEnv: string; stateDir: string; uploadsRoot: string; pollIntervalMs?: number; maxResourceBytes?: number; retryDelayMs?: number }
export const Config: z<Config> = z.object({ authEndpoint: z.string().required(), tokenEnv: z.string().required(), stateDir: z.string().required(), uploadsRoot: z.string().required(), pollIntervalMs: z.number(), maxResourceBytes: z.number(), retryDelayMs: z.number() });

/** 单写reconcile，版本变更先停后启；失去控制面时fail closed，不保留旧授权。 */
export class BotFleet {
  readonly instances = new Map<string, { bot: FleetBot; instance: BotInstance; startedAt: number }>();
  constructor(private readonly start: (bot: FleetBot) => BotInstance, private readonly retryDelayMs = 30_000, private readonly now = Date.now) {}
  async reconcile(bots: FleetBot[]): Promise<void> {
    for (const [owner, entry] of this.instances) {
      const next = bots.find(bot => bot.userId === owner);
      const retry = entry.instance.state() === "failed" && this.now() - entry.startedAt >= this.retryDelayMs;
      if (!next || next.revision !== entry.bot.revision || retry) { await entry.instance.stop(); this.instances.delete(owner); }
    }
    for (const bot of bots) if (!this.instances.has(bot.userId)) this.instances.set(bot.userId, { bot, instance: this.start(bot), startedAt: this.now() });
  }
  async close(): Promise<void> { await this.reconcile([]); }
}

export function apply(ctx: Context, config: Config): void {
  const url = new URL(config.authEndpoint);
  const interval = config.pollIntervalMs ?? 5000;
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/internal/feishu-bots" || !Number.isSafeInteger(interval) || interval < 1000 || interval > 60_000 || !config.stateDir.trim() || !config.uploadsRoot.trim()) throw Error("BOT_FLEET_CONFIG_INVALID");
  const reference = credentialRef(config.tokenEnv);
  const statusLogger = ctx.logger(name);
  // 网关不挂载dsh-base，默认只有内存日志；仅导出本插件固定状态文案供服务就绪核验。
  ctx.logger.exporter({ colors: false, export(message) {
    if (message.name === name && message.args.length === 1 && typeof message.args[0] === "string") console.info(`[${name}] ${message.args[0]}`);
  } });
  const retryDelayMs = config.retryDelayMs ?? 30_000;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1000 || retryDelayMs > 300_000) throw Error("BOT_RETRY_DELAY_INVALID");
  const maxResourceBytes = config.maxResourceBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > 100 * 1024 * 1024) throw Error("BOT_RESOURCE_LIMIT_INVALID");
  let active = true; let running: Promise<void> | undefined;
  let syncedCount: number | undefined;
  const controller = new AbortController();
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const resolved = await ctx.credentials.resolve(reference);
    if (!resolved?.value || !active) throw Error("BOT_CONTROL_UNAVAILABLE");
    const response = await fetch(`${url.origin}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${resolved.value}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Error("BOT_CONTROL_UNAVAILABLE"); }
    return response.json();
  };
  const fleet = new BotFleet(bot => startBot(ctx, bot, { stateDir: config.stateDir, uploadsRoot: config.uploadsRoot, maxResourceBytes, claim: async (b, scope, generation) => { await request(`${url.pathname}/claim`, { userId: b.userId, revision: b.revision, scope, generation }); } }), retryDelayMs);
  const tick = async () => {
    try {
      const bots = parseFleetBots(await request(url.pathname));
      if (!active) return;
      await fleet.reconcile(bots);
      for (const { bot, instance } of fleet.instances.values()) {
        await request(url.pathname, { userId: bot.userId, revision: bot.revision, state: instance.state() });
      }
      // 仅在首次同步/数量变化/恢复时记录数量，不输出账号或凭据；空清单也是健康状态。
      if (syncedCount !== fleet.instances.size) statusLogger.info(`账号机器人配置已同步：${fleet.instances.size} 个启用实例`);
      syncedCount = fleet.instances.size;
    } catch {
      syncedCount = undefined;
      await fleet.close();
      if (active) statusLogger.warn("账号机器人控制面暂不可用，已停止个人连接；下次轮询重试");
    }
  };
  const schedule = () => { if (active && !running) running = tick().finally(() => { running = undefined; }); };
  ctx.effect(() => {
    const timer = setInterval(schedule, interval);
    schedule();
    return async () => { active = false; controller.abort(); clearInterval(timer); await running; await fleet.close(); };
  });
}
