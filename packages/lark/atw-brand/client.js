"use strict";
(() => {
  // packages/lark/atw-brand/src/mark.ts
  var MEWCLAW_MARK_VIEWBOX = "0 0 240 240";
  var MEWCLAW_MARK_MASK_ID = "mewclaw-v-under";
  function renderMewClawBrandMark(React, props) {
    const requestedSize = Number.isFinite(props.size) && props.size > 0 ? props.size : 24;
    const mask = React.createElement(
      "mask",
      { id: MEWCLAW_MARK_MASK_ID },
      React.createElement("rect", { width: "240", height: "240", fill: "#fff" }),
      React.createElement("path", { d: "M76 90h28", stroke: "#000", strokeWidth: "18" }),
      React.createElement("path", { d: "M136 150h28", stroke: "#000", strokeWidth: "18" })
    );
    const body = React.createElement(
      "g",
      {
        transform: "rotate(45 120 120)",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "16"
      },
      React.createElement("rect", { x: "35", y: "90", width: "170", height: "60", rx: "30" }),
      React.createElement("rect", {
        x: "90",
        y: "35",
        width: "60",
        height: "170",
        rx: "30",
        mask: `url(#${MEWCLAW_MARK_MASK_ID})`
      })
    );
    return React.createElement("svg", {
      xmlns: "http://www.w3.org/2000/svg",
      width: requestedSize,
      height: requestedSize,
      className: props.className,
      viewBox: MEWCLAW_MARK_VIEWBOX,
      fill: "none",
      "aria-hidden": "true",
      focusable: "false"
    }, React.createElement("defs", null, mask), body);
  }

  // packages/lark/atw-brand/src/client.ts
  var loader = globalThis.__ModuleLoader__;
  function applyBrand(ctx, React) {
    registerMark(ctx, React, "conversation.hero.brand.mark", "mewclaw-hero-mark");
    registerMark(ctx, React, "sidebar.brand.mark", "mewclaw-sidebar-mark");
    ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, () => React.createElement("span", {
      className: "mewclaw-sidebar-name"
    }, "MewClaw Harness")));
  }
  function registerMark(ctx, React, slot, ownClass) {
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, (props) => renderMewClawBrandMark(React, {
      ...props,
      className: [props.className, ownClass].filter(Boolean).join(" ")
    })));
  }
  loader?.load({
    id: "dsh-lark-atw-brand",
    factory: (require2) => {
      const React = require2("react");
      return {
        apply: (ctx) => applyBrand(ctx, React),
        inject: ["slots"]
      };
    }
  });
})();
