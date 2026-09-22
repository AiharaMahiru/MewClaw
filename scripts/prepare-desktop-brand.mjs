/** 桌面端使用专属品牌变体；基座包作为其依赖一并复制，不维护第二套桌面品牌源码。 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareDesktopBrand(destination) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  // 浏览器入口不由 tsc 生成；先物化同源 client，避免候选携带旧构建。
  await import('./build-web-auth-client.mjs');
  await prepareOne(repoRoot, destination, 'liquid-glass', undefined, 'ui');
  await prepareOne(repoRoot, destination, 'model-seat');
  await prepareOne(repoRoot, destination, 'mewclaw-brand');
  await prepareOne(repoRoot, destination, 'mewclaw-brand-desktop', manifest => {
    // npm workspace 以包名链接本地包；pnpm 的 workspace: 协议需改写为版本号。
    if (manifest.dependencies?.['dsh-lark-mewclaw-brand'] === 'workspace:*') {
      manifest.dependencies['dsh-lark-mewclaw-brand'] = '0.1.0';
    }
  });
}

async function prepareOne(repoRoot, destination, dir, patchManifest, domain = 'lark') {
  const source = resolve(repoRoot, 'packages', domain, dir);
  const target = resolve(destination, dir);
  await mkdir(target, { recursive: true });
  for (const file of ['src', 'client.js', 'package.json']) await cp(resolve(source, file), resolve(target, file), { recursive: true });
  if (dir === 'liquid-glass') await cp(resolve(source, 'THIRD_PARTY_LICENSES.txt'), resolve(target, 'THIRD_PARTY_LICENSES.txt'));
  const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  // 桌面直接分发已编译并附许可证的 client.js；其 React 组件已内联，不安装构建期库。
  if (dir === 'liquid-glass') delete manifest.dependencies['liquid-glass-react'];
  manifest.scripts = { build: 'tsc -b' };
  // 与 Web 同版，避免 npm lock 产生两套官方运行时。
  for (const group of ['peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[group] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) manifest[group][name] = '0.1.6-alpha.2';
    }
  }
  patchManifest?.(manifest);
  await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = JSON.parse(await readFile(resolve(source, 'tsconfig.json'), 'utf8'));
  if (dir === 'liquid-glass') config.exclude = [...config.exclude, 'src/client.ts'];
  delete config.extends;
  const base = JSON.parse(await readFile(resolve(repoRoot, 'tsconfig.base.json'), 'utf8'));
  config.compilerOptions = { ...base.compilerOptions, ...config.compilerOptions, types: ['node'] };
  delete config.compilerOptions.baseUrl;
  await writeFile(resolve(target, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
}
