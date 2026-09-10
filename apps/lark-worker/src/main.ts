/**
 * lark-worker 进程引导。
 *
 * 组合 = package.json 的 dsh.profile.bundles 逐层 patch
 * （dsh-base → dsh-lark-* → 官方 Web → 第三方 Web 扩展 → 本地 Web 政策层）。
 * 装载项目 .env 环境快照后 boot；常驻直到信号有序关停。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {} from "@deepseek-ai/dsh-host-webserver";
import { boot, loadLayeredEnv, loadOverlayPatches, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** app 目录（manifest 与 cordis.yml 的家）。 */
const root = join(here, "..");
/** 仓库根（项目 .env 层）。 */
const repoRoot = join(here, "..", "..", "..");

interface BundleManifest {
  dsh?: { bundle?: { patch?: string } };
}

async function resolveBundlePatch(bundle: string): Promise<string> {
  const manifestPath = require.resolve(`${bundle}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest;
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch === "string" && patch.length > 0) {
    return join(dirname(manifestPath), patch);
  }
  return require.resolve(`${bundle}/cordis.patch.yml`);
}

function webArgs(argv: readonly string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--boot-check") continue;
    if (arg === "--patch") {
      index += 1;
      continue;
    }
    args.push(arg);
  }
  return args;
}

// 项目 .env 进入启动环境快照（蓝图 §7：apps 不直接 dotenv 读值）。
// 生产从状态目录装载低优先级默认值；受管凭证文件仍可显式覆盖。
const launchEnvironment = loadLayeredEnv(
  "lark-worker",
  process.env.DSH_PROJECT_ENV_DIR?.trim() || repoRoot,
);

// 组合层：dsh.profile.bundles（bundle 包各自暴露 cordis.patch.yml）。
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dsh?: { profile?: { bundles?: string[] } };
};
const bundles = manifest.dsh?.profile?.bundles ?? [];
const bundlePatchPaths = await Promise.all(bundles.map(resolveBundlePatch));
const patches = bundlePatchPaths.flatMap((patchPath) =>
  loadOverlayPatches("lark-worker", patchPath),
);
// 可选覆盖层（--patch <file>，可重复；如 oci.overlay.yml 的 M2 生产路径）。
const patchArgIndexes: number[] = [];
process.argv.forEach((arg, index) => {
  if (arg === "--patch") patchArgIndexes.push(index + 1);
});
for (const fileIndex of patchArgIndexes) {
  const file = process.argv[fileIndex];
  if (file) patches.push(...loadOverlayPatches("lark-worker", require.resolve(join(process.cwd(), file))));
}

const configPath = resolveConfigPath(
  process.env.LARK_WORKER_CONFIG ?? join(root, "cordis.yml"),
  process.env.DSH_SNAPSHOT,
);

const ctx = await boot("lark-worker", configPath, patches, (hostCtx) => {
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment);
  provideCmdline(hostCtx, {
    args: webArgs(process.argv.slice(2)),
    exit: (code) => process.exit(code),
  });
});
console.log("[lark-worker] booted");

// 冒烟模式（--boot-check）：组合落定后立即干净关停。
if (process.argv.includes("--boot-check")) {
  await ctx.fiber.dispose();
  console.log("[lark-worker] disposed");
  process.exit(0);
}

// 常驻：信号 → 有序关停。
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void ctx.fiber.dispose().then(
    () => process.exit(0),
    () => {
      console.error("[lark-worker] graceful shutdown failed");
      process.exit(1);
    },
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
