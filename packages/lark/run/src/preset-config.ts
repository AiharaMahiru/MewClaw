import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "dsh-lark-presets";

import type { RunPreset } from "./executor.js";

/** preset 装载期 fail loud，并投影为运行期最小结构。 */
export function resolveRunPreset(ctx: Context, presetId: string): RunPreset {
  const preset = ctx.larkPresets!.resolve(presetId);
  if (!preset) {
    throw new Error(`lark-run: 模板不存在（presetId=${presetId}）——请先经 scripts/bot-new.mjs 创建并算 revision`);
  }
  const denyTools = preset.tools?.deny ?? [];
  for (const toolName of denyTools) {
    if (!ctx.tools.get(toolName)) {
      throw new Error(`lark-run: 模板 ${preset.name} 的 deny 工具未注册（${toolName}）`);
    }
  }
  return {
    name: preset.name,
    version: preset.version,
    revision: preset.revision,
    skills: preset.skills ?? [],
    trustedSkills: ctx.larkPresets!.trustedSkillNames(),
    denyTools,
    autoRetrieve: preset.retrieval !== "off",
    ...(preset.persona ? { persona: preset.persona } : {}),
  };
}
