/** 社区 Desktop Consumer 升级到官方 0.1.5 契约，官方包保持原样。 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function prepareDesktopUiContract(destination) {
  const directory = resolve(destination, 'dsh-plugin-desktop/src/client');
  const contractPath = resolve(directory, 'contracts.ts');
  const contract = (await readFile(contractPath, 'utf8')).replaceAll('\r\n', '\n');
  const slots = contract.indexOf("declare module '@deepseek-ai/dsh-client-ui-slots'");
  if (slots < 0 || !contract.includes('layout: DesktopLayoutService')) throw new Error('DESKTOP_CONTRACT_CHANGED');
  await writeFile(contractPath, "import type {} from '@deepseek-ai/dsh-client-ui-layout/client'\n" + contract.slice(0, slots)
    .replace('MainPanelId, PanelInfo', 'MainPanelId')
    .replace('    /** Desktop bridge for both legacy and current cloud layout consumers. */\n    layout: DesktopLayoutService\n', ''));
  const statePath = resolve(directory, 'layout-state.ts');
  const state = (await readFile(statePath, 'utf8')).replaceAll('\r\n', '\n');
  const old = 'export type MainPanelId = string\nexport interface PanelInfo { readonly activePanelId: MainPanelId | null }';
  if (!state.includes(old)) throw new Error('DESKTOP_PANEL_CONTRACT_CHANGED');
  await writeFile(statePath, state.replace(old,
    "import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'\nexport type { MainPanelId, PanelInfo }"));
  await prepareNativeCsp(destination);
  await prepareDesktopCli(destination);
}

export async function prepareDesktopCli(destination) {
  const path = resolve(destination, 'dsh-plugin-desktop/src/desktop-cli.ts');
  const source = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  if (!source.includes('await load(DSH_ENTRY_URL)')) throw new Error('DESKTOP_CLI_CONTRACT_CHANGED');
  const helper = `/** DSH 0.1.5 导入不再自动执行 CLI，调用公开的 runCli。 */
async function loadDesktopCli(load: (url: string) => Promise<unknown>): Promise<void> {
  const entry = await load(DSH_ENTRY_URL) as { runCli?: () => Promise<void> } | undefined
  if (entry?.runCli !== undefined) await entry.runCli()
}

`;
  await writeFile(path, source.replaceAll('await load(DSH_ENTRY_URL)', 'await loadDesktopCli(load)')
    .replace('export async function runDesktopDshCli(', helper + 'export async function runDesktopDshCli('));
}

export async function prepareNativeCsp(destination) {
  for (const file of ['desktop-dialog', 'profile-create', 'profile-selector', 'recovery', 'setup-wizard']) {
    const path = resolve(destination, 'dsh-plugin-desktop/src/native-ui', file + '.html');
    const html = await readFile(path, 'utf8');
    // frame-ancestors 仅在 HTTP 响应头生效，放入 file 页 meta 会产生浏览器错误。
    await writeFile(path, html.replace("; frame-ancestors 'none'", ''));
  }
}
