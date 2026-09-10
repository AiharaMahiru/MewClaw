import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const extensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const forbidden = [
  [/\bserver\.emit\s*=/u, "禁止替换 Server.emit"],
  [/\brequestRejection\s*=/u, "禁止替换 requestRejection"],
  [/\bauthorizeIndex\s*=/u, "禁止替换 authorizeIndex"],
  [/\b(?:host|window)\.fetch\s*=/u, "禁止替换浏览器全局 fetch"],
  [/Object\.defineProperty\(window,\s*["']open["']/u, "禁止替换 window.open"],
  [/\bwindow\.open\s*=/u, "禁止替换 window.open"],
  [/\bprocess\.env\.[A-Za-z0-9_]+\s*(?:\?\?=|=(?!=))/u, "插件不得改写 process.env"],
];
const failures = [];

for (const base of ["apps", "packages"]) {
  for (const path of await files(join(root, base))) {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (relativePath.includes("/node_modules/") || relativePath.includes(".test.")) continue;
    if (!extensions.has(extname(path))) continue;
    const source = await readFile(path, "utf8");
    for (const [pattern, message] of forbidden) {
      if (pattern.test(source)) failures.push(`${relativePath}: ${message}`);
    }
  }
}

for (const stale of [
  "packages/lark/web-auth/lib/client-prompt-audit.js",
  "packages/lark/web-auth/lib/client-prompt-audit.js.map",
  "packages/lark/web-auth/lib/types/client-prompt-audit.d.ts",
]) {
  if (await exists(join(root, stale))) failures.push(`${stale}: 已删除源码的陈旧构建产物仍存在`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("[verify-plugin-boundaries] 通过：无官方对象/浏览器全局改写、process.env 写入或已知陈旧产物");

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}
