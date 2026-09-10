/**
 * 组合校验测试（SPEC bundles.md §8）：
 * 网关组合不得含任何工具/agent 行；worker 组合不得含 lark 客户端/卡片行。
 * 解析真实 bundle patch 文件（loadOverlayPatches），防误改回耦合。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface PatchRow {
  id?: string;
  name?: string;
  disabled?: unknown;
  config?: Record<string, unknown>;
  insert?: unknown;
}

const testDirectory = dirname(fileURLToPath(import.meta.url));

function isPatchRow(value: unknown): value is PatchRow {
  return typeof value === "object" && value !== null;
}

/** 将 patch 顶层行和 insert 行统一成可断言的行集。 */
function patchRows(patches: readonly unknown[]): PatchRow[] {
  const rows: PatchRow[] = [];
  for (const patch of patches) {
    if (!isPatchRow(patch)) continue;
    rows.push(patch);
    if (!Array.isArray(patch.insert)) continue;
    for (const row of patch.insert) {
      if (isPatchRow(row)) rows.push(row);
    }
  }
  return rows;
}

function repositoryPath(relativePath: string): string {
  return resolve(testDirectory, "..", relativePath);
}

function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(repositoryPath(relativePath), "utf8");
}

function bundlePatches(bundle: string): PatchRow[] {
  const path = require.resolve(`${bundle}/cordis.patch.yml`);
  return patchRows(loadOverlayPatches("composition-test", path));
}

function overlayPatches(relativePath: string): PatchRow[] {
  return patchRows(loadOverlayPatches("composition-test", repositoryPath(relativePath)));
}

/** 提取 bundle patch 的行名（含被 disable 的行）。 */
function rowNames(bundle: string): string[] {
  return bundlePatches(bundle)
    .flatMap((row) => typeof row.name === "string" ? [row.name] : []);
}

describe("网关组合（硬边界）", () => {
  it("不得含任何工具/agent/session/llm 行", () => {
    const names = rowNames("dsh-lark-gateway-bundle");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/agent|tool|llm|session|sandbox|skill|subagent|workflow/);
    }
  });

  it("行集仅账号宿主，不再装载部署级客户端和长连接", () => {
    const names = [...rowNames("dsh-lark-gateway-bundle")].sort();
    expect(names).toEqual([
      "@deepseek-ai/dsh-credentials-local",
      "dsh-cdg-bridge",
      "dsh-lark-gateway/bot-fleet",
      "dsh-lark-run-client",
    ]);
  });

  it("运行客户端固定指向 Worker API，不复用 Web UI 端口", () => {
    const row = bundlePatches("dsh-lark-gateway-bundle").find((patch) => patch.id === "lark-run-client");
    expect(row?.config).toMatchObject({
      baseURL: "http://127.0.0.1:8788",
      tokenEnv: "WORKER_TOKEN",
    });
  });
});

describe("worker 组合（技能与 overlay）", () => {
  it("真实补丁算法禁用官方适配器并装载可解析的路由插件", () => {
    const warnings: string[] = [];
    const rows = composeEntries([
      loadOverlayPatches("test", require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml")),
      loadOverlayPatches("test", repositoryPath("packages/bundle/worker/cordis.patch.yml")),
    ], (message) => warnings.push(message));
    const flatten = (entries: typeof rows): typeof rows => entries.flatMap((row) => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);
    const effective = flatten(rows);
    expect(effective.find((row) => row.id === "llm-deepseek")?.disabled).toBe(true);
    expect(effective.find((row) => row.id === "lark-deepseek-routing")?.name).toContain("dsh-lark-deepseek-routing");
    expect(warnings.filter((message) => message.includes("llm-deepseek"))).toEqual([]);
    const workerRequire = createRequire(repositoryPath("apps/lark-worker/package.json"));
    expect(workerRequire.resolve("dsh-lark-deepseek-routing")).toContain("deepseek-routing");
  });
  it("技能发现只扫描受审 skills 根，不包含项目或用户默认根", () => {
    const row = bundlePatches("dsh-lark-worker").find((patch) => patch.id === "lark-reviewed-skill-filesystem");
    expect(row).toMatchObject({
      name: "@deepseek-ai/dsh-skill-filesystem",
      config: {
        providerName: "dsh-lark-reviewed",
        includeDefaultRoots: false,
        bundledSkillDir: "skills",
      },
    });
  });

  it("技能信任预检固定使用受审清单与 skills 根", () => {
    const row = bundlePatches("dsh-lark-worker").find((patch) => patch.id === "skill-trust");
    expect(row).toMatchObject({
      name: "dsh-skill-trust",
      config: {
        manifestPath: "skills/trust-manifest.json",
        skillsRoot: "skills",
      },
    });
  });

  it("轻量 overlay 不再裁剪本机执行与委派入口，仍保留权限服务", () => {
    const patches = overlayPatches("apps/lark-worker/lightweight.overlay.yml");
    const disabled = patches
      .filter((patch) => patch.disabled === true)
      .map((patch) => patch.id)
      .filter((id): id is string => Boolean(id));
    const execution = [
      "subprocess", "bash-sandbox", "pwsh-sandbox", "tool-bash", "tool-pwsh",
      "jobs", "tool-jobs", "tool-fs-search", "permission", "subagent-spawn-in-process",
      "subagent-fork-in-process", "tool-subagent-control", "tool-subagent-list-agents",
      "tool-subagent", "tool-subagent-fork", "tool-subagent-report", "workflow-worker-thread",
      "tool-workflow", "tool-ralph",
    ];
    for (const id of execution) expect(disabled).not.toContain(id);
    expect(patches).toContainEqual(expect.objectContaining({ id: "permission", disabled: false }));
    expect(disabled).not.toContain("subagent");
  });

  it("full overlay 保留宿主本机执行组合并选择全功能 preset", () => {
    const patches = overlayPatches("apps/lark-worker/full.overlay.yml");
    const presets = patches.find((patch) => patch.id === "agent-presets");
    expect(presets?.config).toMatchObject({ default: "lark-standard", includeUserRoot: false });
    expect(patches.find((patch) => patch.id === "lark-run")?.config)
      .toMatchObject({ agentPresetId: "lark-standard" });
    expect(patches.some((patch) => patch.id === "tool-pwsh" && patch.disabled === true)).toBe(false);
    for (const id of ["subprocess", "sandbox", "bash-sandbox", "shell-env", "permission"]) {
      expect(patches).toContainEqual(expect.objectContaining({ id, disabled: false }));
    }
  });

  it("OCI overlay 禁用本机执行并插入 OCI sandbox", () => {
    const patches = overlayPatches("apps/lark-worker/oci.overlay.yml");
    expect(patches.find((patch) => patch.id === "agent-presets")?.config)
      .toMatchObject({ default: "standard", includeUserRoot: false });
    expect(patches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "subprocess", disabled: true }),
      expect.objectContaining({ id: "sandbox", disabled: true }),
      expect.objectContaining({ id: "sandbox-oci", name: "dsh-sandbox-oci" }),
    ]));
  });

});

