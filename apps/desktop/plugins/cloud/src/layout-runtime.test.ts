// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- the official client loader is intentionally dynamic. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const factories = new Map<string, (require: (id: string) => unknown) => unknown>();
const modules = new Map<string, any>([['@deepseek-ai/dsh-client-ui-primitives', primitives]]);
(window as any).__ModuleLoader__ = { load: (row: any) => factories.set(row.id, row.factory) };
function clientModule(id: string): any {
  if (modules.has(id)) return modules.get(id);
  if (!id.startsWith('@deepseek-ai/dsh-') && id !== 'dsh-plugin-desktop') return require(id);
  if (!factories.has(id)) {
    const manifest = require(id + '/package.json');
    if (!manifest.exports?.['./client']) return require(id);
    const source = readFileSync(require.resolve(id + '/client'), 'utf8');
    new Function('window', source)(window);
  }
  const value = factories.get(id)!(clientModule);
  modules.set(id, value);
  return value;
}

describe('真实客户端布局模块与Cordis释放', () => {
  it.each(['advanced', 'extended', 'compatibility'])('%s 可装载、卸载、再次装载', async mode => {
    document.body.innerHTML = '<div id="root"></div>';
    const desktop = clientModule('dsh-plugin-desktop');
    const official = clientModule('@deepseek-ai/dsh-client-ui-layout');
    expect(typeof clientModule('@deepseek-ai/dsh-client-ui-sidebar').apply).toBe('function');
    expect(typeof clientModule('@deepseek-ai/dsh-client-ui-conversation').apply).toBe('function');
    const ctx = new Context();
    const roots = new Set<unknown>();
    const rootContributions = new Set<any>();
    const slots = {
      register: (spec: any) => { roots.add(spec); return () => { roots.delete(spec); }; },
      inject: (_name: string, callback: () => unknown) => ctx.effect(callback as any),
      provideRoot: (contribution: any) => {
        rootContributions.add(contribution);
        return () => { rootContributions.delete(contribution); };
      },
      entries: () => [],
      subscribe: () => () => {},
    };
    ctx.reflect.provide('slots', slots);
    ctx.reflect.provide('theme', { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} } }) });
    ctx.reflect.provide('locale', {});
    const environment = { mode, platform: 'win32', material: 'off', micaSupported: false, version: '2.0.6' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const fiber = ctx.plugin((scope: Context) => {
        if (mode === 'compatibility') { official.apply(scope); desktop.applyFramedShell(scope, environment); }
        if (mode === 'advanced') desktop.applyAdvancedShell(scope, environment);
        if (mode === 'extended') desktop.applyExtendedShell(scope, environment);
      });
      await fiber;
      expect(ctx.reflect.get('layout', false)).toBeDefined();
      expect([...roots].filter((spec: any) => spec.name === 'root')).toHaveLength(1);
      if (mode !== 'compatibility') {
        const panelInfo = [...rootContributions].find(value => value.hooks?.panelInfo)?.hooks.panelInfo;
        expect(typeof panelInfo?.getSnapshot).toBe('function');
        expect(panelInfo.getSnapshot()).toEqual({ activePanelId: null });
      }
      await fiber.dispose();
      expect(ctx.reflect.get('layout', false)).toBeUndefined();
      expect([...roots].filter((spec: any) => spec.name === 'root')).toHaveLength(0);
      expect(rootContributions.size).toBe(0);
    }
  });
});
