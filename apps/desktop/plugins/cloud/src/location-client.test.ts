// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- 用最小官方 slot runtime 验证浏览器模块。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('通过官方侧栏切换位置，不增加单独的本地目录入口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__MEWCLAW_SESSION_LOCATION__', 'local');
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('getComputedStyle', (element: Element) => ({
    backgroundColor: element === document.body ? 'rgba(240, 240, 242, 0.5)' : 'rgb(240, 240, 242)',
    color: 'rgb(24, 25, 28)',
  }));
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
    expect(buttons.map(button => button.textContent)).toEqual(['云端', '本地']);
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(element.querySelector('[aria-label="打开本地目录"]')).toBeNull();
    await React.act(async () => buttons[0]!.click());
    expect(requests.at(-1)).toEqual(['/api/mewclaw-desktop/location', { location: 'cloud' }]);
    // 切换意图写入 sessionStorage 并立即盖同色过渡面，再由整页重载应用新 BootGraph。
    expect(sessionStorage.getItem('mewclaw.location-switch')).toContain('"to":"cloud"');
    expect(JSON.parse(sessionStorage.getItem('mewclaw.location-switch')!).bg).toBe('rgb(240, 240, 242)');
    expect(document.getElementById('mewclaw-location-splash')).not.toBeNull();
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
    await React.act(async () => root.render(React.createElement(component!, { wide: false })));
    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['云端模式', '本地模式']);
    expect(buttons.every(button => button.querySelector('svg'))).toBe(true);
    buttons[0]!.focus();
    await React.act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');

  } finally { await React.act(async () => root.unmount()); element.remove(); }
});
