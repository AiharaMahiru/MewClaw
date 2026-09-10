/** 通过公开会话标题栏slot提供云端/本机工作区切换。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type * as ReactType from 'react';

const loader = (globalThis as unknown as { __ModuleLoader__: { load(value: unknown): void } }).__ModuleLoader__;
loader.load({ id: 'dsh-lark-desktop-workspace-client', factory: (require: (id: string) => unknown) => {
  const React = require('react') as typeof ReactType;
  async function request(sessionId: string, mode?: string) {
    const response = await fetch('/api/mewclaw-desktop/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...(mode ? { mode } : {}) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error === 'WORKSPACE_BUSY' ? '当前正在执行操作，请完成后切换。' : '工作区连接不可用，请确认云端已启用桌面工作区服务。');
    return value as { mode: 'cloud' | 'desktop'; connected: boolean };
  }
  function WorkspaceSwitch({ sessionId }: { sessionId: string }) {
    const [state, setState] = React.useState<{ mode: 'cloud' | 'desktop'; connected: boolean }>();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
      let mounted = true;
      setState(undefined); setError('');
      const refresh = () => { void request(sessionId).then(value => { if (mounted) setState(value); }).catch(() => { if (mounted) setState(undefined); }); };
      refresh();
      const timer = setInterval(refresh, 5000);
      return () => { mounted = false; clearInterval(timer); };
    }, [sessionId]);
    const select = async (mode: string) => {
      setBusy(true); setError('');
      try { setState(await request(sessionId, mode)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '工作区切换失败'); }
      finally { setBusy(false); }
    };
    return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 }, title: '账号和模型继续使用云端；本地电脑仅访问你授权的目录。' },
      React.createElement('span', null, '工作区'),
      React.createElement('select', { 'aria-label': '工作区位置', value: state?.mode ?? 'unknown', disabled: busy,
        onChange: (event: ReactType.ChangeEvent<HTMLSelectElement>) => { void select(event.target.value); } },
      React.createElement('option', { value: 'unknown', disabled: true }, '未连接'),
      React.createElement('option', { value: 'cloud' }, '云端'), React.createElement('option', { value: 'desktop' }, '本地电脑')),
      state?.mode === 'desktop' && !state.connected ? React.createElement('button', { disabled: busy, onClick: () => { void select('desktop'); } }, '重新授权') : null,
      error ? React.createElement('span', { role: 'status', style: { maxWidth: 260, fontSize: 12 } }, error) : null);
  }
  return { inject: ['slots'], apply(ctx: Context) {
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'mewclaw-workspace-location', order: -100,
      inject: sessionId => ({ sessionId }),
    }, WorkspaceSwitch));
  } };
} });
