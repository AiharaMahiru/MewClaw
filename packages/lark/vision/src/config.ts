export interface VisionConfigInput {
  timeoutMs?: number;
}

export interface ResolvedVisionConfig {
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

/** 视觉请求会占用 Worker 与上游额度，配置必须给出有限的安全时限。 */
export function resolveVisionConfig(input: VisionConfigInput): ResolvedVisionConfig {
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`lark-vision: timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
  }
  return { timeoutMs };
}
