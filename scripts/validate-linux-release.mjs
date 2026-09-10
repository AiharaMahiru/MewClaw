import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
// 启动门禁必须独立于部署凭据；这些是假值，只验证凭据引用和组合装载，不用于请求。
const BOOT_CHECK_ENV = Object.freeze({
  CREDENTIAL_ROLLBACK_KEY: "release-check-credential-rollback-key",
  DATABASE_URL: "postgres://release-check",
  DEEPSEEK_API_KEY: "release-check-deepseek-key",
  FIRECRAWL_API_KEY: "release-check-firecrawl-key",
  LARK_APP_ID: "cli_0123456789abcdef",
  LARK_APP_SECRET: "release-check-lark-secret",
  OPENAI_API_KEY: "release-check-openai-key",
  SILICONFLOW_API_KEY: "release-check-siliconflow-key",
  VISION_OPENAI_API_KEY: "release-check-vision-key",
  WORKER_TOKEN: "release-check-worker-token",
  DSH_BROWSER_WORKSPACE_ROOT: resolve(root, ".release-check/browser/workspaces"),
  DSH_BROWSER_STATE_ROOT: resolve(root, ".release-check/browser/state"),
  DSH_PREVIEW_WORKSPACE_ROOT: resolve(root, ".release-check/preview/workspaces"),
  DSH_PREVIEW_IMAGE: "localhost/dsh-preview:release-check",
});

await runNode(["scripts/verify-dsh-brand.mjs"]);
await runNode(["scripts/verify-plugin-boundaries.mjs"]);
await runNode(["apps/lark-gateway/dist/main.js", "--boot-check"]);
await runNode([
  "apps/lark-worker/dist/main.js",
  "--patch",
  "apps/lark-worker/lightweight.overlay.yml",
  "--patch",
  "apps/lark-worker/web-port0.overlay.yml",
  "--patch",
  "apps/lark-worker/boot-check.overlay.yml",
  "--port",
  "0",
  "--no-open",
  "--boot-check",
]);
await runNode([
  "apps/lark-worker/dist/main.js",
  "--patch",
  "apps/lark-worker/full.overlay.yml",
  "--patch",
  "apps/lark-worker/full-port0.overlay.yml",
  "--patch",
  "apps/lark-worker/boot-check.overlay.yml",
  "--port",
  "0",
  "--no-open",
  "--boot-check",
], { unsetEnv: ["DSH_SANDBOX_IMAGE"] });
await runNode(["apps/admin/dist/main.js", "--patch", "apps/admin/boot-check.overlay.yml", "--boot-check"]);
await runNode(["apps/browser/dist/main.js", "--boot-check"]);
await runNode(["apps/preview/dist/main.js", "--boot-check"]);
await validateAuth();
await validateMigration();

console.log("[linux-release] unpacked validation passed");

async function runNode(args, options) {
  await runCommand(process.execPath, args, options);
}

async function runCommand(command, args, options = {}) {
  const env = { ...process.env, ...BOOT_CHECK_ENV };
  for (const name of options.unsetEnv ?? []) delete env[name];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(undefined);
      else rejectPromise(new Error(`command failed: ${command} ${args.join(" ")} (${code ?? "signal"})`));
    });
  });
}

async function validateAuth() {
  const { runAuthApp } = await import(pathToFileURL(resolve(root, "apps/auth/dist/app.js")).href);
  await runAuthApp({
    bootCheck: true,
    config: {
      adminWorkspaceRoot: resolve(root, ".release-check/auth/admin"),
      databaseUrl: "postgres://release-check",
      host: "127.0.0.1",
      mail: { mode: "console", port: 465, secure: true },
      port: 3080,
      publicOrigin: "http://127.0.0.1:3080",
      requestBodyLimit: 128 * 1024,
      sessionCookieSecure: false,
      trustedOrigins: ["http://127.0.0.1:3080"],
      userModelEncryptionKey: "A".repeat(43),
      userWorkspaceRoot: resolve(root, ".release-check/auth/users"),
      workerBaseUrl: "http://127.0.0.1:3081",
    },
    dependencies: {
      createStore: () => ({ close: async () => undefined, migrate: async () => undefined }),
      createMailSender: () => ({
        sendPasswordReset: async () => undefined,
        sendVerification: async () => undefined,
      }),
      createService: () => ({}),
      createEdgeServer: () => createAuthEdgeStub(),
    },
    log: () => undefined,
  });
}

function createAuthEdgeStub() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{\"ok\":true}");
  });
  return {
    address: () => server.address(),
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    }),
    listen: () => new Promise((resolvePromise, rejectPromise) => {
      server.listen(0, "127.0.0.1", (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    }),
  };
}

async function validateMigration() {
  const { runMigrationCli } = await import(pathToFileURL(resolve(root, "apps/migration/dist/cli.js")).href);
  const exitCode = await runMigrationCli([
    "--boot-check",
    "--tenant-id",
    "release-check",
    "--bot-id",
    "release-check",
    "--deployment-id",
    "release-check",
    "--user-id",
    "release-check-admin",
    "--conversation-id",
    "release-check",
    "--operator-session-id",
    "release-check-session",
    "--request-id",
    "release-check-request",
  ], {
    start: async () => ({ dispose: async () => undefined, service: {} }),
    writeStderr: () => undefined,
    writeStdout: () => undefined,
  });
  if (exitCode !== 0) throw new Error(`migration boot-check failed with exit code ${exitCode}`);
}
