import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Web 插件的 client.js 不会由 tsc -b 生成；所有浏览器入口必须在一次构建中
// 物化，否则新的品牌槽位插件会在下一次发布时静默丢失。
const entries = [
  ["packages/desktop/workspace/src/client.ts", "packages/desktop/workspace/client.js"],
  ["packages/lark/web-auth/src/client.ts", "packages/lark/web-auth/client.js"],
  ["packages/lark/atw-brand/src/client.ts", "packages/lark/atw-brand/client.js"],
].map(([source, target]) => ({
  sourcePath: resolve(root, source),
  targetPath: resolve(root, target),
}));

await Promise.all(entries.map(({ sourcePath, targetPath }) => build({
  entryPoints: [sourcePath],
  outfile: targetPath,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
})));
