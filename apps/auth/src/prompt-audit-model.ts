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
    // Auth 控制面继承的环境不能覆盖 DSH Models 保存的凭证；仅审计上下文过滤进程层。
    // 启动器必须传入原始分层快照，保留项目与用户环境的正常回退，不修改 process.env。
    const snapshot = options.launchEnvironment;
    ctx.provide("launchEnvironment", {
      get: (name) => snapshot.getFrom(name, ["project-env", "user-env"]),
      getFrom: (name, sources) => snapshot.getFrom(name, sources.filter((source) => source !== "process")),
    } satisfies LaunchEnvironmentSnapshot);
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
        model: "deepseek-v4-flash",
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
