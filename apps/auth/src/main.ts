/**
 * 认证边界进程：唯一面向浏览器，Worker/Admin 仍只绑定 loopback。
 * 凭证由 dsh-app-boot 的分层环境加载；本进程不直接读取或打印 .env。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// 生产从状态目录装载低优先级默认值；本地开发仍使用仓库根目录。
const launchEnvironment = loadLayeredEnv("auth", process.env.DSH_PROJECT_ENV_DIR?.trim() || repoRoot);

const ctx = await boot("auth", join(here, "..", "cordis.yml"), [], (hostCtx) => {
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironment);
});
if (process.argv.includes("--boot-check")) {
  await ctx.fiber.dispose();
  process.exit(0);
}
installSignalHandlers();

function installSignalHandlers(): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void ctx.fiber.dispose().then(
      () => process.exit(0),
      () => {
        console.error("[auth] graceful shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
