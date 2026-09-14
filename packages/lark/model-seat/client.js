"use strict";
(() => {
  // packages/lark/model-seat/src/seat.ts
  function currentEntry(state) {
    const current = state.current;
    if (current === null) return { group: void 0, model: void 0 };
    const group = state.groups.find((g) => g.id === current.provider);
    return { group, model: group?.models.find((m) => m.id === current.model) };
  }
  function triggerModelLabel(state, model) {
    if (state.current === null) return state.status === "loading" ? "\u52A0\u8F7D\u4E2D\u2026" : "\u9009\u62E9\u6A21\u578B";
    return model?.name ?? `${state.current.provider}/${state.current.model}`;
  }
  function triggerEffortLabel(model, current) {
    const reasoning = model?.reasoning;
    if (reasoning === void 0) return void 0;
    const effective = current?.reasoningEffort ?? reasoning.defaultEffort;
    if (effective === void 0) return "\u9ED8\u8BA4";
    return reasoning.efforts.find((e) => e.id === effective)?.name ?? effective;
  }
  function initialView(model) {
    return model?.reasoning === void 0 || model.reasoning.efforts.length === 0 ? "list" : "effort";
  }
  function effortRows(model, current) {
    const reasoning = model?.reasoning;
    if (reasoning === void 0) return [];
    const effective = current?.reasoningEffort ?? reasoning.defaultEffort;
    const rows = reasoning.efforts.map((e) => ({
      key: `effort:${e.id}`,
      effort: e.id,
      label: e.name,
      ...e.description !== void 0 ? { description: e.description } : {},
      active: e.id === effective
    }));
    if (reasoning.defaultEffort === void 0) {
      rows.unshift({ key: "provider-default", effort: void 0, label: "\u9ED8\u8BA4", active: current?.reasoningEffort === void 0 });
    }
    return rows;
  }
  function createEffortSlider(React) {
    const h = React.createElement;
    return function EffortSlider(props) {
      const { rows, busy, onPick } = props;
      const [drag, setDrag] = React.useState(null);
      const trackRef = React.useRef(null);
      const n = rows.length;
      if (n === 0) return null;
      const found = rows.findIndex((r) => r.active);
      const active = found < 0 ? 0 : found;
      const index = Math.min(n - 1, Math.max(0, drag ?? active));
      const pct = (i) => n <= 1 ? 50 : i / (n - 1) * 100;
      const indexAt = (clientX) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (rect === void 0 || rect.width <= 0 || n <= 1) return index;
        return Math.min(n - 1, Math.max(0, Math.round((clientX - rect.left) / rect.width * (n - 1))));
      };
      const commit = (i) => {
        if (i !== active) onPick(rows[i]?.effort);
      };
      const onPointerDown = (event) => {
        if (busy || event.button !== void 0 && event.button !== 0) return;
        event.preventDefault?.();
        setDrag(indexAt(event.clientX));
        const win = globalThis.window;
        if (win === void 0) return;
        const move = (ev) => setDrag(indexAt(ev.clientX));
        const up = (ev) => {
          win.removeEventListener("pointermove", move);
          win.removeEventListener("pointerup", up);
          setDrag(null);
          commit(indexAt(ev.clientX));
        };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
      };
      const onKeyDown = (event) => {
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
      return h(
        "div",
        { className: "mwseat-slider" },
        h(
          "div",
          {
            ref: trackRef,
            className: `mwseat-sliderRail${drag !== null ? " drag" : ""}`,
            role: "slider",
            tabIndex: busy ? -1 : 0,
            "aria-label": "\u601D\u8003\u5F3A\u5EA6",
            "aria-orientation": "horizontal",
            "aria-valuemin": 0,
            "aria-valuemax": n - 1,
            "aria-valuenow": index,
            "aria-valuetext": rows[index]?.label,
            "aria-disabled": busy,
            onPointerDown,
            onKeyDown
          },
          h("div", { className: "mwseat-sliderFill", style: { width: `${pct(index)}%` } }),
          rows.map((row, i) => h("span", { key: `t:${row.key}`, className: "mwseat-sliderTick", "aria-hidden": "true", style: { left: `${pct(i)}%` } })),
          h("span", { className: "mwseat-sliderThumb", "aria-hidden": "true", style: { left: `${pct(index)}%` } })
        ),
        h(
          "div",
          { className: "mwseat-sliderStops" },
          rows.map((row, i) => h("button", {
            key: `s:${row.key}`,
            type: "button",
            className: `mwseat-sliderStop${i === index ? " on" : ""}`,
            disabled: busy,
            ...row.description !== void 0 ? { title: row.description } : {},
            style: { left: `${pct(i)}%`, transform: i === 0 ? "translateX(0)" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)" },
            onClick: () => commit(i)
          }, row.label))
        )
      );
    };
  }
  function seatMenuBody(React, o) {
    const h = React.createElement;
    const { state, model, busy } = o;
    if (o.view === "effort") {
      const rows2 = effortRows(model, state.current);
      return h(
        "div",
        { className: "mwseat-body" },
        h(
          "div",
          { className: "mwseat-head" },
          h("span", { className: "mwseat-title" }, triggerModelLabel(state, model)),
          h("button", { type: "button", className: "mwseat-more", onClick: o.onMore }, "\u66F4\u591A")
        ),
        h(o.slider, { rows: rows2, busy, onPick: o.onEffort }),
        state.error !== null ? h("div", { className: "mwseat-error" }, state.error) : null
      );
    }
    const rows = [];
    for (const group of state.groups) {
      rows.push(h("div", { key: `g:${group.id}`, className: "mwseat-groupTitle" }, group.name));
      for (const m of group.models) {
        const selected = state.current?.provider === group.id && state.current.model === m.id;
        const effortName = m.reasoning === void 0 ? void 0 : m.reasoning.efforts.find((e) => e.id === (state.current?.reasoningEffort ?? m.reasoning?.defaultEffort))?.name ?? m.reasoning.defaultEffort;
        rows.push(h(
          "button",
          {
            key: `m:${group.id}/${m.id}`,
            type: "button",
            role: "menuitemradio",
            "aria-checked": selected,
            className: `mwseat-row${selected ? " on" : ""}`,
            disabled: busy,
            onClick: () => o.onModel(group, m)
          },
          h("span", { className: "mwseat-rowName" }, m.name),
          selected && effortName !== void 0 ? h("span", { className: "mwseat-rowMeta" }, effortName) : null,
          selected ? h("span", { className: "mwseat-check", "aria-hidden": "true" }, "\u2713") : null
        ));
      }
    }
    for (const failure of state.failures) {
      rows.push(h("div", { key: `f:${failure.id}`, className: "mwseat-hint" }, `${failure.name}\uFF1A${failure.message}`));
    }
    if (state.groups.length === 0) {
      rows.push(h(
        "div",
        { key: "empty", className: "mwseat-hint" },
        state.status === "loading" ? "\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55\u2026" : state.error ?? "\u6682\u65E0\u53EF\u7528\u6A21\u578B"
      ));
    }
    return h(
      "div",
      { className: "mwseat-body" },
      h(
        "div",
        { className: "mwseat-head" },
        model?.reasoning !== void 0 ? h("button", { type: "button", className: "mwseat-back", "aria-label": "\u8FD4\u56DE\u601D\u8003\u5F3A\u5EA6", onClick: o.onBack }, "\u2039") : null,
        h("span", { className: "mwseat-title" }, "\u9009\u62E9\u6A21\u578B")
      ),
      h("div", { className: "mwseat-list", role: "menu" }, rows),
      state.error !== null && state.groups.length > 0 ? h("div", { className: "mwseat-error" }, state.error) : null
    );
  }
  function createSeatComponent(React, dom) {
    const h = React.createElement;
    const Slider = createEffortSlider(React);
    return function ModelSeat(props) {
      const { locked, available, directory, load, select } = props;
      const state = React.useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot());
      const [open, setOpen] = React.useState(false);
      const [view, setView] = React.useState("effort");
      const [pos, setPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const id = React.useId();
      const { model } = currentEntry(state);
      const busy = state.status === "selecting";
      React.useEffect(() => {
        if (!open) return;
        const closeOutside = (event) => {
          const target = event.target;
          if (target instanceof Node && (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true)) return;
          setOpen(false);
        };
        document.addEventListener("mousedown", closeOutside);
        return () => document.removeEventListener("mousedown", closeOutside);
      }, [open]);
      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return;
        }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect === void 0) return;
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
      const settle = (accepted) => {
        if (accepted) close();
      };
      const show = () => {
        setView(initialView(model));
        setOpen(true);
        load();
      };
      const chooseModel = (group, m) => {
        const selection = {
          provider: group.id,
          model: m.id,
          ...m.reasoning?.defaultEffort !== void 0 ? { reasoningEffort: m.reasoning.defaultEffort } : {}
        };
        if (state.current?.provider === selection.provider && state.current.model === selection.model) {
          close();
          return;
        }
        void select(selection).then(settle);
      };
      const chooseEffort = (effort) => {
        const current = state.current;
        if (current === null) return;
        void select({ provider: current.provider, model: current.model, ...effort === void 0 ? {} : { reasoningEffort: effort } }).then(settle);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        if (view === "list" && model?.reasoning !== void 0) setView("effort");
        else close();
      };
      const mLabel = triggerModelLabel(state, model);
      const eLabel = triggerEffortLabel(model, state.current);
      const menu = h("div", {
        ref: menuRef,
        id: `${id}-menu`,
        className: "mwseat-menu",
        role: "dialog",
        "aria-label": "\u6A21\u578B\u4E0E\u601D\u8003\u5F3A\u5EA6",
        style: pos ?? { visibility: "hidden", left: 0, top: 0 }
      }, seatMenuBody(React, {
        view,
        state,
        model,
        busy,
        slider: Slider,
        onEffort: chooseEffort,
        onModel: chooseModel,
        onMore: () => setView("list"),
        onBack: () => setView("effort")
      }));
      return h(
        "div",
        { ref: rootRef, className: "mwseat-root", onKeyDown },
        h(
          "button",
          {
            ref: triggerRef,
            type: "button",
            className: "mwseat-trigger",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": open ? `${id}-menu` : void 0,
            title: eLabel === void 0 ? mLabel : `${mLabel} \xB7 ${eLabel}`,
            disabled: locked === true,
            onClick: () => open ? close() : show()
          },
          h("span", { className: "mwseat-label" }, mLabel),
          eLabel !== void 0 ? h("span", { className: "mwseat-effort" }, eLabel) : null,
          h(
            "svg",
            { className: `mwseat-chev${open ? " open" : ""}`, width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" },
            h("path", { d: "M3.5 5.25 7 8.75l3.5-3.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" })
          )
        ),
        open ? dom.createPortal(menu, document.body) : null
      );
    };
  }
  var SEAT_CSS = `
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
/* liquid-glass \u7684 panels \u9009\u62E9\u5668\u547D\u4E2D [role="menu"]\uFF1B\u6E05\u5355\u53EA\u662F dialog \u5185\u5185\u5BB9\u533A\uFF0C
   \u538B\u5E73\u7B2C\u4E8C\u5C42\u9762\u677F\u907F\u514D\u53E0\u51FA\u4E24\u5C42\u5706\u89D2\u534A\u900F\u660E\u80CC\u666F\u3002 */
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
  function ensureSeatStyle(doc) {
    if (doc?.getElementById === void 0 || doc.createElement === void 0 || doc.head === void 0) return;
    if (doc.getElementById("dsh-lark-model-seat") != null) return;
    const style = doc.createElement("style");
    style.id = "dsh-lark-model-seat";
    style.textContent = SEAT_CSS;
    doc.head.appendChild(style);
  }

  // packages/lark/model-seat/src/client.ts
  var loader = globalThis.__ModuleLoader__;
  function applyModelSeat(ctx, React, dom) {
    ensureSeatStyle(globalThis.document);
    ctx.slots.inject("conversation.input.model", () => ctx.slots.register(
      {
        name: "conversation.input.model",
        priority: -1,
        inject: (sessionId) => {
          const directory = ctx.modelDirectories.directoryFor(sessionId);
          const available = ctx.sessions.subagentAddress(sessionId) === void 0;
          return {
            available,
            directory: directory.store,
            load: () => {
              if (available) void directory.load().catch(() => {
              });
            },
            select: (selection) => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false)
          };
        }
      },
      createSeatComponent(React, dom)
    ));
  }
  loader?.load({
    id: "dsh-lark-model-seat",
    factory: (require2) => {
      const React = require2("react");
      const dom = require2("react-dom");
      return {
        apply: (ctx) => applyModelSeat(ctx, React, dom),
        // remote.session：directoryFor 内部经本模块 ambient scope 读
        // ctx.remote.session，缺声明会被 inject 代理拒绝。
        inject: ["slots", "modelDirectories", "sessions", "remote.session"]
      };
    }
  });
})();
