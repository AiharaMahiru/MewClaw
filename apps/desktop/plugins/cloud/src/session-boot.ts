/** 扩展官方 BootGraph，保留侧栏、布局和主题 Consumer。 */
import { createHash } from 'node:crypto';
import { sessionUiStateScript } from './session-ui-state.js';
import { SWITCH_SPLASH_SOURCE } from './switch-splash.js';
import type { SessionLocation } from './location.js';

const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar';
const WORKSPACE_CLIENT = 'dsh-lark-desktop-workspace-client';
const WORKSPACE_CLIENT_PATH = '/_dsh/desktop/workspace-client.js';
const LOCATION_CLIENT = 'dsh-lark-desktop-location-client';
const LOCATION_CLIENT_PATH = '/_dsh/desktop/location-client.js';
interface Entry { id: string; url: string; rev: string; inject?: string[]; external?: string[] }
export interface SessionBootGraph { rev: string; entries: Entry[]; batches: { phase: string; url: string; rev: string; entries: string[] }[] }
export const WEB_POLICY_CLIENTS = ['@linxin666/dsh-web-all', '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-client-ui-cordis'];

/** 实时快照沿用首屏的账号政策，不恢复已隐藏的客户端。 */
export function filterSessionClients(graph: SessionBootGraph, disabled: ReadonlySet<string>): void {
  graph.entries = graph.entries.filter(entry => !disabled.has(entry.id));
  for (const entry of graph.entries) {
    if (entry.inject) entry.inject = entry.inject.map(id => id === '@deepseek-ai/dsh-client-ui-settings'
      && disabled.has(id) ? 'dsh-lark-web-auth' : id).filter(id => !disabled.has(id));
    if (entry.external) entry.external = entry.external.filter(id => !disabled.has(id));
  }
  graph.batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => !disabled.has(id)) })).filter(batch => batch.entries.length > 0);
}

export interface SessionBootOptions {
  location: SessionLocation;
  locationRevision: string;
  workspaceRevision?: string;
  brandRevision?: string;
  glassRevision?: string;
  accountRevision?: string;
}

export function sessionLocationHtml(html: string, options: SessionBootOptions): string {
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start < 0) return html;
  const valueStart = start + prefix.length;
  const end = html.indexOf('</script>', valueStart);
  if (end < 0) throw new Error('INVALID_SESSION_BOOT');
  const graph = JSON.parse(html.slice(valueStart, end).trim().replace(/;$/, '')) as SessionBootGraph;
  composeSessionGraph(graph, options);
  // 复用官方 boot script 的 CSP nonce，不额外注入无 nonce 的脚本。
  const account = options.location === 'local' && options.accountRevision ? 'globalThis.__DSH_AUTH_EDGE__={remoteSettings:true};' : '';
  const state = `globalThis.__MEWCLAW_SESSION_LOCATION__=${JSON.stringify(options.location)};${account}${sessionUiStateScript(options.location)}${SWITCH_SPLASH_SOURCE}`;
  return html.slice(0, start) + state + prefix + JSON.stringify(graph).replaceAll('<', '\\u003c') + ';' + html.slice(end);
}

/** 首屏与 HMR 使用同一组合，避免实时快照撤销桌面 Provider。 */
export function composeSessionGraph(graph: SessionBootGraph, options: SessionBootOptions): SessionBootGraph {
  const disabled = new Set([WORKSPACE_CLIENT, LOCATION_CLIENT]);
  if (options.location === 'local' && options.brandRevision) disabled.add('@deepseek-ai/dsh-client-ui-brand-official');
  if (options.location === 'local' && options.accountRevision) {
    // 与 Auth Edge 的普通用户 Web 政策一致，设置服务由同一账号客户端提供。
    for (const id of WEB_POLICY_CLIENTS) disabled.add(id);
  }
  if (!graph.entries.some(entry => entry.id === SIDEBAR)) throw new Error('SIDEBAR_MODULE_REQUIRED');
  if (graph.entries.some(entry => entry.id === LOCATION_CLIENT)) throw new Error('DUPLICATE_LOCATION_CLIENT');
  filterSessionClients(graph, disabled);
  if (options.location === 'cloud' && options.workspaceRevision) {
    graph.entries.push({ id: WORKSPACE_CLIENT, url: WORKSPACE_CLIENT_PATH, rev: options.workspaceRevision, inject: ['dsh-plugin-desktop'] });
    graph.batches.push({ phase: 'application', url: WORKSPACE_CLIENT_PATH, rev: options.workspaceRevision, entries: [WORKSPACE_CLIENT] });
  }
  graph.entries.push({ id: LOCATION_CLIENT, url: LOCATION_CLIENT_PATH, rev: options.locationRevision, inject: ['dsh-plugin-desktop', SIDEBAR] });
  graph.batches.push({ phase: 'application', url: LOCATION_CLIENT_PATH, rev: options.locationRevision, entries: [LOCATION_CLIENT] });
  if (options.location === 'local' && options.brandRevision) {
    const id = 'dsh-lark-mewclaw-brand-desktop';
    const url = '/_dsh/desktop/brand-client.js';
    graph.entries.push({ id, url, rev: options.brandRevision, inject: [LOCATION_CLIENT, SIDEBAR, '@deepseek-ai/dsh-client-ui-renderer'] });
    graph.batches.push({ phase: 'application', url, rev: options.brandRevision, entries: [id] });
  }
  if (options.location === 'local' && options.glassRevision) {
    // 与云端部署同一主题插件；inject 顺序即上游 dsh.client.inject 声明。
    const id = 'dsh-lark-liquid-glass';
    const url = '/_dsh/desktop/glass-client.js';
    graph.entries.push({ id, url, rev: options.glassRevision,
      inject: ['@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings-general'] });
    graph.batches.push({ phase: 'application', url, rev: options.glassRevision, entries: [id] });
  }
  if (options.location === 'local' && options.accountRevision) {
    const id = 'dsh-lark-web-auth';
    const url = '/_dsh/desktop/account-client.js';
    // Web 账号模块的 manifest inject 为空：它提供主题所需的 settingsScope，
    // 不能反向依赖 renderer/theme，否则整张启动图形成等待环。
    graph.entries.push({ id, url, rev: options.accountRevision, inject: [] });
    graph.batches.push({ phase: 'application', url, rev: options.accountRevision, entries: [id] });
  }
  graph.rev = createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
  return graph;
}
