import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { apply as applyPiAi } from "@deepseek-ai/dsh-llm-pi-ai";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface OverlayRow {
  config?: Record<string, unknown>;
  id?: string;
}

async function rows(name: string): Promise<OverlayRow[]> {
  const url = new URL(`../overlays/${name}.production.yml`, import.meta.url);
  await expect(readFile(url, "utf8")).resolves.not.toContain("0.0.0.0");
  return loadOverlayPatches(`linux-${name}`, fileURLToPath(url)) as OverlayRow[];
}

function rowConfig(items: OverlayRow[], id: string): Record<string, unknown> {
  const config = items.find((item) => item.id === id)?.config;
  if (!config) throw new Error(`missing overlay row ${id}`);
  return config;
}

describe("Linux production overlays", () => {
  it("仓库不提供数据库明文默认凭证", async () => {
    const compose = await readFile(new URL("../../postgres/compose.yaml", import.meta.url), "utf8");
    const config = await readFile(new URL("../../postgres/src/config.ts", import.meta.url), "utf8");
    expect(compose).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?");
    expect(compose).not.toContain("POSTGRES_PASSWORD: lark_claw");
    expect(config).toContain("DATABASE_URL is required");
    expect(config).not.toMatch(/postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/u);
  });
  it("rootless 初始化先于受限 Worker/Preview，权限例外不传递给主服务", async () => {
    const ready = await readFile(new URL("../systemd/dsh-podman-ready.service", import.meta.url), "utf8");
    expect(ready).toContain("User=dsh");
    expect(ready).toContain("Type=oneshot");
    expect(ready).toContain("ExecStart=/usr/bin/podman info --format={{.Host.Security.Rootless}}");
    expect(ready).toContain("CapabilityBoundingSet=CAP_SETUID CAP_SETGID");
    for (const name of ["worker", "preview"]) {
      const unit = await readFile(new URL(`../systemd/dsh-${name}.service`, import.meta.url), "utf8");
      expect(unit).toContain("After=dsh-podman-ready.service");
      expect(unit).toMatch(/^Requires=.*dsh-podman-ready.service/mu);
      expect(unit).toContain("NoNewPrivileges=true");
      expect(unit).toContain("CapabilityBoundingSet=\n");
    }
  });
  it("keeps the state .env as a managed-credential fallback", async () => {
    const units = ["auth", "worker", "gateway", "admin", "preview", "browser"];
    for (const unit of units) {
      const source = await readFile(new URL(`../systemd/dsh-${unit}.service`, import.meta.url), "utf8");
      expect(source).toContain("Environment=DSH_PROJECT_ENV_DIR=/var/lib/dsh");
      if (unit === "auth") {
        expect(source).toContain("EnvironmentFile=/etc/dsh/runtime.secrets.env");
        expect(source).toContain("EnvironmentFile=/etc/dsh/deepseek.env");
      }
      else expect(source).not.toContain("EnvironmentFile=/etc/dsh/runtime.secrets.env");
    }

    for (const app of ["auth", "lark-worker", "lark-gateway", "admin"]) {
      const source = await readFile(new URL(`../../../apps/${app}/src/main.ts`, import.meta.url), "utf8");
      expect(source).toContain("process.env.DSH_PROJECT_ENV_DIR?.trim() || repoRoot");
      if (app !== "auth") {
        expect(source).toContain("hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment)");
      }
    }
  });

  it("在进程启动前关闭 mem0 遥测，不由插件改写全局环境", async () => {
    for (const unit of ["worker", "admin"]) {
      const source = await readFile(new URL(`../systemd/dsh-${unit}.service`, import.meta.url), "utf8");
      expect(source).toContain("Environment=MEM0_TELEMETRY=false");
    }
    const plugin = await readFile(new URL("../../../packages/memory/memory-mem0/src/index.ts", import.meta.url), "utf8");
    expect(plugin).not.toMatch(/process\.env\.[A-Za-z0-9_]+\s*(?:\?\?=|=)/u);
  });

  it("通过真实用户运行目录连接 rootless Podman 并保持主目录只读", async () => {
    const source = await readFile(new URL("../systemd/dsh-worker.service", import.meta.url), "utf8");
    expect(source).toContain("ProtectHome=read-only");
    expect(source).toContain("Environment=XDG_RUNTIME_DIR=/run/user/995");
    expect(source).toContain("Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus");
    expect(source).not.toContain("BindPaths=/run/user/995:/var/lib/dsh/rootless-runtime");
    expect(source).toContain("ReadWritePaths=/var/lib/dsh /run/user/995");
    expect(source).toContain("Delegate=yes");

    const bootstrap = await readFile(new URL("../deploy/lib/bootstrap.sh", import.meta.url), "utf8");
    expect(bootstrap).toContain("/var/lib/dsh/rootless-runtime");

    const preview = await readFile(new URL("../systemd/dsh-preview.service", import.meta.url), "utf8");
    expect(preview).toContain("Environment=DSH_PREVIEW_PORT=13082");
    expect(preview).toContain("Environment=DSH_PREVIEW_WORKSPACE_ROOT=/var/lib/dsh/workspaces");
    // Preview 的 Podman 必须识别真实 user manager runtime，才能把受限容器放入
    // user@995.service 的 delegated cgroup；别名路径会回退 cgroupfs 并导致启动失败。
    expect(preview).toContain("Environment=XDG_RUNTIME_DIR=/run/user/995");
    expect(preview).toContain("Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/995/bus");
    expect(preview).not.toContain("BindPaths=/run/user/995:/var/lib/dsh/rootless-runtime");
    expect(preview).toContain("ProtectHome=read-only");
    expect(preview).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(preview).toContain("ReadWritePaths=/var/lib/dsh /run/user/995");
    expect(preview).toContain("CapabilityBoundingSet=");

    const browser = await readFile(new URL("../systemd/dsh-browser.service", import.meta.url), "utf8");
    expect(browser).toContain("Environment=DSH_BROWSER_PORT=13083");
    expect(browser).toContain("Environment=DSH_BROWSER_CHROMIUM_PATH=/usr/bin/chromium");
    expect(browser).toContain("Environment=DSH_BROWSER_STATE_ROOT=/var/lib/dsh/browser");
    expect(browser).toContain("Environment=DSH_BROWSER_WORKSPACE_ROOT=/var/lib/dsh/workspaces");
    expect(browser).toContain("ReadWritePaths=/var/lib/dsh/browser /var/lib/dsh/workspaces");
    expect(browser).toContain("CapabilityBoundingSet=");
  });

  it("Git 只信任托管工作区，不由第三方插件逐请求放宽", async () => {
    const unit = await readFile(new URL("../systemd/dsh-worker.service", import.meta.url), "utf8");
    const gitconfig = await readFile(new URL("../config/gitconfig", import.meta.url), "utf8");
    expect(unit).toContain("Environment=GIT_CONFIG_SYSTEM=/etc/dsh/gitconfig");
    expect(gitconfig).toContain("directory = /var/lib/dsh/workspaces/*");
    expect(gitconfig).not.toMatch(/^\s*directory\s*=\s*\*\s*$/mu);
  });

  it("isolates optional Preview failures from the Auth edge", async () => {
    const auth = await readFile(new URL("../systemd/dsh-auth.service", import.meta.url), "utf8");
    expect(auth).toContain("After=network-online.target postgresql@17-dsh.service dsh-worker.service dsh-admin.service dsh-preview.service");
    expect(auth).toContain("Wants=network-online.target dsh-preview.service");
    expect(auth).toContain("Requires=dsh-worker.service dsh-admin.service");
    expect(auth).not.toMatch(/^Requires=.*dsh-preview\.service/mu);
  });

  it("通过公开 Cordis/LLM 契约装载 GPT、Astra，移除Gemini模型Provider并收敛DeepSeek", async () => {
    const url = new URL("../config/settings.production.yaml", import.meta.url);
    const source = await readFile(url, "utf8");
    expect(source).toContain("provider: openai");
    expect(source).toContain("model: gpt-5.6-luna");
    expect(source).toContain("reasoningEffort: max");
    for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"]) expect(source).toContain(`id: ${model}`);
    expect(source).toContain("apiKeyEnv: OPENAI_API_KEY");
    expect(source).not.toContain("gemini-web2api");
    expect(source).toContain("baseURL: https://api.commandcode.ai/provider/v1");
    expect(source).toContain("id: deepseek-v4.1-flash");
    expect(source).not.toMatch(/apiKey:\s*[^\n]+/u);
    const settings = YAML.parse(source);
    const ctx = new Context();
    new LlmRuntime(ctx);
    ctx.plugin(applyPiAi, settings["llm-pi-ai"]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(ctx.llm.listModels("openai")).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }),
        { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra", inputModalities: ["text", "image"] },
      ]));
      expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain("gemini-web2api");
      await expect(ctx.llm.resolveModelInfo("openai", "gpt-6-astra")).resolves.toMatchObject({
        reasoning: { efforts: [
          { id: "off", name: "Off" }, { id: "low", name: "Low" },
          { id: "medium", name: "Medium" }, { id: "high", name: "High" }, { id: "max", name: "Max" },
        ] },
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("pins every Worker write path inside the systemd writable root", async () => {
    const items = await rows("worker");
    expect(rowConfig(items, "session-persistence-jsonl")).toEqual({ root: "/var/lib/dsh/sessions" });
    expect(rowConfig(items, "settings")).toEqual({ dshHome: "/var/lib/dsh/.dsh" });
    expect(rowConfig(items, "sandbox-policy")).toEqual({ workspaceRoot: "/var/lib/dsh/workspaces" });
    expect(rowConfig(items, "lark-session-directory")).toEqual({
      filePath: "/var/lib/dsh/session-directory.json",
      claimTtlMs: 600000,
      maxEntries: 20,
    });
    expect(rowConfig(items, "knowledge-postgres")).toEqual({
      databaseUrlEnv: "DATABASE_URL",
      siliconflowApiKeyEnv: "SILICONFLOW_API_KEY",
      uploadsRoot: "/var/lib/dsh/uploads",
    });
    expect(rowConfig(items, "lark-uploads")).toEqual({ uploadsRoot: "/var/lib/dsh/uploads" });
    expect(rowConfig(items, "lark-image")).toEqual({
      baseUrl: "https://cpa.rwr.ink/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-image-2",
      workspaceRoot: "/var/lib/dsh/workspaces",
      maxReferences: 8,
    });
    expect(rowConfig(items, "lark-run")).toMatchObject({
      host: "127.0.0.1",
      port: 18788,
      presetId: "lark-standard",
      agentPresetId: "lark-standard",
      workspaceRoot: "/var/lib/dsh/workspaces",
    });
    expect(rowConfig(items, "sandbox-oci")).toMatchObject({
      image: { __jsExpr: "process.env.DSH_SANDBOX_IMAGE" },
      network: "none",
      workspaceRoot: "/var/lib/dsh/workspaces",
    });
  });

  it("keeps Gateway and Admin on the loopback control plane", async () => {
    const gateway = await rows("gateway");
    const admin = await rows("admin");
    expect(rowConfig(gateway, "lark-run-client")).toMatchObject({ baseURL: "http://127.0.0.1:18788" });
    expect(rowConfig(gateway, "account-bot-fleet")).toMatchObject({ authEndpoint: "http://127.0.0.1:13080/internal/feishu-bots", stateDir: "/var/lib/dsh/account-bots", uploadsRoot: "/var/lib/dsh/uploads/account-bots" });
    expect(gateway.map(row => row.id)).toEqual(["account-bot-fleet", "lark-run-client"]);
    expect(rowConfig(admin, "host-webserver")).toMatchObject({ host: "127.0.0.1", port: 18791 });
    expect(rowConfig(admin, "knowledge-postgres")).toMatchObject({
      databaseUrlEnv: "DATABASE_URL",
      siliconflowApiKeyEnv: "SILICONFLOW_API_KEY",
    });
    expect(rowConfig(admin, "lark-admin")).toMatchObject({
      adminTokenEnv: "ADMIN_TOKEN",
      webRoot: "/opt/dsh/current/apps/admin-web/dist",
      controlPlane: {
        workerBaseUrl: "http://127.0.0.1:18788",
        workerTokenEnv: "WORKER_TOKEN",
      },
    });
  });
});
