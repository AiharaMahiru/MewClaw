export interface ImageConfigInput {
  apiKeyEnv?: string;
  baseUrl?: string;
  maxReferenceBytes?: number;
  maxReferences?: number;
  model?: string;
}

export interface ResolvedImageConfig {
  apiKeyEnv: string;
  baseUrl: string;
  maxReferenceBytes: number;
  maxReferences: number;
  model: string;
}

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MAX_REFERENCE_BYTES = 10 * MEBIBYTE;
const MAX_REFERENCE_BYTES = 50 * MEBIBYTE;
const DEFAULT_MAX_REFERENCES = 8;
const MAX_REFERENCES = 16;
export const DEFAULT_IMAGE_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_IMAGE_BASE_URL = "https://api.openai.com";
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

function resolveInteger(value: number | undefined, field: string, fallback: number, maximum: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`lark-image: ${field} must be an integer in [1, ${maximum}]`);
  }
  return resolved;
}

function resolveBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_IMAGE_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("lark-image: baseUrl must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("lark-image: baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return candidate.replace(/\/+$/u, "");
}

function resolveModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_IMAGE_MODEL;
  if (!/^gpt-image-[A-Za-z0-9.-]+$/u.test(model)) {
    throw new Error("lark-image: model must be a GPT Image model");
  }
  return model;
}

/** 生图端点、凭证引用和参考图预算在插件装载时统一验证。 */
export function resolveImageConfig(input: ImageConfigInput): ResolvedImageConfig {
  const apiKeyEnv = input.apiKeyEnv?.trim() || DEFAULT_IMAGE_API_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new Error("lark-image: apiKeyEnv must be a credential reference name");
  }
  return {
    apiKeyEnv,
    baseUrl: resolveBaseUrl(input.baseUrl),
    maxReferenceBytes: resolveInteger(input.maxReferenceBytes, "maxReferenceBytes", DEFAULT_MAX_REFERENCE_BYTES, MAX_REFERENCE_BYTES),
    maxReferences: resolveInteger(input.maxReferences, "maxReferences", DEFAULT_MAX_REFERENCES, MAX_REFERENCES),
    model: resolveModel(input.model),
  };
}
