/** 普通 Web 只展示执行地点，不提供原生目录或 Shell 授权入口。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type * as ReactType from 'react';
const globals = globalThis as unknown as { __MEWCLAW_DESKTOP_WORKSPACE__?: boolean; __ModuleLoader__: { load(input: unknown): void } };
globals.__ModuleLoader__.load({ id: 'dsh-lark-desktop-workspace', factory: (require: (id: string) => unknown) => {
  const React = require('react') as typeof ReactType;
  function Location({ sessionId }: { sessionId: string }) {
    const [text, setText] = React.useState('云端工作区');
    React.useEffect(() => {
      const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = async () => {
        try {
          const csrf = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('dsh_csrf='))?.slice(9) ?? '';
          const response = await fetch('/desktop-workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({ action: 'status', sessionId }), signal: abort.signal });
          if (!response.ok) return;
          const state = await response.json() as { mode: string; connected: boolean };
          if (abort.signal.aborted) return;
          setText(state.mode === 'desktop' ? (state.connected ? '本机工作区 · 桌面已连接' : '本机工作区 · 桌面已断线') : '云端工作区');
          if (state.mode === 'desktop') timer = setTimeout(() => { void refresh(); }, 5000);
        } catch { /* 网络断线由全局连接 UI 提示；不显示虚假本机连接。 */ if (!abort.signal.aborted) setText('工作区状态不可用'); }
      };
      setText('云端工作区'); void refresh();
      return () => { abort.abort(); clearTimeout(timer); };
    }, [sessionId]);
    return React.createElement('span', { role: 'status', title: '本机目录、Shell 和同步授权只能在桌面客户端管理。' }, text);
  }
  return { inject: ['slots'], apply(ctx: Context) {
    if (globals.__MEWCLAW_DESKTOP_WORKSPACE__) return;
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions',
      id: 'mewclaw-workspace-location', order: -100, inject: sessionId => ({ sessionId }) }, Location));
  } };
} });
