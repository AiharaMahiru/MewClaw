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
        // 只刷新当前 renderer，让新的 BootGraph/位置状态生效；Electron 进程保持运行。
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
      style: { display: 'flex', flexDirection: 'column', gap: 4, padding: wide ? '4px 8px' : '4px 0' },
    },
      React.createElement('div', { style: { display: 'flex', gap: 4, justifyContent: wide ? 'stretch' : 'center' } },
        ...(['cloud', 'local'] as const).map(mode => React.createElement('button', {
          key: mode, type: 'button', disabled: busy, 'aria-pressed': mode === location,
          'aria-label': `${label(mode)}模式`, title: `${label(mode)}模式`,
          onClick: () => { void change(mode); },
          style: { flex: wide ? 1 : undefined, minWidth: wide ? 0 : 36, padding: '4px 6px' },
        }, wide ? label(mode) : mode === location ? '●' : '○'))),
      location === 'local' ? React.createElement('button', {
        type: 'button', disabled: busy, onClick: () => { void open(); },
        'aria-label': '打开本地目录', title: '打开本地目录',
        style: { width: '100%', padding: '4px 6px', textAlign: wide ? 'left' : 'center' },
      }, wide ? '打开本地目录' : '目录') : null,
      error ? React.createElement('span', { role: 'status', title: error, style: { fontSize: 11, overflowWrap: 'anywhere' } }, error) : null);
  }

  return { inject: ['slots', 'uiWorkspace'], apply(ctx: Context) {
    const workspace = (ctx as Context & { uiWorkspace: WorkspaceApi }).uiWorkspace;
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'mewclaw-location', order: -100,
    }, (props: LocationProps) => React.createElement(LocationActions, { ...props, workspace })));
  } };
} });
