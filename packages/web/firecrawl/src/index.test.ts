/**
 * dsh-web-firecrawl 测试（SPEC web-firecrawl.md §8）：
 * wire 解析、429 重试、密钥脱敏、装载期凭证缺失 fail loud。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebFetchProvider, WebSearchProvider } from "@deepseek-ai/dsh-web";
import { apply } from "./index.js";
const API_KEY = "fc-test-secret";
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
const FALLBACK_KEYS = ["fc-key-b", "fc-key-c"];
interface RegisteredTool {
  name: string;
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>;
}
/** 组装插件：mock credentials + 捕获注册的 provider 与工具。 */
async function makeProviders(options: { fallbacks?: boolean; emptyFallback?: boolean } = {}): Promise<{
  search: WebSearchProvider;
  fetch: WebFetchProvider;
  tools: RegisteredTool[];
  ctx: { effect: ReturnType<typeof vi.fn>; systemPrompt: { section: ReturnType<typeof vi.fn> } };
}> {
  const searchProviders: WebSearchProvider[] = [];
  const fetchProviders: WebFetchProvider[] = [];
  const tools: RegisteredTool[] = [];
  const ctx = {
    credentials: {
      resolve: vi.fn(async (reference: string) => {
        if (reference === "FIRECRAWL_API_KEY") return { value: API_KEY };
        return { value: options.emptyFallback ? "" : FALLBACK_KEYS.join(",") };
      }),
    },
    web: {
      registerSearchProvider: vi.fn((provider: WebSearchProvider) => { searchProviders.push(provider); }),
      registerFetchProvider: vi.fn((provider: WebFetchProvider) => { fetchProviders.push(provider); }),
    },
    tools: { register: vi.fn((definition: RegisteredTool) => { tools.push(definition); return () => undefined; }) },
    systemPrompt: { section: vi.fn() },
    effect: vi.fn((run: () => unknown) => { run(); return () => undefined; }),
  };
  await apply(ctx as never, {
    apiKeyEnv: "FIRECRAWL_API_KEY",
    ...(options.fallbacks || options.emptyFallback ? { apiKeyFallbacksEnv: "FIRECRAWL_API_KEY_FALLBACKS" } : {}),
  });
  return { search: searchProviders[0]!, fetch: fetchProviders[0]!, tools, ctx };
}
/** 请求的 Authorization key（按调用序）。 */
function usedKeys(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(((call[1] as RequestInit).headers as Record<string, string>).authorization));
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("dsh-web-firecrawl", () => {
  it("凭证缺失 → 装载期 fail loud", async () => {
    const ctx = {
      credentials: { resolve: vi.fn(async () => undefined) },
      web: { registerSearchProvider: vi.fn(), registerFetchProvider: vi.fn() },
    };
    await expect(apply(ctx as never, { apiKeyEnv: "FIRECRAWL_API_KEY" }))
      .rejects.toThrow(/凭证引用未配置/);
  });
  it("非法 Provider 配置在凭证解析前 fail loud", async () => {
    const resolve = vi.fn(async () => ({ value: API_KEY }));
    const ctx = {
      credentials: { resolve },
      web: { registerSearchProvider: vi.fn(), registerFetchProvider: vi.fn() },
    };
    await expect(apply(ctx as never, { apiKeyEnv: "FIRECRAWL_API_KEY", timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs/);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("search：wire 映射（title/description/publishedDate → WebSearchSource）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      success: true,
      data: [
        { url: "https://a.example", title: "A", description: "摘要A", publishedDate: "2026-08-01" },
        { url: "https://b.example", title: "B" },
      ],
    })));
    const { search } = await makeProviders();
    const result = await search.search({ query: "q", maxResults: 5 });
    expect(result).toEqual({
      sources: [
        { url: "https://a.example", title: "A", snippet: "摘要A", publishedAt: "2026-08-01" },
        { url: "https://b.example", title: "B" },
      ],
      truncated: false,
    });
  });
  it("search：success=false 报错；429 退避重试后成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) return jsonResponse({ success: false, error: "rate limited" }, 429);
      return jsonResponse({ success: true, data: [{ url: "https://ok.example" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { search } = await makeProviders();
    const promise = search.search({ query: "q" });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result.sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("错误信息脱敏密钥（非重试状态不重试）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: `bad key ${API_KEY}` }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const { search } = await makeProviders();
    await expect(search.search({ query: "q" })).rejects.toThrow(/Firecrawl request failed \(400\)/);
    await expect(search.search({ query: "q" })).rejects.not.toThrow(API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 两条各 1 次，无重试
  });
  it("fetch：scrape markdown → WebFetchResult（状态码与 HTML 判定）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      success: true,
      data: {
        markdown: "# 页面内容",
        metadata: { statusCode: 200, sourceURL: "https://final.example" },
      },
    })));
    const { fetch: fetchProvider } = await makeProviders();
    const result = await fetchProvider.fetch({ url: "https://page.example" });
    expect(result).toEqual({
      url: "https://final.example",
      statusCode: 200,
      body: { kind: "text", content: "# 页面内容" },
      truncated: false,
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      success: true,
      data: { markdown: "<html><body>hi</body></html>", metadata: { statusCode: 404 } },
    })));
    const html = await fetchProvider.fetch({ url: "https://page.example" });
    expect(html.body).toEqual({ kind: "html", content: "<html><body>hi</body></html>" });
    expect(html.statusCode).toBe(404);
  });
  it("fetch：success=false → fail loud，不伪造空页面", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false, error: "upstream failed" })));
    const { fetch: fetchProvider } = await makeProviders();
    await expect(fetchProvider.fetch({ url: "https://page.example" })).rejects.toThrow(/scrape returned a failed response/);
  });
});
describe("dsh-web-firecrawl · 多 key 轮换（SPEC §8a）", () => {
  it("429 换 key 成功，成功后游标轮转到下一把", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string> | undefined)?.authorization);
      if (key === `Bearer ${API_KEY}`) return jsonResponse({ success: false, error: "quota" }, 429);
      return jsonResponse({ success: true, data: [{ url: "https://ok.example" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { search } = await makeProviders({ fallbacks: true });
    const first = await search.search({ query: "q" });
    expect(first.sources).toHaveLength(1);
    // 第二次请求从轮转游标（fc-key-c）直接出发。
    await search.search({ query: "q2" });
    expect(usedKeys(fetchMock)).toEqual([
      `Bearer ${API_KEY}`, "Bearer fc-key-b", "Bearer fc-key-c",
    ]);
  });

  it("全池 429 → 报错（key rejected，不再无限退避）", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false }, 429)));
    const { search } = await makeProviders({ fallbacks: true });
    const rejected = expect(search.search({ query: "q" })).rejects.toThrow(/key rejected \(429\)/);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
  });

  it("备用 key 环境值为空时只使用主 key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, data: [{ url: "https://ok.example" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const { search } = await makeProviders({ emptyFallback: true });
    await expect(search.search({ query: "q" })).resolves.toMatchObject({
      sources: [{ url: "https://ok.example" }],
    });
    expect(usedKeys(fetchMock)).toEqual([`Bearer ${API_KEY}`]);
  });
});

