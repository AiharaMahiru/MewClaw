/** 在官方侧栏底部提供云端/本地 Harness 控制，不替换官方侧栏。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type * as ReactType from 'react';

type SessionLocation = 'cloud' | 'local';
type ModuleLoader = { load(value: { id: string; factory: (require: (id: string) => unknown) => unknown }): void };
type LocationProps = { wide: boolean };

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

  // 与 Web 的雾白/石墨底面及语义交互色保持同源，窄侧栏仅改变排列。
  const styleText = `
.mewclaw-location{display:flex;flex-direction:column;gap:6px;padding:6px 8px;color:var(--dsw-alias-label-primary);font:inherit}
.mewclaw-location-toggle{display:grid;grid-template-columns:1fr 1fr;position:relative;isolation:isolate;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-selector)}
.mewclaw-location button{appearance:none;display:flex;align-items:center;justify-content:center;gap:7px;min-width:0;min-height:34px;padding:6px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color 160ms ease,color 160ms ease,box-shadow 160ms ease;touch-action:manipulation}
.mewclaw-location button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mewclaw-location button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.mewclaw-location button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.mewclaw-location button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 3px rgb(0 0 0 / 8%),inset 0 0 0 1px var(--dsw-alias-border-l2);font-weight:600}
.mewclaw-location button:disabled{cursor:wait;opacity:.6}
.mewclaw-location svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.mewclaw-location[data-wide=false]{padding:6px 4px;align-items:center}
.mewclaw-location[data-wide=false] .mewclaw-location-toggle{grid-template-columns:1fr}
.mewclaw-location[data-wide=false] button{width:36px;padding:6px}
.mewclaw-location-status{font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.mewclaw-location[data-wide=false] .mewclaw-location-status{position:absolute;left:52px;bottom:16px;max-width:240px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);z-index:100}
@media(prefers-reduced-motion:reduce){.mewclaw-location button{transition:none}}
`;
  const icon = (kind: SessionLocation) => React.createElement('svg', { viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('path', { d: kind === 'cloud' ? 'M6 18h12a4 4 0 0 0 .6-7.95A7 7 0 0 0 5.1 8.8 4.7 4.7 0 0 0 6 18Z'
      : 'M4 4h16v12H4zM8 20h8M12 16v4' }));

  function LocationActions(props: LocationProps): ReactType.ReactElement {
    const [busy, setBusy] = React.useState(false);
    const pending = React.useRef(false);
    const [targetLocation, setTargetLocation] = React.useState<SessionLocation | null>(null);
    const [error, setError] = React.useState('');
    const wide = props.wide;
    const change = async (target: SessionLocation) => {
      if (target === location || pending.current) return;
      pending.current = true; setBusy(true); setTargetLocation(target); setError('');
      try {
        await request('/api/mewclaw-desktop/location', { location: target });
        // 预存切换意图并在当前页盖同色过渡面；整页重载后由注入运行时延续同一过渡面。
        // 键名与 switch-splash.ts 的 SWITCH_FLAG_KEY 保持同一字面量（本文件按静态脚本分发，不能引入模块依赖）。
        let bg = '';
        let ink = '';
        try {
          // body 常是透明底色（主题把底画在 html/root 上）：透明会让官方启动屏透上来与
          // 过渡文案叠影——先 body 后 html 取首个不透明色，仍透明则交给新页面默认色。
          const transparent = (value: string) => {
            const alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(value)?.[1];
            if (alpha !== undefined) return Number.parseFloat(alpha) < 1;
            const hex = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.exec(value);
            return hex !== null && (value.length === 5 ? value[4] === '0' : value.slice(7) === '00');
          };
          const body = getComputedStyle(document.body);
          bg = body.backgroundColor;
          if (transparent(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
          if (transparent(bg)) bg = '';
          ink = body.color;
        } catch { /* 样式不可读时由新页面用默认色 */ }
        try { sessionStorage.setItem('mewclaw.location-switch', JSON.stringify({ to: target, bg, ink })); } catch { /* 意图缺失时新页面直接启动 */ }
        const overlay = document.createElement('div');
        overlay.id = 'mewclaw-location-splash';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('style', `position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:${bg || '#17181c'};color:${ink || '#e8eaef'};font:13px/1.6 system-ui,"Segoe UI",sans-serif;`);
        const label = document.createElement('div');
        label.textContent = target === 'local' ? '正在切换到本地工作区' : '正在切换到云端工作区';
        overlay.appendChild(label);
        document.body.appendChild(overlay);
        // 重载被阻断的极小概率下移除覆盖层，避免页面被永久盖住。
        setTimeout(() => overlay.remove(), 15000);
        globalThis.location.reload();
      }
      catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败，请重试。'); pending.current = false; setBusy(false); setTargetLocation(null); }
    };
    const label = (mode: SessionLocation) => mode === 'cloud' ? '云端' : '本地';
    return React.createElement('div', {
      className: 'mewclaw-location', 'data-wide': wide, 'aria-busy': busy,
    },
      React.createElement('div', { className: 'mewclaw-location-toggle', role: 'group', 'aria-label': '工作区位置',
        onKeyDown: (event: ReactType.KeyboardEvent<HTMLDivElement>) => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0 || busy) return;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1
            : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % 2
            : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + 1) % 2 : -1;
          if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
        },
      }, ...(['cloud', 'local'] as const).map(mode => React.createElement('button', {
        key: mode, type: 'button', disabled: busy, 'aria-pressed': mode === location,
        'aria-label': `${label(mode)}模式`, title: mode === 'cloud' ? '云端模式：使用云端工作区' : '本地模式：使用这台电脑的工作区和工具，模型由云端账号提供',
        onClick: () => { void change(mode); },
      }, icon(mode), wide ? React.createElement('span', null, label(mode)) : null))),
      error || busy ? React.createElement('span', { role: 'status', 'aria-live': 'polite', className: 'mewclaw-location-status' },
        error || (targetLocation ? `正在切换到${label(targetLocation)}…` : '正在打开目录…')) : null);
  }

  return { inject: ['slots'], apply(ctx: Context) {
    ctx.effect(() => {
      const style = document.createElement('style'); style.textContent = styleText; document.head.append(style);
      return () => style.remove();
    });
    ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'mewclaw-location', order: -100,
    }, (props: LocationProps) => React.createElement(LocationActions, props))));
  } };
} });
