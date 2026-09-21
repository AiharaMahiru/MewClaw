// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- 用最小官方 slot runtime 验证浏览器模块。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

function makeStore<T>(init: T) {
  let value = init;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (next: T) => { value = next; for (const fn of listeners) fn(); },
  };
}

const CATALOG = {
  current: { provider: 'mewclaw-cloud', model: 'shared/deepseek-official/deepseek-v4.1-flash' },
  groups: [{ id: 'mewclaw-cloud', name: 'MewClaw', models: [
    { id: 'shared/deepseek-official/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash',
      reasoning: { defaultEffort: 'high', efforts: [
        { id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }, { id: 'max', name: 'Max' },
      ] } },
    { id: 'shared/openai/gpt-5.6-luna', name: 'GPT 5.6 Luna' },
  ] }],
  status: 'ready', routable: true, failures: [], error: null,
};

function boot(state = CATALOG) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const store = makeStore(state);
  const directory = { store, load: vi.fn(async () => undefined), select: vi.fn(async () => undefined) };
  const directories = new Map([['s1', directory]]);
  let component: React.ComponentType<any> | undefined;
  let injectFn: ((sessionId: string) => unknown) | undefined;
  const registrations: any[] = [];
  const ctx = {
    effect: (fn: () => () => void) => fn(),
    slots: {
      inject: (name: string, fn: () => unknown) => { expect(name).toBe('conversation.input.dock'); return fn(); },
      register: (spec: any, value: React.ComponentType<any>) => { registrations.push(value); injectFn = spec.inject; return () => undefined; },
    },
    modelDirectories: { directoryFor: (id: string) => directories.get(id) },
  } as any;
  vi.stubGlobal('__ModuleLoader__', { load: (row: any) => {
    const value = row.factory(() => React);
    value.apply(ctx);
    component = registrations.at(-1);
  } });
  const source = readFileSync(join(dirname(createRequire(import.meta.url).resolve('dsh-lark-desktop-cloud')), 'effort-client.js'), 'utf8').replace('\nexport {};', '');
  new Function(source)();
  return { component, injectFn, directory, store };
}

it('当前模型带 reasoning 元数据时在 input.dock 渲染思考强度滑条', async () => {
  const { component, injectFn } = boot();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    const props = injectFn!('s1') as any;
    expect(props.sessionId).toBe('s1');
    expect(props.directory).toBeDefined();
    await React.act(async () => root.render(React.createElement(component!, props)));
    const rail = element.querySelector('[role="slider"]');
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute('aria-valuetext')).toBe('高'); // defaultEffort: high
    expect(rail!.getAttribute('aria-label')).toBe('思考强度');
    expect(element.querySelectorAll('.mewclaw-effort-tick').length).toBe(4);
    expect(element.querySelector('.mewclaw-effort-valueName')?.textContent).toBe('高');
    expect(element.textContent).toContain('3/4');
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});

it('键盘提交把 reasoningEffort 写回目录选择', async () => {
  const { component, injectFn, directory } = boot();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, injectFn!('s1'))));
    const rail = element.querySelector('[role="slider"]')!;
    // high 是 index 2 → ArrowLeft 一步到 medium
    await React.act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(directory.select).toHaveBeenCalledWith({ provider: 'mewclaw-cloud', model: 'shared/deepseek-official/deepseek-v4.1-flash', reasoningEffort: 'medium' });
    await React.act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(directory.select).toHaveBeenLastCalledWith({ provider: 'mewclaw-cloud', model: 'shared/deepseek-official/deepseek-v4.1-flash', reasoningEffort: 'max' });
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});

it('模型无 reasoning 元数据时不渲染', async () => {
  const { component, injectFn } = boot({ ...CATALOG, current: { provider: 'mewclaw-cloud', model: 'shared/openai/gpt-5.6-luna' } });
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, injectFn!('s1'))));
    expect(element.querySelector('[role="slider"]')).toBeNull();
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});

it('无 defaultEffort 的模型首档为「默认」档（提交即清除显式 effort）', async () => {
  const { component, injectFn, directory } = boot({
    ...CATALOG,
    current: { provider: 'mewclaw-cloud', model: 'shared/deepseek-official/deepseek-v4.1-flash', reasoningEffort: 'low' },
    groups: [{ id: 'mewclaw-cloud', name: 'M', models: [{ id: 'shared/deepseek-official/deepseek-v4.1-flash', name: 'F',
      reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } }] }],
  });
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  try {
    await React.act(async () => root.render(React.createElement(component!, injectFn!('s1'))));
    const rail = element.querySelector('[role="slider"]')!;
    expect(element.querySelectorAll('.mewclaw-effort-tick').length).toBe(3); // 默认 + 低 + 高
    await React.act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(directory.select).toHaveBeenCalledWith({ provider: 'mewclaw-cloud', model: 'shared/deepseek-official/deepseek-v4.1-flash' });
  } finally { await React.act(async () => root.unmount()); element.remove(); }
});
