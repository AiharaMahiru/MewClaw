import z from "@deepseek-ai/schemastery";

export interface ProfileTimeouts {
  quick: number;
  standard: number;
  long: number;
}

export interface ConcurrencyConfig {
  maxRuns: number;
  maxRunsPerUser: number;
  maxQueuedPerScope: number;
}

export interface Config {
  host?: string;
  port?: number;
  tokenEnv?: string;
  runTimeoutMs?: number;
  runHardTimeoutMs?: number;
  profileTimeouts?: ProfileTimeouts;
  concurrency?: ConcurrencyConfig;
  heartbeatIntervalMs?: number;
  presetId: string;
  agentPresetId?: string;
  workspaceRoot?: string;
}

export interface ResolvedRunConfig {
  host: string;
  port: number;
  tokenEnv?: string;
  runHardTimeoutMs: number;
  profileTimeouts: ProfileTimeouts;
  concurrency: ConcurrencyConfig;
  heartbeatIntervalMs: number;
  presetId: string;
  agentPresetId: string;
  workspaceRoot: string;
}

export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number(),
  tokenEnv: z.string(),
  runTimeoutMs: z.number(),
  runHardTimeoutMs: z.number(),
  profileTimeouts: z.object({ quick: z.number(), standard: z.number(), long: z.number() }),
  concurrency: z.object({
    maxRuns: z.number(),
    maxRunsPerUser: z.number(),
    maxQueuedPerScope: z.number(),
  }),
  heartbeatIntervalMs: z.number(),
  presetId: z.string().required(),
  agentPresetId: z.string(),
  workspaceRoot: z.string(),
});

const DEFAULT_PORT = 8787;
const DEFAULT_RUN_HARD_TIMEOUT_MS = 0;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WORKSPACE_ROOT = ".workspaces";
const DEFAULT_AGENT_PRESET_ID = "standard";
const MIN_PORT = 0;
const MAX_PORT = 65_535;
const MIN_POSITIVE_VALUE = 1;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_PROFILE_TIMEOUTS: ProfileTimeouts = {
  quick: 5 * 60_000,
  standard: 20 * 60_000,
  long: 60 * 60_000,
};
const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxRuns: 4,
  maxRunsPerUser: 1,
  maxQueuedPerScope: 3,
};

interface IntegerRule {
  min: number;
  max: number;
}

const PORT_RULE: IntegerRule = { min: MIN_PORT, max: MAX_PORT };
const POSITIVE_TIMER_RULE: IntegerRule = { min: MIN_POSITIVE_VALUE, max: MAX_TIMER_DELAY_MS };
const HARD_TIMEOUT_RULE: IntegerRule = { min: DEFAULT_RUN_HARD_TIMEOUT_MS, max: MAX_TIMER_DELAY_MS };
const POSITIVE_COUNT_RULE: IntegerRule = { min: MIN_POSITIVE_VALUE, max: Number.MAX_SAFE_INTEGER };

function requireInteger(value: number, label: string, rule: IntegerRule): number {
  if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`lark-run: ${label} 必须是 ${rule.min}..${rule.max} 的安全整数`);
  }
  return value;
}

function resolveHost(host: string | undefined): string {
  const resolved = host ?? "127.0.0.1";
  if (resolved !== "127.0.0.1" && resolved !== "0.0.0.0") {
    throw new Error(`lark-run: 非法 host ${resolved}（仅 127.0.0.1 / 0.0.0.0）`);
  }
  return resolved;
}

function resolveTokenEnv(host: string, tokenEnv: string | undefined): string | undefined {
  if (host === "0.0.0.0" && !tokenEnv) {
    throw new Error("lark-run: 0.0.0.0 监听必须配置 tokenEnv");
  }
  return tokenEnv;
}

function resolveProfileTimeouts(input: ProfileTimeouts | undefined, legacyTimeout: number | undefined): ProfileTimeouts {
  const defaults = legacyTimeout === undefined
    ? DEFAULT_PROFILE_TIMEOUTS
    : { quick: legacyTimeout, standard: legacyTimeout, long: legacyTimeout };
  return {
    quick: requireInteger(input?.quick ?? defaults.quick, "profileTimeouts.quick", POSITIVE_TIMER_RULE),
    standard: requireInteger(input?.standard ?? defaults.standard, "profileTimeouts.standard", POSITIVE_TIMER_RULE),
    long: requireInteger(input?.long ?? defaults.long, "profileTimeouts.long", POSITIVE_TIMER_RULE),
  };
}

function resolveConcurrency(input: ConcurrencyConfig | undefined): ConcurrencyConfig {
  return {
    maxRuns: requireInteger(input?.maxRuns ?? DEFAULT_CONCURRENCY.maxRuns, "concurrency.maxRuns", POSITIVE_COUNT_RULE),
    maxRunsPerUser: requireInteger(input?.maxRunsPerUser ?? DEFAULT_CONCURRENCY.maxRunsPerUser, "concurrency.maxRunsPerUser", POSITIVE_COUNT_RULE),
    maxQueuedPerScope: requireInteger(input?.maxQueuedPerScope ?? DEFAULT_CONCURRENCY.maxQueuedPerScope, "concurrency.maxQueuedPerScope", POSITIVE_COUNT_RULE),
  };
}

function resolveWorkspaceRoot(workspaceRoot: string | undefined): string {
  const resolved = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  if (resolved.trim().length === 0) throw new Error("lark-run: workspaceRoot 不得为空");
  return resolved;
}

function resolveAgentPresetId(agentPresetId: string | undefined): string {
  const resolved = agentPresetId ?? DEFAULT_AGENT_PRESET_ID;
  if (resolved.trim().length === 0) throw new Error("lark-run: agentPresetId 不得为空");
  return resolved;
}

export function resolveRunConfig(config: Config): ResolvedRunConfig {
  const host = resolveHost(config.host);
  const tokenEnv = resolveTokenEnv(host, config.tokenEnv);
  const legacyTimeout = config.runTimeoutMs === undefined
    ? undefined
    : requireInteger(config.runTimeoutMs, "runTimeoutMs", POSITIVE_TIMER_RULE);
  return {
    host,
    port: requireInteger(config.port ?? DEFAULT_PORT, "port", PORT_RULE),
    ...(tokenEnv ? { tokenEnv } : {}),
    runHardTimeoutMs: requireInteger(
      config.runHardTimeoutMs ?? DEFAULT_RUN_HARD_TIMEOUT_MS,
      "runHardTimeoutMs",
      HARD_TIMEOUT_RULE,
    ),
    profileTimeouts: resolveProfileTimeouts(config.profileTimeouts, legacyTimeout),
    concurrency: resolveConcurrency(config.concurrency),
    heartbeatIntervalMs: requireInteger(
      config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
      POSITIVE_TIMER_RULE,
    ),
    presetId: config.presetId,
    agentPresetId: resolveAgentPresetId(config.agentPresetId),
    workspaceRoot: resolveWorkspaceRoot(config.workspaceRoot),
  };
}
