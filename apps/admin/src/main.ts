/**
 * admin 进程引导。
 *
 * 组合 = package.json 的 dsh.profile.bundles 逐层 patch（与 dsh CLI 的
 * profile 语义一致，分发时可直接被 `dsh --profile` 装载）。
 * 装载项目 .env 环境快照（credentials 的 project-env 层依赖它）后 boot；
 * 组合落定后常驻，直到 SIGINT/SIGTERM 有序关停。
 *
 * 组合只有 admin bundle——不挂 dsh-base：本进程物理上没有 agents/tools，
 * 管理面不可能执行工作区工具（硬边界）。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, loadLayeredEnv, loadOverlayPatches, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** app 目录（manifest 与 cordis.yml 的家）。 */
const root = join(here, "..");
/** 仓库根（项目 .env 层）。 */
const repoRoot = join(here, "..", "..", "..");

// 项目 .env 进入启动环境快照（蓝图 §7：apps 不直接 dotenv 读值）。
// 生产从状态目录装载低优先级默认值；受管凭证文件仍可显式覆盖。
const launchEnvironment = loadLayeredEnv(
  "lark-admin",
  process.env.DSH_PROJECT_ENV_DIR?.trim() || repoRoot,
);
console.log("[lark-admin] ADMIN_TOKEN present:", Boolean(process.env.ADMIN_TOKEN));

// 组合层：dsh.profile.bundles（bundle 包各自暴露 cordis.patch.yml）。
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dsh?: { profile?: { bundles?: string[] } };
};
const bundles = manifest.dsh?.profile?.bundles ?? [];
const patches = bundles.flatMap((bundle) =>
  loadOverlayPatches("lark-admin", require.resolve(`${bundle}/cordis.patch.yml`)),
);
// 可选覆盖层（--patch <file>，可重复；演练/交接用）。
const patchArgIndexes: number[] = [];
process.argv.forEach((arg, index) => {
  if (arg === "--patch") patchArgIndexes.push(index + 1);
});
for (const fileIndex of patchArgIndexes) {
  const file = process.argv[fileIndex];
  if (file) patches.push(...loadOverlayPatches("lark-admin", require.resolve(join(process.cwd(), file))));
}

const configPath = resolveConfigPath(
  process.env.LARK_ADMIN_CONFIG ?? join(root, "cordis.yml"),
  process.env.DSH_SNAPSHOT,
);

const ctx = await boot("lark-admin", configPath, patches, (hostCtx) => {
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment);
});
console.log("[lark-admin] booted");

// 冒烟模式（--boot-check）：组合落定后立即干净关停。
if (process.argv.includes("--boot-check")) {
  await ctx.fiber.dispose();
  console.log("[lark-admin] disposed");
  process.exit(0);
}

// 常驻：信号 → 有序关停（supervisor IPC 契约 M5 对接）。
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void ctx.fiber.dispose().then(
    () => process.exit(0),
    () => {
      console.error("[lark-admin] graceful shutdown failed");
      process.exit(1);
    },
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
