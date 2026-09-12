import { expect, it } from 'vitest';
import { sessionLocationHtml } from './session-boot.js';

it.each(['local', 'cloud'] as const)('保留官方侧栏并只追加一个位置Consumer：%s', location => {
  const entries = [{ id: '@deepseek-ai/dsh-client-ui-sidebar', rev: 'a', url: '/sidebar' }, { id: 'dsh-plugin-desktop', rev: 'b', url: '/desktop', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] }];
  const html = '<html><head></head><script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify({ rev: 'a', entries, batches: [{ entries: entries.map(x => x.id), rev: 'a', url: '/batch', phase: 'application' }] }) + ';</script></html>';
  const output = sessionLocationHtml(html, { location, locationRevision: 'next', workspaceRevision: 'workspace' });
  expect(output).toContain('@deepseek-ai/dsh-client-ui-sidebar');
  expect(output).toContain(`__MEWCLAW_SESSION_LOCATION__="${location}"`);
  expect(output).toContain('dsh-lark-desktop-location-client');
  expect(output).toContain(location === 'cloud' ? 'dsh-lark-desktop-workspace-client' : '"id":"dsh-lark-desktop-location-client"');
});

it('本地复用Web品牌时停用官方品牌Consumer，避免同优先级重复注册', () => {
  const id = '@deepseek-ai/dsh-client-ui-brand-official';
  const sidebar = '@deepseek-ai/dsh-client-ui-sidebar';
  const graph = { rev: 'a', entries: [{ id, rev: 'a', url: '/brand' }, { id: sidebar, rev: 's', url: '/sidebar' }], batches: [{ entries: [id, sidebar], rev: 'a', url: '/brand', phase: 'application' }] };
  const html = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify(graph) + ';</script>';
  const output = sessionLocationHtml(html, { location: 'local', locationRevision: 'next', brandRevision: 'brand' });
  expect(output).not.toContain(id);
  expect(output).toContain('dsh-lark-atw-brand');
  expect(sessionLocationHtml(html, { location: 'cloud', locationRevision: 'next' })).toContain(id);
});

it('本地模式停用云端工作区桥接并拒绝重复位置客户端', () => {
  const entries = [
    { id: '@deepseek-ai/dsh-client-ui-sidebar', rev: 'a', url: '/sidebar' },
    { id: 'dsh-lark-desktop-workspace-client', rev: 'old', url: '/workspace' },
  ];
  const html = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify({ rev: 'a', entries, batches: [{ entries: entries.map(x => x.id), rev: 'a', url: '/batch', phase: 'application' }] }) + ';</script>';
  const output = sessionLocationHtml(html, { location: 'local', locationRevision: 'next' });
  expect(output).not.toContain('dsh-lark-desktop-workspace-client');
  expect(() => sessionLocationHtml(output, { location: 'local', locationRevision: 'next' })).toThrow('DUPLICATE_LOCATION_CLIENT');
});
