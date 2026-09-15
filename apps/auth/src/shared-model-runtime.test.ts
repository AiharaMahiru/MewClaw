import { describe, expect, it, vi } from "vitest";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { createSharedModelRuntimeClient } from "./shared-model-runtime.js";

function fixture(chunks: StreamChunk[], providers = [{ id: "openai", name: "OpenAI" }], catalog: Record<string, { id: string; name: string }[]> = { openai: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] }) {
  const requests: GenerateOptions[] = [];
  const close = vi.fn(async () => {});
  const runtime = createSharedModelRuntimeClient(
    providers,
    async (provider) => catalog[provider] ?? [],
    async function* (request) { requests.push(request); yield* chunks; },
    close,
  );
  const base = {
    provider: "openai", model: "gpt-5.6-luna", modelEcho: "shared/openai/gpt-5.6-luna",
    messages: [{ role: "user", content: "你好" }] as Array<Record<string, unknown>>,
    signal: new AbortController().signal,
  };
  return { runtime, requests, close, base };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iterable) lines.push(line);
  return lines;
}

const dataOf = (line: string) => { const payload = line.replace(/^data: /u, "").trim(); return payload === "[DONE]" ? { done: true } : JSON.parse(payload); };

describe("共享模型运行时", () => {
  it("目录聚合各 provider 的可见模型", async () => {
    const { runtime, close } = fixture([], [{ id: "openai", name: "OpenAI" }, { id: "deepseek-official", name: "DeepSeek" }], {
      openai: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      "deepseek-official": [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
    });
    expect(await runtime.listModels()).toEqual([
      { provider: "openai", model: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { provider: "deepseek-official", model: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    ]);
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("text/reasoning/tool_calls/usage/finish 翻译为 OpenAI SSE", async () => {
    const { runtime, requests, base } = fixture([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "想" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "想" } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "回答" },
      { type: "block-end", index: 1, block: { type: "text", text: "回答" } },
      { type: "block-start", index: 2, blockType: "tool-call" },
      { type: "tool-call-delta", index: 2, id: "call-1" as never, name: "ls", argumentsDelta: "{\"dir\":" },
      { type: "tool-call-delta", index: 2, id: "call-1" as never, argumentsDelta: "\"/\"}" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
    const lines = await collect(runtime.stream({
      ...base,
      tools: [{ type: "function", function: { name: "ls", description: "列目录", parameters: { type: "object" } } }],
      maxTokens: 100, temperature: 0.2, stop: ["END"], reasoningEffort: "low", includeUsage: true,
    }));
    const first = dataOf(lines[0]!);
    expect(first.choices[0].delta).toEqual({ role: "assistant" });
    expect(first.model).toBe("shared/openai/gpt-5.6-luna");
    expect(lines.some(line => dataOf(line).choices[0]?.delta?.reasoning_content === "想")).toBe(true);
    expect(lines.some(line => dataOf(line).choices[0]?.delta?.content === "回答")).toBe(true);
    const toolLines = lines.filter(line => dataOf(line).choices?.[0]?.delta?.tool_calls);
    expect(dataOf(toolLines[0]!).choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: "call-1", type: "function", function: { name: "ls", arguments: "{\"dir\":" } });
    expect(dataOf(toolLines[1]!).choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: "\"/\"}" } });
    const usage = lines.map(dataOf).find(chunk => chunk.usage);
    expect(usage.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const final = dataOf(lines.at(-2)!);
    expect(final.choices[0].finish_reason).toBe("tool_calls");
    expect(lines.at(-1)).toBe("data: [DONE]\n\n");
    const request = requests[0]!;
    expect(request.provider).toBe("openai");
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.maxTokens).toBe(100);
    expect(request.tools).toEqual([{ name: "ls", description: "列目录", parameters: { type: "object" } }]);
    expect(request.stop).toEqual(["END"]);
  });

  it("消息翻译：system/user/assistant/tool 角色与非文本部件拒绝", async () => {
    const { runtime, requests, base } = fixture([{ type: "finish", reason: { kind: "stop" } }]);
    await collect(runtime.stream({ ...base, messages: [
      { role: "system", content: "规则" },
      { role: "user", content: [{ type: "text", text: "问题" }] },
      { role: "assistant", content: "答复", reasoning_content: "理由", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "结果" },
      { role: "user", content: "继续" },
    ] }));
    const messages = requests[0]!.messages;
    expect(messages.map(m => m.role)).toEqual(["system", "user", "assistant", "user", "user"]);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "规则" }]);
    expect(messages[2]!.content).toEqual(expect.arrayContaining([
      { type: "reasoning", text: "理由" },
      { type: "text", text: "答复" },
      { type: "tool-call", id: "c1", name: "ls", arguments: "{}" },
    ]));
    expect(messages[3]!.content[0]).toMatchObject({ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "结果" }] });
    await expect(async () => {
      for await (const _ of runtime.stream({ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] })) void _;
    }).rejects.toThrow("text content parts only");
  });

  it("finish error/aborted 与无 finish 截断产出错误行，不含上游细节", async () => {
    const failed = fixture([{ type: "finish", reason: { kind: "error", failure: { code: "UPSTREAM_500", message: "provider内部细节" } } }]);
    const lines = await collect(failed.runtime.stream(failed.base));
    const errorLine = dataOf(lines.at(-2)!);
    expect(errorLine.error.code).toBe("UPSTREAM_500");
    expect(errorLine.error.message).not.toContain("provider内部细节");
    const truncated = fixture([]);
    const tail = await collect(truncated.runtime.stream(truncated.base));
    expect(dataOf(tail.at(-2)!).error.code).toBe("STREAM_INCOMPLETE");
  });
});
