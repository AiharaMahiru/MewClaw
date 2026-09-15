/** 桌面端使用专属品牌变体；基座包作为其依赖一并复制，不维护第二套桌面品牌源码。 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareDesktopBrand(destination) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  await prepareOne(repoRoot, destination, 'mewclaw-brand');
  await prepareOne(repoRoot, destination, 'mewclaw-brand-desktop', manifest => {
    // npm workspace 以包名链接本地包；pnpm 的 workspace: 协议需改写为版本号。
    if (manifest.dependencies?.['dsh-lark-mewclaw-brand'] === 'workspace:*') {
      manifest.dependencies['dsh-lark-mewclaw-brand'] = '0.1.0';
    }
  });
}

async function prepareOne(repoRoot, destination, dir, patchManifest) {
  const source = resolve(repoRoot, 'packages/lark', dir);
  const target = resolve(destination, dir);
  await mkdir(target, { recursive: true });
  for (const file of ['src', 'client.js', 'package.json']) await cp(resolve(source, file), resolve(target, file), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  manifest.scripts = { build: 'tsc -b' };
  // 桌面候选与源码仓库统一使用 rc.2，避免 npm lock 产生两套官方运行时。
  for (const group of ['peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[group] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) manifest[group][name] = '0.1.5-rc.2';
    }
  }
  patchManifest?.(manifest);
  await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = JSON.parse(await readFile(resolve(source, 'tsconfig.json'), 'utf8'));
  delete config.extends;
  const base = JSON.parse(await readFile(resolve(repoRoot, 'tsconfig.base.json'), 'utf8'));
  config.compilerOptions = { ...base.compilerOptions, ...config.compilerOptions, types: ['node'] };
  delete config.compilerOptions.baseUrl;
  await writeFile(resolve(target, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
}
