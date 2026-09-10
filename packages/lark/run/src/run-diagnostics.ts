import { LarkError } from "dsh-lark-contracts";

export type RunStage =
  | "billing-quota"
  | "session-target"
  | "workspace"
  | "workspace-attach"
  | "artifact-snapshot"
  | "skill-preflight"
  | "agent-list-snapshots"
  | "agent-create"
  | "agent-resume"
  | "session-input"
  | "prompt-prepare"
  | "model-followup"
  | "first-visible"
  | "agent-idle"
  | "session-projection-cache"
  | "artifact-collect"
  | "agent-dispose";

export type RunStageOutcome = "ok" | "failed";

export type RunStageReporter = (stage: RunStage, durationMs: number, outcome: RunStageOutcome) => void;

export class RunStageError extends Error {
  constructor(readonly stage: RunStage, readonly original: unknown) {
    super(`run stage ${stage} failed`, { cause: original });
    this.name = "RunStageError";
  }
}

function wrap(stage: RunStage, error: unknown): unknown {
  if (error instanceof RunStageError || error instanceof LarkError) return error;
  return new RunStageError(stage, error);
}

export function reportRunStage(
  reporter: RunStageReporter | undefined,
  stage: RunStage,
  startedAt: number,
  outcome: RunStageOutcome,
): void {
  if (!reporter) return;
  try {
    reporter(stage, Math.max(0, Date.now() - startedAt), outcome);
  } catch {
    // 诊断输出不能改变运行结果。
  }
}

export async function atRunStage<T>(
  stage: RunStage,
  operation: () => Promise<T>,
  reporter?: RunStageReporter,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    reportRunStage(reporter, stage, startedAt, "ok");
    return result;
  } catch (error) {
    reportRunStage(reporter, stage, startedAt, "failed");
    throw wrap(stage, error);
  }
}

export function atRunStageSync<T>(stage: RunStage, operation: () => T, reporter?: RunStageReporter): T {
  const startedAt = Date.now();
  try {
    const result = operation();
    reportRunStage(reporter, stage, startedAt, "ok");
    return result;
  } catch (error) {
    reportRunStage(reporter, stage, startedAt, "failed");
    throw wrap(stage, error);
  }
}

function rootCause(error: unknown): unknown {
  return error instanceof RunStageError ? error.original : error;
}

function safeMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(/(api[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, "<path>")
    .trim()
    .slice(0, 240);
  return scrubbed.length > 0 ? scrubbed : undefined;
}

function safeCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : undefined;
}

export function describeRunFailure(error: unknown): string {
  const stage = error instanceof RunStageError ? error.stage : "unknown";
  const cause = rootCause(error);
  const name = cause instanceof Error ? cause.name : "unknown";
  const code = safeCode(cause);
  const message = safeMessage(cause);
  return [
    `stage=${stage}`,
    `error=${name}`,
    ...(code ? [`code=${code}`] : []),
    ...(message ? [`message=${message}`] : []),
  ].join(" ");
}
