import { expect, it } from 'vitest';
import { sessionLocationHtml } from './session-boot.js';

it.each(['local', 'cloud'] as const)('只保留一个侧栏Consumer：%s', location => {
  const entries = [{ id: '@deepseek-ai/dsh-client-ui-sidebar', rev: 'a', url: '/sidebar' }, { id: 'dsh-plugin-desktop', rev: 'b', url: '/desktop', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] }];
  const html = '<html><head></head><script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify({ rev: 'a', entries, batches: [{ entries: entries.map(x => x.id), rev: 'a', url: '/batch', phase: 'application' }] }) + ';</script></html>';
  const output = sessionLocationHtml(html, { location, revision: 'next' });
  expect(output).not.toContain('@deepseek-ai/dsh-client-ui-sidebar');
  expect(output).toContain(`__MEWCLAW_SESSION_LOCATION__="${location}"`);
  expect(output).toContain('dsh-lark-desktop-workspace-client');
});

it('本地复用Web品牌时停用官方品牌Consumer，避免同优先级重复注册', () => {
  const id = '@deepseek-ai/dsh-client-ui-brand-official';
  const graph = { rev: 'a', entries: [{ id, rev: 'a', url: '/brand' }], batches: [{ entries: [id], rev: 'a', url: '/brand', phase: 'application' }] };
  const html = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify(graph) + ';</script>';
  const output = sessionLocationHtml(html, { location: 'local', revision: 'next', brandRevision: 'brand' });
  expect(output).not.toContain(id);
  expect(output).toContain('dsh-lark-atw-brand');
  expect(sessionLocationHtml(html, { location: 'cloud', revision: 'next' })).toContain(id);
});
