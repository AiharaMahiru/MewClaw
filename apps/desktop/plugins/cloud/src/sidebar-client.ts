/** 左侧栏 Consumer：品牌、会话位置、新建会话与官方工作区列表。 */
import type * as ReactType from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: { size: number; active: boolean } };
  }
}

const global = globalThis as unknown as { __MEWCLAW_SESSION_LOCATION__?: 'cloud' | 'local'; __ModuleLoader__: { load(value: unknown): void } };
global.__ModuleLoader__.load({ id: 'dsh-lark-desktop-workspace-client', factory: (require: (id: string) => unknown) => {
  const React = require('react') as typeof ReactType;
  const h = React.createElement;
  const location = global.__MEWCLAW_SESSION_LOCATION__ ?? 'cloud';
  type Slots = 'sidebar.brand.mark' | 'sidebar.brand.name' | 'sidebar.workspaces' | 'sidebar.settings' | 'sidebar.footer.action' | 'sidebar.panellist';
  type Props = PropsRuntime<'sidebar'> & PropsRenderSlots<Slots> & { startSession(id?: string): void; toggle(): void; panelContext?: Context };

  function Panels({ ctx, renderSlot, wide }: { ctx: Context; renderSlot: Props['renderSlot']; wide: boolean }) {
    const [, update] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => ctx.slots.subscribe('sidebar.panellist', update), [ctx]);
    const panels = ctx.slots.entriesOfSlot('sidebar.panellist').map(entry => entry.options).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return h(React.Fragment, null, ...panels.map(panel => {
      const id = panel.id;
      if (!id) return null;
      const label = typeof panel.label === 'function' ? panel.label() : panel.label ?? panel.id;
      return h('button', { key: id, title: label, className: 'mewclaw-sidebar-action',
        onClick: () => (ctx.layout as unknown as { selectPanel(id: string): void }).selectPanel(id) },
      renderSlot('sidebar.panellist', { size: 18, active: false }, { only: id }), wide ? label : null);
    }));
  }

  async function request(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? '操作失败');
    return value;
  }

  function Sidebar(props: Props) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const wide = !props.collapsed;
    const change = async (target: 'cloud' | 'local') => {
      if (target === location) return;
      setBusy(true); setError('');
      try { await request('/api/mewclaw-desktop/location', { location: target }); }
      catch { setError('切换失败，请重试。'); setBusy(false); }
    };
    const open = async () => {
      setBusy(true); setError('');
      try {
        const value = await request('/api/mewclaw-desktop/local-directory', {});
        if (typeof value?.workspaceId === 'string') {
          props.startSession(value.workspaceId);
          // WorkspaceController 的 upsert 通知与 React 渲染可能不同步；
          // 首次调用若发生在快照更新前，稍后重试即可完成会话连接。
          window.setTimeout(() => props.startSession(value.workspaceId as string), 100);
        }
      } catch { setError('目录打开失败，请重新选择。'); }
      finally { setBusy(false); }
    };
    return h('nav', { className: 'mewclaw-session-sidebar', 'aria-label': '会话导航', style: { width: props.width } },
      h('div', { className: 'mewclaw-sidebar-brand' }, props.renderSlot('sidebar.brand.mark', { size: 24 }),
        wide ? props.renderSlot('sidebar.brand.name', {}, { fallback: h('strong', null, 'MewClaw') }) : null,
        h('button', { onClick: props.toggle, title: wide ? '收起侧栏' : '展开侧栏', 'aria-label': '切换侧栏' }, '☰')),
      h('div', { className: 'mewclaw-location-switch', role: 'group', 'aria-label': '会话位置' },
        ...(['cloud', 'local'] as const).map(mode => h('button', { key: mode, disabled: busy, 'aria-pressed': mode === location,
          title: mode === 'cloud' ? '云端会话' : '本地会话', onClick: () => { void change(mode); } }, mode === 'cloud' ? '云端' : '本地'))),
      h('button', { className: 'mewclaw-sidebar-action', disabled: busy, onClick: () => props.startSession(), title: '新建会话' }, wide ? '＋ 新建会话' : '＋'),
      location === 'local' ? h('button', { className: 'mewclaw-sidebar-action', disabled: busy, onClick: () => { void open(); }, title: '打开本地目录' }, wide ? '打开本地目录' : '目录') : null,
      error ? h('p', { role: 'alert' }, error) : null,
      busy ? h('p', { role: 'status' }, '正在处理…') : null,
      location === 'cloud' && props.panelContext ? h(Panels, { ctx: props.panelContext, renderSlot: props.renderSlot, wide }) : null,
      h('div', { className: 'mewclaw-sidebar-sessions' }, props.renderSlot('sidebar.workspaces', { wide, expandSidebar: props.toggle })),
      h('footer', null, props.renderSlot('sidebar.settings', { wide }), props.renderSlot('sidebar.footer.action', { wide })));
  }

  return { inject: ['slots', 'layout', 'uiWorkspace'], apply(ctx: Context) {
    ctx.effect(() => {
      const style = document.createElement('style');
      style.textContent = `.mewclaw-session-sidebar{height:100%;display:flex;flex-direction:column;padding:12px 8px;box-sizing:border-box;gap:8px;color:inherit;background:transparent}.mewclaw-sidebar-brand{display:flex;align-items:center;justify-content:space-between;min-height:36px;padding:0 8px}.mewclaw-session-sidebar button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:8px;padding:8px;background:transparent;-webkit-app-region:no-drag}.mewclaw-location-switch{display:flex;gap:3px;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:9px;padding:3px}.mewclaw-location-switch button{flex:1;padding:6px 2px;font-size:12px}.mewclaw-location-switch button[aria-pressed=true]{background:color-mix(in srgb,currentColor 14%,transparent);font-weight:600}.mewclaw-sidebar-action{text-align:left}.mewclaw-sidebar-action:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.mewclaw-sidebar-sessions{min-height:0;flex:1;display:flex;flex-direction:column}.mewclaw-session-sidebar footer{display:flex;align-items:center}.mewclaw-session-sidebar p{font-size:12px;margin:0 6px}.mewclaw-session-sidebar button:disabled{opacity:.5;cursor:wait}`;
      document.head.append(style);
      return () => style.remove();
    });
    ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' }, 'sidebar.footer.action': { kind: 'list', scope: 'root' },
    }, inject: () => ({ panelContext: ctx, startSession: (id?: string) => ctx.uiWorkspace.startSession(id as WorkspaceId | undefined), toggle: () => ctx.layout.toggleSidebar() }) }, Sidebar));
  } };
} });
