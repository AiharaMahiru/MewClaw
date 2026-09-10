"use strict";
(() => {
  // packages/lark/atw-brand/src/mark.ts
  var MEWCLAW_MARK_VIEWBOX = "0 0 512 512";
  function renderMewClawBrandMark(React, props) {
    const requestedSize = Number.isFinite(props.size) && props.size > 0 ? props.size : 24;
    const className = [props.className, "mewclaw-brand-mark"].filter(Boolean).join(" ");
    return React.createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: requestedSize,
        height: requestedSize,
        className,
        viewBox: MEWCLAW_MARK_VIEWBOX,
        shapeRendering: "geometricPrecision",
        "aria-hidden": "true",
        focusable: "false"
      },
      React.createElement("circle", { className: "mewclaw-mark-bg", cx: "256", cy: "256", r: "256" }),
      React.createElement("path", {
        className: "mewclaw-mark-ink",
        d: "M256 132 C244 132 233 137 222 146 C208 136 196 120 184 96 C179 88 169 90 166 98 C154 130 142 172 134 200 C128 214 125 230 126 246 C123.8 281.9 38.5 324.3 51.2 351.5 A226 226 0 0 0 460.8 351.5 C473.5 324.3 388.2 281.9 386 246 C387 230 384 214 378 200 C358 130 370 172 346 98 C343 90 333 88 328 96 C316 120 304 136 290 146 C279 137 268 132 256 132 Z"
      }),
      React.createElement("path", { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "62", strokeLinecap: "round", d: "M116.9 410.6 A208 208 0 0 0 234.2 462.8" }),
      React.createElement("path", { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "34", strokeLinecap: "round", d: "M116.9 410.6 A208 208 0 0 0 234.2 462.8" }),
      React.createElement("path", { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "62", strokeLinecap: "round", d: "M366.2 432.4 A208 208 0 0 0 462.9 234.3" }),
      React.createElement("path", { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "34", strokeLinecap: "round", d: "M366.2 432.4 A208 208 0 0 0 462.9 234.3" }),
      React.createElement(
        "g",
        { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "10", strokeLinecap: "round" },
        React.createElement("path", { d: "M128 276 L44 252" }),
        React.createElement("path", { d: "M126 300 L50 296" })
      ),
      React.createElement(
        "g",
        { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "15", strokeLinecap: "round" },
        React.createElement("path", { d: "M174 266 Q204 300 234 266" }),
        React.createElement("path", { d: "M278 266 Q308 300 338 266" })
      ),
      React.createElement("path", { className: "mewclaw-mark-cutout", d: "M247 312 L265 312 L256 325 Z", strokeWidth: "7", strokeLinejoin: "round" })
    );
  }

  // packages/lark/atw-brand/src/client.ts
  var HERO_COPY = ["\u8BE5\u505A\u70B9\u4EC0\u4E48\u5462~ Mew", "\u7075\u611F\u6B63\u4F38\u7740\u61D2\u8170", "\u628A\u96BE\u9898\u4EA4\u7ED9\u732B\u722A", "\u4ECA\u5929\u4E5F\u8981\u806A\u660E\u4E00\u70B9"];
  var loader = globalThis.__ModuleLoader__;
  function applyBrand(ctx, React) {
    ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, () => {
      const [copy] = React.useState(() => HERO_COPY[Math.floor(Math.random() * HERO_COPY.length)] ?? HERO_COPY[0]);
      return React.createElement(
        "span",
        { className: "mewclaw-hero-brand" },
        renderMewClawBrandMark(React, { size: 46, className: "mewclaw-hero-mark" }),
        React.createElement("span", { className: "mewclaw-hero-copy" }, copy)
      );
    }));
    registerMark(ctx, React, "sidebar.brand.mark", "mewclaw-sidebar-mark", 24);
    ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, () => React.createElement("span", {
      className: "mewclaw-sidebar-name"
    }, "MewClaw Harness")));
  }
  function registerMark(ctx, React, slot, ownClass, fixedSize) {
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, (props) => renderMewClawBrandMark(React, {
      ...props,
      size: fixedSize ?? props.size,
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
