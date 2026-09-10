/**
 * dsh-lark-presets 插件入口（SPEC presets.md）。
 *
 * 模板目录装载与校验：presets/<name>/preset.json——schema 严格、
 * revision（内容 SHA-256）不符拒绝（篡改检测）、skills 必须与
 * trust-manifest 一致（越权模板部署前失败）、deny 未知工具名拒绝
 * （防拼写错误静默放行）。校验失败的模板跳过 + 告警，不阻止进程；
 * lark-run 配置的 presetId 缺失时由其 fail loud。
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { revisionOf, validatePreset } from "./validation.js";

export const name = "lark-presets";

export const inject = [];

export interface Preset {
  name: string;
  version: string;
  /** preset.json 内容的 SHA-256（生成器维护；不符 = 装载拒绝）。 */
  revision: string;
  identity?: { tenantId?: string; botId?: string; deploymentId?: string };
  profile?: "quick" | "standard" | "long";
  tools?: { deny?: string[] };
  skills?: string[];
  retrieval?: "auto" | "off";
  persona?: string;
}

export interface LarkPresets {
  resolve(name: string): Preset | undefined;
  list(): Preset[];
  /** trust-manifest 中全部受审技能名（运行期只做减法）。 */
  trustedSkillNames(): string[];
}

export interface Config {
  /** 模板根目录（默认 presets）。 */
  presetsRoot: string;
  /** 技能 trust-manifest 路径（默认 skills/trust-manifest.json；技能声明核对）。 */
  trustManifestPath?: string;
}

export const Config: z<Config> = z.object({
  presetsRoot: z.string().required(),
  trustManifestPath: z.string(),
});

interface PresetLoadInput {
  root: string;
  name: string;
  declaredSkills: Set<string>;
  warn(message: string): void;
}

async function readPresetEntries(root: string, warn: (message: string) => void): Promise<string[] | undefined> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    warn("lark-presets: 模板目录不可读（presetsRoot 不存在？），按空表装载");
    return undefined;
  }
}

async function loadPreset(input: PresetLoadInput): Promise<Preset | undefined> {
  const { root, name, declaredSkills, warn } = input;
  try {
    const content = await readFile(join(root, name, "preset.json"), "utf8");
    const result = validatePreset(JSON.parse(content) as unknown, revisionOf(content));
    if ("error" in result) {
      warn(`lark-presets: 模板 ${name} 拒绝（${result.error}）`);
      return undefined;
    }
    if (result.preset.name !== name) {
      warn(`lark-presets: 模板目录 ${name} 与 preset.name 不一致，拒绝`);
      return undefined;
    }
    if (result.preset.skills && !result.preset.skills.every((skill) => declaredSkills.has(skill))) {
      warn(`lark-presets: 模板 ${name} 声明的技能缺失或未在 trust-manifest，拒绝`);
      return undefined;
    }
    return result.preset;
  } catch (error) {
    warn(`lark-presets: 模板 ${name} 装载失败（${error instanceof Error ? error.message : "unknown"}）`);
    return undefined;
  }
}

/**
 * async apply：装载完成才激活（下游 lark-run 在装载期校验 presetId——
 * 依赖本行激活时模板表已就绪，避免启动竞态）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = resolve(config.presetsRoot);
  const manifestPath = config.trustManifestPath || "skills/trust-manifest.json";
  const presets = new Map<string, Preset>();
  const declaredSkills = await readManifestSkills(manifestPath, ctx);
  const entries = await readPresetEntries(root, (message) => ctx.logger.warn(message));
  if (!entries) {
    ctx.provide("larkPresets", {
      resolve: () => undefined,
      list: () => [],
      trustedSkillNames: () => [],
    });
    return;
  }
  for (const name of entries) {
    const preset = await loadPreset({
      root,
      name,
      declaredSkills,
      warn: (message) => ctx.logger.warn(message),
    });
    if (preset) presets.set(name, preset);
  }
  ctx.provide("larkPresets", {
    resolve: (name: string) => presets.get(name),
    list: () => [...presets.values()],
    trustedSkillNames: () => [...declaredSkills].sort(),
  });
}

/** 读取 trust-manifest 的技能名集合（缺失/损坏 = 空集——模板技能声明核对 fail closed）。 */
async function readManifestSkills(manifestPath: string, ctx: Context): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      skills?: Record<string, unknown>;
    };
    return new Set(Object.keys(manifest.skills ?? {}));
  } catch {
    ctx.logger.warn("lark-presets: trust-manifest 不可读，技能声明核对按缺失处理（fail closed）");
    return new Set();
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** bot 模板目录（worker 宿主面；lark-run 运行期应用）。 */
    larkPresets?: LarkPresets;
  }
}

export type { Config as PresetsConfig };
export { revisionOf, validatePreset } from "./validation.js";
