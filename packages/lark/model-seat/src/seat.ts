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

export type MenuBodyOpts = {
  view: SeatView;
  state: SeatSnapshot;
  model: SeatModel | undefined;
  busy: boolean;
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
      h("div", { className: "mwseat-track", role: "radiogroup", "aria-label": "思考强度" },
        rows.map((row) => h("button", {
          key: row.key,
          type: "button",
          role: "radio",
          "aria-checked": row.active,
          className: `mwseat-seg${row.active ? " on" : ""}`,
          disabled: busy,
          ...(row.description !== undefined ? { title: row.description } : {}),
          onClick: () => o.onEffort(row.effort),
        }, row.label))),
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
      view, state, model, busy,
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
.mwseat-track{display:flex;gap:2px;margin:0 4px 4px;padding:2px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.mwseat-seg{flex:1 1 0;min-width:0;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
.mwseat-seg:hover:not(:disabled):not(.on){color:var(--dsw-alias-label-primary)}
.mwseat-seg.on{background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.18)}
.mwseat-seg:disabled{cursor:default;opacity:.6}
.mwseat-list{overflow-y:auto;min-height:0;padding:0 0 2px}
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
