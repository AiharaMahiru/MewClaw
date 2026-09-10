/** worker 进程内唯一运行入口：队列协调、agent 执行与窄 HTTP 面。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-session-projection-cache";
import type {} from "@deepseek-ai/dsh-workspace";
import type { RunRequest } from "dsh-lark-contracts";
import type {} from "dsh-lark-presets";
import type {} from "dsh-lark-billing";

// lark/* 会话事件必须在任何持久化恢复前注册，避免历史 session 被误判为不兼容。
import "dsh-lark-contracts";

import "./events.js";
import { resolveRunConfig, type Config as RunConfig } from "./config.js";
import { resolveRunPreset } from "./preset-config.js";
import { RunCoordinator } from "./run-coordinator.js";
import { startRunServer } from "./server-bootstrap.js";
import { indexFeishuSessions, shortFeishuSessionKey } from "./feishu-session-index.js";
import { installWebBilling } from "./web-billing.js";

export const name = "lark-run";

export const inject = [
  "agents",
  "agentPresets",
  "sessionPersistence",
  "larkSessionDirectory",
  "workspaceRegistry",
  "sessionProjectionCache",
  "credentials",
  "agentDefaultModel",
  "skillTrust",
  "larkUploads",
  "cron",
  "larkPresets",
  "tools",
  "memory",
  "billing",
  // 以下两键在 agent 子上下文上访问（preset 人设段、未授权技能 shadow），
  // 由 dsh-base 根级提供——声明依赖以保证装载顺序。
  "systemPrompt",
  "skills",
];

export { Config } from "./config.js";
export type { ConcurrencyConfig, ProfileTimeouts } from "./config.js";

export async function apply(ctx: Context, input: RunConfig): Promise<void> {
  const config = resolveRunConfig(input);
  const preset = resolveRunPreset(ctx, config.presetId);
  await indexFeishuSessions({
    persistence: ctx.sessionPersistence!,
    registry: ctx.workspaceRegistry,
    projectionCache: ctx.sessionProjectionCache,
    workspaceRoot: config.workspaceRoot,
    onCacheError: (sessionId, error) => {
      ctx.logger.warn(
        `lark-run: Feishu 会话 ${shortFeishuSessionKey(String(sessionId))} 投影预热失败（${String(error)}）`,
      );
    },
  });
  const coordinator = new RunCoordinator({ ctx, config, preset });
  ctx.provide("larkScopeIndex", {
    get: (sessionId: string) => coordinator.scopeForSession(sessionId),
    bindWeb: (input: unknown) => coordinator.bindWebScope(input),
    webModelRouteFor: (sessionId: string, rpcId: string) => coordinator.webModelRouteFor(sessionId, rpcId),
    webModelRouteForCurrentSelection: (sessionId: string) => coordinator.webModelRouteForCurrentSelection(sessionId),
    webModelSelectionFor: (sessionId: string) => coordinator.webModelSelectionFor(sessionId),
  });
  if (ctx.billing) {
    ctx.effect(() => installWebBilling(
      ctx,
      ctx.billing!,
      (sessionId) => coordinator.webBillingScopeForSession(sessionId),
    ));
  }
  ctx.on("lark/run/submit", (request: RunRequest) => coordinator.submitDetached(request));

  // 活跃守卫：dispose 早于 listen 完成时，刚启动的 server 立即关闭（不留孤儿）。
  let active = true;
  let closeServer: (() => Promise<void>) | undefined;
  ctx.effect(() => async () => {
    active = false;
    await closeServer?.();
  });
  const server = await startRunServer(ctx, config, coordinator);
  if (active) closeServer = server.close;
  else await server.close();
}

export { parseRunRequest } from "./request.js";
export { RunQueue, QueueFullError } from "./queue.js";
export { executeRun } from "./executor.js";
export type { RunResult } from "./executor.js";
