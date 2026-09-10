/** Wire边界与生命周期管理：每个App一个全新的Cordis根，绝不共用事件总线。 */
import { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { createLarkApi } from "dsh-lark";
import * as card from "dsh-lark-card";
import * as commands from "dsh-lark-commands";
import * as ws from "dsh-lark-ws";
import type { LarkRunClient } from "dsh-lark-run-client";
import { BotCredentials } from "./bot-credentials.js";
import * as gateway from "./index.js";

export interface FleetBot {
  userId: string; id: string; appId: string; appSecret: string;
  domain: string; authorizedOpenIds: string[]; revision: number;
}
export function parseFleetBots(value: unknown): FleetBot[] {
  const rows = (value as { bots?: unknown } | null)?.bots;
  if (!Array.isArray(rows)) throw Error("BOT_MANIFEST_INVALID");
  const users = new Set<string>(); const apps = new Set<string>();
  return rows.map((input: unknown) => {
    const b = input as FleetBot;
    if (!b || ![b.userId, b.id].every(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) || typeof b.appId !== "string" || !/^cli_[0-9a-f]{16}$/i.test(b.appId) || typeof b.appSecret !== "string" || !b.appSecret || b.appSecret.length > 256 || !["https://open.feishu.cn", "https://open.larksuite.com"].includes(b.domain) || !Array.isArray(b.authorizedOpenIds) || !b.authorizedOpenIds.length || b.authorizedOpenIds.some(id => typeof id !== "string" || !/^ou_[a-zA-Z0-9_]{3,128}$/.test(id)) || !Number.isSafeInteger(b.revision) || b.revision < 1 || users.has(b.userId) || apps.has(b.appId)) throw Error("BOT_MANIFEST_INVALID");
    users.add(b.userId); apps.add(b.appId); return b;
  });
}
export interface BotInstance { readonly ready?: Promise<void>; stop(): Promise<void>; state(): "connected" | "reconnecting" | "failed" }
export interface BotHostOptions {
  stateDir: string; uploadsRoot: string; maxResourceBytes: number;
  claim(bot: FleetBot, scope: unknown, generation: number): Promise<void>;
}

export function startBot(parent: Context, bot: FleetBot, options: BotHostOptions): BotInstance {
  const root = new Context();
  let active = true;
  let state: ReturnType<BotInstance["state"]> = "reconnecting";
  const abort = new AbortController();
  const stop = async () => { active = false; abort.abort(); await root.fiber.dispose(); };
  const start = async () => {
    await root.plugin({ name: "account-bot-services", apply(ctx: Context) {
      const values = new Map([["BOT_APP_ID", bot.appId], ["BOT_APP_SECRET", bot.appSecret]]);
      new BotCredentials(ctx, values);
      ctx.effect(() => () => { values.clear(); });
      const lark = createLarkApi({ appId: bot.appId, appSecret: bot.appSecret, domain: bot.domain, maxResourceBytes: options.maxResourceBytes });
      const check = () => { if (!active) throw Error("BOT_STOPPED"); };
      ctx.provide("lark", {
        getToken: () => { check(); return lark.getToken(); },
        sendMessage: (...args) => { check(); return lark.sendMessage(...args); },
        sendMessageToUser: (...args) => { check(); return lark.sendMessageToUser(...args); },
        updateMessage: (...args) => { check(); return lark.updateMessage(...args); },
        uploadImage: (...args) => { check(); return lark.uploadImage(...args); },
        downloadResource: (...args) => { check(); return lark.downloadResource(...args); },
        getChatMembers: (...args) => { check(); return lark.getChatMembers(...args); },
      });
      const client = parent.larkRunClient!;
      const scoped: LarkRunClient = {
        submit: async (request, signal) => {
          check(); await options.claim(bot, request.scope, request.sessionGeneration ?? 0); check();
          return client.submit(request, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]));
        },
        cancel: (...a) => client.cancel(...a),
        resolveInteraction: (...a) => { check(); return client.resolveInteraction(...a); },
        sessionOverview: (...a) => { check(); return client.sessionOverview(...a); },
        sessionCurrent: (...a) => { check(); return client.sessionCurrent(...a); },
        sessionList: (...a) => { check(); return client.sessionList(...a); },
        sessionClaim: (...a) => { check(); return client.sessionClaim(...a); },
        sessionUse: (...a) => { check(); return client.sessionUse(...a); },
        sessionNew: (...a) => { check(); return client.sessionNew(...a); },
        sessionUnlink: (...a) => { check(); return client.sessionUnlink(...a); },
        readArtifact: (...a) => { check(); return client.readArtifact(...a); },
        cronControl: (...a) => { check(); return client.cronControl(...a); },
        claimCronDeliveries: (...a) => { check(); return client.claimCronDeliveries(...a); },
        ackCronDelivery: (...a) => { check(); return client.ackCronDelivery(...a); },
      };
      ctx.provide("larkRunClient", scoped);
      ctx.provide("cdgBridge", parent.cdgBridge);
      ctx.on("lark/connection", payload => { if (active) state = payload.state; });
    } });
    if (!active) return;
    await root.plugin(card, {});
    if (!active) return;
    // 个人机器人不复用跨应用 Open ID 的部署级配对；会话由可信内部 claim 归属 owner。
    await root.plugin(commands, {
      pairingUnavailableMessage: "该个人机器人已归属当前 MewClaw 账号，无需再次绑定。机器人会话会自动归入当前账号。",
    });
    if (!active) return;
    await root.plugin(gateway, {
      tenantId: bot.userId, botId: bot.appId, deploymentId: bot.id,
      authorizedOpenIds: bot.authorizedOpenIds, allowedChatIds: [],
      processingCardText: "正在思考…", failureCardTemplate: "运行失败（{{code}}）：{{hint}}",
      stateDir: join(options.stateDir, bot.id), uploadsRoot: join(options.uploadsRoot, bot.id),
    });
    if (!active) return;
    await root.plugin(ws, { appIdEnv: "BOT_APP_ID", appSecretEnv: "BOT_APP_SECRET", baseURL: bot.domain });
  };
  const ready = start();
  void ready.catch(async () => { state = "failed"; await stop().catch(() => undefined); });
  return { ready, stop, state: () => state };
}
