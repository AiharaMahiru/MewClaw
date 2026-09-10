/** 组合公开 WebBootGraph：云端模块保持原样，追加本地桌面客户端。 */
import { createHash } from 'node:crypto';

export const DESKTOP_CLIENT_PATH = '/_dsh/desktop/mewclaw-client.js';
export const BOOT_REPORT_PATH = '/_dsh/desktop/renderer-boot';
interface Entry { id: string; url: string; rev: string; inject?: string[]; external?: string[] }
interface Graph { rev: string; entries: Entry[]; batches: { phase: string; url: string; rev: string; entries: string[] }[] }

/** 登录页只报告自身表单可用；会话页由原桌面客户端等待 Cordis Loader 后报告。 */
export function desktopCloudHtml(html: string, client: { revision: string; inject: string[]; workspaceRevision?: string }, parameters: string): string {
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start >= 0) {
    const valueStart = start + prefix.length;
    const end = html.indexOf('</script>', valueStart);
    if (end < 0) throw new Error('INVALID_CLOUD_BOOT');
    const graph = JSON.parse(html.slice(valueStart, end).trim().replace(/;$/, '')) as Graph;
    if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) throw new Error('INVALID_CLOUD_BOOT');
    if (graph.entries.some(entry => entry.id === 'dsh-plugin-desktop')) throw new Error('DUPLICATE_DESKTOP_CLIENT');
    const mode = new URLSearchParams(parameters).get('dsh-desktop-mode');
    if (mode === 'advanced' || mode === 'extended') {
      const layout = '@deepseek-ai/dsh-client-ui-layout';
      if (graph.entries.some(entry => entry.id !== layout && entry.external?.includes(layout))) {
        throw new Error('CLOUD_LAYOUT_MODULE_REQUIRED');
      }
      graph.entries = graph.entries.filter(entry => entry.id !== layout);
      for (const entry of graph.entries) {
        if (entry.inject) entry.inject = entry.inject.filter(id => id !== layout);
      }
      graph.batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => id !== layout) }))
        .filter(batch => batch.entries.length > 0);
    }
    const inject = client.inject.map(id => id === '@deepseek-ai/dsh-client-ui-settings' ? 'dsh-lark-web-auth' : id);
    if (inject.some(id => !graph.entries.some(entry => entry.id === id))) throw new Error('CLOUD_CLIENT_DEPENDENCY_MISSING');
    graph.entries.push({ id: 'dsh-plugin-desktop', url: DESKTOP_CLIENT_PATH, rev: client.revision, inject });
    graph.batches.push({ phase: 'application', url: DESKTOP_CLIENT_PATH, rev: client.revision, entries: ['dsh-plugin-desktop'] });
    if (client.workspaceRevision) {
      const id = 'dsh-lark-desktop-workspace-client';
      const url = '/_dsh/desktop/workspace-client.js';
      graph.entries.push({ id, url, rev: client.workspaceRevision, inject: ['dsh-plugin-desktop'] });
      graph.batches.push({ phase: 'application', url, rev: client.workspaceRevision, entries: [id] });
    }
    graph.rev = createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
    html = html.slice(0, valueStart) + JSON.stringify(graph).replaceAll('<', '\\u003c') + ';' + html.slice(end);
  }
  const safeParameters = JSON.stringify(parameters).replaceAll('<', '\\u003c');
  const restore = `globalThis.__MEWCLAW_DESKTOP_WORKSPACE__=true;(()=>{const p=new URLSearchParams(${safeParameters});const u=new URL(location.href);for(const [k,v] of p)u.searchParams.set(k,v);history.replaceState(null,'',u);})();`;
  const loginHealth = start < 0 ? `addEventListener('DOMContentLoaded',()=>{if(document.querySelector('#email')&&document.querySelector('#password')&&document.querySelector('form'))void fetch('${BOOT_REPORT_PATH}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'healthy'})}).catch(()=>{});},{once:true});` : '';
  // 将真实认证页面主体标为可见内容根；不添加空节点绕过桌面看门狗。
  if (start < 0 && html.includes('<main class="auth-page">')) html = html.replace('<main class="auth-page">', '<main id="root" class="auth-page">');
  return html.replace('</head>', `<script>${restore}${loginHealth}</script></head>`);
}
