/** 社区 Desktop Consumer 升级到官方 0.1.5 契约，官方包保持原样。 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareDesktopAlphaContract } from './desktop-alpha-contract.mjs';

export async function prepareDesktopUiContract(destination) {
  const directory = resolve(destination, 'dsh-plugin-desktop/src/client');
  const contractPath = resolve(directory, 'contracts.ts');
  const contract = (await readFile(contractPath, 'utf8')).replaceAll('\r\n', '\n');
  if (!contract.includes("import type {} from '@deepseek-ai/dsh-client-ui-layout/client'")) {
    throw new Error('DESKTOP_CONTRACT_CHANGED');
  }
  const shell = await readFile(resolve(directory, 'advanced-shell.ts'), 'utf8');
  if (!shell.includes("'main'") || !shell.includes("'rightbar'")) throw new Error('DESKTOP_PANEL_CONTRACT_CHANGED');
  await prepareNativeCsp(destination);
  await prepareDesktopCli(destination);
  await preparePackagedSmoke(destination);
  await prepareDesktopAlphaContract(destination);
}

/** 独立发行把 ripgrep 放入 extraResources；冒烟须精确核对该物理路径。 */
export async function preparePackagedSmoke(destination) {
  const path = resolve(destination, 'dsh-plugin-desktop/src/packaged-runtime-smoke.ts');
  const source = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('assert(\n  usesAsar\n');
  const end = source.indexOf('assert(existsSync(rgPath)', start);
  if (start < 0 || end < 0) throw new Error('DESKTOP_NATIVE_SMOKE_CONTRACT_CHANGED');
  const assertion = "assert(\n  rgPath === fileURLToPath(new URL('../../../node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', installAnchor)),\n  `resolved ripgrep outside MewClaw extraResources: ${rgPath}`,\n)\n";
  const adapted = source.slice(0, start) + assertion + source.slice(end);
  // 本发行的应用根在插件目录之上两层；依赖由 electron-builder 提升到应用根。
  await writeFile(path, adapted.replace("verifyBundledSkills(fileURLToPath(new URL('./', installAnchor)))",
    "verifyBundledSkills(fileURLToPath(new URL('../../', installAnchor)))"));
}

export async function prepareDesktopCli(destination) {
  const path = resolve(destination, 'dsh-plugin-desktop/src/desktop-cli.ts');
  const source = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  if (!source.includes('runCli({ allowDesktopProfile: true })')) throw new Error('DESKTOP_CLI_CONTRACT_CHANGED');
}

export async function prepareNativeCsp(destination) {
  for (const file of ['desktop-dialog', 'profile-create', 'profile-selector', 'recovery', 'setup-wizard']) {
    const path = resolve(destination, 'dsh-plugin-desktop/src/native-ui', file + '.html');
    const html = await readFile(path, 'utf8');
    // frame-ancestors 仅在 HTTP 响应头生效，放入 file 页 meta 会产生浏览器错误。
    await writeFile(path, html.replace("; frame-ancestors 'none'", ''));
  }
}
