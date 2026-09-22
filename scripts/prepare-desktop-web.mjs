/** 从 Web 的已声明组合准备桌面资源；不复制服务器凭据或部署配置。 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 名称来自 Web 账号边界的既有策略；只改变官方 roster 的显示投影。 */
export async function prepareDesktopPresetPolicy(destination) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const policy = await readFile(resolve(root, 'packages/auth/edge/src/rpc-policy.ts'), 'utf8');
  const declaration = policy.match(/const names: Record<string, string> = \{([^}]+)\};/)?.[1];
  if (!declaration) throw new Error('WEB_PRESET_POLICY_CHANGED');
  const displayNames = Object.fromEntries([...declaration.matchAll(/(?:"([\w-]+)"|(\w+)):\s*"([^"]+)"/g)].map(match => [match[1] ?? match[2], match[3]]));
  if (!displayNames.standard) throw new Error('WEB_PRESET_DEFAULT_MISSING');
  const path = resolve(destination, 'dsh-plugin-desktop/src/profile.ts');
  const source = await readFile(path, 'utf8');
  const marker = /patches\.push\(\{\n      id: AGENT_PRESETS_ROW_ID,\n      config: ([^\n]+),\n    \}\)/;
  if (!marker.test(source)) throw new Error('DESKTOP_PRESET_PROVIDER_CHANGED');
  // Include patch 的 name 是匹配断言，不是替换字段；禁用旧 Provider 并插入新行。
  await writeFile(path, source.replace(marker, (_match, config) => `patches.push(\n      { id: AGENT_PRESETS_ROW_ID, disabled: true },\n      { insert: [{ id: 'mewclaw-agent-presets', name: 'dsh-lark-desktop-cloud/presets', config: ${config} }] },\n    )`)
    .replace("roots, default: 'standard'", `roots, displayNames: ${JSON.stringify(displayNames)}, default: 'standard'`));
}

/** 按 Web bundle → full overlay 顺序复用实际 UI 政策。 */
export async function writeDesktopWebPolicy(destination) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const rows = [];
  for (const file of ['packages/bundle/web/cordis.patch.yml', 'apps/lark-worker/full.overlay.yml']) {
    const policy = await readFile(resolve(root, file), 'utf8');
    rows.push(...[...policy.matchAll(/^- id: ((?:web-ui-[\w-]+)|ui-brand-official|ui-sidebar-files|ui-sidebar-terminal|ui-plugin-manager|terminal-controller|session-telemetry-otel)\n  disabled: (?:true|false)/gm)].map(match => match[0]));
  }
  if (rows.length === 0) throw new Error('WEB_UI_POLICY_MISSING');
  await writeFile(resolve(destination, 'mewclaw-cloud/web.patch.yml'), [
    '# 从 Web bundle 和 full overlay 生成，禁止手改候选。', ...rows,
    '- id: llm-deepseek\n  disabled: true', '- id: llm-pi-ai\n  disabled: true',
    '- insert:\n    - id: model-seat\n      name: dsh-lark-model-seat',
  ].join('\n') + '\n');
}

/** 复用 Web 模式文件，历史 wrapper 按官方包导出定位，兼容开发链接和物理发行。 */
export async function prepareDesktopWebPresets(destination) {
  const web = fileURLToPath(new URL('../packages/bundle/web/', import.meta.url));
  const cloud = resolve(destination, 'mewclaw-cloud');
  for (const directory of ['agent-presets', 'agent-presets-lightweight']) {
    await cp(resolve(web, directory), resolve(cloud, directory), { recursive: true });
  }
  for (const wrapper of ['agent-presets/lark-standard', 'agent-presets-lightweight/lark-lightweight']) {
    const path = resolve(cloud, wrapper, 'agent.cordis.yml');
    const source = await readFile(path, 'utf8');
    const relative = '../../../../node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml';
    const include = "name: '@deepseek-ai/cordis-plugin-include'\n  config:\n    path: " + relative;
    if (!source.includes(include)) throw new Error('WEB_STANDARD_PRESET_WRAPPER_CHANGED');
    await writeFile(path, source.replace(include, 'name: dsh-lark-desktop-cloud/standard-preset'));
  }
}

