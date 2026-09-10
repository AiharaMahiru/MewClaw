const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_MINUTE = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE;
const MILLISECONDS_PER_HOUR = MILLISECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const MILLISECONDS_PER_DAY = MILLISECONDS_PER_HOUR * HOURS_PER_DAY;
const MIN_LEASE_SECONDS = 3;
const MAX_BATCH_SIZE = 100;

export const DEFAULT_POLL_INTERVAL_MS = 10 * MILLISECONDS_PER_SECOND;
export const DEFAULT_LEASE_MS = 15 * MILLISECONDS_PER_MINUTE;
export const DEFAULT_OUTBOX_LEASE_MS = 5 * MILLISECONDS_PER_MINUTE;
export const DEFAULT_BATCH_SIZE = 10;

export interface CronRuntimeConfig {
  pollIntervalMs?: number;
  leaseMs?: number;
  outboxLeaseMs?: number;
  batchSize?: number;
}

export interface ResolvedCronConfig {
  pollIntervalMs: number;
  leaseMs: number;
  outboxLeaseMs: number;
  batchSize: number;
}

interface IntegerBounds {
  field: keyof CronRuntimeConfig;
  fallback: number;
  minimum: number;
  maximum: number;
}

const POLL_INTERVAL_BOUNDS: IntegerBounds = {
  field: "pollIntervalMs", fallback: DEFAULT_POLL_INTERVAL_MS,
  minimum: MILLISECONDS_PER_SECOND, maximum: MILLISECONDS_PER_HOUR,
};
const LEASE_BOUNDS: IntegerBounds = {
  field: "leaseMs", fallback: DEFAULT_LEASE_MS,
  minimum: MIN_LEASE_SECONDS * MILLISECONDS_PER_SECOND, maximum: MILLISECONDS_PER_DAY,
};
const OUTBOX_LEASE_BOUNDS: IntegerBounds = {
  field: "outboxLeaseMs", fallback: DEFAULT_OUTBOX_LEASE_MS,
  minimum: MILLISECONDS_PER_SECOND, maximum: MILLISECONDS_PER_DAY,
};
const BATCH_SIZE_BOUNDS: IntegerBounds = {
  field: "batchSize", fallback: DEFAULT_BATCH_SIZE, minimum: 1, maximum: MAX_BATCH_SIZE,
};

function resolveBoundedInteger(value: number | undefined, bounds: IntegerBounds): number {
  if (value === undefined) return bounds.fallback;
  if (Number.isSafeInteger(value) && value >= bounds.minimum && value <= bounds.maximum) return value;
  throw new Error(`lark-cron: ${bounds.field} 配置必须为 ${bounds.minimum}..${bounds.maximum} 的安全整数`);
}

/** 装载期拒绝会改变轮询、租约或 SQL LIMIT 语义的非法数值。 */
export function resolveCronConfig(config: CronRuntimeConfig): ResolvedCronConfig {
  return {
    pollIntervalMs: resolveBoundedInteger(config.pollIntervalMs, POLL_INTERVAL_BOUNDS),
    leaseMs: resolveBoundedInteger(config.leaseMs, LEASE_BOUNDS),
    outboxLeaseMs: resolveBoundedInteger(config.outboxLeaseMs, OUTBOX_LEASE_BOUNDS),
    batchSize: resolveBoundedInteger(config.batchSize, BATCH_SIZE_BOUNDS),
  };
}
