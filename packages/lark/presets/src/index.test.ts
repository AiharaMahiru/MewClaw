/**
 * dsh-lark-presets 测试（SPEC presets.md §8）：
 * 校验（schema/未知键/revision 不符/技能声明/目录一致性）、装载（拒绝模板跳过）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apply, revisionOf, validatePreset, type LarkPresets } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-lark-presets-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 规范文件内容（revision = 排除 revision 字段的哈希；与生成器同算法）。 */
function makeFile(overrides: Record<string, unknown> = {}): { content: string; parsed: Record<string, unknown> } {
  const parsed: Record<string, unknown> = {
    name: "demo",
    version: "1.0.0",
    ...overrides,
  };
  const { revision: _revision, ...canonical } = parsed;
  void _revision;
  const revision = revisionOf(`${JSON.stringify(canonical, null, 2)}\n`);
  parsed.revision = revision;
  return { content: `${JSON.stringify(parsed, null, 2)}\n`, parsed };
}

async function writePreset(name: string, content: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "preset.json"), content, "utf8");
}

async function load(presetsRoot = root): Promise<{ presets: LarkPresets; ctx: { logger: { warn: ReturnType<typeof vi.fn> }; provide: ReturnType<typeof vi.fn> } }> {
  let provided: LarkPresets | undefined;
  const ctx = {
    logger: { warn: vi.fn() },
    provide: vi.fn((_name: string, value: LarkPresets) => { provided = value; }),
  };
  apply(ctx as never, { presetsRoot });
  for (let attempt = 0; attempt < 50 && !provided; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { presets: provided!, ctx };
}

describe("validatePreset", () => {
  it("合法模板通过（revision 与内容一致）", () => {
    const { content, parsed } = makeFile();
    expect(validatePreset(parsed, revisionOf(content))).toMatchObject({ preset: { name: "demo" } });
  });

  it("未知键/非法名/非法 revision 拒绝", () => {
    expect(validatePreset({ ...makeFile().parsed, extra: 1 }, undefined)).toMatchObject({ error: expect.stringContaining("未知字段") });
    expect(validatePreset({ ...makeFile().parsed, name: "Bad Name" }, undefined)).toMatchObject({ error: expect.stringContaining("name") });
    expect(validatePreset({ ...makeFile().parsed, revision: "xyz" }, undefined)).toMatchObject({ error: expect.stringContaining("revision") });
  });

  it("revision 与内容不符拒绝（篡改检测）", () => {
    const { content, parsed } = makeFile();
    expect(validatePreset(parsed, revisionOf(content))).toMatchObject({ preset: expect.anything() });
    // 篡改内容（加 persona）但保留旧 revision → 拒绝。
    const tampered = { ...parsed, persona: "注入" };
    const tamperedContent = `${JSON.stringify(tampered, null, 2)}\n`;
    expect(validatePreset(tampered, revisionOf(tamperedContent))).toMatchObject({ error: expect.stringContaining("revision") });
  });

  it("非法 profile/retrieval/deny 类型拒绝", () => {
    expect(validatePreset({ ...makeFile().parsed, profile: "turbo" }, undefined)).toMatchObject({ error: expect.stringContaining("profile") });
    expect(validatePreset({ ...makeFile().parsed, retrieval: "maybe" }, undefined)).toMatchObject({ error: expect.stringContaining("retrieval") });
    expect(validatePreset({ ...makeFile().parsed, tools: { deny: [1] } }, undefined)).toMatchObject({ error: expect.stringContaining("tools") });
    expect(validatePreset({ ...makeFile().parsed, skills: "rag" }, undefined)).toMatchObject({ error: expect.stringContaining("skills") });
  });
});

describe("apply（装载）", () => {
  it("合法模板装载；目录名与 preset.name 不一致拒绝", async () => {
    await writePreset("demo", makeFile().content);
    await writePreset("mismatch", makeFile({ name: "other" }).content);
    const { presets } = await load();
    expect(presets.resolve("demo")?.name).toBe("demo");
    expect(presets.resolve("mismatch")).toBeUndefined();
    expect(presets.list()).toHaveLength(1);
  });

  it("暴露 trust-manifest 的完整受审技能名，供运行期做 preset 减法", async () => {
    const manifestPath = join(root, "trust-manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      skills: { "lark-rag": {}, "lark-web": {} },
    }), "utf8");
    await writePreset("demo", makeFile({ skills: ["lark-rag"] }).content);
    let provided: LarkPresets | undefined;
    const ctx = { logger: { warn: vi.fn() }, provide: vi.fn((_name: string, value: LarkPresets) => { provided = value; }) };
    await apply(ctx as never, { presetsRoot: root, trustManifestPath: manifestPath });
    expect(provided?.trustedSkillNames()).toEqual(["lark-rag", "lark-web"]);
  });

  it("revision 不符 / 技能声明缺失 → 模板拒绝（跳过 + 告警）", async () => {
    // revision 不符（篡改后未重算）。
    const { content, parsed } = makeFile();
    await writePreset("bad-rev", `${JSON.stringify({ ...parsed, persona: "x" }, null, 2)}\n`);
    // 技能声明缺失（trust-manifest 不可读 → 空集 → 拒绝）。
    const skillContent = makeFile({ skills: ["ghost-skill"] });
    await writePreset("bad-skill", skillContent.content);
    const { presets, ctx } = await load();
    expect(presets.list()).toHaveLength(0);
    expect(ctx.logger.warn).toHaveBeenCalled();
    void content;
  });

  it("模板目录不可读 → 空表（不崩溃）", async () => {
    const { presets } = await load(join(root, "missing"));
    expect(presets.list()).toHaveLength(0);
  });
});
