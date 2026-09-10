/**
 * dsh-lark-ws 插件入口（SPEC lark-ws.md）。
 *
 * 与飞书建立唯一一条 WebSocket 长连接，把平台事件转成类型化进程事件：
 * lark/message/received、lark/message/recalled、lark/card/action、
 * lark/bot/menu、lark/connection。本包不做授权/去重（gateway 职责）。
 *
 * 重连退避由官方 SDK 的 WSClient 承担（lark-claw 同源语义）；
 * 持续重连超过 failureWindowMs 即发布 failed（supervisor 存活判据）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

import { createLarkWs } from "./client.js";
import { resolveLarkWsConfig } from "./config.js";
import "./events.js";

export const name = "lark-ws";

export const inject = ["credentials"];

export interface Config {
  /** 应用 ID 凭证引用（与 dsh-lark 同 ref）；缺失 fail loud at load。 */
  appIdEnv: string;
  /** 应用密钥凭证引用。 */
  appSecretEnv: string;
  /** 飞书域名（feishu.cn / larksuite.com）。 */
  baseURL?: string;
  /** 持续重连超过该窗口（毫秒，默认 5 分钟）发布 failed。 */
  failureWindowMs?: number;
  /** 健康状态发布间隔（毫秒，默认 30s；发布的是最近已知状态）。 */
  healthPublishIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  appIdEnv: z.string().required(),
  appSecretEnv: z.string().required(),
  baseURL: z.string(),
  failureWindowMs: z.number(),
  healthPublishIntervalMs: z.number(),
});

type ConnectionState = "connected" | "reconnecting" | "failed";

export async function apply(ctx: Context, config: Config): Promise<void> {
  const { failureWindowMs, healthPublishIntervalMs: healthPublishMs } = resolveLarkWsConfig(config);

  let state: ConnectionState = "reconnecting";
  let failureTimer: NodeJS.Timeout | undefined;
  let parseFailures = 0;
  let ws: ReturnType<typeof createLarkWs> | undefined;
  // 活跃守卫：dispose 发生在凭证解析/连接建立期间时，迟到连接立即停掉。
  let active = true;

  /** 发布连接状态并维护 failed 判定窗口。 */
  const setState = (next: ConnectionState): void => {
    if (!active) return;
    state = next;
    ctx.emit("lark/connection", { state: next });
    if (failureTimer) clearTimeout(failureTimer);
    if (next === "reconnecting") {
      // 窗口内没有恢复即判 failed；connected 会清除本定时器。
      failureTimer = setTimeout(() => setState("failed"), failureWindowMs);
    }
  };

  const start = async (): Promise<void> => {
    const resolve = async (reference: string): Promise<string> => {
      const resolved = await ctx.credentials!.resolve(reference as CredentialRef);
      if (!resolved) {
        throw new Error(`lark-ws: 凭证引用未配置（${reference}）——请检查 .env 与凭证提供方`);
      }
      return resolved.value;
    };
    const [appId, appSecret] = await Promise.all([
      resolve(config.appIdEnv),
      resolve(config.appSecretEnv),
    ]);

    ws = createLarkWs({
      appId,
      appSecret,
      ...(config.baseURL ? { domain: config.baseURL } : {}),
      handlers: {
        onMessage: (message) => ctx.emit("lark/message/received", message),
        onRecalled: (messageId) => ctx.emit("lark/message/recalled", { messageId }),
        onCardAction: (payload) => ctx.emit("lark/card/action", payload),
        onBotMenu: (menu) => ctx.emit("lark/bot/menu", menu),
        onParseFailure: () => {
          parseFailures += 1;
          ctx.logger.warn(`lark-ws: 丢弃畸形帧（累计 ${parseFailures}）`);
        },
      },
      lifecycle: {
        onReady: () => setState("connected"),
        onReconnected: () => setState("connected"),
        onReconnecting: () => setState("reconnecting"),
        onError: () => setState("reconnecting"),
      },
    });
    await ws.start();
    if (!active) ws.stop();
  };

  // 健康心跳：周期性发布最近已知状态（supervisor 判据）。
  const healthTimer = setInterval(() => {
    ctx.emit("lark/connection", { state });
  }, healthPublishMs);

  // 关停：停健康心跳、失败窗口定时器与连接（迟到连接由 active 守卫兜住）。
  ctx.effect(() => () => {
    active = false;
    clearInterval(healthTimer);
    if (failureTimer) clearTimeout(failureTimer);
    ws?.stop();
  });

  // 装载期必须等待连接与凭证解析，让 Cordis 管理失败和清理顺序。
  try {
    await start();
  } catch (error) {
    clearInterval(healthTimer);
    if (failureTimer) clearTimeout(failureTimer);
    ws?.stop();
    throw error;
  }
}

// 包的公开类型面（gateway 等从这里导入）。
export * from "./client.js";
export type { InboundMessage } from "./events.js";
export type { LarkBotMenuEvent } from "./bot-menu.js";
