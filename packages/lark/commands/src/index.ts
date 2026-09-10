/**
 * dsh-lark-commands 插件入口（SPEC lark-commands.md）。
 *
 * 网关侧确定性命令表（不启动模型；`/cron create` 类自然语言任务 M2 起
 * 路由给模型工具）。与 dsh-commands 注册表的关系：后者是进程内 agent
 * 语义（handler 针对具体 agent 执行），网关侧路由使用本包自有轻量表
 * （SPEC §9 已记录该调整）。
 *
 * 命令集：/clear（换新会话，代次递增）、/handoff、/runtime（档位读写，
 * 内存态，重启回默认）、/todo、/session、/cron（定时任务确定性管理，
 * R-18：列表/详情/暂停/恢复/删除，走 worker cron-control 端点）、/login（飞书
 * 身份与 Web 一次性配对）、/help。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import type { ChatId, InteractionId, RunProfile, Scope } from "dsh-lark-contracts";
import type {} from "dsh-lark-run-client";

import {
  CardActionRegistry,
  DEFAULT_CARD_ACTION_MAX_ENTRIES,
  DEFAULT_CARD_ACTION_TTL_MS,
  MAX_CARD_ACTION_MAX_ENTRIES,
  MAX_CARD_ACTION_TTL_MS,
} from "./card-actions.js";
import { GatewayCommands, resolveDefaultProfile } from "./service.js";
import { createFeishuPairingClient } from "./pairing.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 网关命令服务（宿主面，不进模型上下文）。 */
    larkCommands?: LarkCommandsService;
  }
  interface Events {
    /**
     * 用户执行 /clear：网关据此递增该 scope 的会话代次（旧会话保留）。
     * @param payload - 目标 scope 与 chatId
     * @mode sync
     */
    "lark/command/clear-session"(payload: { scope: Scope; chatId: ChatId }): void;
  }
}

export const name = "lark-commands";

export const inject = ["credentials", "larkRunClient"];

export interface Config {
  /** 运行时档位默认值（默认 standard；非白名单值被拒绝回默认）。 */
  defaultProfile?: string;
  /** 命令卡服务端 action 的存活时间（默认 10 分钟）。 */
  cardActionTtlMs?: number;
  /** 未消费命令卡 action 的最大数量（默认 1000）。 */
  cardActionMaxEntries?: number;
  /** auth-edge loopback 配对签发端点；缺省时 /login 返回配置提示。 */
  pairingEndpoint?: string;
  /** 配对端点 Bearer 凭证引用（默认 AUTH_PAIRING_TOKEN）。 */
  pairingTokenEnv?: string;
  /** 未配置配对端点时的 /login 提示；个人机器人用它说明账号归属语义。 */
  pairingUnavailableMessage?: string;
}

export const Config: z<Config> = z.object({
  defaultProfile: z.string(),
  cardActionTtlMs: z.number(),
  cardActionMaxEntries: z.number(),
  pairingEndpoint: z.string(),
  pairingTokenEnv: z.string(),
  pairingUnavailableMessage: z.string(),
});

export interface ParsedGatewayCommand {
  /** 小写命令名（不含斜杠）。 */
  name: string;
  /** 命令名之后的原文（trim）。 */
  args: string;
}

export interface GatewayCommandResult {
  /** 渲染为 markdown 卡片的正文。 */
  markdown: string;
  /** 已注册的操作按钮；wire payload 只会得到对应 actionId。 */
  actions?: readonly CommandCardAction[];
}

/** 命令 provider 内部语义，渲染时会剥离 command，只序列化 actionId。 */
export interface CommandCardAction {
  label: string;
  command: string;
  actionId?: InteractionId;
  style?: "default" | "primary" | "danger";
  confirm?: string;
  group?: string;
  layout?: "stack";
}

export interface GatewayCommandInput {
  scope: Scope;
  chatId: ChatId;
  command: ParsedGatewayCommand;
  /** 当前 Scope 的 `/clear` 代次；缺省按初始会话 0。 */
  sessionGeneration?: number;
}

/** 已授权卡片 callback 的最小输入；actionId 仅作服务端状态引用。 */
export interface GatewayCardActionInput {
  scope: Scope;
  chatId: ChatId;
  actionId: InteractionId;
  sessionGeneration?: number;
}

export interface LarkCommandsService {
  /** 解析斜杠命令；非命令文本返回 undefined。 */
  parse(text: string): ParsedGatewayCommand | undefined;
  /** 解析飞书机器人菜单 eventKey；未知键 fail closed。 */
  resolveBotMenu(eventKey: string): ParsedGatewayCommand | undefined;
  /** 执行已知命令；未知命令返回 undefined（网关回退为提示卡）。 */
  handle(input: GatewayCommandInput): Promise<GatewayCommandResult | undefined>;
  /** 消费已注册的命令卡 action；失败始终返回用户可见的拒绝卡。 */
  handleCardAction(input: GatewayCardActionInput): Promise<GatewayCommandResult>;
  /** 读取该 scope 的运行档位（/runtime 设置；内存态）。 */
  getProfile(scope: Scope): RunProfile;
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide("larkCommands", new GatewayCommands({
    ctx,
    runClient: ctx.larkRunClient!,
    pairingClient: config.pairingEndpoint
      ? createFeishuPairingClient({ endpoint: config.pairingEndpoint, tokenEnv: config.pairingTokenEnv, credentials: ctx.credentials })
      : undefined,
    pairingUnavailableMessage: config.pairingUnavailableMessage,
    defaultProfile: resolveDefaultProfile(config.defaultProfile),
    cardActions: new CardActionRegistry({
      ttlMs: resolveBoundedConfig(config.cardActionTtlMs, DEFAULT_CARD_ACTION_TTL_MS, MAX_CARD_ACTION_TTL_MS, "cardActionTtlMs"),
      maxEntries: resolveBoundedConfig(config.cardActionMaxEntries, DEFAULT_CARD_ACTION_MAX_ENTRIES, MAX_CARD_ACTION_MAX_ENTRIES, "cardActionMaxEntries"),
    }),
  }));
}

function resolveBoundedConfig(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`lark-commands: ${label} 必须是 1..${maximum} 的安全整数`);
  }
  return resolved;
}

export { parseGatewayCommand } from "./parse.js";
export { resolveBotMenuCommand } from "./bot-menu.js";
export { CardActionRegistry } from "./card-actions.js";
