/**
 * composer 模型位 shadow 组件的纯视图层：思考强度滑条优先、
 * 「更多」进入模型清单。与官方 ModelSelect 共用同一个
 * ModelDirectory store / select 通路（SPEC docs/specs/model-seat.md §2）。
 */
import type { ReactNode } from "react";

export type SeatSelection = { provider: string; model: string; reasoningEffort?: string };
export type SeatEffort = { id: string; name: string; description?: string };
export type SeatModel = {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts: readonly SeatEffort[]; defaultEffort?: string };
};
export type SeatGroup = { id: string; name: string; models: readonly SeatModel[] };
export type SeatSnapshot = {
  current: SeatSelection | null;
  routable: boolean | null;
  groups: readonly SeatGroup[];
  failures: readonly { id: string; name: string; message: string }[];
  status: "idle" | "loading" | "ready" | "selecting" | "error";
  error: string | null;
};
export type SeatStore = { subscribe(fn: () => void): () => void; getSnapshot(): SeatSnapshot };
/** 与官方 ModelSelectInjected 对齐的注入面（本组件消费的最小形状）。 */
export type SeatFace = {
  available: boolean;
  directory: SeatStore;
  load(): void;
  select(selection: SeatSelection): Promise<boolean>;
};
export type SeatProps = SeatFace & { locked?: boolean };
export type SeatView = "effort" | "list";

