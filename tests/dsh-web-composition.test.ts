import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

interface PatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  insert?: unknown;
}

interface BundleManifest {
  dsh?: { bundle?: { patch?: string } };
}

interface PackageManifest {
  dsh?: { client?: { platform?: string } };
  exports?: Record<string, unknown>;
}

function repositoryPath(relativePath: string): string {
  return resolve(here, "..", relativePath);
}

function packageRoot(packageSpecifier: string): string {
  const parts = packageSpecifier.split("/");
  return packageSpecifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function packageManifest(packageName: string): PackageManifest {
  return JSON.parse(
    readFileSync(repositoryPath(`node_modules/${packageRoot(packageName)}/package.json`), "utf8"),
  ) as PackageManifest;
}

function clientExport(packageManifestValue: PackageManifest): string | undefined {
  const value = packageManifestValue.exports?.["./client"];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { default?: unknown }).default === "string") {
    return (value as { default: string }).default;
  }
  return undefined;
}

function rowsFrom(value: unknown): PatchRow[] {
  if (!value || typeof value !== "object") return [];
  const row = value as PatchRow;
  const rows = [row];
  if (Array.isArray(row.insert)) {
    rows.push(...row.insert.filter((entry): entry is PatchRow => Boolean(entry && typeof entry === "object")));
  }
  return rows;
}

