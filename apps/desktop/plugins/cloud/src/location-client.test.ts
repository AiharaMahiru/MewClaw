// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- 用最小官方 slot runtime 验证浏览器模块。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('通过官方 sidebar.footer.action 提供本地目录入口并启动 workspace', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__MEWCLAW_SESSION_LOCATION__', 'local');
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  let component: React.ComponentType<{ wide: boolean }> | undefined;
  const registrations: any[] = [];
  const ctx = {
    effect: (fn: () => () => void) => fn(),
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (_spec: unknown, value: React.ComponentType<any>) => { registrations.push(value); return () => undefined; },
    },
    uiWorkspace: { startSession: vi.fn() },
  } as any;
  vi.stubGlobal('__ModuleLoader__', { load: (row: any) => {
    const value = row.factory(() => React);
    value.apply(ctx);
    component = registrations.at(-1);
  } });
  const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud')), 'location-client.js'), 'utf8').replace('\nexport {};', '');
  new Function(source)();
  const requests: Array<[string, unknown]> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push([url, JSON.parse(String(init.body))]);
    return { ok: true, json: async () => url.endsWith('/location') ? { location: 'cloud', reload: true } : { workspaceId: 'local-workspace' } };
  });
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, { wide: true })));
    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['云端', '本地', '打开本地目录']);
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    await React.act(async () => buttons[2]!.click());
    expect(requests).toEqual([['/api/mewclaw-desktop/local-directory', {}]]);
    expect(ctx.uiWorkspace.startSession).toHaveBeenCalledWith('local-workspace');
    await React.act(async () => buttons[0]!.click());
    expect(requests.at(-1)).toEqual(['/api/mewclaw-desktop/location', { location: 'cloud' }]);
    expect(reload).toHaveBeenCalledOnce();
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});

it('云端模式保留官方 sidebar，仅显示位置切换', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__MEWCLAW_SESSION_LOCATION__', 'cloud');
  let component: React.ComponentType<{ wide: boolean }> | undefined;
  const registrations: any[] = [];
  const ctx = { effect: (fn: () => () => void) => fn(), slots: {
    inject: (_name: string, fn: () => unknown) => fn(),
    register: (_spec: unknown, value: React.ComponentType<any>) => { registrations.push(value); return () => undefined; },
  }, uiWorkspace: { startSession: vi.fn() } } as any;
  vi.stubGlobal('__ModuleLoader__', { load: (row: any) => { const value = row.factory(() => React); value.apply(ctx); component = registrations.at(-1); } });
  const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud')), 'location-client.js'), 'utf8').replace('\nexport {};', '');
  new Function(source)();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, { wide: true })));
    expect([...element.querySelectorAll('button')].map(button => button.textContent)).toEqual(['云端', '本地']);
    expect(element.textContent).not.toContain('打开本地目录');
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});
