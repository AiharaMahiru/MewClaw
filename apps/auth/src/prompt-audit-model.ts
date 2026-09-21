import { Context } from "@deepseek-ai/cordis";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import type { LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import LlmRuntime, { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import * as deepseekRouting from "dsh-lark-deepseek-routing";

export interface PromptAuditModel {
  generate(input: { system: string; text: string; signal: AbortSignal; sessionId?: string }): Promise<string>;
  close(): Promise<void>;
}

export interface PromptAuditModelOptions {
  dshHome?: string;
  launchEnvironment: LaunchEnvironmentSnapshot;
  maxTokens?: number;
  /** 主审计模型失败时在同一路由内按序切换的备用逻辑模型。 */
  fallbackModels?: string[];
  /** 会话粘性窗口：sessionId 在 TTL 内优先回到上次成功的模型；0 关闭。 */
  stickyMs?: number;
}

/** 独立审计上下文只复用官方配置和模型能力，不挂载 Worker、会话或工具。 */
export async function createPromptAuditModel(options: PromptAuditModelOptions): Promise<PromptAuditModel> {
  const ctx = new Context();
  try {
    // 完整传递官方冻结快照；凭证来源优先级由 dsh-credentials-local 统一实现。
    ctx.provide("launchEnvironment", options.launchEnvironment);
    const fileConfig = options.dshHome === undefined ? {} : { dshHome: options.dshHome };
    await ctx.plugin(LocalCredentialProvider, fileConfig);
    await ctx.plugin(FileSettingsProvider, fileConfig);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(deepseekRouting, {});
    return createPromptAuditModelClient(
      (request) => ctx.llm.stream(request),
      async () => { await ctx.fiber.dispose(); },
      options.maxTokens ?? 512,
      {
        ...(options.fallbackModels?.length ? { fallbackModels: options.fallbackModels } : {}),
        ...(options.stickyMs !== undefined ? { stickyMs: options.stickyMs } : {}),
      },
    );
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

const PRIMARY_AUDIT_MODEL = "deepseek-v4.1-flash";
/** 粘性表上限：sessionId 有界审计流量下足够，超限时先清过期再逐最旧。 */
const STICKY_CAP = 1024;
const DEFAULT_STICKY_MS = 30 * 60_000;

/** 收敛流协议；不完整、截断或失败的响应不得充当放行结果。 */
export function createPromptAuditModelClient(
  stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  close: () => Promise<void>,
  maxTokens: number,
  options: { fallbackModels?: string[]; stickyMs?: number } = {},
): PromptAuditModel {
  const chain = [PRIMARY_AUDIT_MODEL, ...(options.fallbackModels ?? [])];
  const stickyMs = options.stickyMs ?? DEFAULT_STICKY_MS;
  const sticky = new Map<string, { model: string; expiresAt: number }>();
  // 同一会话优先回到上次成功的模型：主模型故障期内不必每次都先撞一次坏模型，
  // TTL 到期后自然回链首，主模型恢复后自动回归。
  const orderFor = (sessionId: string | undefined): string[] => {
    if (!sessionId || stickyMs <= 0) return chain;
    const hit = sticky.get(sessionId);
    if (!hit) return chain;
    if (hit.expiresAt <= Date.now()) { sticky.delete(sessionId); return chain; }
    return [hit.model, ...chain.filter((model) => model !== hit.model)];
  };
  const stick = (sessionId: string | undefined, model: string): void => {
    if (!sessionId || stickyMs <= 0) return;
    sticky.delete(sessionId);
    sticky.set(sessionId, { model, expiresAt: Date.now() + stickyMs });
    if (sticky.size > STICKY_CAP) {
      const now = Date.now();
      for (const [key, entry] of sticky) { if (entry.expiresAt <= now) sticky.delete(key); }
      while (sticky.size > STICKY_CAP) sticky.delete(sticky.keys().next().value!);
    }
  };
  const unstick = (sessionId: string | undefined, model: string): void => {
    if (sessionId && sticky.get(sessionId)?.model === model) sticky.delete(sessionId);
  };
  const attempt = async (input: { system: string; text: string; signal: AbortSignal }, model: string): Promise<string> => {
    const { system, text, signal } = input;
    signal.throwIfAborted();
    let output = "";
    let completed = false;
    for await (const chunk of stream({
      provider: "deepseek-official",
      model,
      reasoningEffort: ReasoningEffortId("off"),
      system,
      messages: [createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] })],
      maxTokens,
      signal,
    })) {
      signal.throwIfAborted();
      if (completed) throw new Error("prompt audit: unexpected data after finish");
      if (chunk.type === "text-delta") {
        if (output.length + chunk.text.length > maxTokens * 8) throw new Error("prompt audit: oversized model response");
        output += chunk.text;
      }
      if (chunk.type === "finish") {
        if (chunk.reason.kind !== "stop") {
          const code = "failure" in chunk.reason && /^[A-Z0-9_]+$/u.test(chunk.reason.failure.code)
            ? chunk.reason.failure.code : "NO_CODE";
          throw new Error(`prompt audit: finish ${chunk.reason.kind} ${code}`);
        }
        completed = true;
      }
    }
    signal.throwIfAborted();
    if (!completed || !output.trim()) throw new Error("prompt audit: missing model response");
    return output;
  };
  return {
    close,
    async generate(input) {
      const order = orderFor(input.sessionId);
      let lastError: unknown;
      for (let index = 0; index < order.length; index += 1) {
        const model = order[index]!;
        try {
          const output = await attempt(input, model);
          stick(input.sessionId, model);
          return output;
        } catch (error) {
          // 凭证/配额/模型禁用等确定性 code 也是模型维度故障，链上其余模型同样
          // 值得尝试；只有调用方中止（预算耗尽）才提前收手。
          if (input.signal.aborted) throw error;
          lastError = error;
          unstick(input.sessionId, model);
          const next = order[index + 1];
          if (next) console.warn(`[prompt-audit] 审计模型 ${model} 失败，切换 ${next}: ${auditFailureSummary(error)}`);
        }
      }
      throw lastError ?? new Error("prompt audit: unavailable");
    },
  };
}

/** 日志只允许已消毒的失败类别，不透传上游错误正文或异常对象。 */
function auditFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^prompt audit: [a-z0-9 _:-]+$/iu.test(message) ? message : "prompt audit: upstream error";
}
