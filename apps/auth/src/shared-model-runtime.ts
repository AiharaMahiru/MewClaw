/**
 * 部署侧共享模型目录：Edge 进程内的独立 Cordis 上下文承载 LlmRuntime，
 * 模型目录与凭证解析完全复用 settings/凭证引用；密钥不出本进程。
 * 对 edge 暴露窄接口 DesktopSharedRuntime（枚举目录 + 产出 OpenAI SSE 行）。
 */
import { randomUUID } from "node:crypto";

import { Context } from "@deepseek-ai/cordis";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import type { LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import LlmRuntime, {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import * as piAi from "@deepseek-ai/dsh-llm-pi-ai";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import type { DesktopSharedRuntime } from "dsh-lark-auth-edge";
import { InvalidSharedRequestError } from "dsh-lark-auth-edge";
import * as deepseekRouting from "dsh-lark-deepseek-routing";

const PLUGIN_ID = "dsh-lark-auth-edge";
const REASONING_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "max", "xhigh"]);

export interface SharedModelRuntime extends DesktopSharedRuntime {
  close(): Promise<void>;
}

export interface SharedModelRuntimeOptions {
  dshHome?: string;
  launchEnvironment: LaunchEnvironmentSnapshot;
}

/** 独立共享推理上下文只复用官方配置、凭证与模型能力，不挂载 Worker、会话或工具。 */
export async function createSharedModelRuntime(options: SharedModelRuntimeOptions): Promise<SharedModelRuntime> {
  const ctx = new Context();
  try {
    ctx.provide("launchEnvironment", options.launchEnvironment);
    const fileConfig = options.dshHome === undefined ? {} : { dshHome: options.dshHome };
    await ctx.plugin(LocalCredentialProvider, fileConfig);
    await ctx.plugin(FileSettingsProvider, fileConfig);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(deepseekRouting, {});
    await ctx.plugin(piAi, {});
    return createSharedModelRuntimeClient(
      ctx.llm.listProviders(),
      (provider) => ctx.llm.listModels(provider),
      (request) => ctx.llm.stream(request),
      async () => { await ctx.fiber.dispose(); },
    );
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

/** 与 ctx 解耦的实现核心：注入目录枚举与流入口，便于无密钥重放的单测。 */
export function createSharedModelRuntimeClient(
  providers: readonly { id: string; name: string }[],
  listModels: (provider: string) => Promise<readonly { id: string; name: string }[]>,
  stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  close: () => Promise<void>,
): SharedModelRuntime {
  return {
    close,
    async listModels() {
      const entries: { provider: string; model: string; name: string }[] = [];
      for (const provider of providers) {
        for (const model of await listModels(provider.id).catch(() => [])) {
          entries.push({ provider: provider.id, model: model.id, name: model.name || model.id });
        }
      }
      return entries;
    },
    // 非生成器方法：消息翻译在调用时急切执行，内容校验错误先于响应头发出。
    stream(input) {
      const messages = toModelMessages(input.messages, input.provider, input.model);
      return streamToSse(input, messages, stream);
    },
  };
}

type SharedStreamInput = Parameters<DesktopSharedRuntime["stream"]>[0];

async function* streamToSse(
  input: SharedStreamInput,
  messages: Message[],
  stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
): AsyncIterable<string> {
      const options: GenerateOptions = {
        provider: input.provider,
        model: input.model,
        messages,
        signal: input.signal,
      };
      if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
      if (input.temperature !== undefined) options.temperature = input.temperature;
      if (input.stop !== undefined) options.stop = input.stop;
      if (input.reasoningEffort && REASONING_EFFORTS.has(input.reasoningEffort)) options.reasoningEffort = ReasoningEffortId(input.reasoningEffort);
      const tools = toToolSchemas(input.tools);
      if (tools.length) options.tools = tools;

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const emit = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: input.modelEcho, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      yield emit({ role: "assistant" });
      // 源块 index → OpenAI tool_calls index + 首帧（携带 id/name）是否已发出。
      const toolCalls = new Map<number, { index: number; started: boolean }>();
      let sawFinish = false;
      for await (const chunk of stream(options)) {
        if (chunk.type === "text-delta") yield emit({ content: chunk.text });
        else if (chunk.type === "reasoning-delta") yield emit({ reasoning_content: chunk.text });
        else if (chunk.type === "tool-call-delta") {
          let state = toolCalls.get(chunk.index);
          if (!state) { state = { index: toolCalls.size, started: false }; toolCalls.set(chunk.index, state); }
          yield emit({ tool_calls: [state.started
            ? { index: state.index, function: { arguments: chunk.argumentsDelta } }
            : { index: state.index, id: chunk.id, type: "function", function: { name: chunk.name ?? "", arguments: chunk.argumentsDelta } }] });
          state.started = true;
        } else if (chunk.type === "usage" && input.includeUsage) {
          yield `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: input.modelEcho, choices: [], usage: {
            prompt_tokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
            completion_tokens: chunk.usage.outputTokens,
            total_tokens: chunk.usage.totalTokens ?? (chunk.usage.inputTokens + chunk.usage.outputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)),
          } })}\n\n`;
        } else if (chunk.type === "finish") {
          sawFinish = true;
          const reason = chunk.reason.kind;
          if (reason === "stop" || reason === "tool-calls" || reason === "max-tokens") {
            yield emit({}, reason === "stop" ? "stop" : reason === "tool-calls" ? "tool_calls" : "length");
          } else {
            const code = "failure" in chunk.reason ? chunk.reason.failure.code : "INFERENCE_FAILED";
            yield `data: ${JSON.stringify({ error: { message: "shared model inference failed", type: "server_error", code } })}\n\n`;
          }
        }
      }
  if (!sawFinish) yield `data: ${JSON.stringify({ error: { message: "shared model stream ended without finish", type: "server_error", code: "STREAM_INCOMPLETE" } })}\n\n`;
  yield "data: [DONE]\n\n";
}

/** OpenAI 消息 → provider 中立 Message[]；非文本内容部件 fail closed。 */
function toModelMessages(messages: Array<Record<string, unknown>>, provider: string, model: string): Message[] {
  const result: Message[] = [];
  for (const raw of messages) {
    switch (raw.role) {
      case "system":
      case "developer":
        result.push(createSystemMessage(textOf(raw.content), PLUGIN_ID));
        break;
      case "user":
        result.push(createUserMessage({ source: { kind: "user" }, content: toContentBlocks(raw.content) }));
        break;
      case "assistant": {
        const content = toContentBlocks(raw.content);
        const reasoning = typeof raw.reasoning_content === "string" ? raw.reasoning_content
          : typeof raw.reasoning === "string" ? raw.reasoning : undefined;
        if (reasoning) content.unshift({ type: "reasoning", text: reasoning });
        for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls as Array<Record<string, unknown>> : []) {
          const fn = call?.function as Record<string, unknown> | undefined;
          if (call?.type === "function" && fn && typeof fn.name === "string") {
            content.push({
              type: "tool-call",
              id: ToolCallId(String(call.id ?? "")),
              name: fn.name,
              arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            });
          }
        }
        result.push(createAssistantMessage({ source: { provider, model }, content }));
        break;
      }
      case "tool":
        result.push(createToolResultMessage({
          callId: ToolCallId(String(raw.tool_call_id ?? "")),
          content: toContentBlocks(raw.content),
          isError: false,
        }));
        break;
    }
  }
  return result;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return toContentBlocks(content).filter((block): block is { type: "text"; text: string } => block.type === "text").map(block => block.text).join("");
}

function toContentBlocks(content: unknown): ContentBlock[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new InvalidSharedRequestError("content must be a string or array of text parts");
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text" || typeof (part as { text?: unknown }).text !== "string") {
      throw new InvalidSharedRequestError("shared inference accepts text content parts only");
    }
    blocks.push({ type: "text", text: (part as { text: string }).text });
  }
  return blocks;
}

function toToolSchemas(tools: Array<Record<string, unknown>> | undefined): ToolSchema[] {
  const schemas: ToolSchema[] = [];
  for (const tool of tools ?? []) {
    const fn = tool?.function as Record<string, unknown> | undefined;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string") continue;
    schemas.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: (fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {}) as Record<string, unknown>,
    });
  }
  return schemas;
}
