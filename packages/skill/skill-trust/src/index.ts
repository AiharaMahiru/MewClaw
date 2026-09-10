/**
 * dsh-skill-trust 插件入口（SPEC skill-trust.md）。
 *
 * 提供 ctx.skillTrust：会话创建前的供应链预检（lark-run 挂点调用）。
 * 预检失败 → 返回拒绝报告（调用方转 SESSION_CREATE_FAILED，fail closed）。
 * 事件 `skill-trust/result` 仅技能名 + 通过/拒绝 + 原因码（不含目录细节）。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { preflightSkills, SkillTrustError, type TrustReport } from "./preflight.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 技能供应链预检服务（worker 宿主面）。 */
    skillTrust?: SkillTrustService;
  }
  interface Events {
    /**
     * 单项技能预检结果（仅技能名与原因码，不含摘要冲突详情）。
     * @param payload - 技能名 + 结果
     * @mode sync
     */
    "skill-trust/result"(payload: { name: string; ok: boolean; reasonCode?: string }): void;
  }
}

export const name = "skill-trust";

export const inject = [];

export interface Config {
  /** manifest 路径（默认 <repo>/skills/trust-manifest.json）。 */
  manifestPath?: string;
  /** 受检技能根（默认 <repo>/skills）。 */
  skillsRoot?: string;
}

export const Config: z<Config> = z.object({
  manifestPath: z.string(),
  skillsRoot: z.string(),
});

export interface SkillTrustService {
  /** 全量预检；拒绝项见报告（fail closed 由调用方执行）。 */
  preflight(): Promise<TrustReport>;
}

export function apply(ctx: Context, config: Config): void {
  // schemastery 可选字符串缺省为 ""（非 nullish）——用 || 回退（M2 实证）。
  const manifestPath = config.manifestPath || "skills/trust-manifest.json";
  const skillsRoot = config.skillsRoot || "skills";

  const service: SkillTrustService = {
    async preflight() {
      let report: TrustReport;
      try {
        report = await preflightSkills({ manifestPath, skillsRoot });
      } catch (error) {
        if (error instanceof SkillTrustError) {
          // manifest 缺失/损坏：fail loud（预检报告以假失败呈现，调用方拒绝会话）。
          report = {
            ok: false,
            failures: [{ name: "manifest", reasonCode: "manifest-missing" }],
          };
          ctx.logger.warn(`skill-trust: ${error.message}`);
        } else {
          throw error;
        }
      }
      for (const failure of report.failures) {
        ctx.emit("skill-trust/result", {
          name: failure.name,
          ok: false,
          reasonCode: failure.reasonCode,
        });
      }
      return report;
    },
  };
  ctx.provide("skillTrust", service);
}

export { preflightSkills, SkillTrustError } from "./preflight.js";
export type { TrustFailure, TrustManifest, TrustReport, SkillTrustEntry } from "./preflight.js";