export type SeatReactApi = {
  createElement(type: string | ((props: never) => unknown), props?: Record<string, unknown> | null, ...children: unknown[]): ReactNode;
  useSyncExternalStore<T>(subscribe: (fn: () => void) => () => void, getSnapshot: () => T): T;
  useState<T>(initial: T | (() => T)): [T, (value: T) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useId(): string;
};
export type SeatDomApi = { createPortal(node: unknown, host: unknown): ReactNode };

/** 当前选中在目录里的条目；目录归属是 advisory，缺失时 group/model 为 undefined。 */
export function currentEntry(state: SeatSnapshot): { group: SeatGroup | undefined; model: SeatModel | undefined } {
  const current = state.current;
  if (current === null) return { group: undefined, model: undefined };
  const group = state.groups.find((g) => g.id === current.provider);
  return { group, model: group?.models.find((m) => m.id === current.model) };
}

/** 触发器模型名：等待加载 / 无目录条目时回退 provider/model 原文。 */
export function triggerModelLabel(state: SeatSnapshot, model: SeatModel | undefined): string {
  if (state.current === null) return state.status === "loading" ? "加载中…" : "选择模型";
  return model?.name ?? `${state.current.provider}/${state.current.model}`;
}

/** 触发器强度名：模型无 reasoning 元数据时不显示；未显式选择时落默认档。 */
export function triggerEffortLabel(model: SeatModel | undefined, current: SeatSelection | null): string | undefined {
  const reasoning = model?.reasoning;
  if (reasoning === undefined) return undefined;
  const effective = current?.reasoningEffort ?? reasoning.defaultEffort;
  if (effective === undefined) return "默认";
  return reasoning.efforts.find((e) => e.id === effective)?.name ?? effective;
}

/** 打开弹层的初始视图：当前模型带思考强度档 → 滑条；否则直接进清单。 */
export function initialView(model: SeatModel | undefined): SeatView {
  return model?.reasoning === undefined || model.reasoning.efforts.length === 0 ? "list" : "effort";
}

export type EffortRow = { key: string; effort: string | undefined; label: string; description?: string; active: boolean };
/** 滑条档位：defaultEffort 缺失时首档为「默认」（选中即清除显式 effort，与官方语义一致）。 */
export function effortRows(model: SeatModel | undefined, current: SeatSelection | null): EffortRow[] {
  const reasoning = model?.reasoning;
  if (reasoning === undefined) return [];
  const effective = current?.reasoningEffort ?? reasoning.defaultEffort;
  const rows: EffortRow[] = reasoning.efforts.map((e) => ({
    key: `effort:${e.id}`,
    effort: e.id,
    label: e.name,
    ...(e.description !== undefined ? { description: e.description } : {}),
    active: e.id === effective,
  }));
  if (reasoning.defaultEffort === undefined) {
    rows.unshift({ key: "provider-default", effort: undefined, label: "默认", active: current?.reasoningEffort === undefined });
  }
  return rows;
}

export type SeatSliderProps = { rows: readonly EffortRow[]; busy: boolean; onPick(effort: string | undefined): void };
export type SeatSliderComponent = (props: SeatSliderProps) => ReactNode;

/**
 * 思考强度离散滑条：指针按下后随拖动预览档位、松开提交；
 * 方向键逐档、Home/End 跳端点；档位标签本身可点。提交值是 row.effort
 * （「默认」档为 undefined，由上层清除显式 effort）。
 */
export function createEffortSlider(React: SeatReactApi): SeatSliderComponent {
  const h = React.createElement;
  return function EffortSlider(props: SeatSliderProps): ReactNode {
    const { rows, busy, onPick } = props;
    const [drag, setDrag] = React.useState<number | null>(null);
    const trackRef = React.useRef<{ getBoundingClientRect(): { left: number; width: number } } | null>(null);
    const n = rows.length;
    if (n === 0) return null;
    const found = rows.findIndex((r) => r.active);
    const active = found < 0 ? 0 : found;
    const index = Math.min(n - 1, Math.max(0, drag ?? active));
    const pct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
    const indexAt = (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined || rect.width <= 0 || n <= 1) return index;
      return Math.min(n - 1, Math.max(0, Math.round(((clientX - rect.left) / rect.width) * (n - 1))));
    };
    const commit = (i: number) => {
      if (i !== active) onPick(rows[i]?.effort);
    };
    const onPointerDown = (event: { clientX: number; button?: number; preventDefault?(): void }) => {
      if (busy || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault?.();
      setDrag(indexAt(event.clientX));
      const win = globalThis.window;
      if (win === undefined) return;
      const move = (ev: { clientX: number }) => setDrag(indexAt(ev.clientX));
      const up = (ev: { clientX: number }) => {
        win.removeEventListener("pointermove", move);
        win.removeEventListener("pointerup", up);
        setDrag(null);
        commit(indexAt(ev.clientX));
      };
      win.addEventListener("pointermove", move);
      win.addEventListener("pointerup", up);
    };
    const onKeyDown = (event: { key: string; preventDefault(): void }) => {
      const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
      if (step !== 0) {
        event.preventDefault();
        commit(Math.min(n - 1, Math.max(0, index + step)));
      } else if (event.key === "Home") {
        event.preventDefault();
        commit(0);
      } else if (event.key === "End") {
        event.preventDefault();
        commit(n - 1);
      }
    };
    return h("div", { className: "mwseat-slider" },
      h("div", {
        ref: trackRef,
        className: `mwseat-sliderRail${drag !== null ? " drag" : ""}`,
        role: "slider",
        tabIndex: busy ? -1 : 0,
        "aria-label": "思考强度",
        "aria-orientation": "horizontal",
        "aria-valuemin": 0,
        "aria-valuemax": n - 1,
        "aria-valuenow": index,
        "aria-valuetext": rows[index]?.label,
        "aria-disabled": busy,
        onPointerDown,
        onKeyDown,
      },
        h("div", { className: "mwseat-sliderFill", style: { width: `${pct(index)}%` } }),
        rows.map((row, i) => h("span", { key: `t:${row.key}`, className: "mwseat-sliderTick", "aria-hidden": "true", style: { left: `${pct(i)}%` } })),
        h("span", { className: "mwseat-sliderThumb", "aria-hidden": "true", style: { left: `${pct(index)}%` } })),
      h("div", { className: "mwseat-sliderStops" },
        rows.map((row, i) => h("button", {
          key: `s:${row.key}`,
          type: "button",
          className: `mwseat-sliderStop${i === index ? " on" : ""}`,
          disabled: busy,
          ...(row.description !== undefined ? { title: row.description } : {}),
          style: { left: `${pct(i)}%`, transform: i === 0 ? "translateX(0)" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)" },
          onClick: () => commit(i),
        }, row.label))));
  };
}

export type MenuBodyOpts = {
  view: SeatView;
  state: SeatSnapshot;
  model: SeatModel | undefined;
  busy: boolean;
  slider: SeatSliderComponent;
  onEffort(effort: string | undefined): void;
  onModel(group: SeatGroup, model: SeatModel): void;
  onMore(): void;
  onBack(): void;
};

/** 弹层主体：effort 视图（标题 + 更多 + 横向档位滑条）或 list 视图（分组模型清单）。 */
export function seatMenuBody(React: Pick<SeatReactApi, "createElement">, o: MenuBodyOpts): ReactNode {
  const h = React.createElement;
  const { state, model, busy } = o;
  if (o.view === "effort") {
    const rows = effortRows(model, state.current);
    return h("div", { className: "mwseat-body" },
      h("div", { className: "mwseat-head" },
        h("span", { className: "mwseat-title" }, triggerModelLabel(state, model)),
        h("button", { type: "button", className: "mwseat-more", onClick: o.onMore }, "更多")),
      h(o.slider, { rows, busy, onPick: o.onEffort }),
      state.error !== null ? h("div", { className: "mwseat-error" }, state.error) : null);
  }
  const rows: unknown[] = [];
  for (const group of state.groups) {
    rows.push(h("div", { key: `g:${group.id}`, className: "mwseat-groupTitle" }, group.name));
    for (const m of group.models) {
      const selected = state.current?.provider === group.id && state.current.model === m.id;
      const effortName = m.reasoning === undefined
        ? undefined
        : (m.reasoning.efforts.find((e) => e.id === (state.current?.reasoningEffort ?? m.reasoning?.defaultEffort))?.name ?? m.reasoning.defaultEffort);
      rows.push(h("button", {
        key: `m:${group.id}/${m.id}`,
        type: "button",
        role: "menuitemradio",
        "aria-checked": selected,
        className: `mwseat-row${selected ? " on" : ""}`,
        disabled: busy,
        onClick: () => o.onModel(group, m),
      },
        h("span", { className: "mwseat-rowName" }, m.name),
        selected && effortName !== undefined ? h("span", { className: "mwseat-rowMeta" }, effortName) : null,
        selected ? h("span", { className: "mwseat-check", "aria-hidden": "true" }, "✓") : null));
    }
  }
  for (const failure of state.failures) {
    rows.push(h("div", { key: `f:${failure.id}`, className: "mwseat-hint" }, `${failure.name}：${failure.message}`));
  }
  if (state.groups.length === 0) {
    rows.push(h("div", { key: "empty", className: "mwseat-hint" },
      state.status === "loading" ? "正在加载模型目录…" : state.error ?? "暂无可用模型"));
  }
  return h("div", { className: "mwseat-body" },
    h("div", { className: "mwseat-head" },
      model?.reasoning !== undefined
        ? h("button", { type: "button", className: "mwseat-back", "aria-label": "返回思考强度", onClick: o.onBack }, "‹")
        : null,
      h("span", { className: "mwseat-title" }, "选择模型")),
    h("div", { className: "mwseat-list", role: "menu" }, rows),
    state.error !== null && state.groups.length > 0 ? h("div", { className: "mwseat-error" }, state.error) : null);
}

/** 生成 slot 组件：闭包持有 React/DOM 面，props 即注入面 + 宿主 locked。 */
export function createSeatComponent(React: SeatReactApi, dom: SeatDomApi) {
  const h = React.createElement;
  const Slider = createEffortSlider(React);
  return function ModelSeat(props: SeatProps): ReactNode {
    const { locked, available, directory, load, select } = props;
    const state = React.useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot());
    const [open, setOpen] = React.useState(false);
    const [view, setView] = React.useState<SeatView>("effort");
    const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
    const rootRef = React.useRef<HTMLElement | null>(null);
    const triggerRef = React.useRef<HTMLElement | null>(null);
    const menuRef = React.useRef<HTMLElement | null>(null);
    const id = React.useId();
    const { model } = currentEntry(state);
    const busy = state.status === "selecting";

    React.useEffect(() => {
      if (!open) return;
      const closeOutside = (event: Event) => {
        const target = event.target;
        if (target instanceof Node && (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true)) return;
        setOpen(false);
      };
      document.addEventListener("mousedown", closeOutside);
      return () => document.removeEventListener("mousedown", closeOutside);
    }, [open]);

    React.useLayoutEffect(() => {
      if (!open) { setPos(null); return; }
      const place = () => {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (rect === undefined) return;
        const MARGIN = 12;
        const lw = menuRef.current?.offsetWidth ?? 0;
        const lh = menuRef.current?.offsetHeight ?? 0;
        let x = rect.right - lw;
        let y = rect.top - 8 - lh;
        if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
        if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
        setPos({ left: x, top: y });
      };
      place();
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      return () => {
        window.removeEventListener("scroll", place, true);
        window.removeEventListener("resize", place);
      };
    }, [open, view, state]);

    if (!available) return null;

    const close = () => setOpen(false);
    const settle = (accepted: boolean) => { if (accepted) close(); };
    const show = () => { setView(initialView(model)); setOpen(true); load(); };
    const chooseModel = (group: SeatGroup, m: SeatModel) => {
      const selection: SeatSelection = {
        provider: group.id,
        model: m.id,
        ...(m.reasoning?.defaultEffort !== undefined ? { reasoningEffort: m.reasoning.defaultEffort } : {}),
      };
      if (state.current?.provider === selection.provider && state.current.model === selection.model) { close(); return; }
      void select(selection).then(settle);
    };
    const chooseEffort = (effort: string | undefined) => {
      const current = state.current;
      if (current === null) return;
      void select({ provider: current.provider, model: current.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }).then(settle);
    };
    const onKeyDown = (event: { key: string; preventDefault(): void }) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      if (view === "list" && model?.reasoning !== undefined) setView("effort");
      else close();
    };

    const mLabel = triggerModelLabel(state, model);
    const eLabel = triggerEffortLabel(model, state.current);
    const menu = h("div", {
      ref: menuRef,
      id: `${id}-menu`,
      className: "mwseat-menu",
      role: "dialog",
      "aria-label": "模型与思考强度",
      style: pos ?? { visibility: "hidden", left: 0, top: 0 },
    }, seatMenuBody(React, {
      view, state, model, busy, slider: Slider,
      onEffort: chooseEffort,
      onModel: chooseModel,
      onMore: () => setView("list"),
      onBack: () => setView("effort"),
    }));
    return h("div", { ref: rootRef, className: "mwseat-root", onKeyDown },
      h("button", {
        ref: triggerRef,
        type: "button",
        className: "mwseat-trigger",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? `${id}-menu` : undefined,
        title: eLabel === undefined ? mLabel : `${mLabel} · ${eLabel}`,
        disabled: locked === true,
        onClick: () => (open ? close() : show()),
      },
        h("span", { className: "mwseat-label" }, mLabel),
        eLabel !== undefined ? h("span", { className: "mwseat-effort" }, eLabel) : null,
        h("svg", { className: `mwseat-chev${open ? " open" : ""}`, width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" },
          h("path", { d: "M3.5 5.25 7 8.75l3.5-3.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }))),
      open ? dom.createPortal(menu, document.body) : null);
  };
}

/**
 * 组件样式：一次性注入 <style id="dsh-lark-model-seat">。
 * `.mwseat-groupTitle` 显式透明——官方 groupTitle 的 `--dsw-specific-menu` 实底在
 * provider 名下呈现为黑色矩形（本组件的清单不复用该类，规则仅作其他官方入口的安全网）。
 */
export const SEAT_CSS = `
.mwseat-root{position:relative;display:inline-flex;min-width:0}
.mwseat-trigger{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 6px 0 10px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;min-width:0}
.mwseat-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mwseat-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.mwseat-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mwseat-effort{color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:nowrap}
.mwseat-chev{display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.mwseat-chev.open{transform:rotate(180deg)}
.mwseat-menu{position:fixed;z-index:1100;display:flex;flex-direction:column;min-width:220px;max-width:min(360px,calc(100vw - 24px));max-height:min(340px,calc(100vh - 96px));padding:4px;border-radius:16px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);overflow:hidden;font-size:13px}
.mwseat-head{display:flex;align-items:center;gap:6px;padding:8px 8px 6px}
.mwseat-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mwseat-more,.mwseat-back{border:0;background:transparent;padding:0;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.mwseat-more{font-weight:500}
.mwseat-back{display:inline-flex;align-items:center;padding:0 2px;font-size:14px}
.mwseat-more:hover,.mwseat-back:hover{color:var(--dsw-alias-label-primary)}
.mwseat-slider{padding:0 10px 4px;user-select:none}
.mwseat-sliderRail{position:relative;height:24px;cursor:pointer;touch-action:none;outline:none}
.mwseat-sliderRail::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;transform:translateY(-50%);border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}
.mwseat-sliderRail:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px;border-radius:6px}
.mwseat-sliderFill{position:absolute;left:0;top:50%;height:4px;transform:translateY(-50%);border-radius:999px;background:var(--dsw-alias-state-business-primary,#5c70c9)}
.mwseat-sliderTick{position:absolute;top:50%;width:5px;height:5px;border-radius:50%;transform:translate(-50%,-50%);background:var(--dsw-alias-label-dimmed);pointer-events:none}
.mwseat-sliderThumb{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;transform:translate(-50%,-50%);background:var(--dsw-alias-label-primary);box-shadow:0 1px 4px rgb(0 0 0 / 32%);pointer-events:none}
.mwseat-sliderRail:not(.drag) .mwseat-sliderThumb,.mwseat-sliderRail:not(.drag) .mwseat-sliderFill{transition:left .12s ease,width .12s ease}
.mwseat-sliderStops{position:relative;height:20px;margin-top:2px}
.mwseat-sliderStop{position:absolute;border:0;background:transparent;padding:0;font:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap}
.mwseat-sliderStop.on{color:var(--dsw-alias-label-primary);font-weight:500}
.mwseat-sliderStop:disabled{cursor:default;opacity:.6}
.mwseat-list{overflow-y:auto;min-height:0;padding:0 0 2px}
/* liquid-glass 的 panels 选择器命中 [role="menu"]；清单只是 dialog 内内容区，
   压平第二层面板避免叠出两层圆角半透明背景。 */
.mwseat-menu .mwseat-list[role="menu"]{background:transparent;background-color:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;border-radius:0;padding:0;scroll-padding:0}
.mwseat-groupTitle{padding:8px 8px 4px;font-size:12px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-caption);background:transparent}
.mwseat-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.mwseat-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mwseat-row:disabled{cursor:default;opacity:.6}
.mwseat-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mwseat-rowMeta{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mwseat-check{color:var(--dsw-alias-label-secondary)}
.mwseat-hint{padding:10px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mwseat-error{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);border-top:1px solid rgba(127,127,127,.18)}
`;

/** 幂等注入组件样式（client apply 调用一次；测试与 SSR 无 document 时跳过）。 */
export function ensureSeatStyle(doc: { head?: { appendChild(node: unknown): void }; getElementById?(id: string): unknown; createElement?(tag: string): { id: string; textContent: string } } | undefined): void {
  if (doc?.getElementById === undefined || doc.createElement === undefined || doc.head === undefined) return;
  if (doc.getElementById("dsh-lark-model-seat") != null) return;
  const style = doc.createElement("style");
  style.id = "dsh-lark-model-seat";
  style.textContent = SEAT_CSS;
  doc.head.appendChild(style);
}
