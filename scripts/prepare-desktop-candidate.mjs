/** 创建独立、无官方依赖补丁的桌面验证树，不修改上游检出或生产。 */
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDesktopUiContract } from './desktop-ui-contract.mjs';
import { prepareDesktopBrand } from './prepare-desktop-brand.mjs';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg || !isAbsolute(sourceArg) || !isAbsolute(destinationArg)) {
  throw new Error('用法：node scripts/prepare-desktop-candidate.mjs <上游绝对路径> <新候选绝对路径>');
}
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (destination === source || destination.startsWith(`${source}${sep}`)) throw new Error('候选不得覆盖上游');
try { await access(destination); throw new Error('候选目录已存在，拒绝覆盖'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== 'a1ddcda8e701a8490c619ce411ea8a3d6daa1453') throw new Error('上游提交与评审基线不一致');
await mkdir(destination, { recursive: true });
await cp(resolve(source, 'dsh-plugin-desktop'), resolve(destination, 'dsh-plugin-desktop'), { recursive: true });
const desktopPatch = fileURLToPath(new URL('../apps/desktop/patches/cloud-layout-bridge.patch', import.meta.url));
execFileSync('git', ['apply', '--whitespace=error-all', desktopPatch], { cwd: destination, stdio: 'inherit' });
await prepareDesktopUiContract(destination);
await cp(resolve(source, 'LICENSE'), resolve(destination, 'UPSTREAM-LICENSE'));
await cp(fileURLToPath(new URL('../apps/desktop/plugins/cloud', import.meta.url)), resolve(destination, 'mewclaw-cloud'), {
  recursive: true, filter: path => !path.split(/[\\/]/).includes('lib'),
});
await prepareDesktopBrand(destination);
await cp(fileURLToPath(new URL('../packages/desktop/host', import.meta.url)), resolve(destination, 'mewclaw-host'), { recursive: true, filter: path => !path.split(/[\\/]/).includes('lib') });
const hostManifestPath = resolve(destination, 'mewclaw-host/package.json');
const hostManifest = JSON.parse(await readFile(hostManifestPath, 'utf8'));
// 桌面与服务器各自锁定官方版本，共享 Consumer 不把服务端版本带进 Electron。
for (const name of Object.keys(hostManifest.devDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-')) hostManifest.devDependencies[name] = '0.1.5-rc.2';
}
await writeFile(hostManifestPath, JSON.stringify(hostManifest, null, 2) + '\n');
const hostTsconfigPath = resolve(destination, 'mewclaw-host/tsconfig.json');
const hostTsconfig = JSON.parse(await readFile(hostTsconfigPath, 'utf8'));
delete hostTsconfig.extends;
hostTsconfig.compilerOptions = { ...JSON.parse(await readFile(fileURLToPath(new URL('../tsconfig.base.json', import.meta.url)), 'utf8')).compilerOptions, ...hostTsconfig.compilerOptions };
delete hostTsconfig.compilerOptions.baseUrl;
hostTsconfig.compilerOptions.types = ['node'];
await writeFile(hostTsconfigPath, JSON.stringify(hostTsconfig, null, 2) + '\n');
await cp(fileURLToPath(new URL('../apps/desktop/launcher.mjs', import.meta.url)), resolve(destination, 'launcher.mjs'));
await cp(fileURLToPath(new URL('../apps/desktop/electron-builder.cjs', import.meta.url)), resolve(destination, 'electron-builder.cjs'));
await cp(fileURLToPath(new URL('../apps/desktop/release-path.cjs', import.meta.url)), resolve(destination, 'release-path.cjs'));
const sourceChanges = [];
sourceChanges.push('dsh-plugin-desktop: 云端与本地统一 DSH 0.1.5 的 main/rightbar、品牌与布局服务契约');
sourceChanges.push('原生 file 页面去掉无效 meta frame-ancestors；ProfilePatchReload 类型从公开 Profile 推导');
for (const filename of ['index.ts', 'notifications.ts']) {
  const path = resolve(destination, 'dsh-plugin-desktop/src', filename);
  const original = await readFile(path, 'utf8');
  if (!original.includes("import { settingsNamespace } from '@deepseek-ai/dsh-settings'")) {
    throw new Error(`桌面消费方接口已变化：${filename}`);
  }
  const updated = original.replace("import { settingsNamespace } from '@deepseek-ai/dsh-settings'\n", '')
    .replaceAll(/settingsNamespace\(([^()]+)\)/g, '$1');
  await writeFile(path, updated);
  sourceChanges.push(`${filename}: settingsNamespace 改为官方支持的字符串参数`);
}
const smokePath = resolve(destination, 'dsh-plugin-desktop/src/packaged-runtime-smoke.ts');
const smokeSource = await readFile(smokePath, 'utf8');
const asarPattern = String.raw`/([\\/])app\.asar\.unpacked\1/u.test(rgPath)`;
if (!smokeSource.includes(asarPattern)) throw new Error('上游原生路径烟雾入口已变化');
await writeFile(smokePath, smokeSource.replace(asarPattern,
  String.raw`/([\\/])resources\1(?:app\.asar\.unpacked\1)?node_modules\1/u.test(rgPath)`));
sourceChanges.push('packaged-runtime-smoke.ts: 接受独立物理 resources/node_modules 的原生依赖布局');
const manifestPath = resolve(destination, 'dsh-plugin-desktop/package.json');
const profilePath = resolve(destination, 'dsh-plugin-desktop/src/profile.ts');
const profileSource = (await readFile(profilePath, 'utf8')).replaceAll('\r\n', '\n');
const providerLine = 'const DESKTOP_WEB_SERVER_PACKAGE = `${DESKTOP_PACKAGE_NAME}/webserver`';
if (!profileSource.includes(providerLine)) throw new Error('桌面 WebServer 组合入口已变化');
const asarFallbackAnchor = "export function healDesktopProfileModuleFallback(home: string, profile?: Profile): Promise<void> {\n  const heal = () => healProfilesModuleFallback({\n    installAnchor: INSTALL_ANCHOR,\n    home,\n    ...(profile === undefined ? {} : { profile }),\n  })\n";
if (!profileSource.includes(asarFallbackAnchor)) throw new Error('桌面 ASAR fallback 入口已变化');
const asarFallbackReplacement = "function healDesktopAsarFallback(home: string, profile: Profile | undefined): Promise<void> {\n  const runtime = process as NodeJS.Process & { pkg?: unknown };\n  const packagedAsar = /([\\\\/])app\\.asar([\\\\/]|$)/u.test(INSTALL_ANCHOR);\n  if (!packagedAsar) return healProfilesModuleFallback({\n    installAnchor: INSTALL_ANCHOR,\n    home,\n    ...(profile === undefined ? {} : { profile }),\n  });\n  const hadPkg = Object.prototype.hasOwnProperty.call(runtime, 'pkg');\n  const previousPkg = runtime.pkg;\n  runtime.pkg = true;\n  return healProfilesModuleFallback({\n    installAnchor: INSTALL_ANCHOR,\n    home,\n    ...(profile === undefined ? {} : { profile }),\n  }).finally(() => {\n    if (hadPkg) runtime.pkg = previousPkg;\n    else delete runtime.pkg;\n  });\n}\n\nexport function healDesktopProfileModuleFallback(home: string, profile?: Profile): Promise<void> {\n  const heal = () => healDesktopAsarFallback(home, profile)\n";
await writeFile(profilePath, profileSource.replace(providerLine, "const DESKTOP_WEB_SERVER_PACKAGE = process.env.MEWCLAW_DESKTOP_CLOUD === '1'\n  ? 'dsh-lark-desktop-cloud'\n  : `${DESKTOP_PACKAGE_NAME}/webserver`")
  .replace(asarFallbackAnchor, asarFallbackReplacement)
  .replace('  type ProfilePatchReload,\n', '')
  .replace("import { resolveDshHome }", "type ProfilePatchReload = Profile['patchReload']\nimport { resolveDshHome }"));
sourceChanges.push('profile.ts: MewClaw 发行配置选择自有 WebServer Provider，并将 ASAR fallback 生成为物理代理');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
// 0.1.5 新增会话上传 peer，显式锁定，避免 npm 自动选中其他候选版本。
manifest.dependencies['@deepseek-ai/dsh-client-file-upload'] = '0.1.5-rc.2';
manifest.devDependencies.lexical = '0.49.0';
manifest.devDependencies.shiki = '4.3.1';
manifest.devDependencies['@shikijs/langs'] = '4.3.1';
Object.assign(manifest.devDependencies, {
  anser: '2.3.5', katex: '0.16.47', 'micromark-core-commonmark': '2.0.3',
  zustand: '4.4.7', immer: '10.1.1',
  'micromark-util-classify-character': '2.0.1', 'micromark-factory-space': '2.0.1',
  'micromark-extension-math': '3.1.0', 'mdast-util-from-markdown': '2.0.3',
  'mdast-util-gfm': '3.1.0', 'mdast-util-math': '3.0.0', 'micromark-extension-gfm': '3.0.0',
});
for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[group] ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) manifest[group][name] = '0.1.5-rc.2';
  }
}
manifest.dependencies['dsh-lark-desktop-cloud'] = '0.1.0';
// 第三方市场及 AA 接入不在 MewClaw 首版范围；通过配置关闭，不修改其运行时代码。
for (const name of ['@agents-anywhere/dsh-bridge-next', 'dsh-community-market', 'dshmarket']) {
  delete manifest.dependencies[name];
}
delete manifest.scripts.prepack;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await cp(fileURLToPath(new URL('../apps/desktop/generate-mewclaw-icon.mjs', import.meta.url)), resolve(destination, 'generate-mewclaw-icon.mjs'));
await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'mewclaw-desktop-candidate', version: '1.0.0',
  description: 'MewClaw desktop development build', author: 'MewClaw contributors', license: 'MIT',
  private: true, type: 'module', main: 'launcher.mjs',
  dependencies: { 'dsh-plugin-desktop': manifest.version, 'dsh-lark-desktop-cloud': '0.1.0' },
  overrides: JSON.parse(await readFile(fileURLToPath(new URL('../apps/desktop/dsh-overrides.json', import.meta.url)), 'utf8')),
  workspaces: ['dsh-plugin-desktop', 'mewclaw-cloud', 'mewclaw-host', 'mewclaw-brand'],
  scripts: { build: 'npm run build --workspace mewclaw-host && npm run build --workspace mewclaw-brand && node generate-mewclaw-icon.mjs && npm run build --workspace dsh-plugin-desktop && npm run build --workspace mewclaw-cloud' },
}, null, 2)}\n`);
await writeFile(resolve(destination, 'UPSTREAM.json'), `${JSON.stringify({
  repository: 'https://github.com/anywhere-labs/dsh-desktop', revision,
  desktop: manifest.version, dsh: manifest.dependencies['@deepseek-ai/dsh'],
  officialPatches: [], sourceChanges,
  manifestChanges: ['排除可选市场与 AA 依赖', '关闭发行 prepack 全仓库钩子'],
}, null, 2)}\n`);
await cp(fileURLToPath(new URL('../apps/desktop/candidate.package-lock.json', import.meta.url)), resolve(destination, 'package-lock.json'));
console.log(`候选已创建：${destination}；已复制冻结锁文件，尚未验证兼容性`);
