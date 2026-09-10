import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// 与 Auth/Worker/Admin 共用启动环境分层，应用不直接解析或输出凭证文件。
loadLayeredEnv("dsh-preview", process.env.DSH_PROJECT_ENV_DIR?.trim() || repoRoot);
const ctx = await boot("dsh-preview", join(here, "..", "cordis.yml"));

if (process.argv.includes("--boot-check")) {
  await ctx.fiber.dispose();
  process.exit(0);
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void ctx.fiber.dispose().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
