import {
  MAX_GENERATED_IMAGE_BASE64_CHARS,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_ERROR_DETAIL_CHARS,
  MAX_IMAGE_ERROR_RESPONSE_BYTES,
  readImageJson,
  readImageText,
} from "./response.js";

/**
 * OpenAI 兼容 images 客户端（lark-claw generate-image 核心 wire 语义平移）：
 * 无参考图 POST /v1/images/generations（JSON），有参考图 POST /v1/images/edits
 * （multipart）。响应 b64 解码后校验 PNG 魔数；错误信息脱敏 key 与 base URL。
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class ImageApiError extends Error {
  readonly retryable: boolean;
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ImageApiError";
    this.retryable = status === 429 || (status !== undefined && status >= 500);
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPENAI_KEY_PATTERN = /(^|[^A-Za-z0-9_*.-])(sk-[A-Za-z0-9_*.-]{8,})/giu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+*/=-]{8,}/giu;

function redact(text: string, config: ImageClientConfig): string {
  return text
    .replaceAll(config.apiKey, "[REDACTED]")
    .replaceAll(config.baseUrl, "[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "$1[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
}

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot).toLowerCase();
  return IMAGE_MIME_TYPES[extension] ?? "application/octet-stream";
}

function endpoint(baseUrl: string, route: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = base.endsWith("/v1") ? "" : "/v1";
  return `${base}${prefix}/images/${route}`;
}

export function decodePng(encoded: string, config: ImageClientConfig): Buffer {
  if (encoded.length > MAX_GENERATED_IMAGE_BASE64_CHARS || !BASE64_PATTERN.test(encoded)) {
    throw new ImageApiError(redact("图片 API 返回的 base64 数据非法或超过交付物上限", config));
  }
  const png = Buffer.from(encoded, "base64");
  if (png.length === 0 || png.length > MAX_GENERATED_IMAGE_BYTES || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new ImageApiError(redact("图片 API 返回的数据不是 PNG 或超过交付物上限", config));
  }
  return png;
}

/** 参考图载荷（调用方已完成工作区包含校验）。 */
export interface ReferenceImage {
  /** 绝对路径。 */
  path: string;
  /** 展示名（工作区相对，正斜杠）。 */
  relativePath: string;
}

/**
 * 生成一张 PNG：references 空 → generations；非空 → edits（参考图注入提示
 * 由调用方预先并入 prompt）。fetch 可注入（测试）。
 */
export async function requestImage(
  config: ImageClientConfig,
  prompt: string,
  references: ReferenceImage[],
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const route = references.length > 0 ? "edits" : "generations";
  let body: BodyInit;
  const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` };
  if (route === "edits") {
    const form = new FormData();
    for (const reference of references) {
      let buffer: Buffer;
      try {
        buffer = await (await import("node:fs/promises")).readFile(reference.path);
      } catch {
        throw new ImageApiError(`参考图无法读取：${reference.relativePath}`);
      }
      form.append("image[]", new Blob([new Uint8Array(buffer)], { type: mimeForPath(reference.path) }), reference.relativePath.replaceAll("/", "_"));
    }
    form.append("model", config.model);
    form.append("output_format", "png");
    form.append("prompt", prompt);
    body = form;
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ model: config.model, prompt, output_format: "png" });
  }
  let response: Response;
  try {
    response = await fetchImpl(endpoint(config.baseUrl, route), { method: "POST", headers, body });
  } catch (error) {
    throw new ImageApiError(redact(`图片请求失败：${error instanceof Error ? error.message : "unknown"}`, config));
  }
  if (!response.ok) {
    const detail = (await readImageText(response, MAX_IMAGE_ERROR_RESPONSE_BYTES).catch(() => ""))
      .slice(0, MAX_IMAGE_ERROR_DETAIL_CHARS);
    const hint = response.status === 429 || response.status >= 500
      ? "（上游暂时失败，可稍后使用相同提示词重试；不是已确认的提示词问题）" : "";
    throw new ImageApiError(redact(`图片 API 错误 ${response.status}：${detail}${hint}`, config), response.status);
  }
  let payload: { data?: Array<{ b64_json?: unknown }> } | undefined;
  try {
    payload = await readImageJson(response) as { data?: Array<{ b64_json?: unknown }> };
  } catch {
    throw new ImageApiError(redact("图片 API 返回的 JSON 非法或超过响应上限", config));
  }
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new ImageApiError(redact("图片 API 未返回 base64 数据", config));
  }
  return decodePng(encoded, config);
}
