/**
 * dsh-lark-image 插件入口（SPEC image.md）。
 *
 * 生图/改图能力缝（Definition + Provider）：ctx.larkImage.generate ——
 * 参考图工作区包含校验（realpath 前缀 + symlink 拒绝）→ OpenAI 兼容 images
 * API（generations/edits）→ PNG 魔数校验 → 写工作区顶层 generated-<uuid>.png
 * （R-06 产物收集自动产生 📎 产物行）。
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { scopeKey, type Scope } from "dsh-lark-contracts";

import { requestImage, type ImageClientConfig, type ReferenceImage } from "./client.js";
import { resolveImageConfig } from "./config.js";

export { ImageApiError, requestImage } from "./client.js";
export type { FetchLike, ImageClientConfig, ReferenceImage } from "./client.js";

export const name = "lark-image";

export const inject = ["credentials"];

export interface Config {
  /** OpenAI Image API base URL；非敏感配置，默认官方端点。 */
  baseUrl?: string;
  /** OpenAI API Key 凭证引用，默认 OPENAI_API_KEY。 */
  apiKeyEnv?: string;
  /** GPT Image 模型名，默认 gpt-image-2。 */
  model?: string;
  /** 工作区根（与 lark-run 的 workspaceRoot 一致；工作区派生规则相同）。 */
  workspaceRoot: string;
  /** 参考图单张字节上限（默认 10 MiB）。 */
  maxReferenceBytes?: number;
  /** 单次参考图上限（默认 8，允许 1..16）。 */
  maxReferences?: number;
}

export const Config: z<Config> = z.object({
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  model: z.string(),
  workspaceRoot: z.string().required(),
  maxReferenceBytes: z.number(),
  maxReferences: z.number(),
});

const MAX_PROMPT_CHARS = 4_000;

/** 生成结果。 */
export interface GeneratedImage {
  /** 工作区相对路径（正斜杠）。 */
  path: string;
  bytes: number;
}

/** 服务契约（ctx.larkImage）。 */
export interface LarkImageService {
  generate(input: {
    scope: Scope;
    /** Web 共享会话的实际工作目录；省略时按飞书 Scope 派生。 */
    workspace?: string;
    prompt: string;
    /** 工作区相对路径（数量由 Provider 配置控制，默认 8）。 */
    references?: string[];
  }): Promise<GeneratedImage>;
}

async function resolveWorkspace(root: string, scope: Scope, requested?: string): Promise<string> {
  const configuredRoot = resolve(root);
  const candidate = resolve(requested ?? resolve(configuredRoot, scopeKey(scope)));
  if (!isWithinWorkspace(configuredRoot, candidate)) throw new Error("生图工作区越出配置根");
  await mkdir(configuredRoot, { recursive: true });
  await mkdir(candidate, { recursive: true });
  const [realRoot, realCandidate] = await Promise.all([realpath(configuredRoot), realpath(candidate)]);
  if (!isWithinWorkspace(realRoot, realCandidate)) throw new Error("生图工作区真实路径越出配置根");
  return realCandidate;
}

/** 跨平台 realpath 包含判断：统一分隔符，Windows 路径按大小写不敏感比较。 */
export function isWithinWorkspace(workspace: string, target: string): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
      ? normalized.toLowerCase()
      : normalized;
  };
  const root = normalize(workspace);
  const candidate = normalize(target);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** 参考图校验：存在、常规文件、在真实工作区内（realpath 前缀）、大小上限。 */
async function resolveReference(workspace: string, relative: string, maxBytes: number): Promise<ReferenceImage> {
  const clean = relative.replaceAll("\\", "/").replace(/^\/+/, "");
  if (clean.length === 0 || clean.includes("..") || clean.startsWith(".")) {
    throw new Error(`参考图路径非法：${relative}`);
  }
  const absolute = resolve(workspace, clean);
  const realWorkspace = await realpath(workspace);
  let realPath: string;
  try {
    realPath = await realpath(absolute);
  } catch {
    throw new Error(`参考图不存在：${clean}`);
  }
  if (!isWithinWorkspace(realWorkspace, realPath)) {
    throw new Error(`参考图越出工作区：${clean}`);
  }
  const metadata = await lstat(realPath);
  if (!metadata.isFile()) throw new Error(`参考图不是常规文件：${clean}`);
  if (metadata.size > maxBytes) throw new Error(`参考图超过字节上限：${clean}`);
  return { path: realPath, relativePath: clean };
}

/** 参考图按“图N”编号，显式固定主图与角色映射语义。 */
function editPrompt(prompt: string, references: ReferenceImage[]): string {
  const list = references
    .map((reference, index) => `- 图${index + 1}（${reference.relativePath}）`)
    .join("\n");
  return [
    prompt,
    "",
    "参考图角色映射（按输入顺序）：",
    list,
    "",
    "请使用“图N”引用对应素材；图1优先作为构图主图，其余图片按人物、风格、姿态或细节角色融合。",
  ].join("\n");
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveImageConfig(config);
  const { maxReferenceBytes, maxReferences } = resolved;

  const service: LarkImageService = {
    async generate(input) {
      const prompt = input.prompt.trim();
      if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`prompt 必须为 1..${MAX_PROMPT_CHARS} 字符`);
      }
      if ((input.references?.length ?? 0) > maxReferences) {
        throw new Error(`参考图最多 ${maxReferences} 张`);
      }
      const workspace = await resolveWorkspace(config.workspaceRoot, input.scope, input.workspace);
      const references = input.references
        ? await Promise.all(input.references.map((item) => resolveReference(workspace, item, maxReferenceBytes)))
        : [];

      const clientConfig: ImageClientConfig = {
        baseUrl: resolved.baseUrl,
        apiKey: (await ctx.credentials!.resolve(resolved.apiKeyEnv as CredentialRef))?.value ?? "",
        model: resolved.model,
      };
      if (!clientConfig.apiKey) {
        throw new Error(`lark-image: 凭证引用未配置（${resolved.apiKeyEnv}）`);
      }

      const png = await requestImage(clientConfig, references.length > 0 ? editPrompt(prompt, references) : prompt, references);
      const name = `generated-${randomUUID()}.png`;
      await writeFile(resolve(workspace, name), png);
      const metadata = await stat(resolve(workspace, name));
      return { path: name, bytes: metadata.size };
    },
  };
  ctx.provide("larkImage", service);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 生图/改图能力缝（worker 宿主面）。 */
    larkImage?: LarkImageService;
  }
}
