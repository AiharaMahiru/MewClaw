/** 使用安装版本的官方 schema 校验自有配置，避免字符串断言掩盖字段改名。 */
import { resolve } from "node:path";
import { loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { Config as PersonaConfig } from "@deepseek-ai/dsh-persona";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { expect, it } from "vitest";

// YAML 是不可信输入；schema 的静态入参比其实际解析边界窄，测试显式走 unknown。
const parsePersona = PersonaConfig as unknown as (input: unknown) => { prefix: string };

function config(path: string, id: string): Record<string, unknown> {
  const rows = loadOverlayPatches("persona-compat", resolve(path)).flat() as Array<{ id?: string; config?: Record<string, unknown> }>;
  const value = rows.find((row) => row.id === id)?.config;
  if (!value) throw new Error("missing configured row");
  return value;
}

it.each([
  "packages/bundle/web/agent-presets-oci/minimal/agent.cordis.yml",
  "packages/bundle/web/agent-presets/liangshen/agent.cordis.yml",
])("自有人设通过官方必填字段校验：%s", (path) => {
  const input = config(path, "persona");
  expect(input).not.toHaveProperty("text");
  expect(parsePersona(input).prefix).toBe(input.prefix);
  expect(input.prefix).toEqual(expect.any(String));
  expect(() => parsePersona({ text: input.prefix })).toThrow();
});

it.each(["packages/bundle/base/cordis.patch.yml", "packages/bundle/web/cordis.patch.yml"])("部署人设被官方schema消费而非静默丢失：%s", (path) => {
  const input = config(path, "system-prompt");
  expect(input).not.toHaveProperty("persona");
  expect(SystemPrompt.Config(input).personaPrefix).toEqual(expect.stringContaining("MewClaw"));
});
