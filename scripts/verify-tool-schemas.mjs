import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

// R49 事故防回归：裸 ctx.tools.register 的 parameters 由 schemaOf 原样
// 透传到 wire；传 defineTool 字段表会得到缺根 type 的 schema，provider
// 严格校验以 "type: null" 拒掉整轮请求（PTC 模式掩盖、native 模式暴露）。
//
// 两条硬规则：
// 1. .mjs 插件（无 typecheck 兜底）一律经 registerModelTool（bundle/web
//    的 tool-schema.mjs）注册——object 根断言失败在装载期抛错，boot-check 即拦。
// 2. .ts 源码禁止 register({...}) 内联字面量——走 defineTool 编译或先命名再
//    传引用，让类型与测试能兜住 schema 形状。
const root = process.cwd();
const HELPER = "packages/bundle/web/tool-schema.mjs";
const failures = [];

for (const base of ["apps", "infra", "packages", "scripts", "tests"]) {
  for (const path of await files(join(root, base))) {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (relativePath.includes("/node_modules/") || relativePath.includes("/dist/")
      || relativePath.includes("/lib/") || relativePath.includes(".test.")
      || relativePath.endsWith(".d.ts")) continue;
    const extension = extname(path);
    const source = await readFile(path, "utf8");
    if (extension === ".mjs") {
      // 用 [.] 写法避免本脚本的消息文本自我命中。
      if (relativePath !== HELPER && /[.]tools[.]register\s*[(]/u.test(source)) {
        failures.push(`${relativePath}: .mjs 插件禁止直接 tools.register()，改用 registerModelTool（${HELPER}）`);
      }
    } else if (extension === ".ts" || extension === ".tsx") {
      for (const match of source.matchAll(/[.]tools[.]register\s*[(]\s*(.)/gu)) {
        if (match[1] === "{") {
          failures.push(`${relativePath}: tools.register({...}) 内联字面量绕过 defineTool 编译，schema 形状无人校验`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("[verify-tool-schemas] 通过：.mjs 注册经 registerModelTool、.ts 无内联字面量注册");

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
