/**
 * M4 技能发现 e2e（SPEC skills.md §8）：worker 组合真启动后，
 * skill-filesystem 的 customSkillDirs 覆盖生效——skills/ 下受信技能可被
 * ctx.skills 发现，且 skill-trust 预检对真实清单全绿。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import type {} from "@deepseek-ai/dsh-skill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preflightSkills } from "../packages/skill/skill-trust/src/preflight.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workerRoot = join(repoRoot, "apps", "lark-worker");
const testCredentialsPath = join(repoRoot, "tests", "fixtures", "missing-credentials.yaml");

const testEnvironment = {
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/dsh_test",
  DEEPSEEK_API_KEY: "test-deepseek-key",
  FIRECRAWL_API_KEY: "test-firecrawl-key",
  MAIL_HOST: "",
  SILICONFLOW_API_KEY: "test-siliconflow-key",
  VISION_BASE_URL: "https://example.invalid/v1",
  VISION_MODEL: "test-vision-model",
  VISION_OPENAI_API_KEY: "test-vision-key",
  WORKER_TOKEN: "test-worker-token",
};

const disabledWorkerEntries = [
  "browser",
  "cdg-bridge",
  "lark-approval",
  "lark-billing",
  "lark-cron",
  "lark-image",
  "lark-presets",
  "lark-run",
  "lark-uploads",
  "lark-vision",
  "mail-imap",
  "memory-mem0",
  "preview",
  "tool-memory",
  "tool-browser",
  "tool-preview",
  "knowledge-postgres",
  "tool-cron",
  "tool-cdg",
  "tool-image",
  "tool-knowledge",
  "tool-mail",
  "web-firecrawl",
  "web-private-model",
];

// 该测试只验证 Skill 文件发现；第三方 Web 行需要 webServer/runtime 等宿主，
// 在没有 Web Host 的隔离组合中必须显式禁用，避免 pending 行阻断 boot。
const disabledWebEntries = [
  "web-ui-settings",
  "web-ui-task-board",
  "web-ui-git-graph",
  "web-ui-pet",
  "web-ui-remote-web-ui",
  "web-ui-ssh",
  "web-ui-describe-image",
  "web-ui-dsh-aionui-panel",
  "web-ui-liangshen",
  "web-ui-skill-explorer",
  "web-ui-skin-center",
  "web-ui-better-sidebar",
  "web-ui-plugin-manager",
  "web-ui-market",
  "web-ui-dsh-perf",
  "web-ui-desktop-launcher",
  "web-ui-doctor",
  "web-ui-archive-manager",
];

const nonSkillDiscoveryBundles = new Set([
  "@deepseek-ai/dsh-web-app",
  "dsh-lark-web-bundle",
]);

interface BundleManifest {
  dsh?: { bundle?: { patch?: string } };
}

async function bundlePatchPath(bundle: string): Promise<string> {
  const manifestPath = require.resolve(`${bundle}/package.json`, { paths: [workerRoot] });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest;
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch === "string" && patch.length > 0) {
    return join(dirname(manifestPath), patch);
  }
  return require.resolve(`${bundle}/cordis.patch.yml`, { paths: [workerRoot] });
}

function installTestEnvironment(): void {
  for (const [key, value] of Object.entries(testEnvironment)) vi.stubEnv(key, value);
}

describe("M4 技能发现", () => {
  beforeEach(installTestEnvironment);
  afterEach(() => vi.unstubAllEnvs());

  it("worker 组合：ctx.skills 只发现十个受信 Skill", async () => {
    const manifest = JSON.parse(await readFile(join(workerRoot, "package.json"), "utf8")) as {
      dsh?: { profile?: { bundles?: string[] } };
    };
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const skillDiscoveryBundles = bundles.filter((bundle) => !nonSkillDiscoveryBundles.has(bundle));
    const bundlePatchPaths = await Promise.all(skillDiscoveryBundles.map(bundlePatchPath));
    const patches = [
      // Skill discovery does not need to start the Web Host. The complete
      // official Web composition is covered by dsh-web-composition and live
      // protocol tests; keeping it out here avoids false failures on its
      // bind-dependent webServer/webRuntime services.
      ...bundlePatchPaths.flatMap((patchPath) => loadOverlayPatches(
        "skills-discovery-test",
        patchPath,
      )),
      // 只测试 Skill 发现，禁止无关 Provider 在加载期触发数据库或外部服务。
      ...disabledWorkerEntries.map((id) => ({ id, disabled: true })),
      ...disabledWebEntries.map((id) => ({ id, disabled: true })),
      // 使用不存在且不监听的测试凭证文件；不读取项目 .env 或用户凭证文件。
      {
        id: "credentials",
        config: {
          path: testCredentialsPath,
          watch: false,
        },
      },
    ];
    const ctx = await boot("skills-discovery-test", join(workerRoot, "cordis.yml"), patches);
    try {
      const skills = await ctx.skills.list({ cwd: repoRoot });
      const names = skills.map((skill) => skill.name);
      expect(names.sort()).toEqual([
        "cdg-bridge",
        "lark-automation",
        "lark-browser",
        "lark-coding",
        "lark-cron",
        "lark-office",
        "lark-rag",
        "lark-research",
        "lark-share",
        "lark-web",
      ]);
      const cdg = await ctx.skills.get("cdg-bridge", { cwd: repoRoot });
      expect(cdg?.content).toContain("cdg_file");
      const rag = await ctx.skills.get("lark-rag", { cwd: repoRoot });
      expect(rag?.content).toContain("knowledge_search");
      const web = await ctx.skills.get("lark-web", { cwd: repoRoot });
      expect(web?.content).toContain("web_screenshot");
      expect(web?.content).toContain("cron_schedule");
      const office = await ctx.skills.get("lark-office", { cwd: repoRoot });
      expect(office?.content).toContain("mail_send");
      const research = await ctx.skills.get("lark-research", { cwd: repoRoot });
      expect(research?.content).toContain("knowledge_search");
      expect(research?.content).toContain("web_crawl");
      const automation = await ctx.skills.get("lark-automation", { cwd: repoRoot });
      expect(automation?.content).toContain("cron_schedule");
      const coding = await ctx.skills.get("lark-coding", { cwd: repoRoot });
      expect(coding?.content).toContain("`read`");
      expect(coding?.content).toContain("`edit`");
      const share = await ctx.skills.get("lark-share", { cwd: repoRoot });
      expect(share?.content).toContain("share_web");
      expect(share?.content).toContain("share_revoke");
      const browser = await ctx.skills.get("lark-browser", { cwd: repoRoot });
      expect(browser?.content).toContain("browser_open");
      expect(browser?.content).toContain("browser_console");
      expect(browser?.content).toContain("browser_close");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 60_000);

  it("供应链预检：真实清单全绿", async () => {
    const report = await preflightSkills({
      manifestPath: "skills/trust-manifest.json",
      skillsRoot: "skills",
    });
    expect(report.ok).toBe(true);
  });
});
