/** 本地模式思考强度滑条：注入官方输入框上方 ambient 坞（conversation.input.dock，list/session），
 * 复用 ctx.modelDirectories 的会话共享目录——与 /model 弹层、composer 模型座同一份状态，
 * 仅当当前模型带 reasoning 元数据时渲染。交互对齐 Web 版 mwseat 滑条：按住轨道拖动预览、
 * 松开提交；方向键逐档、Home/End 跳端点；提交后拇指停留待 store 确认（pending），失败回退。 */
import type { Context } from '@deepseek-ai/cordis';
import type * as ReactType from 'react';

type SessionId = string;
type Effort = { id: string; name: string; description?: string };
type Reasoning = { efforts: readonly Effort[]; defaultEffort?: string };
type CatalogModel = { id: string; name: string; reasoning?: Reasoning };
type DirectoryState = {
  current: { provider: string; model: string; reasoningEffort?: string } | null;
  groups: readonly { id: string; models: readonly CatalogModel[] }[];
  status: string;
};
type Store<T> = { getSnapshot(): T; subscribe(fn: () => void): () => void };
type Directory = { store: Store<DirectoryState>; load(): Promise<unknown>; select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> };
type Injected = { sessionId: SessionId; directory: Directory };

const loader = (globalThis as unknown as { __ModuleLoader__: { load(value: unknown): void } }).__ModuleLoader__;
loader.load({ id: 'dsh-lark-desktop-effort-client', factory: (require: (id: string) => unknown) => {
  const React = require('react') as typeof ReactType;

  /** 滑条档位：defaultEffort 缺失时首档为「默认」（选中即清除显式 effort，与官方语义一致）。 */
  function effortRows(reasoning: Reasoning, currentEffort: string | undefined) {
    const effective = currentEffort ?? reasoning.defaultEffort;
    const rows: { key: string; effort: string | undefined; label: string; active: boolean }[] =
      reasoning.efforts.map(e => ({ key: `effort:${e.id}`, effort: e.id, label: e.name, active: e.id === effective }));
    if (reasoning.defaultEffort === undefined) rows.unshift({ key: 'provider-default', effort: undefined, label: '默认', active: currentEffort === undefined });
    return rows;
  }

  function EffortDock(props: Injected & { directory: Directory }): ReactType.ReactElement | null {
    const { directory } = props;
    const state = React.useSyncExternalStore(
      (fn: () => void) => directory.store.subscribe(fn),
      () => directory.store.getSnapshot());
    React.useEffect(() => { void directory.load().catch(() => {}); }, [directory]);
    const [drag, setDrag] = React.useState<number | null>(null);
    const [pending, setPending] = React.useState<number | null>(null);
    const trackRef = React.useRef<HTMLDivElement | null>(null);

    const current = state.current;
    const model = current === null ? undefined
      : state.groups.find(g => g.id === current.provider)?.models.find(m => m.id === current.model);
    const reasoning = model?.reasoning;
    const rows = reasoning === undefined ? [] : effortRows(reasoning, current?.reasoningEffort);
    const n = rows.length;
    const busy = state.status === 'selecting';
    const found = rows.findIndex(r => r.active);
    const active = found < 0 ? 0 : found;
    React.useEffect(() => { if (pending !== null && pending === active) setPending(null); }, [pending, active]);
    const index = Math.min(n - 1, Math.max(0, drag ?? pending ?? active));
    if (current === null || n === 0) return null;
    const frac = (i: number) => (n <= 1 ? 0.5 : i / (n - 1));
    const PAD = 12; const HALF = 7;
    const pos = (i: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${frac(i)})`;
    const fill = (i: number) => `calc(${PAD + HALF + 4}px + (100% - ${PAD * 2}px) * ${frac(i)})`;
    const indexAt = (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined || rect.width <= PAD * 2 || n <= 1) return index;
      return Math.min(n - 1, Math.max(0, Math.round(((clientX - rect.left - PAD) / (rect.width - PAD * 2)) * (n - 1))));
    };
    const commit = (i: number) => {
      if (busy || i === index) return;
      setPending(i);
      const effort = rows[i]?.effort;
      void directory.select(effort === undefined
        ? { provider: current.provider, model: current.model }
        : { provider: current.provider, model: current.model, reasoningEffort: effort })
        .then(() => undefined, () => setPending(null));
    };
    const onPointerDown = (event: ReactType.PointerEvent<HTMLDivElement>) => {
      if (busy || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault?.();
      setDrag(indexAt(event.clientX));
      const move = (ev: PointerEvent) => setDrag(indexAt(ev.clientX));
      const up = (ev: PointerEvent) => {
        globalThis.window.removeEventListener('pointermove', move);
        globalThis.window.removeEventListener('pointerup', up);
        setDrag(null);
        commit(indexAt(ev.clientX));
      };
      globalThis.window.addEventListener('pointermove', move);
      globalThis.window.addEventListener('pointerup', up);
    };
    const onKeyDown = (event: ReactType.KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : 0;
      if (step !== 0) { event.preventDefault(); commit(Math.min(n - 1, Math.max(0, index + step))); }
      else if (event.key === 'Home') { event.preventDefault(); commit(0); }
      else if (event.key === 'End') { event.preventDefault(); commit(n - 1); }
    };
    return React.createElement('div', { className: 'mewclaw-effort' },
      React.createElement('span', { className: 'mewclaw-effort-label' }, '思考强度'),
      React.createElement('div', {
        ref: trackRef,
        className: `mewclaw-effort-rail${drag !== null ? ' drag' : ''}`,
        role: 'slider', tabIndex: busy ? -1 : 0,
        'aria-label': '思考强度', 'aria-orientation': 'horizontal',
        'aria-valuemin': 0, 'aria-valuemax': n - 1, 'aria-valuenow': index,
        'aria-valuetext': rows[index]?.label, 'aria-disabled': busy,
        onPointerDown, onKeyDown,
      },
        React.createElement('div', { className: 'mewclaw-effort-fill', 'aria-hidden': 'true', style: { width: fill(index) } }),
        rows.map((row, i) => React.createElement('span', {
          key: `t:${row.key}`, 'aria-hidden': 'true',
          className: `mewclaw-effort-tick${i <= index ? ' on' : ''}`, style: { left: pos(i) },
        })),
        React.createElement('span', { className: 'mewclaw-effort-thumb', 'aria-hidden': 'true', style: { left: pos(index) } })),
      React.createElement('span', { className: 'mewclaw-effort-value', 'aria-live': 'polite' },
        rows[index]?.label ?? '',
        React.createElement('span', { className: 'mewclaw-effort-pos' }, `${index + 1}/${n}`)));
  }

  /** 胶囊轨道 + 拇指样式，全部走 dsw 令牌；轨道宽 168px 对齐 Web 弹层滑条密度。 */
  const EFFORT_CSS = `
.mewclaw-effort{display:flex;align-items:center;gap:10px;padding:2px 4px 0;min-height:22px}
.mewclaw-effort-label{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,rgb(249 250 251 / 40%));letter-spacing:.02em}
.mewclaw-effort-rail{position:relative;flex:none;width:168px;height:20px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgb(220 220 235 / 10%));cursor:pointer;outline:none;touch-action:none}
.mewclaw-effort-rail:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#8ab4f8);outline-offset:2px}
.mewclaw-effort-rail[aria-disabled="true"]{cursor:default;opacity:.55}
.mewclaw-effort-fill{position:absolute;left:0;top:0;bottom:0;border-radius:10px;background:var(--dsw-alias-label-primary-bluish,#8ab4f8);opacity:.85;transition:width .08s}
.mewclaw-effort-rail.drag .mewclaw-effort-fill{transition:none}
.mewclaw-effort-tick{position:absolute;top:50%;width:3px;height:3px;border-radius:50%;transform:translate(-50%,-50%);background:var(--dsw-alias-label-tertiary,rgb(249 250 251 / 40%))}
.mewclaw-effort-tick.on{background:rgb(255 255 255 / 70%)}
.mewclaw-effort-thumb{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;transform:translate(-50%,-50%);background:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 1px 3px rgb(0 0 0 / 35%),inset 0 0 0 1px rgb(0 0 0 / 6%);transition:left .08s}
.mewclaw-effort-rail.drag .mewclaw-effort-thumb{transition:none}
.mewclaw-effort-value{display:flex;align-items:baseline;gap:6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb);min-width:0}
.mewclaw-effort-pos{font-size:10px;color:var(--dsw-alias-label-tertiary,rgb(249 250 251 / 40%))}
`;

  function ensureEffortStyle(): void {
    if (document.getElementById('mewclaw-effort-style')) return;
    const style = document.createElement('style');
    style.id = 'mewclaw-effort-style';
    style.textContent = EFFORT_CSS;
    document.head.appendChild(style);
  }

  // remote.session：directoryFor 内部经本模块 ambient scope 读 ctx.remote.session，
  // 缺声明会被 inject 代理拒绝（同 mwseat seat 的依赖面）。
  return { inject: ['slots', 'modelDirectories', 'sessions', 'remote.session'], apply(ctx: Context) {
    const models = (ctx as Context & { modelDirectories: { directoryFor(id: SessionId): Directory } }).modelDirectories;
    ensureEffortStyle();
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'mewclaw-effort', order: 100,
      inject: (sessionId: SessionId) => {
        const directory = models.directoryFor(sessionId);
        return { sessionId, directory };
      },
    }, EffortDock));
  } };
} });