async function bundlePatchPath(bundle: string): Promise<string> {
  const manifestPath = require.resolve(`${bundle}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest;
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch === "string") return resolve(dirname(manifestPath), patch);
  return require.resolve(`${bundle}/cordis.patch.yml`);
}

async function bundleRows(bundle: string): Promise<PatchRow[]> {
  return loadOverlayPatches(
    "dsh-web-composition-test",
    await bundlePatchPath(bundle),
  ).flatMap(rowsFrom);
}

function overlayRows(relativePath: string): PatchRow[] {
  return loadOverlayPatches("dsh-web-composition-test", repositoryPath(relativePath)).flatMap(rowsFrom);
}

function namedRows(rows: readonly PatchRow[]): Set<string> {
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

describe("官方 dsh Web 组合", () => {
  it("全仓 boot-check 通过随机端口验证 admin，不占用生产服务端口", async () => {
    const manifest = JSON.parse(
      await readFile(repositoryPath("package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.smoke).toBe("node scripts/validate-linux-release.mjs");
    const validator = await readFile(repositoryPath("scripts/validate-linux-release.mjs"), "utf8");
    for (const path of [
      "apps/lark-worker/web-port0.overlay.yml",
      "apps/lark-worker/lightweight.overlay.yml",
      "apps/lark-worker/full.overlay.yml",
      "apps/lark-worker/full-port0.overlay.yml",
      "apps/lark-worker/boot-check.overlay.yml",
      "apps/admin/boot-check.overlay.yml",
    ]) expect(validator).toContain(path);
    expect(validator).toContain('"--port",');
    expect(validator).toContain('"0",');
    expect(validator).toContain('"--boot-check"');
    const row = overlayRows("apps/admin/boot-check.overlay.yml")
      .find((entry) => entry.id === "host-webserver");
    expect(row?.config).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(overlayRows("apps/lark-worker/full-port0.overlay.yml"))
      .toContainEqual(expect.objectContaining({ id: "web-ui-task-board", disabled: true }));
  });

  it("Worker profile 以官方 Web bundle 加载完整聊天表层", async () => {
    const manifest = JSON.parse(
      await readFile(repositoryPath("apps/lark-worker/package.json"), "utf8"),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    expect(manifest.dsh?.profile?.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "dsh-lark-base",
      "dsh-lark-worker",
      "@deepseek-ai/dsh-web-app",
      "dsh-context",
      "@linxin666/dsh-web-all",
      "dsh-lark-web-bundle",
    ]);

    const names = namedRows(await bundleRows("@deepseek-ai/dsh-web-app"));
    for (const name of [
      "@deepseek-ai/dsh-host-webserver",
      "@deepseek-ai/dsh-web-app",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-hmr",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-commands",
      "@deepseek-ai/dsh-client-ui-skill",
      "@deepseek-ai/dsh-client-ui-workspace",
      "@deepseek-ai/dsh-client-ui-tool",
      "@deepseek-ai/dsh-client-ui-plan",
      "@deepseek-ai/dsh-client-ui-user-questions",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-model-selection",
      "@deepseek-ai/dsh-client-ui-deliverables",
      "@deepseek-ai/dsh-client-ui-workflow-run",
      "@deepseek-ai/dsh-client-ui-trajectory",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("客户端资源 roster 只收录可服务的 Web client，并由 workspace 承载文件查看器", async () => {
    const names = namedRows(await bundleRows("@deepseek-ai/dsh-web-app"));
    const browserNames = [...names].filter((name) => {
      const manifest = packageManifest(name);
      return manifest.dsh?.client?.platform === "web";
    });

    expect(browserNames).toContain("@deepseek-ai/dsh-client-ui-workspace");
    expect(existsSync(repositoryPath("node_modules/@deepseek-ai/dsh-client-ui-file-viewer"))).toBe(false);

    for (const name of browserNames) {
      const manifest = packageManifest(name);
      const relativeClient = clientExport(manifest);
      expect(relativeClient, `${name} must export ./client`).toBeTruthy();
      expect(relativeClient).toMatch(/^\.\/.*client\.js$/);
      expect(existsSync(repositoryPath(`node_modules/${packageRoot(name)}/${relativeClient!.slice(2)}`))).toBe(true);
    }

    for (const hostOnlyName of [
      "@deepseek-ai/dsh-goal",
      "@deepseek-ai/dsh-permission-presets",
      "@deepseek-ai/dsh-session-stats",
      "@deepseek-ai/dsh-session-title",
      "@deepseek-ai/dsh-subagent",
      "@deepseek-ai/dsh-token-meter",
    ]) {
      expect(browserNames).not.toContain(hostOnlyName);
      expect(packageManifest(hostOnlyName).dsh?.client).toBeUndefined();
    }
  });

  it("第三方 Web 扩展精确锁定且 sidebar 只由聚合包挂载一次", async () => {
    const manifest = JSON.parse(
      await readFile(repositoryPath("apps/lark-worker/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };

    expect(manifest.dependencies).toMatchObject({
      "dsh-context": "0.48.0",
      "@linxin666/dsh-web-all": "0.3.19",
      "dsh-better-sidebar": "0.18.1",
    });
    expect(manifest.dsh?.profile?.bundles).not.toContain("dsh-better-sidebar");

    const aggregateRows = await bundleRows("@linxin666/dsh-web-all");
    expect(aggregateRows.filter((row) => row.name === "dsh-better-sidebar")).toEqual([
      expect.objectContaining({ id: "web-ui-better-sidebar" }),
    ]);
  });

  it("认证插件同时提供 Auth Edge 守卫和 classic 浏览器账户 bundle", async () => {
    const manifest = JSON.parse(await readFile(repositoryPath("packages/lark/web-auth/package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
      dsh?: { client?: { platform?: string; inject?: string[] } };
    };
    const client = await readFile(repositoryPath("packages/lark/web-auth/client.js"), "utf8");
    expect(manifest.exports?.["./client"]).toEqual(expect.objectContaining({ default: "./client.js" }));
    expect(manifest.dsh?.client).toEqual(expect.objectContaining({ platform: "web", inject: [] }));
    expect(client).toContain('inject: ["slots", "connection", "remote", "remote.settings"]');
    expect(client).toContain('id: "dsh-lark-web-auth"');
    expect(client).toContain('"settings.trigger"');
    expect(client).toContain('"settings.section"');
    expect(client).toContain("hostDescription");
    expect(client).toContain("source.subscribe");
    expect(client).toContain("mewclaw-network-status");
    expect(client).toContain("\\u7F51\\u7EDC\\u8FDE\\u63A5\\u5DF2\\u4E2D\\u65AD");
    expect(client).toContain('id: "mewclaw-account"');
    expect(client).toContain('mewclaw-account-fold');
    expect(client).toContain('mewclaw-account-session-buttons');
    expect(client).toContain("\\u5207\\u6362\\u8D26\\u53F7");
    expect(client).toContain("\\u9000\\u51FA\\u767B\\u5F55");
    expect(client).toContain('.mewclaw-account-center{box-sizing:border-box;display:flex;flex-direction:column;gap:20px');
    expect(client).toContain('.mewclaw-account-profile{display:grid;grid-template-columns:auto minmax(0,1fr) auto');
    expect(client).toContain('div:has(>div>div>div>.mewclaw-account-center){flex-direction:column}');
    expect(client).not.toContain('[data-dsh-surface="settings"]:has(.mewclaw-account-center)');
    expect(client).not.toContain('label: "账户概览"');
    expect(client).toContain('priority: -1');
    expect(client).not.toContain('id: "mewclaw-security"');
    expect(client).not.toContain('id: "mewclaw-feishu"');
    expect(client).not.toContain('id: "mewclaw-usage"');
    expect(client).not.toContain('id: "mewclaw-admin"');
    expect(client).not.toContain('"settings.general.item"');
    expect(client).not.toContain('mewclaw-account-settings');
    expect(client).not.toContain('账户、安全、飞书连接、用量与权限统一在此管理');
    expect(client).not.toContain("export {};");
  });

  it("Git 扩展按 workspace 根注入 safe.directory，兼容服务账号所有权检查", async () => {
    const manifest = JSON.parse(await readFile(repositoryPath("package.json"), "utf8")) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };
    expect(manifest.pnpm?.patchedDependencies).toBeUndefined();
    const gitconfig = await readFile(repositoryPath("infra/linux/config/gitconfig"), "utf8");
    expect(gitconfig).toContain("directory = /var/lib/dsh/workspaces/*");
    expect(gitconfig).not.toContain("directory = *\n");
  });

  it("OCI minimal 使用会话 cwd 文件工具，避免混用容器与宿主绝对路径", async () => {
    const preset = await readFile(
      repositoryPath("packages/bundle/web/agent-presets-oci/minimal/agent.cordis.yml"),
      "utf8",
    );

    expect(preset).toContain("{{cwd}}");
    expect(preset).toContain("绝不能传 /workspace");
    expect(preset).toContain("/workspace 只用于 Bash");
    expect(preset).toContain("容器内没有 apply_patch");
    expect(preset).toContain("name: '@deepseek-ai/dsh-tool-fs'");
    expect(preset).not.toContain("@deepseek-ai/dsh-tool-str-replace-editor");

    expect(overlayRows("apps/lark-worker/oci.overlay.yml")).toContainEqual(expect.objectContaining({
      id: "oci-workspace-guidance",
      name: "dsh-lark-web-bundle/agent-presets-oci/workspace-guidance.mjs",
    }));
    const manifest = JSON.parse(
      await readFile(repositoryPath("packages/bundle/web/package.json"), "utf8"),
    ) as { exports?: Record<string, string> };
    expect(manifest.exports?.["./agent-presets-oci/workspace-guidance.mjs"])
      .toBe("./agent-presets-oci/workspace-guidance.mjs");
  });

  it("MewClaw 品牌占据官方槽位且禁用官方 occupant", async () => {
    const rows = overlayRows("packages/bundle/web/cordis.patch.yml");
    expect(rows).toContainEqual(expect.objectContaining({ id: "ui-brand-official", disabled: true }));
    expect(rows).toContainEqual(expect.objectContaining({ id: "atw-brand", name: "dsh-lark-atw-brand" }));
    const client = await readFile(repositoryPath("packages/lark/atw-brand/src/client.ts"), "utf8");
    for (const slot of ["conversation.hero.brand.mark", "sidebar.brand.mark", "sidebar.brand.name"]) expect(client).toContain(slot);
  });

  it("MewClaw Host 半部通过公开 WebServer 扩展点提供静态品牌", async () => {
    const host = await readFile(repositoryPath("packages/lark/atw-brand/src/index.ts"), "utf8");
    expect(host).toContain("ctx.webServer.tapIndex");
    expect(host).toContain('FAVICON_PATH = "/mewclaw-brand/favicon.svg"');
    expect(host).toContain('MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest"');
    expect(host).toContain("MewClaw Harness");
    expect(host).toContain('font-family:"Maple Mono NF CN"');
  });

  it("品牌实现不读取或修改官方包产物", async () => {
    const sources = await Promise.all(["index.ts", "client.ts", "mark.ts"].map((file) => readFile(repositoryPath(`packages/lark/atw-brand/src/${file}`), "utf8")));
    expect(sources.join("\n")).not.toContain("node_modules/");
    expect(sources.join("\n")).not.toContain("FishLogo");
  });

  it("目录选择器保持官方插件原样并由受控 Worker profile 组合", async () => {
    const rows = overlayRows("apps/lark-worker/full.overlay.yml");
    expect(rows).toContainEqual(expect.objectContaining({
      id: "directory-picker-browse-host",
      name: "@deepseek-ai/dsh-host-directory-picker-browse",
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      id: "directory-picker-browse-client",
      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse",
    }));
    const manifest = JSON.parse(await readFile(repositoryPath("package.json"), "utf8")) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };
    expect(manifest.pnpm?.patchedDependencies).toBeUndefined();
  });

  it("第三方 Web 用户可见 roster 保持可重放快照", async () => {
    const rows = [
      ...await bundleRows("dsh-context"),
      ...await bundleRows("@linxin666/dsh-web-all"),
    ];
    const names = rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []);
    expect(names).toMatchInlineSnapshot(`
      [
        "dsh-context",
        "@linxin666/dsh-web-all",
        "@linxin666/dsh-web-all/settings",
        "@linxin666/dsh-web-all/plugin-manager",
        "@linxin666/dsh-web-all/community-plugins",
        "@linxin666/dsh-web-all/market",
        "@linxin666/dsh-web-all/task-board",
        "@linxin666/dsh-web-all/git-graph",
        "@linxin666/dsh-web-all/remote-web-ui",
        "@linxin666/dsh-web-all/pet",
        "@linxin666/dsh-web-all/ssh",
        "@linxin666/dsh-web-all/describe-image",
        "@linxin666/dsh-web-all/liangshen",
        "@linxin666/dsh-web-all/skill-explorer",
        "@linxin666/dsh-web-all/doctor",
        "@linxin666/dsh-web-all/usage",
        "@linxin666/dsh-web-all/session-archive",
        "@linxin666/dsh-web-all/model-capabilities",
        "@linxin666/dsh-web-all/preset-center",
        "@linxin666/dsh-web-all/skin-center",
        "@linxin666/dsh-i18n",
        "dsh-better-sidebar",
      ]
    `);
  });

  it("Worker 全部 bundle 均可按 manifest 或导出 subpath 解析", async () => {
    const manifest = JSON.parse(
      await readFile(repositoryPath("apps/lark-worker/package.json"), "utf8"),
    ) as { dsh?: { profile?: { bundles?: string[] } } };
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const paths = await Promise.all(bundles.map(bundlePatchPath));
    expect(paths).toHaveLength(bundles.length);
  });

  it("第三方 Web 扩展不进入 Gateway 且原生构建脚本显式放行", async () => {
    const gateway = await readFile(repositoryPath("apps/lark-gateway/package.json"), "utf8");
    for (const name of ["dsh-context", "dsh-web-all", "dsh-better-sidebar"]) {
      expect(gateway).not.toContain(name);
    }

    const workspace = await readFile(repositoryPath("pnpm-workspace.yaml"), "utf8");
    for (const dependency of ["cloudflared", "cpu-features", "node-pty", "ssh2"]) {
      expect(workspace).toContain(`  - ${dependency}`);
    }
  });

  it("本地政策与 lightweight 只激活符合边界的第三方行", () => {
    const webRows = overlayRows("packages/bundle/web/cordis.patch.yml");
    for (const id of [
      "web-ui-dsh-aionui-panel",
      "web-ui-plugin-manager",
      "web-ui-market",
      "web-ui-desktop-launcher",
      "web-ui-doctor",
      "web-ui-dsh-perf",
      "web-ui-skin-center",
      "web-ui-git-graph",
      "web-ui-task-board",
      "web-ui-remote-web-ui",
      "web-ui-ssh",
      "web-ui-describe-image",
      "web-ui-liangshen",
      "web-ui-pet",
      "web-ui-archive-manager",
      "web-ui-session-branch",
      "web-ui-session-rdb",
      "web-ui-conversation-message-actions",
    ]) {
      expect(webRows).toContainEqual(expect.objectContaining({ id, disabled: true }));
    }

    const lightweightRows = overlayRows("apps/lark-worker/lightweight.overlay.yml");
    expect(lightweightRows).not.toContainEqual(expect.objectContaining({ id: "subagent", disabled: true }));
    for (const id of ["web-ui-pet"]) {
      expect(lightweightRows).toContainEqual(expect.objectContaining({ id, disabled: true }));
    }
  });

  it("部署覆盖只修改 MewClaw persona、模型与 provider 边界", () => {
    const rows = overlayRows("packages/bundle/web/cordis.patch.yml");
    const prompt = rows.find((row) => row.id === "system-prompt");
    expect(prompt?.config?.personaPrefix).toEqual(expect.stringContaining("MewClaw"));
    expect(rows).toContainEqual(expect.objectContaining({
      id: "agent-default-model",
      config: { provider: "openai", model: "gpt-5.6-luna" },
    }));
    expect(rows).toContainEqual(expect.objectContaining({ id: "lark-approval", disabled: true }));
    expect(rows).toContainEqual(expect.objectContaining({
      id: "lark-web-auth",
      name: "dsh-lark-web-auth",
      config: { tokenEnv: "WORKER_TOKEN" },
    }));
    expect(rows.find((row) => row.id === "session-persistence-jsonl")?.config).toEqual({
      root: { __jsExpr: "dshHomePath('sessions')" },
      packChunks: true,
      compression: "zstd",
      preparedSessionCacheSize: 5,
      writeBatchMaxDelayMs: 200,
    });
  });

  it("full roster 提供飞书全功能模式并保留官方 standard", async () => {
    const rows = overlayRows("packages/bundle/web/cordis.patch.yml");
    const roster = rows.find((row) => row.id === "agent-presets");
    expect(roster?.config?.roots).toEqual([
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-lightweight'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/@deepseek-ai/dsh-agent-presets/presets'" },
        trust: "system",
      },
    ]);

    const fullRows = overlayRows("packages/bundle/web/agent-presets/lark-standard/agent.cordis.yml");
    expect(fullRows).toContainEqual(expect.objectContaining({
      name: "@deepseek-ai/cordis-plugin-include",
      config: {
        path: "../../../../node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml",
      },
    }));
    const metadata = await readFile(
      repositoryPath("packages/bundle/web/agent-presets/lark-standard/preset.yml"),
      "utf8",
    );
    expect(metadata).toContain("飞书全功能模式");
    expect(metadata).not.toContain("旧会话兼容");
  });

  it("lightweight 复用完整宿主能力和官方 standard，保留默认 ID 与账号策略", () => {
    const bundleManifest = JSON.parse(
      readFileSync(repositoryPath("packages/bundle/web/package.json"), "utf8"),
    ) as { files?: string[] };
    expect(bundleManifest.files).toContain("agent-presets-lightweight");

    const lightweightRows = overlayRows("apps/lark-worker/lightweight.overlay.yml");
    const roster = lightweightRows.find((row) => row.id === "agent-presets");
    expect(roster?.config).toEqual({
      default: "lark-lightweight",
      roots: (overlayRows("apps/lark-worker/full.overlay.yml").find((row) => row.id === "agent-presets")?.config as { roots: unknown }).roots,
      includeUserRoot: false,
    });

    const larkRun = lightweightRows.find((row) => row.id === "lark-run");
    expect(larkRun?.config).toEqual({
      host: "127.0.0.1",
      port: 8788,
      presetId: "lark-standard",
      agentPresetId: "lark-lightweight",
      workspaceRoot: ".workspaces",
      tokenEnv: "WORKER_TOKEN",
    });

    const presetRows = overlayRows(
      "packages/bundle/web/agent-presets-lightweight/lark-lightweight/agent.cordis.yml",
    );
    expect(presetRows).toEqual(overlayRows("packages/bundle/web/agent-presets/lark-standard/agent.cordis.yml"));
    for (const id of ["subprocess", "sandbox", "bash-sandbox", "shell-env", "permission", "web-ui-git-graph", "web-ui-better-sidebar"]) {
      expect(lightweightRows).toContainEqual(expect.objectContaining({ id, disabled: false }));
    }

    const webRows = overlayRows("packages/bundle/web/cordis.patch.yml");
    expect(webRows.find((row) => row.id === "agent-presets")?.config)
      .toEqual(expect.objectContaining({ default: "standard", includeUserRoot: false }));
    expect(overlayRows("apps/lark-worker/oci.overlay.yml"))
      .toContainEqual(expect.objectContaining({
        id: "agent-presets",
        config: expect.objectContaining({ default: "standard", includeUserRoot: false }),
      }));
  });

  it("lightweight roster 只保留飞书轻量模式，不展示旧兼容条目", () => {
    expect(existsSync(repositoryPath("packages/bundle/web/agent-presets-lightweight/lark-standard")))
      .toBe(false);
  });

  it("full overlay 启用本机执行并暴露七项 system preset", () => {
    const rows = overlayRows("apps/lark-worker/full.overlay.yml");
    for (const id of ["subprocess", "sandbox", "bash-sandbox", "shell-env", "permission"]) {
      expect(rows).toContainEqual(expect.objectContaining({ id, disabled: false }));
    }
    expect(rows.find((row) => row.id === "agent-presets")?.config).toEqual({
      default: "lark-standard",
      roots: [
        {
          path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-lightweight'" },
          trust: "system",
        },
        {
          path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets'" },
          trust: "system",
        },
        {
          path: { __jsExpr: "process.cwd() + '/node_modules/@deepseek-ai/dsh-agent-presets/presets'" },
          trust: "system",
        },
      ],
      includeUserRoot: false,
    });
    expect(rows.find((row) => row.id === "lark-run")?.config).toEqual(expect.objectContaining({
      presetId: "lark-standard",
      agentPresetId: "lark-standard",
    }));
    for (const id of [
      "web-ui-task-board",
      "web-ui-git-graph",
      "web-ui-better-sidebar",
      "web-ui-describe-image",
      "web-ui-skill-explorer",
    ]) {
      expect(rows).toContainEqual(expect.objectContaining({ id, disabled: false }));
    }
    expect(rows.some((row) => row.id === "git-graph-host")).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({ id: "web-ui-dsh-aionui-panel", disabled: true }));
    for (const id of ["web-ui-remote-web-ui", "web-ui-ssh", "web-ui-liangshen", "web-ui-pet"]) {
      expect(rows).toContainEqual(expect.objectContaining({ id, disabled: true }));
    }
    for (const id of ["standard", "ptc", "minimal", "cordis"]) {
      expect(existsSync(repositoryPath(`node_modules/@deepseek-ai/dsh-agent-presets/presets/${id}/agent.cordis.yml`)))
        .toBe(true);
    }
    expect(existsSync(repositoryPath("packages/bundle/web/agent-presets/lark-standard/agent.cordis.yml"))).toBe(true);
    expect(existsSync(repositoryPath("packages/bundle/web/agent-presets/liangshen/agent.cordis.yml"))).toBe(true);
  });

  it("full 与 OCI 的 system roots 实际组成恰好七项 preset", () => {
    const expected = ["cordis", "lark-lightweight", "lark-standard", "liangshen", "minimal", "ptc", "standard"];
    const ids = [
      ...readdirSync(repositoryPath("packages/bundle/web/agent-presets-lightweight")),
      ...readdirSync(repositoryPath("packages/bundle/web/agent-presets")),
      ...readdirSync(repositoryPath("node_modules/@deepseek-ai/dsh-agent-presets/presets")),
    ].filter((id) => !id.startsWith(".")).sort();
    expect(ids).toEqual(expected);

    const fullRoots = [
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-lightweight'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/@deepseek-ai/dsh-agent-presets/presets'" },
        trust: "system",
      },
    ];
    const ociRoots = [
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-oci'" },
        trust: "system",
      },
      ...fullRoots,
    ];
    for (const [file, roots] of [
      ["apps/lark-worker/full.overlay.yml", fullRoots],
      ["apps/lark-worker/oci.overlay.yml", ociRoots],
    ] as const) {
      const roster = overlayRows(file).find((row) => row.id === "agent-presets");
      expect(roster?.config).toEqual(expect.objectContaining({ includeUserRoot: false }));
      expect(roster?.config?.roots).toEqual(roots);
    }
  });

  it("full system root 提供全能优化模式并保持 Liangshen session ID 兼容", async () => {
    const presetRoot = repositoryPath("packages/bundle/web/agent-presets/liangshen");
    expect(existsSync(resolve(presetRoot, "agent.cordis.yml"))).toBe(true);
    expect(existsSync(resolve(presetRoot, "custom-bash.mjs"))).toBe(true);
    expect(existsSync(resolve(presetRoot, "tool-bootstrap.mjs"))).toBe(true);
    const metadata = await readFile(resolve(presetRoot, "preset.yml"), "utf8");
    expect(metadata).toContain("name: 全能优化模式");
    expect(metadata).toContain("更低 token 消耗");
    expect(metadata).not.toContain("梁神模式");
    const composition = await readFile(resolve(presetRoot, "agent.cordis.yml"), "utf8");
    expect(composition).toContain("name: ./tool-bootstrap.mjs");
    expect(composition).toContain("bootstrapMaxTokens: 1024");
    expect(composition).toContain("promotedPresentation: ptc");
  });

  it("full/OCI 七项 roster 只来自 system roots，不扫描用户 preset 根", () => {
    const fullRoots = [
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-lightweight'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets'" },
        trust: "system",
      },
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/@deepseek-ai/dsh-agent-presets/presets'" },
        trust: "system",
      },
    ];
    const ociRoots = [
      {
        path: { __jsExpr: "process.cwd() + '/node_modules/dsh-lark-web-bundle/agent-presets-oci'" },
        trust: "system",
      },
      ...fullRoots,
    ];
    for (const [file, roots] of [
      ["apps/lark-worker/full.overlay.yml", fullRoots],
      ["apps/lark-worker/oci.overlay.yml", ociRoots],
    ] as const) {
      expect(overlayRows(file).find((row) => row.id === "agent-presets")?.config)
        .toEqual(expect.objectContaining({ roots, includeUserRoot: false }));
    }
    const webRoots = fullRoots;
    expect(overlayRows("packages/bundle/web/cordis.patch.yml")
      .find((row) => row.id === "agent-presets")?.config)
      .toEqual(expect.objectContaining({ roots: webRoots, includeUserRoot: false }));

    expect(overlayRows("apps/lark-worker/oci.overlay.yml")
      .find((row) => row.id === "sandbox-oci")?.config)
      .toEqual(expect.objectContaining({
        workspaceRoot: { __jsExpr: "process.cwd() + '/.workspaces'" },
      }));
  });

  it("RC1 官方 standard 在 Windows 选择 pwsh 工具", async () => {
    const standardPath = resolve(dirname(require.resolve("@deepseek-ai/dsh-agent-presets/package.json")), "presets/standard/agent.cordis.yml");
    const standard = await readFile(standardPath, "utf8");
    expect(standard).toContain("name: '@deepseek-ai/dsh-tool-pwsh'");
    expect(standard).toContain("disabled: !!js process.platform !== 'win32'");
  });

  it("隔离验证 overlay 保持 loopback 并把 lark-run 置为随机端口", () => {
    const row = overlayRows("apps/lark-worker/web-port0.overlay.yml")
      .find((entry) => entry.id === "lark-run");
    expect(row?.config).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      agentPresetId: "lark-lightweight",
    });
  });
});
