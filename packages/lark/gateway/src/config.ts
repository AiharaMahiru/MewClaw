import z from "@deepseek-ai/schemastery";
import {
  parseBotId,
  parseChatId,
  parseDeploymentId,
  parseTenantId,
  parseUserId,
  type BotId,
  type ChatId,
  type DeploymentId,
  type ParseResult,
  type TenantId,
  type UserId,
} from "dsh-lark-contracts";

export interface Config {
  authorizedOpenIds: string[];
  allowedChatIds: string[];
  tenantId?: string;
  botId?: string;
  deploymentId?: string;
  dedupTtlMs?: number;
  dedupMaxEntries?: number;
  maxToolLines?: number;
  processingCardText: string;
  failureCardTemplate: string;
  unauthorizedCardText?: string;
  stateDir?: string;
  uploadsRoot: string;
  maxAttachmentBytes?: number;
  attachmentTtlMs?: number;
  cronPollIntervalMs?: number;
}

export const Config: z<Config> = z.object({
  authorizedOpenIds: z.array(z.string()),
  allowedChatIds: z.array(z.string()),
  tenantId: z.string(),
  botId: z.string(),
  deploymentId: z.string(),
  dedupTtlMs: z.number(),
  dedupMaxEntries: z.number(),
  maxToolLines: z.number(),
  processingCardText: z.string().required(),
  failureCardTemplate: z.string().required(),
  unauthorizedCardText: z.string(),
  stateDir: z.string(),
  uploadsRoot: z.string().required(),
  maxAttachmentBytes: z.number(),
  attachmentTtlMs: z.number(),
  cronPollIntervalMs: z.number(),
});

export const DEFAULT_DEDUP_TTL_MS = 10 * 60_000;
export const DEFAULT_DEDUP_ENTRIES = 100_000;
export const DEFAULT_MAX_TOOL_LINES = 8;
export const MAX_TOOL_LINES = 20;
export const DEFAULT_GATEWAY_STATE_DIR = "var/gateway";
export const DEFAULT_CRON_POLL_INTERVAL_MS = 15_000;

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

export interface GatewayRuntimeConfig {
  stateDir: string;
  dedupTtlMs: number;
  dedupMaxEntries: number;
  maxToolLines: number;
  cronPollIntervalMs: number;
}

const DEDUP_TTL_RULE: IntegerRule = {
  field: "dedupTtlMs", fallback: DEFAULT_DEDUP_TTL_MS, minimum: 1_000, maximum: 60 * 60_000,
};
const DEDUP_ENTRIES_RULE: IntegerRule = {
  field: "dedupMaxEntries", fallback: DEFAULT_DEDUP_ENTRIES, minimum: 1, maximum: DEFAULT_DEDUP_ENTRIES,
};
const TOOL_LINES_RULE: IntegerRule = {
  field: "maxToolLines", fallback: DEFAULT_MAX_TOOL_LINES, minimum: 1, maximum: MAX_TOOL_LINES,
};
const CRON_POLL_RULE: IntegerRule = {
  field: "cronPollIntervalMs", fallback: DEFAULT_CRON_POLL_INTERVAL_MS, minimum: 0, maximum: 60 * 60_000,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-gateway: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 去重、轮询和代次状态先于任何 listener 或 timer 固化。 */
export function resolveGatewayRuntimeConfig(config: Config): GatewayRuntimeConfig {
  const stateDir = (config.stateDir === undefined ? DEFAULT_GATEWAY_STATE_DIR : config.stateDir).trim();
  if (!stateDir) throw new Error("lark-gateway: stateDir must be non-empty");
  return {
    stateDir,
    dedupTtlMs: resolveInteger(config.dedupTtlMs, DEDUP_TTL_RULE),
    dedupMaxEntries: resolveInteger(config.dedupMaxEntries, DEDUP_ENTRIES_RULE),
    maxToolLines: resolveInteger(config.maxToolLines, TOOL_LINES_RULE),
    cronPollIntervalMs: resolveInteger(config.cronPollIntervalMs, CRON_POLL_RULE),
  };
}

type IdParser<T> = (value: unknown) => ParseResult<T>;

export interface GatewaySecurity {
  identity: {
    tenantId: TenantId;
    botId: BotId;
    deploymentId: DeploymentId;
  };
  authorizedOpenIds: UserId[];
  allowedChatIds: ChatId[];
}

function parseConfiguredId<T>(value: unknown, label: string, parser: IdParser<T>): T {
  const parsed = parser(value);
  if (!parsed.ok) throw new Error(`lark-gateway: ${label} 配置非法`);
  return parsed.value;
}

function parseConfiguredIds<T>(values: string[], label: string, parser: IdParser<T>): T[] {
  return values.map((value, index) => parseConfiguredId(value, `${label}[${index}]`, parser));
}

/** 配置是跨部署输入，启动时一次性品牌化并拒绝非法身份与授权名单。 */
export function resolveGatewaySecurity(config: Config): GatewaySecurity {
  return {
    identity: {
      tenantId: parseConfiguredId(config.tenantId ?? "lark", "tenantId", parseTenantId),
      botId: parseConfiguredId(config.botId ?? "default", "botId", parseBotId),
      deploymentId: parseConfiguredId(config.deploymentId ?? "default", "deploymentId", parseDeploymentId),
    },
    authorizedOpenIds: parseConfiguredIds(config.authorizedOpenIds, "authorizedOpenIds", parseUserId),
    allowedChatIds: parseConfiguredIds(config.allowedChatIds, "allowedChatIds", parseChatId),
  };
}
