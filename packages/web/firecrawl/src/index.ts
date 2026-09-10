/**
 * dsh-web-firecrawl 插件入口：把 Firecrawl 接入 dsh-web，并以独立工具补足
 * map/crawl/screenshot。传输、wire 解析、工具注册各自单一归属，注册均随 Cordis
 * fiber 自动释放。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import type { WebFetchProvider, WebFetchRequest, WebFetchResult, WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";

import { createFirecrawlClient } from "./client.js";
import { resolveFirecrawlConfig } from "./config.js";
import { parseScrapeResponse, parseSearchResponse } from "./response.js";
import { registerFirecrawlTools } from "./tools.js";

export const name = "web-firecrawl";

export const inject = ["credentials", "web", "tools", "systemPrompt"];

export interface Config {
  /** 主 Firecrawl API Key 凭证引用（env 变量名；缺失 fail loud）。 */
  apiKeyEnv: string;
  /** 备用 key 凭证引用；值为逗号分隔的 key 列表，缺省不启用。 */
  apiKeyFallbacksEnv?: string;
  /** API base URL（默认 https://api.firecrawl.dev）。 */
  apiUrl?: string;
  /** 请求超时（默认 60s）。 */
  timeoutMs?: number;
  /** 是否注册 web_map / web_crawl / web_screenshot（默认 true）。 */
  enabledTools?: boolean;
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().required(),
  apiKeyFallbacksEnv: z.string(),
  apiUrl: z.string(),
  timeoutMs: z.number(),
  enabledTools: z.boolean(),
});

async function resolveApiKeys(ctx: Context, config: Config): Promise<string[]> {
  const primary = await ctx.credentials!.resolve(config.apiKeyEnv as CredentialRef);
  if (!primary?.value) {
    throw new Error(`web-firecrawl: 凭证引用未配置（${config.apiKeyEnv}）——密钥值绝不写入配置`);
  }
  if (!config.apiKeyFallbacksEnv) return [primary.value];
  const fallback = await ctx.credentials!.resolve(config.apiKeyFallbacksEnv as CredentialRef);
  const fallbackKeys = (fallback?.value ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (fallbackKeys.length === 0) return [primary.value];
  return [...new Set([primary.value, ...fallbackKeys])];
}

/** 加载 Provider 与可选工具；所有注册 disposer 归属当前 Cordis fiber。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { apiUrl, timeoutMs } = resolveFirecrawlConfig(config);
  const apiKeys = await resolveApiKeys(ctx, config);
  const client = createFirecrawlClient({ apiUrl, apiKeys, timeoutMs });
  const searchProvider: WebSearchProvider = {
    id: "firecrawl",
    available: () => true,
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      return parseSearchResponse(await client.post("/v1/search", {
        query: request.query,
        ...(request.maxResults ? { limit: request.maxResults } : {}),
      }, signal));
    },
  };
  const fetchProvider: WebFetchProvider = {
    id: "firecrawl",
    available: () => true,
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      return parseScrapeResponse(await client.post("/v1/scrape", { url: request.url, formats: ["markdown"] }, signal), request.url);
    },
  };

  ctx.effect(() => [
    ctx.web!.registerSearchProvider(searchProvider),
    ctx.web!.registerFetchProvider(fetchProvider),
  ], "web-firecrawl:providers");
  if (config.enabledTools !== false) ctx.effect(() => registerFirecrawlTools(ctx, client), "web-firecrawl:tools");
}
