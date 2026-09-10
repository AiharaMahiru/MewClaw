/** Firecrawl v1 响应的最小运行时校验与 dsh-web 归一化。 */
import type { WebFetchResult, WebSearchResult } from "@deepseek-ai/dsh-web";

const MAX_CONTENT_CHARS = 1_000_000;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function requireSuccess(input: unknown, operation: string): Record<string, unknown> {
  const record = asRecord(input);
  if (!record || record.success !== true) throw new Error(`Firecrawl ${operation} returned a failed response`);
  return record;
}

/** search 响应 wire 校验（缺字段容错；success!==true fail loud）。 */
export function parseSearchResponse(input: unknown): WebSearchResult {
  const data = requireSuccess(input, "search").data;
  if (!Array.isArray(data)) return { sources: [], truncated: false };
  const sources = data.flatMap((item) => {
    const entry = asRecord(item);
    if (!entry || typeof entry.url !== "string" || !entry.url) return [];
    return [{
      url: entry.url,
      ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
      ...(typeof entry.description === "string" && entry.description ? { snippet: entry.description } : {}),
      ...(typeof entry.publishedDate === "string" && entry.publishedDate ? { publishedAt: entry.publishedDate } : {}),
    }];
  });
  return { sources, truncated: false };
}

/** scrape 响应 wire 校验：markdown 内容、状态码、HTML 判定与长度截断。 */
export function parseScrapeResponse(input: unknown, requestUrl: string): WebFetchResult {
  const data = asRecord(requireSuccess(input, "scrape").data);
  const markdown = typeof data?.markdown === "string" ? data.markdown : "";
  const metadata = asRecord(data?.metadata);
  const statusCode = typeof metadata?.statusCode === "number" ? metadata.statusCode : 200;
  const isHtml = /<!(?:doctype html)|<html|<body/i.test(markdown);
  const truncated = markdown.length > MAX_CONTENT_CHARS || metadata?.truncated === true;
  const content = markdown.slice(0, MAX_CONTENT_CHARS);
  const sourceURL = typeof metadata?.sourceURL === "string" ? metadata.sourceURL : requestUrl;
  return { url: sourceURL, statusCode, body: isHtml ? { kind: "html", content } : { kind: "text", content }, truncated };
}

/** 截图 URL 是 Firecrawl 托管的短期外部产物，必须从成功 scrape 响应中取得。 */
export function parseScreenshotUrl(input: unknown): string {
  const data = asRecord(requireSuccess(input, "screenshot").data);
  const screenshot = typeof data?.screenshot === "string" ? data.screenshot.trim() : "";
  if (!screenshot) throw new Error("web_screenshot: Firecrawl did not return a screenshot URL");
  return screenshot;
}
