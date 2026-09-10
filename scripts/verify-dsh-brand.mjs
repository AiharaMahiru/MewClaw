import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const failures = [];
const officialBrandPackages = [
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-web-frontend",
];

async function readRequired(path, label) {
  try {
    return await readFile(resolve(root, path), "utf8");
  } catch {
    failures.push(`${label}: 无法读取 ${path}`);
    return null;
  }
}

async function readJson(path, label) {
  const source = await readRequired(path, label);
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    failures.push(`${label}: 不是有效 JSON`);
    return null;
  }
}

function requireMatch(value, expected, label) {
  if (typeof value !== "string" || !value.includes(expected)) failures.push(`${label}: 缺少 ${expected}`);
}

const [workspacePackage, dshPackage, brandPackage, brandClient, brandHost, builtBrandClient, builtBrandHost, builtBrandTypes, webBundle, adminIndexHtml, adminApp, adminStyles] = await Promise.all([
  readJson("package.json", "工作区 package.json"),
  readJson("node_modules/@deepseek-ai/dsh/package.json", "已安装 DSH package.json"),
  readJson("packages/lark/atw-brand/package.json", "品牌插件 package.json"),
  readRequired("packages/lark/atw-brand/src/client.ts", "品牌客户端插件"),
  readRequired("packages/lark/atw-brand/src/index.ts", "品牌 Host 插件"),
  readRequired("packages/lark/atw-brand/client.js", "品牌客户端发布入口"),
  readRequired("packages/lark/atw-brand/lib/index.js", "品牌 Host 发布入口"),
  readRequired("packages/lark/atw-brand/lib/types/index.d.ts", "品牌发布声明"),
  readRequired("packages/bundle/web/cordis.patch.yml", "Web bundle 插件 roster"),
  readRequired("apps/admin-web/index.html", "管理台 HTML 入口"),
  readRequired("apps/admin-web/src/App.tsx", "管理台品牌组件"),
  readRequired("apps/admin-web/src/styles.css", "管理台品牌样式"),
]);

const expectedVersion = workspacePackage?.devDependencies?.["@deepseek-ai/dsh"];
if (typeof expectedVersion !== "string") failures.push("工作区 package.json 缺少精确的 @deepseek-ai/dsh 版本");
if (dshPackage?.name !== "@deepseek-ai/dsh" || dshPackage?.version !== expectedVersion) {
  failures.push(`DSH 安装包身份不匹配: 期望 @deepseek-ai/dsh@${expectedVersion}，实际 ${dshPackage?.name}@${dshPackage?.version}`);
}
for (const packageName of officialBrandPackages) {
  const installed = await readJson(`node_modules/${packageName}/package.json`, `${packageName} 安装包`);
  if (installed?.name !== packageName || installed?.version !== expectedVersion) {
    failures.push(`官方品牌包身份不匹配: 期望 ${packageName}@${expectedVersion}，实际 ${installed?.name}@${installed?.version}`);
  }
}

if (workspacePackage?.pnpm?.patchedDependencies !== undefined) failures.push("package.json 不得声明 patchedDependencies");
if (brandPackage?.name !== "dsh-lark-atw-brand") failures.push("品牌插件 package identity 错误");
if (brandPackage?.dsh?.client?.platform !== "web") failures.push("品牌插件缺少 Web client 声明");
for (const slot of ["conversation.hero.brand.mark", "sidebar.brand.mark", "sidebar.brand.name"]) {
  requireMatch(brandClient, slot, `品牌公开槽位 ${slot}`);
}
requireMatch(brandClient, 'id: "dsh-lark-atw-brand"', "品牌客户端注册");
requireMatch(brandHost, "ctx.webServer.tapIndex", "品牌 HTML transform");
requireMatch(brandHost, "ctx.webServer.register", "品牌静态资源路由");
requireMatch(brandHost, 'FAVICON_PATH = "/mewclaw-brand/favicon.svg"', "品牌 favicon 独占路由");
requireMatch(brandHost, 'MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest"', "品牌 manifest 独占路由");
requireMatch(brandHost, "MewClaw Harness", "品牌产品名称");
for (const [source, label] of [[builtBrandClient, "品牌客户端发布入口"], [builtBrandHost, "品牌 Host 发布入口"], [builtBrandTypes, "品牌发布声明"]]) {
  requireMatch(source, "MewClaw Harness", label);
  if (source?.includes("MewClaw Harnness")) failures.push(`${label}: 含陈旧品牌拼写`);
}
if (brandHost?.includes("grid-template-columns:104px") || builtBrandHost?.includes("grid-template-columns:104px")) {
  failures.push("品牌 Host 不得覆盖官方 Hero 网格布局");
}
requireMatch(webBundle, "id: ui-brand-official\n  disabled: true", "禁用官方品牌 occupant");
requireMatch(webBundle, "name: dsh-lark-atw-brand", "启用 MewClaw 品牌插件");

for (const source of [brandClient, brandHost]) {
  if (source?.includes("node_modules/")) failures.push("品牌插件不得读写 node_modules 官方产物");
}
requireMatch(adminIndexHtml, "<title>MewClaw Harness 管理工作台</title>", "管理台页面标题");
requireMatch(adminIndexHtml, 'rel="icon" type="image/svg+xml" href="/favicon.svg"', "管理台 favicon");
requireMatch(adminApp, 'viewBox="0 0 512 512"', "管理台 MewClaw 商标几何");
requireMatch(adminApp, 'className="mewclaw-mark-ink"', "管理台商标墨色分层");
requireMatch(adminStyles, "body[data-ds-dark-theme] .mewclaw-brand-mark", "管理台商标自动深色反转");
requireMatch(adminStyles, ".hHd-Xa_brandMark {", "管理台商标样式");

if (failures.length > 0) {
  console.error("[verify-dsh-brand] MewClaw 品牌插件校验失败：");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[verify-dsh-brand] MewClaw 品牌插件有效，官方 DSH ${expectedVersion} 保持原包`);
}
