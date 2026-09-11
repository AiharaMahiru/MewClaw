import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';

it('桌面CLI显式调用DSH 0.1.5公开入口', async () => {
  const root = dirname(createRequire(import.meta.url).resolve('dsh-plugin-desktop/package.json'));
  const { runDesktopDshCli } = await import(pathToFileURL(join(root, 'lib/desktop-cli.js')).href);
  const runCli = vi.fn(async () => {});
  const load = vi.fn(async () => ({ runCli }));
  await runDesktopDshCli({}, load, ['node', 'desktop-cli', '--help']);
  expect(load).toHaveBeenCalledOnce();
  expect(runCli).toHaveBeenCalledOnce();
});
