import { Context } from "@deepseek-ai/cordis";
import { AgentPresets } from "@deepseek-ai/dsh-agent-presets";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

it("OCI 实际 roster 解析 minimal 指向管道版而非默认内置 PTY 版", async () => {
  const root = process.cwd();
  const rows = loadOverlayPatches("oci-roster-test", resolve(root, "apps/lark-worker/oci.overlay.yml"));
  const config = rows.find((row) => row.id === "agent-presets")?.config;
  expect(config).toMatchObject({ includeShippedRoot: false });
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(resolve(root, "apps/lark-worker/entry.mjs")).href;
  ctx.provide("sessionProjections", { register: () => () => {} } as never);
  const roster = new AgentPresets(ctx, {
    default: "minimal", includeUserRoot: false, includeShippedRoot: false,
    roots: [
      { path: resolve(root, "packages/bundle/web/agent-presets-oci"), trust: "system" },
      { path: resolve(root, "node_modules/@deepseek-ai/dsh-agent-presets/presets"), trust: "system" },
    ],
  });
  try {
    const preset = await roster.resolve("minimal");
    expect(JSON.stringify(preset)).toContain("agent-presets-oci/minimal");
    const composition = await readFile(resolve(root, "packages/bundle/web/agent-presets-oci/minimal/agent.cordis.yml"), "utf8");
    expect(composition).toContain("../pipe-bash.mjs");
    expect(composition).not.toContain("dsh-terminal-bash");
  } finally { await ctx.fiber.dispose(); }
});