describe("dsh-web-firecrawl · web_map / web_crawl 工具", () => {
  it("web_map：透传 search/includeSubdomains 并返回链接清单", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, links: ["https://s.example/a", "https://s.example/b", 42] }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tools } = await makeProviders();
    const map = tools.find((tool) => tool.name === "web_map");
    expect(map).toBeDefined();
    expect(ctx.effect).toHaveBeenCalledTimes(2);
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/web_screenshot.*credits/),
    }));
    const result = await map!.execute({
      url: "https://s.example",
      limit: 3,
      search: "docs",
      includeSubdomains: true,
    }, { signal: new AbortController().signal }) as { links: string[] };
    expect(result.links).toEqual(["https://s.example/a", "https://s.example/b"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      url: "https://s.example",
      limit: 3,
      search: "docs",
      includeSubdomains: true,
    });
  });

  it("web_map：success=false → fail loud", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false })));
    const { tools } = await makeProviders();
    const map = tools.find((tool) => tool.name === "web_map")!;
    await expect(map.execute({ url: "https://s.example" }, { signal: new AbortController().signal })).rejects.toThrow(/map returned a failed response/);
  });

  it("web_crawl：任务轮询到 completed 后返回页面摘要", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const path = String(input);
      if (path.endsWith("/v1/crawl")) return jsonResponse({ success: true, id: "job-1" });
      // 轮询第一次 running、第二次 completed。
      if (calls === 2) return jsonResponse({ success: true, status: "running" });
      return jsonResponse({
        success: true,
        status: "completed",
        data: [{ markdown: "# 首页", metadata: { sourceURL: "https://s.example/" } }],
      });
    }));
    const { tools } = await makeProviders();
    const crawl = tools.find((tool) => tool.name === "web_crawl");
    const promise = crawl!.execute({ url: "https://s.example" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise as { pages: Array<{ url: string }> };
    expect(result.pages).toEqual([{ url: "https://s.example/", excerpt: "# 首页" }]);
  });

  it("web_crawl：透传 includePaths/excludePaths，failed/cancelled 立即失败", async () => {
    vi.useFakeTimers();
    let status: "failed" | "cancelled" = "failed";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/v1/crawl")) return jsonResponse({ success: true, id: "job-fail" });
      return jsonResponse({ success: true, status });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { tools } = await makeProviders();
    const crawl = tools.find((tool) => tool.name === "web_crawl")!;
    const failedPromise = crawl.execute({
      url: "https://s.example",
      includePaths: ["/docs/.*"],
      excludePaths: ["/private/.*"],
    }, { signal: new AbortController().signal });
    const failed = expect(failedPromise).rejects.toThrow(/failed/);
    await vi.advanceTimersByTimeAsync(3_000);
    await failed;
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      includePaths: ["/docs/.*"],
      excludePaths: ["/private/.*"],
    });

    status = "cancelled";
    const cancelledPromise = crawl.execute({ url: "https://s.example" }, { signal: new AbortController().signal });
    const cancelled = expect(cancelledPromise).rejects.toThrow(/cancelled/);
    await vi.advanceTimersByTimeAsync(3_000);
    await cancelled;
  });

  it("web_crawl：截图工具返回约 24 小时有效的 URL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: true,
      data: { screenshot: "https://cdn.example/shot.png" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { tools } = await makeProviders();
    const screenshot = tools.find((tool) => tool.name === "web_screenshot");
    expect(screenshot).toBeDefined();
    const result = await screenshot!.execute({ url: "https://s.example" }, { signal: new AbortController().signal });
    expect(result).toEqual({ url: "https://cdn.example/shot.png", expiresIn: "约 24 小时" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://s.example", formats: ["screenshot"] });
  });

  it("web_crawl：轮询沿用启动任务实际使用的 key", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const auth = String((init?.headers as Record<string, string>).authorization);
      if (path.endsWith("/v1/crawl") && auth === "Bearer " + API_KEY) return jsonResponse({ success: false }, 429);
      if (path.endsWith("/v1/crawl")) return jsonResponse({ success: true, id: "job-key" });
      if (auth !== "Bearer fc-key-b") return jsonResponse({ success: false, status: "failed" });
      return jsonResponse({ success: true, status: "completed", data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { tools } = await makeProviders({ fallbacks: true });
    const crawl = tools.find((tool) => tool.name === "web_crawl")!;
    const promise = crawl.execute({ url: "https://s.example" }, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toEqual({ pages: [] });
    expect(usedKeys(fetchMock)).toEqual([`Bearer ${API_KEY}`, "Bearer fc-key-b", "Bearer fc-key-b"]);
  });
});
