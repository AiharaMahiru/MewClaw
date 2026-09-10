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
): PromptAuditModel {
  return {
    close,
    async generate({ system, text, signal }) {
      signal.throwIfAborted();
      let output = "";
      let completed = false;
      for await (const chunk of stream({
        provider: "deepseek-official",
        model: "deepseek-v4.1-flash",
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
    },
  };
}
