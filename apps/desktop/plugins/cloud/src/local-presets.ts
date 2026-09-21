/** 本地模式 preset 物化：把随包 vendored 的云端 preset 集复制到
 * `$DSH_HOME/mewclaw-presets`，由 profile.ts 生成的 `agent-presets.roots`
 * 接进 roster，使本地模式的模式列表与云端同集同序。
 *
 * 为什么不直接让 roots 指向包内目录：preset 组合里的 `@deepseek-ai/*`
 * specifier 从组合文件所在目录向上解析 node_modules；安装目录内的 vendored
 * 副本能解析，但 roots 路径要由 profile 组合期写出——`profile.ts` 生成的根
 * 只能落在 `$DSH_HOME` 下，物化同时让 preset 脱离只读安装目录。loader 的
 * 发现语义（每次 list 重扫）不变。 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** vendored 布局：`agent-presets-lightweight/`、`agent-presets/`、`agent-presets-oci/`
 * 与 `tool-schema.mjs`，对应云端 packages/bundle/web/ 下的同名目录。 */
const STAMP_FILE = '.mewclaw-preset-stamp';
/** agent-presets 根内的目录扫描序须复刻云端：cordis 在前（云端该位是自定义
 * cordis；桌面运行时为 0.1.5 没有 dsh-plugin-manager，改拷官方 shipped
 * cordis——同名同位，cordis_mount 工具面在本机可工作），再 vendored 两目录。 */
const AGENT_PRESET_ORDER = ['lark-standard', 'liangshen'];

/** Edge rpc-policy 对 agentPresets/list 的显示层变换：只放行白名单 id 并改
 * 显示名。本地 roster 复刻同一变换，客户端字典再对 trust=system 的 preset
 * 做 i18n 覆盖，最终呈现与云端同款四项菜单；resolve/mount 不受影响。 */
export const CLOUD_PRESET_NAMES: Record<string, string> = {
  'lark-lightweight': '日常助手',
  standard: '通用工作',
  liangshen: '高效执行',
  cordis: '插件开发',
};

/** 复刻 Edge rpc-policy 的 roster 变换（id 白名单过滤 + 显示名改写）。 */
export function cloudPresetRoster<T extends { id: string }>(presets: readonly T[]): T[] {
  return presets.flatMap(item => {
    const name = CLOUD_PRESET_NAMES[item.id];
    return name === undefined ? [] : [{ ...item, name }];
  });
}

/** 递归收集目录下全部文件（相对路径 + 绝对路径）。 */
function* entries(dir: string, base = dir): Generator<{ path: string; file: string }> {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) yield* entries(full, base);
    else if (item.isFile()) yield { path: relative(base, full), file: full };
  }
}

/** vendored 树 + 官方 cordis 的合并指纹；任一侧内容变化触发重写。 */
function stampOf(roots: { source: string; prefix: string }[]): string {
  const hash = createHash('sha256');
  for (const { source, prefix } of roots) {
    if (!existsSync(source)) continue;
    for (const { path, file } of [...entries(source)].sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(prefix + '/' + path.split(sep).join('/'));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex');
}

/**
 * 物化云端 preset 集到 `home/mewclaw-presets`。幂等：内容指纹未变时直接跳过。
 * vendored `agent.cordis.yml` 里指向 `node_modules/@deepseek-ai/dsh-agent-presets/`
 * 的相对 `path:` 改写为运行时安装的官方包内绝对路径，与部署版本严格一致。
 * @returns 物化根目录；vendored 源缺失时返回 undefined（不应发生）。
 */
export function materializeLocalPresets(home: string): string | undefined {
  const vendored = fileURLToPath(new URL('../presets', import.meta.url));
  if (!existsSync(vendored)) return undefined;
  const require = createRequire(import.meta.url);
  const shipped = join(dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets');
  const dest = join(home, 'mewclaw-presets');
  const stamp = stampOf([
    { source: vendored, prefix: 'vendored' },
    { source: join(shipped, 'cordis'), prefix: 'shipped-cordis' },
  ]);
  const stampPath = join(dest, STAMP_FILE);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) return dest;

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'agent-presets'), { recursive: true });
  // 云端 agent-presets 根的目录序是 cordis < lark-standard < liangshen；
  // 先拷 cordis 占位以固定同一序（readdir 在此卷上按创建序返回）。
  if (existsSync(join(shipped, 'cordis'))) {
    cpSync(join(shipped, 'cordis'), join(dest, 'agent-presets', 'cordis'), { recursive: true });
  }
  for (const id of AGENT_PRESET_ORDER) {
    cpSync(join(vendored, 'agent-presets', id), join(dest, 'agent-presets', id), { recursive: true });
  }
  for (const dir of ['agent-presets-lightweight', 'agent-presets-oci']) {
    cpSync(join(vendored, dir), join(dest, dir), { recursive: true });
  }
  cpSync(join(vendored, 'tool-schema.mjs'), join(dest, 'tool-schema.mjs'));

  for (const { file } of entries(join(dest, 'agent-presets'))) {
    if (!file.endsWith('agent.cordis.yml')) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('node_modules/@deepseek-ai/dsh-agent-presets/')) continue;
    writeFileSync(file, text.replaceAll(
      /path:\s*'?(?:\.\.\/)+node_modules\/@deepseek-ai\/dsh-agent-presets\/presets\/([^\n']+)'?/g,
      (_, rest) => `path: '${join(shipped, rest.trim()).split(sep).join('/')}'`));
  }
  writeFileSync(stampPath, stamp);
  return dest;
}
