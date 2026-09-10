// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });
it('会话标题栏切换保持会话ID，失败时不假报本机已连接', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let component: React.ComponentType<{ sessionId: string }> | undefined;
  const dispose = vi.fn();
  const slots = { inject: (_name: string, register: () => unknown) => register(), register: (_spec: unknown, value: typeof component) => { component = value; return dispose; } };
  const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud')), 'workspace-client.js'), 'utf8').replace('\nexport {};', '');
  vi.stubGlobal('__ModuleLoader__', { load: (row: any) => row.factory(() => React).apply({ slots }) });
  new Function(source)();
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body);
    if (body.mode === 'desktop') return { ok: false, json: async () => ({ error: 'WORKSPACE_CLOUD_UNAVAILABLE' }) };
    return { ok: true, json: async () => ({ mode: 'cloud', connected: false }) };
  });
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => { root.render(React.createElement(component!, { sessionId: 'session-a' })); });
    const select = element.querySelector('select')!;
    expect(select.value).toBe('cloud');
    expect([...select.options].map(option => option.text)).toMatchInlineSnapshot(`
      [
        "未连接",
        "云端",
        "本地电脑",
      ]
    `);
    await React.act(async () => { select.value = 'desktop'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(select.value).toBe('cloud');
    expect(requests).toContainEqual({ sessionId: 'session-a', mode: 'desktop' });
    expect(element.querySelector('[role="status"]')?.textContent).toContain('工作区连接不可用');
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});
