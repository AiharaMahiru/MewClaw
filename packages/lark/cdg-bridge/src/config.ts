export interface CdgBridgeConfigInput {
  command?: string;
  timeoutMs?: number;
}

export interface ResolvedCdgBridgeConfig {
  command: string | undefined;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

function resolveTimeout(value: number | undefined): number {
  const timeoutMs = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`cdg-bridge: timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
  }
  return timeoutMs;
}

/** command 缺省明确关闭桥接；显式空白命令和无界超时都在装载期拒绝。 */
export function resolveCdgBridgeConfig(input: CdgBridgeConfigInput): ResolvedCdgBridgeConfig {
  const command = input.command?.trim();
  if (input.command !== undefined && !command) {
    throw new Error("cdg-bridge: command must not be empty when configured");
  }
  return { command, timeoutMs: resolveTimeout(input.timeoutMs) };
}