export async function prepareDesktopWeb(destination) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cloud = resolve(destination, 'mewclaw-cloud');
  const sourceManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const patches = sourceManifest.pnpm.patchedDependencies;
  await mkdir(resolve(destination, 'patches'), { recursive: true });
  for (const file of Object.values(patches)) await cp(resolve(root, file), resolve(destination, file));
  await writeFile(resolve(destination, 'web-patches.json'), JSON.stringify(patches, null, 2) + '\n');
  await cp(resolve(root, 'apps/desktop/apply-web-patches.mjs'), resolve(destination, 'apply-web-patches.mjs'));
  await prepareDesktopWebPresets(destination);
  await cp(resolve(root, 'packages/bundle/web/tool-schema.mjs'), resolve(cloud, 'tool-schema.mjs'));
  await cp(resolve(root, 'packages/lark/web-auth/client.js'), resolve(cloud, 'web-auth-client.js'));
  await writeDesktopWebPolicy(destination);
  const worker = JSON.parse(await readFile(resolve(root, 'apps/lark-worker/package.json'), 'utf8'));
  const bundles = worker.dsh.profile.bundles.filter(name => name === 'dsh-context' || name === '@linxin666/dsh-web-all');
  const path = resolve(destination, 'dsh-plugin-desktop/src/profile.ts');
  let source = await readFile(path, 'utf8');
  const required = 'return [...template.bundles]';
  const presets = "const shippedRoot = shippedPresetRoot()\n    const roots: Array<{ path: string, trust: 'system' | 'user' }> = [\n      { path: shippedRoot, trust: 'system' },\n      { path: join(home, USER_PRESET_DIRNAME), trust: 'user' },\n    ]";
  const end = 'patches: structuredClone(patches),';
  if (![required, presets, end].every(marker => source.includes(marker))) throw new Error('DESKTOP_WEB_COMPOSITION_CHANGED');
  source = source.replace(required, `return [...template.bundles, ...${JSON.stringify(bundles)}]`)
    .replace("const USER_PRESET_DIRNAME = '.agent-presets'\n", '')
    .replace(presets, "const webRoot = dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud/package.json'))\n    const roots: Array<{ path: string, trust: 'system' | 'user' }> = [\n      { path: join(webRoot, 'agent-presets-lightweight'), trust: 'system' },\n      { path: join(webRoot, 'agent-presets'), trust: 'system' },\n      { path: shippedPresetRoot(), trust: 'system' },\n    ]")
    .replace('roots, includeUserRoot: false', "roots, default: 'standard', includeShippedRoot: false, includeUserRoot: false")
    .replace("if (platform === 'win32') {\n    if (!rows.has(DIRECTORY_PICKER_ROW_ID))", "{\n    if (!rows.has(DIRECTORY_PICKER_ROW_ID))")
    .replace("if (pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE", "if (platform === 'win32' && pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE")
    .replace(end, "patches: structuredClone([...patches, ...loadOverlayPatches(BIN_NAME, createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud/web.patch.yml'))]),");
  await writeFile(path, source);
  await prepareDesktopPresetPolicy(destination);
  const dependencies = Object.fromEntries([...bundles, 'dsh-better-sidebar'].map(name => [name, worker.dependencies[name]]));
  // Desktop 的公开 Loader 以安装根解析 bare 插件；把官方组合声明的包显式列入，
  // 避免 npm 把 provider 留在 bundle 私有 node_modules，导致 Host 无法解析。
  for (const name of ['dsh-base', 'dsh-web-app', 'dsh-agent-presets']) {
    const manifest = JSON.parse(await readFile(resolve(root, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@deepseek-ai/dsh-')) dependencies[dependency] = worker.dependencies['@deepseek-ai/dsh'];
    }
  }
  return dependencies;
}