describe("worker 组合（平台行）", () => {
  it("不得含 lark 客户端/卡片/网关行", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/^dsh-lark$/);
      expect(name).not.toMatch(/dsh-lark-(card|ws|gateway|run-client|commands|admin)/);
    }
  });

  it("含运行服务器与交互 provider 行", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names).toContain("dsh-lark-run");
    expect(names).toContain("dsh-lark-approval");
  });

  it("含知识 Provider、检索工具与附件管线行（M3）", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names).toContain("dsh-knowledge-postgres");
    expect(names).toContain("dsh-tool-knowledge");
    expect(names).toContain("dsh-lark-uploads");
    expect(names).toContain("dsh-cdg-bridge");
    expect(names).toContain("dsh-tool-cdg");
  });

  it("可选 CDG 桥接缺省时传递 undefined，而不是空命令", () => {
    const row = bundlePatches("dsh-lark-worker").find((patch) => patch.id === "cdg-bridge");
    expect(row?.config?.command).toEqual({ __jsExpr: "process.env.CDG_BRIDGE_PATH" });
    const tool = bundlePatches("dsh-lark-worker").find((patch) => patch.id === "tool-cdg");
    expect(tool?.config?.command).toEqual({ __jsExpr: "process.env.CDG_BRIDGE_PATH" });
  });

  it("含 cron 能力缝与模型面工具行（M4）", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names).toContain("dsh-lark-cron");
    expect(names).toContain("dsh-tool-cron");
  });

  it("含所有用户可用的公共 Web/API 分享能力与工具", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names).toContain("dsh-preview");
    expect(names).toContain("dsh-tool-preview");
  });

  it("含所有用户可用的受控浏览器能力与工具", () => {
    const names = rowNames("dsh-lark-worker");
    expect(names).toContain("dsh-browser");
    expect(names).toContain("dsh-tool-browser");
    const browser = bundlePatches("dsh-lark-worker").find((patch) => patch.id === "browser");
    expect(browser?.config).toMatchObject({
      browserBaseUrl: "http://127.0.0.1:13083",
      tokenEnv: "WORKER_TOKEN",
    });
  });
});

describe("admin 组合（硬边界）", () => {
  it("不得含任何工具/agent/session/llm/sandbox 行", () => {
    const names = rowNames("dsh-lark-admin-bundle");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/agent|tool|llm|session|sandbox|skill|subagent|workflow|run-client/);
    }
  });

  it("行集 = 凭证 + webServer + knowledge + billing + admin 面（白名单）", () => {
    const names = [...rowNames("dsh-lark-admin-bundle")].sort();
    expect(names).toEqual([
      "@deepseek-ai/dsh-credentials-local",
      "@deepseek-ai/dsh-host-webserver",
      "dsh-knowledge-postgres",
      "dsh-lark-admin",
      "dsh-lark-billing",
      "dsh-memory-mem0",
    ]);
  });

  it("不得引入 worker 或 gateway 的运行协调客户端", () => {
    const names = rowNames("dsh-lark-admin-bundle");
    for (const name of names) {
      expect(name).not.toMatch(/dsh-lark-(gateway|run(?:-client)?|ws|card|commands)/);
    }
  });

  it("浏览器 API client 只请求 admin 控制面，不直连 worker", async () => {
    const source = await readRepositoryFile("apps/admin-web/src/api.ts");
    expect(source).toContain("/api/admin/");
    expect(source).not.toContain("/v1/");
    expect(source).not.toMatch(/worker(?:BaseUrl|Token|TokenEnv)|WORKER_/i);
  });
});

describe("平台强制层", () => {
  it("dsh-lark-base 禁用 hmr 并设置平台 persona（不可覆盖层）", () => {
    const patches = bundlePatches("dsh-lark-base");
    expect(patches).toContainEqual({ id: "hmr", disabled: true });
    const prompt = patches.find((patch) => patch.id === "system-prompt");
    expect(prompt?.config).toMatchObject({ personaPrefix: expect.stringContaining("MewClaw") });
  });
});
