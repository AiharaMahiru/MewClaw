/** 替换侧栏 Consumer，官方浏览器模块文件保持原样。 */
import { createHash } from 'node:crypto';
import { sessionUiStateScript } from './session-ui-state.js';
import type { SessionLocation } from './location.js';

const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar';
const CLIENT = 'dsh-lark-desktop-workspace-client';
const CLIENT_PATH = '/_dsh/desktop/workspace-client.js';
interface Entry { id: string; url: string; rev: string; inject?: string[]; external?: string[] }
interface Graph { rev: string; entries: Entry[]; batches: { phase: string; url: string; rev: string; entries: string[] }[] }

export function sessionLocationHtml(html: string, options: { location: SessionLocation; revision: string; brandRevision?: string }): string {
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start < 0) return html;
  const valueStart = start + prefix.length;
  const end = html.indexOf('</script>', valueStart);
  if (end < 0) throw new Error('INVALID_SESSION_BOOT');
  const graph = JSON.parse(html.slice(valueStart, end).trim().replace(/;$/, '')) as Graph;
  const disabled = new Set([SIDEBAR, CLIENT]);
  if (options.location === 'local' && options.brandRevision) disabled.add('@deepseek-ai/dsh-client-ui-brand-official');
  if (graph.entries.some(entry => entry.id !== SIDEBAR && entry.external?.includes(SIDEBAR))) throw new Error('SIDEBAR_MODULE_REQUIRED');
  graph.entries = graph.entries.filter(entry => !disabled.has(entry.id));
  for (const entry of graph.entries) if (entry.inject) entry.inject = entry.inject.filter(id => !disabled.has(id));
  graph.batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => !disabled.has(id)) })).filter(batch => batch.entries.length > 0);
  graph.entries.push({ id: CLIENT, url: CLIENT_PATH, rev: options.revision, inject: ['dsh-plugin-desktop'] });
  graph.batches.push({ phase: 'application', url: CLIENT_PATH, rev: options.revision, entries: [CLIENT] });
  if (options.location === 'local' && options.brandRevision) {
    const id = 'dsh-lark-atw-brand';
    const url = '/_dsh/desktop/brand-client.js';
    graph.entries.push({ id, url, rev: options.brandRevision, inject: [CLIENT, '@deepseek-ai/dsh-client-ui-renderer'] });
    graph.batches.push({ phase: 'application', url, rev: options.brandRevision, entries: [id] });
  }
  graph.rev = createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
  // 复用官方 boot script 的 CSP nonce，不额外注入无 nonce 的脚本。
  const state = `globalThis.__MEWCLAW_SESSION_LOCATION__=${JSON.stringify(options.location)};${sessionUiStateScript(options.location)}`;
  return html.slice(0, start) + state + prefix + JSON.stringify(graph).replaceAll('<', '\\u003c') + ';' + html.slice(end);
}
