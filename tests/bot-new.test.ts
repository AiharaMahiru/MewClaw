/**
 * bot:new 生成器 e2e（SPEC presets.md §6）：创建模板（revision 规范）、
 * 拒绝覆盖、--revision 重算、装载校验一致性。
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { revisionOf, validatePreset } from "../packages/lark/presets/src/index.js";

const SCRIPT = "scripts/bot-new.mjs";
const TEST_NAME = "test-bot-round15";

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
  });
}

afterAll(async () => {
  await rm(join("presets", TEST_NAME), { recursive: true, force: true });
});

describe("bot:new 生成器", () => {
  it("创建模板（revision 规范）+ 装载校验一致 + 拒绝覆盖", async () => {
    const created = await runScript([TEST_NAME, "--template", "coding-assistant"]);
    expect(created.code).toBe(0);

    const content = await readFile(join("presets", TEST_NAME, "preset.json"), "utf8");
    const parsed = JSON.parse(content) as { name: string; revision: string; tools?: { deny?: string[] } };
    expect(parsed.name).toBe(TEST_NAME);
    expect(parsed.tools?.deny).toContain("knowledge_search"); // 参考模板继承。

    // 装载校验一致（生成器产物可直接通过插件校验）。
    expect(validatePreset(parsed, revisionOf(content))).toMatchObject({ preset: { name: TEST_NAME } });

    // 覆盖拒绝。
    const again = await runScript([TEST_NAME, "--template", "knowledge-assistant"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("已存在");
  });

  it("--revision 重算后仍通过校验（变更 → 重算 → 一致）", async () => {
    const path = join("presets", TEST_NAME, "preset.json");
    const before = JSON.parse(await readFile(path, "utf8")) as { revision: string };
    // 先改内容（persona），再重算——修订号必须变化。
    const { writeFile } = await import("node:fs/promises");
    const changed = { ...before, persona: "round15 测试模板" };
    await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    const revised = await runScript(["--revision", TEST_NAME]);
    expect(revised.code).toBe(0);

    const after = JSON.parse(await readFile(path, "utf8")) as { revision: string };
    expect(after.revision).not.toBe(before.revision);
    expect(validatePreset(after, revisionOf(await readFile(path, "utf8")))).toMatchObject({
      preset: { name: TEST_NAME },
    });
  });
});
