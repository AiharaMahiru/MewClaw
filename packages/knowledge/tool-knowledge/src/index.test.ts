/**
 * dsh-tool-knowledge 测试（SPEC knowledge.md §5）：
 * 工具注册、Scope 取自运行信封（agent → larkScopeIndex）、
 * 引用先落盘后返回（模型可见 ⟺ 已落盘）、无 Scope/无 agent fail loud。
 */
import { describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { KnowledgeHit } from "dsh-knowledge";

import { apply, formatKnowledgeOutput } from "./index.js";

function makeHit(docId: string, text: string): KnowledgeHit {
  return {
    docId: docId as never,
    documentKey: "notes.md",
    name: "notes.md",
    version: 1,
    visibility: "user_private",
    chunk: 0,
    text,
    score: 0.9,
    citation: { source: docId, snippet: text.slice(0, 20), score: 0.9 },
  };
}

interface CapturedCtx {
  tools: { register: ReturnType<typeof vi.fn> };
  systemPrompt: { section: ReturnType<typeof vi.fn> };
  knowledge: { retrieve: ReturnType<typeof vi.fn> };
  larkScopeIndex: { get: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  effect: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn> };
}

/** 组装假 ctx（捕获注册的工具定义）。 */
function makeCtx(): { ctx: CapturedCtx; definitions: ToolDefinition[] } {
  const definitions: ToolDefinition[] = [];
  const ctx: CapturedCtx = {
    tools: {
      register: vi.fn((definition: ToolDefinition) => {
        definitions.push(definition);
        return () => undefined;
      }),
    },
    systemPrompt: { section: vi.fn() },
    knowledge: { retrieve: vi.fn(async () => []) },
    larkScopeIndex: { get: vi.fn(() => undefined) },
    on: vi.fn(() => () => undefined),
    effect: vi.fn(() => () => undefined),
    logger: { warn: vi.fn() },
  };
  return { ctx, definitions };
}

function register(config: Parameters<typeof apply>[1] = {}) {
  const { ctx, definitions } = makeCtx();
  apply(ctx as never, config);
  return { ctx, tool: definitions[0]! };
}

describe("dsh-tool-knowledge", () => {
  it("注册 knowledge_search：schema 只暴露 query（scope 无输入面）", () => {
    const { ctx, tool } = register();
    expect(tool.name).toBe("knowledge_search");
    const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: unknown };
    expect(Object.keys(parameters.properties ?? {})).toEqual(["query"]);
    expect(parameters.required).toContain("query");
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ name: "tool:knowledge_search" }));
  });

  it("非法配置在发布模型指引或注册工具前 fail loud", () => {
    const { ctx } = makeCtx();

    expect(() => apply(ctx as never, { topK: 0 })).toThrow(/topK/);
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled();
    expect(ctx.tools.register).not.toHaveBeenCalled();
  });

  it("执行：Scope 取自 agent → larkScopeIndex；引用先落盘再返回", async () => {
    const { ctx, tool } = register({ topK: 2 });
    const scope = { tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1" };
    ctx.larkScopeIndex.get.mockReturnValue(scope);
    ctx.knowledge.retrieve.mockResolvedValue([makeHit("11111111-1111-4111-8111-111111111111", "片段内容")]);
    const append = vi.fn();
    const exec = {
      agent: { id: "session-1", session: { append } },
    };

    const result = await tool.execute({ query: "  查询词  " }, exec as never);
    expect(ctx.knowledge.retrieve).toHaveBeenCalledWith(scope, "查询词", { topK: 2, candidateCount: 20, rerank: true });
    // 引用事件先落盘（模型可见 ⟺ 已落盘）。
    expect(append).toHaveBeenCalledWith("lark/knowledge/citations", {
      scope,
      citations: [{ source: "11111111-1111-4111-8111-111111111111", snippet: "片段内容", score: 0.9 }],
    });
    expect(result).toEqual({
      hits: [{
        docId: "11111111-1111-4111-8111-111111111111",
        documentKey: "notes.md",
        name: "notes.md",
        version: 1,
        visibility: "user_private",
        chunk: 0,
        text: "片段内容",
        score: 0.9,
      }],
    });
  });

  it("无命中不写 citations 事件；空结果非错误", async () => {
    const { ctx, tool } = register();
    ctx.larkScopeIndex.get.mockReturnValue({});
    ctx.knowledge.retrieve.mockResolvedValue([]);
    const append = vi.fn();
    const result = await tool.execute({ query: "x" }, { agent: { id: "s", session: { append } } } as never);
    expect(result).toEqual({ hits: [] });
    expect(append).not.toHaveBeenCalled();
  });

  it("无 agent / 无 lark Scope → fail loud（检索拒绝在无 Scope 下执行）", async () => {
    const { tool } = register();
    await expect(tool.execute({ query: "x" }, {} as never)).rejects.toThrow(/agent context/);

    const { ctx: scopedCtx, tool: scopedTool } = register();
    scopedCtx.larkScopeIndex.get.mockReturnValue(undefined);
    await expect(scopedTool.execute({ query: "x" }, { agent: { id: "s", session: { append: vi.fn() } } } as never))
      .rejects.toThrow(/lark run scope/);
  });

  it("query 空白拒绝；enabled=false 不注册", () => {
    void register();
    const { definitions } = makeCtx();
    apply({ tools: { register: vi.fn() }, systemPrompt: { section: vi.fn() } } as never, { enabled: false });
    expect(definitions).toHaveLength(0);
  });

  it("formatKnowledgeOutput：无结果文案 + 不可信证据指引", () => {
    expect(formatKnowledgeOutput(undefined)).toBe("No knowledge base results found.");
    expect(formatKnowledgeOutput({ hits: [] })).toBe("No knowledge base results found.");
    const text = formatKnowledgeOutput({ hits: [makeHit("11111111-1111-4111-8111-111111111111", "内容")] });
    expect(text).toContain("notes.md (v1");
    expect(text).toContain("untrusted evidence");
  });
});
