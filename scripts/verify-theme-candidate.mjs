/** 候选真实模块解析、官方 HTTP 变换与完整 Worker 启动；所有状态位于新临时目录。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(process.argv[2] || "");
assert.ok(process.argv[2], "必须指定已完成的候选目录");
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = await mkdtemp(join(tmpdir(), "mew-glass-candidate-"));
const require = createRequire(join(root, "apps/lark-worker/dist/main.js"));
const modulePath = require.resolve("dsh-lark-liquid-glass");
assert.ok(modulePath.startsWith(root + "/"), "主题解析到了候选之外");
const theme = await import(pathToFileURL(modulePath));
const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
const { default: WebServer } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-host-webserver")));
const ctx = new Context();
ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
ctx.plugin(theme, { enabled: true, identityTimeoutMs: 5000 });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("候选 HTTP 服务未就绪")), 5000);
    ctx.inject(["webServer"], () => { clearTimeout(timeout); resolve(); });
  });
  const index = await readFile(join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.webServer.registerFallback((_req, res) => { res.setHeader("content-type", "text/html"); res.end(ctx.webServer.renderIndex(index)); });
  const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="mewclaw-liquid-glass-config"'));
  assert.ok(html.includes('"identityTimeoutMs":5000'));
} finally { await ctx.fiber.dispose(); }

const env = {
  PATH: process.env.PATH, LANG: "C.UTF-8",
  DSH_HOME: state, DSH_PROJECT_ENV_DIR: state,
  DATABASE_URL: "postgres://release-check", WORKER_TOKEN: "release-check-worker-token",
  DEEPSEEK_API_KEY: "release-check-deepseek-key", OPENAI_API_KEY: "release-check-openai-key",
  SILICONFLOW_API_KEY: "release-check-siliconflow-key", VISION_OPENAI_API_KEY: "release-check-vision-key",
  FIRECRAWL_API_KEY: "release-check-firecrawl-key", CREDENTIAL_ROLLBACK_KEY: "release-check-rollback-key",
  DSH_SANDBOX_IMAGE: "localhost/dsh-lark-sandbox:release-check",
};
const args = ["apps/lark-worker/dist/main.js",
  "--patch", "apps/lark-worker/full.overlay.yml",
  "--patch", "apps/lark-worker/oci.overlay.yml",
  "--patch", "apps/lark-worker/full-port0.overlay.yml",
  "--patch", "apps/lark-worker/boot-check.overlay.yml",
  "--patch", relative(root, join(source, "config/liquid-glass.patch.yml")),
  "--port", "0", "--no-open", "--boot-check"];
const log = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("候选 Worker 启动超时")); }, 45000);
  child.on("error", reject);
  child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(output)); });
});
await writeFile(join(state, "worker-boot.log"), log);
assert.ok(log.includes("[lark-worker] disposed"));
assert.ok(log.includes("preset mounted:"));
console.log(JSON.stringify({ status: "THEME_CANDIDATE_VERIFIED", root, modulePath, actualHttpTransform: true, fullOciPresetsMounted: true, state }, null, 2));
