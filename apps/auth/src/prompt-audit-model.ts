import { Context } from "@deepseek-ai/cordis";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import type { LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import LlmRuntime, { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import * as deepseekRouting from "dsh-lark-deepseek-routing";

export interface PromptAuditModel {
  generate(input: { system: string; text: string; signal: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

export interface PromptAuditModelOptions {
  dshHome?: string;
  launchEnvironment: LaunchEnvironmentSnapshot;
  maxTokens?: number;
  /** 主审计模型失败时在同一路由内切换的备用逻辑模型。 */
  fallbackModel?: string;
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
      { ...(options.fallbackModel ? { fallbackModel: options.fallbackModel } : {}) },
    );
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

/** 收敛流协议；不完整、截断或失败的响应不得充当放行结果。 */
export function createPromptAuditModelClient(
  stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  close: () => Promise<void>,
  maxTokens: number,
  options: { fallbackModel?: string } = {},
): PromptAuditModel {
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
      try {
        return await attempt(input, "deepseek-v4.1-flash");
      } catch (error) {
        // 凭证/配额/模型禁用等确定性 code 也是模型维度故障，备用模型同样值得尝试；
        // 只有调用方中止（预算耗尽）才不切换。
        if (!options.fallbackModel || input.signal.aborted) throw error;
        console.warn(`[prompt-audit] 主审计模型失败，切换备用模型 ${options.fallbackModel}: ${auditFailureSummary(error)}`);
        return await attempt(input, options.fallbackModel);
      }
    },
  };
}

/** 日志只允许已消毒的失败类别，不透传上游错误正文或异常对象。 */
function auditFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^prompt audit: [a-z0-9 _:-]+$/iu.test(message) ? message : "prompt audit: upstream error";
}
