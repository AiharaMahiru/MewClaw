// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
it('侧栏在新建会话前显示模式切换，本地目录调用不带云端会话ID', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__MEWCLAW_SESSION_LOCATION__', 'local');
  let component: React.ComponentType<Record<string, unknown>> | undefined;
  const disposers: (() => void)[] = [];
  const ctx = { effect: (fn: () => () => void) => { disposers.push(fn()); },
    slots: { inject: (_name: string, fn: () => void) => fn(), register: (_spec: unknown, value: typeof component) => { component = value; return () => {}; } } };
  type ClientModule = { factory(require: () => typeof React): { apply(context: typeof ctx): void } };
  vi.stubGlobal('__ModuleLoader__', { load: (row: ClientModule) => row.factory(() => React).apply(ctx) });
  const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud')), 'sidebar-client.js'), 'utf8').replace('\nexport {};', '');
  new Function(source)();
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push([url, JSON.parse(String(init.body))]);
    return { ok: true, json: async () => ({ workspaceId: 'local-workspace' }) };
  });
  const startSession = vi.fn();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, { collapsed: false, width: 280, startSession, toggle: () => {}, renderSlot: () => null })));
    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['☰', '云端', '本地', '＋ 新建会话', '打开本地目录']);
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
    await React.act(async () => buttons[4]!.click());
    expect(requests).toEqual([['/api/mewclaw-desktop/local-directory', {}]]);
    expect(startSession).toHaveBeenCalledWith('local-workspace');
    await React.act(async () => buttons[1]!.click());
    expect(requests.at(-1)).toEqual(['/api/mewclaw-desktop/location', { location: 'cloud' }]);
  } finally { await React.act(async () => root.unmount()); element.remove(); disposers.forEach(fn => fn()); }
});
