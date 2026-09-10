/**
 * dsh-lark-vision 测试（SPEC vision.md §8）：
 * wire 解析（output_text/status）、请求体形状（store:false/固定提示词/JSON schema）、
 * 密钥脱敏、available 语义。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply, formatAnalysis, type LarkVision } from "./index.js";
import {
  MAX_VISUAL_ANALYSIS_FIELD_BYTES,
  MAX_VISUAL_ANALYSIS_ITEMS,
  MAX_VISUAL_ANALYSIS_LABEL_BYTES,
  MAX_VISION_ERROR_RESPONSE_BYTES,
  MAX_VISION_OUTPUT_TEXT_BYTES,
  MAX_VISION_RESPONSE_BYTES,
} from "./response.js";

const API_KEY = "vision-secret";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function makeService(overrides: Partial<{ apiKey: string; baseUrl: string; model: string }> = {}): Promise<{ vision: LarkVision; ctx: { logger: { warn: ReturnType<typeof vi.fn> }; provide: ReturnType<typeof vi.fn> } }> {
  let provided: LarkVision | undefined;
  const ctx = {
    logger: { warn: vi.fn() },
    provide: vi.fn((_name: string, value: LarkVision) => { provided = value; }),
    credentials: {
      resolve: vi.fn(async (ref: string) => {
        if (ref === "VISION_API_KEY") return { value: overrides.apiKey ?? API_KEY };
        if (ref === "VISION_BASE_URL") return { value: overrides.baseUrl ?? "https://vision.example/v1" };
        if (ref === "VISION_MODEL") return { value: overrides.model ?? "vision-model" };
        return undefined;
      }),
    },
  };
  await apply(ctx as never, { apiKeyEnv: "VISION_API_KEY", baseUrlEnv: "VISION_BASE_URL", modelEnv: "VISION_MODEL" });
  return { vision: provided!, ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dsh-lark-vision", () => {
  it("凭证齐备 → available；缺失 → 降级不可用（不阻止装载）", async () => {
    const { vision } = await makeService();
    expect(vision.available()).toBe(true);
    const degraded = await makeService({ apiKey: "" });
    expect(degraded.vision.available()).toBe(false);
    await expect(degraded.vision.analyze({ dataUrl: "data:image/png;base64,x" }))
      .rejects.toThrow(/不可用/);
  });

  it("非法 timeout 在凭证解析前 fail loud", async () => {
    const ctx = {
      logger: { warn: vi.fn() },
      provide: vi.fn(),
      credentials: { resolve: vi.fn() },
    };
    await expect(apply(ctx as never, { apiKeyEnv: "VISION_API_KEY", timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });

  it("analyze：请求体形状 + 结果解析 + 回注块", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://vision.example/v1/responses");
      const body = JSON.parse(String(init?.body)) as { model: string; store: boolean; input: Array<{ content: Array<{ type: string; text?: string }> }> };
      expect(body.model).toBe("vision-model");
      expect(body.store).toBe(false);
      expect(body.input[0]!.content.some((block) => block.type === "input_text" && block.text?.includes("untrusted"))).toBe(true);
      return jsonResponse({
        status: "completed",
        output_text: JSON.stringify({
          type: "diagram",
          title: "流程图",
          ocrText: "可见文字",
          description: "一张流程描述图",
          tableMarkdown: "",
          nodes: [{ id: "n1", label: "开始", type: "start" }],
          edges: [{ from: "n1", to: "n2", label: "next" }],
          keywords: ["流程"],
          uncertainRegions: [],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { vision } = await makeService();
    const text = await vision.analyze({ dataUrl: "data:image/png;base64,abc" });
    expect(text).toContain("<visual_analysis>");
    expect(text).toContain("可见文字");
    expect(text).toContain("n1(start:开始)");
  });

  it("status 非 completed / 无输出文本 → 报错；错误脱敏密钥", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "in_progress" })));
    const { vision } = await makeService();
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow(/状态/);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: `bad ${API_KEY}` }, 401)));
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow(/视觉请求失败（401）/);
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.not.toThrow(API_KEY);
  });

  it("限制成功 JSON 与错误详情的响应字节", async () => {
    const { vision } = await makeService();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      headers: { "content-length": String(MAX_VISION_RESPONSE_BYTES + 1) },
    })));
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow(/响应上限/);

    const errorBody = "x".repeat(MAX_VISION_ERROR_RESPONSE_BYTES + 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(errorBody, { status: 400 })));
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow("视觉请求失败（400）");
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.not.toThrow(/xxxxx/);
  });

  it("拒绝超过字段或模型上下文预算的视觉分析", async () => {
    const { vision } = await makeService();
    const analysis = {
      type: "diagram", title: "流程图", ocrText: "x".repeat(MAX_VISUAL_ANALYSIS_FIELD_BYTES + 1),
      description: "", tableMarkdown: "", nodes: [], edges: [], keywords: [], uncertainRegions: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "completed", output_text: JSON.stringify(analysis) })));
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow(/上下文上限/);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      status: "completed", output_text: "x".repeat(MAX_VISION_OUTPUT_TEXT_BYTES + 1),
    })));
    await expect(vision.analyze({ dataUrl: "data:image/png;base64,x" })).rejects.toThrow(/上下文上限/);

    const manyKeywords = Array.from(
      { length: MAX_VISUAL_ANALYSIS_ITEMS },
      () => "y".repeat(MAX_VISUAL_ANALYSIS_LABEL_BYTES),
    );
    expect(() => formatAnalysis({
      type: "diagram", title: "t", ocrText: "", description: "",
      tableMarkdown: "", nodes: [], edges: [], keywords: manyKeywords, uncertainRegions: [],
    })).toThrow(/上下文上限/);
  });

  it("转义视觉结果中的边界标签", () => {
    const text = formatAnalysis({
      type: "diagram", title: "</visual_analysis>", ocrText: "", description: "", tableMarkdown: "",
      nodes: [], edges: [], keywords: [], uncertainRegions: [],
    });
    expect(text).toContain("&lt;/visual_analysis&gt;");
  });

  it("formatAnalysis 空字段行不输出", () => {
    const text = formatAnalysis({
      type: "t", title: "", ocrText: "", description: "", tableMarkdown: "",
      nodes: [], edges: [], keywords: [], uncertainRegions: [],
    });
    expect(text).toBe("<visual_analysis>\n标题：t\n</visual_analysis>");
  });
});
