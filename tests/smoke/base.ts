/**
 * M0 冒烟：验证「bundle patch 层 + boot()」机制在本仓库可用。
 *
 * 以 dsh-base 自带的 cordis.patch.yml 作为 insert 层挂到空组合上：
 * 组合落定后立即关停；任何一行装载失败都会让 boot() 抛错、进程非零退出。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// dsh-base 通过 exports 暴露自己的 bundle patch 文件；解析出磁盘路径供 Loader 读取。
const basePatch = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
const patches = loadOverlayPatches("smoke-base", basePatch);

const ctx = await boot("smoke-base", join(here, "empty.cordis.yml"), patches);
console.log("[smoke-base] dsh-base bundle mounted");
await ctx.fiber.dispose();
console.log("[smoke-base] disposed");
