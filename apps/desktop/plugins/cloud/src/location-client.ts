/** 在官方 rc.2 侧栏底部提供云端/本地 Harness 控制，不替换官方侧栏。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type * as ReactType from 'react';

type SessionLocation = 'cloud' | 'local';
type ModuleLoader = { load(value: { id: string; factory: (require: (id: string) => unknown) => unknown }): void };
type LocationProps = { wide: boolean };
type WorkspaceApi = { startSession(id?: string): void; openWorkspace?(id: string): Promise<void> };

const global = globalThis as typeof globalThis & {
  __MEWCLAW_SESSION_LOCATION__?: SessionLocation;
  __ModuleLoader__: ModuleLoader;
};

global.__ModuleLoader__.load({ id: 'dsh-lark-desktop-location-client', factory: (require) => {
  const React = require('react') as typeof ReactType;
  const location = global.__MEWCLAW_SESSION_LOCATION__ ?? 'cloud';

  async function request(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '操作失败');
    return value;
  }

  async function openWorkspaceWhenReady(workspace: WorkspaceApi, workspaceId: string): Promise<void> {
    if (workspace.openWorkspace === undefined) { workspace.startSession(workspaceId); return; }
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await workspace.openWorkspace(workspaceId); return; }
      catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes('unknown workspace')) throw cause;
        lastError = cause;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('工作区尚未同步到桌面界面');
  }

  function LocationActions(props: LocationProps & { workspace: WorkspaceApi }): ReactType.ReactElement {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const wide = props.wide;
    const change = async (target: SessionLocation) => {
      if (target === location || busy) return;
      setBusy(true); setError('');
      try {
        await request('/api/mewclaw-desktop/location', { location: target });
        // 预存切换意图并在当前页盖同色过渡面；整页重载后由注入运行时延续同一过渡面。
        // 键名与 switch-splash.ts 的 SWITCH_FLAG_KEY 保持同一字面量（本文件按静态脚本分发，不能引入模块依赖）。
        let bg = '';
        let ink = '';
        try { const style = getComputedStyle(document.body); bg = style.backgroundColor; ink = style.color; } catch { /* 样式不可读时由新页面用默认色 */ }
        try { sessionStorage.setItem('mewclaw.location-switch', JSON.stringify({ to: target, bg, ink })); } catch { /* 意图缺失时新页面直接启动 */ }
        const overlay = document.createElement('div');
        overlay.id = 'mewclaw-location-splash';
        overlay.setAttribute('style', `position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:${bg || '#17181c'};color:${ink || '#e8eaef'};font:13px/1.6 system-ui,"Segoe UI",sans-serif;`);
        const label = document.createElement('div');
        label.textContent = target === 'local' ? '正在切换到本地工作区' : '正在切换到云端工作区';
        overlay.appendChild(label);
        document.body.appendChild(overlay);
        // 重载被阻断的极小概率下移除覆盖层，避免页面被永久盖住。
        setTimeout(() => overlay.remove(), 15000);
        globalThis.location.reload();
      }
      catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败，请重试。'); setBusy(false); }
    };
    const open = async () => {
      if (busy) return;
      setBusy(true); setError('');
      try {
        const value = await request('/api/mewclaw-desktop/local-directory', {});
        if (typeof value?.workspaceId === 'string') await openWorkspaceWhenReady(props.workspace, value.workspaceId);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '目录打开失败，请重新选择。'); }
      finally { setBusy(false); }
    };
    const label = (mode: SessionLocation) => mode === 'cloud' ? '云端' : '本地';
    return React.createElement('div', {
      role: 'group', 'aria-label': 'Harness 位置', title: '账号和模型继续使用云端；本地模式只访问你授权的目录。',
      className: 'mewclaw-location',
      style: { padding: wide ? '4px 8px' : '4px 0' },
    },
      React.createElement('div', { className: 'mewclaw-location-track' },
        ...(['cloud', 'local'] as const).map(mode => React.createElement('button', {
          key: mode, type: 'button', disabled: busy,
          className: 'mewclaw-location-seg' + (mode === location ? ' is-active' : ''),
          'aria-pressed': mode === location,
          'aria-label': `${label(mode)}模式`, title: `${label(mode)}模式`,
          onClick: () => { void change(mode); },
        }, wide ? label(mode) : mode === location ? '●' : '○'))),
      location === 'local' ? React.createElement('button', {
        type: 'button', disabled: busy, onClick: () => { void open(); },
        className: 'mewclaw-location-open',
        'aria-label': '打开本地目录', title: '打开本地目录',
        style: { textAlign: wide ? 'left' : 'center' },
      }, wide ? '打开本地目录' : '目录') : null,
      error ? React.createElement('span', { role: 'status', title: error, className: 'mewclaw-location-error' }, error) : null);
  }

  /** 控件样式跟随 dsw 令牌；轨道用交互悬停色，选中段浮起为 layer-3。 */
  const LOCATION_CSS = `
.mewclaw-location{display:flex;flex-direction:column;gap:6px}
.mewclaw-location-track{display:flex;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgb(220 220 235 / 10%))}
.mewclaw-location-seg{appearance:none;flex:1;min-width:0;height:26px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,rgb(249 250 251 / 60%));font:inherit;font-size:12px;font-weight:500;line-height:26px;cursor:pointer;transition:background .12s,color .12s,box-shadow .12s}
.mewclaw-location-seg:hover:not(:disabled):not(.is-active){color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-interactive-bg-hover,rgb(220 220 235 / 10%))}
.mewclaw-location-seg.is-active{background:var(--dsw-alias-bg-layer-3,#303035);color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 1px 2px rgb(0 0 0 / 30%),inset 0 0 0 1px rgb(255 255 255 / 8%)}
.mewclaw-location-seg:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#8ab4f8);outline-offset:-2px}
.mewclaw-location-seg:disabled{cursor:default;opacity:.55}
.mewclaw-location-open{appearance:none;width:100%;height:30px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary,rgb(249 250 251 / 60%));font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background .12s,color .12s}
.mewclaw-location-open:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(220 220 235 / 10%));color:var(--dsw-alias-label-primary,#f9fafb)}
.mewclaw-location-open:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#8ab4f8);outline-offset:-2px}
.mewclaw-location-open:disabled{cursor:default;opacity:.55}
.mewclaw-location-error{font-size:11px;color:var(--dsw-alias-state-warn-label,#f2994a);overflow-wrap:anywhere}
`;

  function ensureLocationStyle(): void {
    if (document.getElementById('mewclaw-location-style')) return;
    const style = document.createElement('style');
    style.id = 'mewclaw-location-style';
    style.textContent = LOCATION_CSS;
    document.head.appendChild(style);
  }

  return { inject: ['slots', 'uiWorkspace'], apply(ctx: Context) {
    const workspace = (ctx as Context & { uiWorkspace: WorkspaceApi }).uiWorkspace;
    ensureLocationStyle();
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'mewclaw-location', order: -100,
    }, (props: LocationProps) => React.createElement(LocationActions, { ...props, workspace })));
  } };
} });
