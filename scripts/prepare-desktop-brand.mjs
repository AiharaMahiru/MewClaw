/** 复用 Web 的品牌插件源码和客户端，不维护第二套桌面品牌。 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareDesktopBrand(destination) {
  const source = fileURLToPath(new URL('../packages/lark/atw-brand/', import.meta.url));
  const target = resolve(destination, 'mewclaw-brand');
  await mkdir(target, { recursive: true });
  for (const file of ['src', 'client.js', 'package.json']) await cp(resolve(source, file), resolve(target, file), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
  manifest.scripts = { build: 'tsc -b' };
  await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = JSON.parse(await readFile(resolve(source, 'tsconfig.json'), 'utf8'));
  delete config.extends;
  const base = JSON.parse(await readFile(fileURLToPath(new URL('../tsconfig.base.json', import.meta.url)), 'utf8'));
  config.compilerOptions = { ...base.compilerOptions, ...config.compilerOptions, types: ['node'] };
  delete config.compilerOptions.baseUrl;
  await writeFile(resolve(target, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
}
