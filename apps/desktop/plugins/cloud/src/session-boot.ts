/** 扩展官方 rc.2 BootGraph，保留侧栏、布局和主题 Consumer。 */
import { createHash } from 'node:crypto';
import { sessionUiStateScript } from './session-ui-state.js';
import type { SessionLocation } from './location.js';

const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar';
const WORKSPACE_CLIENT = 'dsh-lark-desktop-workspace-client';
const WORKSPACE_CLIENT_PATH = '/_dsh/desktop/workspace-client.js';
const LOCATION_CLIENT = 'dsh-lark-desktop-location-client';
const LOCATION_CLIENT_PATH = '/_dsh/desktop/location-client.js';
interface Entry { id: string; url: string; rev: string; inject?: string[]; external?: string[] }
interface Graph { rev: string; entries: Entry[]; batches: { phase: string; url: string; rev: string; entries: string[] }[] }

export function sessionLocationHtml(html: string, options: {
  location: SessionLocation;
  locationRevision: string;
  workspaceRevision?: string;
  brandRevision?: string;
}): string {
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start < 0) return html;
  const valueStart = start + prefix.length;
  const end = html.indexOf('</script>', valueStart);
  if (end < 0) throw new Error('INVALID_SESSION_BOOT');
  const graph = JSON.parse(html.slice(valueStart, end).trim().replace(/;$/, '')) as Graph;
  const disabled = new Set([WORKSPACE_CLIENT, LOCATION_CLIENT]);
  if (options.location === 'local' && options.brandRevision) disabled.add('@deepseek-ai/dsh-client-ui-brand-official');
  if (!graph.entries.some(entry => entry.id === SIDEBAR)) throw new Error('SIDEBAR_MODULE_REQUIRED');
  if (graph.entries.some(entry => entry.id === LOCATION_CLIENT)) throw new Error('DUPLICATE_LOCATION_CLIENT');
  graph.entries = graph.entries.filter(entry => !disabled.has(entry.id));
  for (const entry of graph.entries) {
    if (entry.inject) entry.inject = entry.inject.filter(id => !disabled.has(id));
    if (entry.external) entry.external = entry.external.filter(id => !disabled.has(id));
  }
  graph.batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => !disabled.has(id)) })).filter(batch => batch.entries.length > 0);
  if (options.location === 'cloud' && options.workspaceRevision) {
    graph.entries.push({ id: WORKSPACE_CLIENT, url: WORKSPACE_CLIENT_PATH, rev: options.workspaceRevision, inject: ['dsh-plugin-desktop'] });
    graph.batches.push({ phase: 'application', url: WORKSPACE_CLIENT_PATH, rev: options.workspaceRevision, entries: [WORKSPACE_CLIENT] });
  }
  graph.entries.push({ id: LOCATION_CLIENT, url: LOCATION_CLIENT_PATH, rev: options.locationRevision, inject: ['dsh-plugin-desktop', SIDEBAR] });
  graph.batches.push({ phase: 'application', url: LOCATION_CLIENT_PATH, rev: options.locationRevision, entries: [LOCATION_CLIENT] });
  if (options.location === 'local' && options.brandRevision) {
    const id = 'dsh-lark-atw-brand';
    const url = '/_dsh/desktop/brand-client.js';
    graph.entries.push({ id, url, rev: options.brandRevision, inject: [LOCATION_CLIENT, SIDEBAR, '@deepseek-ai/dsh-client-ui-renderer'] });
    graph.batches.push({ phase: 'application', url, rev: options.brandRevision, entries: [id] });
  }
  graph.rev = createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
  // 复用官方 boot script 的 CSP nonce，不额外注入无 nonce 的脚本。
  const state = `globalThis.__MEWCLAW_SESSION_LOCATION__=${JSON.stringify(options.location)};${sessionUiStateScript(options.location)}`;
  return html.slice(0, start) + state + prefix + JSON.stringify(graph).replaceAll('<', '\\u003c') + ';' + html.slice(end);
}
