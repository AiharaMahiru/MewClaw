import { describe, expect, it } from 'vitest';
import { desktopCloudHtml } from './boot.js';

describe('桌面启动清单组合', () => {
  const client = { revision: 'test-revision', inject: ['@deepseek-ai/dsh-client-ui-settings'] };
  const graph = { rev: 'cloud', entries: [{ id: 'dsh-lark-web-auth', url: '/auth.js', rev: '1' }], batches: [{ phase: 'application', url: '/auth.js', rev: '1', entries: ['dsh-lark-web-auth'] }] };
  const html = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`;
  it('保留云端行并追加社区桌面模块，不修改官方实例', () => {
    const result = desktopCloudHtml(html, client, 'dsh-desktop-mode=compatibility');
    expect(result).toContain('"id":"dsh-lark-web-auth"');
    expect(result).toContain('"id":"dsh-plugin-desktop"');
    expect(result).toContain('"inject":["dsh-lark-web-auth"]');
    expect(result).not.toContain("status:'healthy'");
  });
  it('依赖缺失时明确失败，不伪报健康', () => {
    expect(() => desktopCloudHtml(html, { ...client, inject: ['missing'] }, '')).toThrow('CLOUD_CLIENT_DEPENDENCY_MISSING');
  });
  it('登录页健康仅在表单实际存在时报告，转义窗口参数', () => {
    const result = desktopCloudHtml('<html><head></head><body></body></html>', client, '</script>');
    expect(result).toContain("document.querySelector('#email')");
    expect(result).toContain('\\u003c/script>');
  });
  it('重复桌面模块拒绝装载', () => {
    const once = desktopCloudHtml(html, client, '');
    expect(() => desktopCloudHtml(once, client, '')).toThrow('DUPLICATE_DESKTOP_CLIENT');
  });
});
