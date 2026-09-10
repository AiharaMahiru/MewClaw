/** 创建独立、无官方依赖补丁的桌面验证树，不修改上游检出或生产。 */
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg || !isAbsolute(sourceArg) || !isAbsolute(destinationArg)) {
  throw new Error('用法：node scripts/prepare-desktop-candidate.mjs <上游绝对路径> <新候选绝对路径>');
}
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (destination === source || destination.startsWith(`${source}/`)) throw new Error('候选不得覆盖上游');
try { await access(destination); throw new Error('候选目录已存在，拒绝覆盖'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== 'a1ddcda8e701a8490c619ce411ea8a3d6daa1453') throw new Error('上游提交与评审基线不一致');
await mkdir(destination, { recursive: true });
await cp(resolve(source, 'dsh-plugin-desktop'), resolve(destination, 'dsh-plugin-desktop'), { recursive: true });
await cp(resolve(source, 'LICENSE'), resolve(destination, 'UPSTREAM-LICENSE'));
await cp(fileURLToPath(new URL('../apps/desktop/plugins/cloud', import.meta.url)), resolve(destination, 'mewclaw-cloud'), { recursive: true });
await cp(fileURLToPath(new URL('../packages/desktop/host', import.meta.url)), resolve(destination, 'mewclaw-host'), { recursive: true, filter: path => !path.split(/[\\/]/).includes('lib') });
const hostManifestPath = resolve(destination, 'mewclaw-host/package.json');
const hostManifest = JSON.parse(await readFile(hostManifestPath, 'utf8'));
// 桌面与服务器各自锁定官方版本，共享 Consumer 不把服务端版本带进 Electron。
for (const name of Object.keys(hostManifest.devDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-')) hostManifest.devDependencies[name] = '0.1.2-rc.1';
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
const sourceChanges = [];
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
const profileSource = await readFile(profilePath, 'utf8');
const providerLine = 'const DESKTOP_WEB_SERVER_PACKAGE = `${DESKTOP_PACKAGE_NAME}/webserver`';
if (!profileSource.includes(providerLine)) throw new Error('桌面 WebServer 组合入口已变化');
await writeFile(profilePath, profileSource.replace(providerLine, "const DESKTOP_WEB_SERVER_PACKAGE = process.env.MEWCLAW_DESKTOP_CLOUD === '1'\n  ? 'dsh-lark-desktop-cloud'\n  : `${DESKTOP_PACKAGE_NAME}/webserver`"));
sourceChanges.push('profile.ts: MewClaw 发行配置选择自有 WebServer Provider');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dependencies['dsh-lark-desktop-cloud'] = '0.1.0';
// 第三方市场及 AA 接入不在 MewClaw 首版范围；通过配置关闭，不修改其运行时代码。
for (const name of ['@agents-anywhere/dsh-bridge-next', 'dsh-community-market', 'dshmarket']) {
  delete manifest.dependencies[name];
}
delete manifest.scripts.prepack;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'mewclaw-desktop-candidate', version: '0.1.0-desktop.5',
  description: 'MewClaw desktop development build', author: 'MewClaw contributors', license: 'MIT',
  private: true, type: 'module', main: 'launcher.mjs',
  dependencies: { 'dsh-plugin-desktop': manifest.version, 'dsh-lark-desktop-cloud': '0.1.0' },
  workspaces: ['dsh-plugin-desktop', 'mewclaw-cloud', 'mewclaw-host'],
  scripts: { build: 'npm run build --workspace mewclaw-host && npm run build --workspace dsh-plugin-desktop && npm run build --workspace mewclaw-cloud' },
}, null, 2)}\n`);
await writeFile(resolve(destination, 'UPSTREAM.json'), `${JSON.stringify({
  repository: 'https://github.com/anywhere-labs/dsh-desktop', revision,
  desktop: manifest.version, dsh: manifest.dependencies['@deepseek-ai/dsh'],
  officialPatches: [], sourceChanges,
  manifestChanges: ['排除可选市场与 AA 依赖', '关闭发行 prepack 全仓库钩子'],
}, null, 2)}\n`);
console.log(`候选已创建：${destination}；仅生成候选清单，尚未验证兼容性`);
