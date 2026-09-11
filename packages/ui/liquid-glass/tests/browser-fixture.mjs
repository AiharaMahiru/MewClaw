/** 无密钥示例：真实 Cordis + ThemeRuntime + SlotRegistry，Host settings 使用内存。 */
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as Jsx from "react/jsx-runtime";
import * as Cordis from "@deepseek-ai/cordis";
import * as Slots from "@deepseek-ai/dsh-client-ui-slots";

const factories = new Map();
const modules = new Map(Object.entries({
  react: React, "react-dom": ReactDom, "react-dom/client": ReactDomClient, "react/jsx-runtime": Jsx,
  "@deepseek-ai/cordis": Cordis, "@deepseek-ai/dsh-client-ui-slots": Slots,
  // ThemeRuntime 模块会读取通用设置行的图标引用，但本示例不渲染那些行。
  "@deepseek-ai/dsh-client-ui-primitives": new Proxy({}, { get() { return () => { throw new Error("本示例不渲染官方通用设置图标"); }; } }),
  // 本示例只实例化 ThemeRuntime，不挂载官方通用设置行；若调用 store 必须失败。
  "@deepseek-ai/dsh-client-store": new Proxy({}, { get() { throw new Error("本示例未装配官方通用设置 store"); } }),
}));
function requireModule(id) {
  if (!modules.has(id)) {
    if (!factories.has(id)) throw new Error(`未提供浏览器模块 ${id}`);
    modules.set(id, factories.get(id)(requireModule));
  }
  return modules.get(id);
}
window.__ModuleLoader__ = { load({ id, factory }) { factories.set(id, factory); } };
window.bootGlassFixture = async () => {
  const ctx = new Cordis.Context();
  const renderer = requireModule("@deepseek-ai/dsh-client-ui-renderer");
  const { ThemeRuntime } = requireModule("@deepseek-ai/dsh-client-ui-theme");
  const settings = { preference: "light", fontSize: 14 };
  const subscribers = new Set();
  const theme = new ThemeRuntime(ctx, {
    getSnapshot: () => ({ value: settings }),
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    set: (key, value) => { settings[key] = value; for (const fn of subscribers) fn(); },
  });
  ctx.reflect.provide("theme", theme);
  renderer.apply(ctx);
  const emptySession = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
  ctx.slots.installScope("session", {
    current: { getSnapshot: () => emptySession, subscribe: () => () => {} },
    resolve: () => undefined,
  });
  const paint = () => {
    const state = theme.getTheme();
    document.body.style.colorScheme = state.active.colorScheme;
    for (const name of Array.from(document.body.style)) if (name.startsWith("--dsw-")) document.body.style.removeProperty(name);
    for (const [key, value] of Object.entries(state.active.tokens)) document.body.style.setProperty(key, value);
  };
  ctx.on("theme/change", paint);
  const fixture = ctx.plugin((scope) => {
    scope.slots.register({ name: "root", children: { "settings.section": { kind: "list", scope: "root" } } },
      ({ renderSlot }) => React.createElement("main", { style: { maxWidth: 680, margin: "auto", padding: 24 } }, renderSlot("settings.section", {})));
  });
  let fork;
  const mount = async () => {
    fork = ctx.plugin(requireModule("dsh-lark-liquid-glass"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (fork.status === "failed") throw new Error("主题插件启动失败");
  };
  await mount();
  paint();
  const unmount = ctx.uiRenderer.mount(document.getElementById("root"));
  window.glassFixture = {
    setTheme: (value) => theme.setTheme(value),
    snapshot: () => theme.getTheme(),
    addBaseLayer: () => theme.overrideTokens("fixture-underlying", { "--dsw-alias-bg-base": { light: "#fefefe", dark: "#121212" } }),
    unload: () => fork.dispose(),
    mount,
    finish: async () => { unmount(); await fork.dispose(); await fixture.dispose(); await ctx.fiber.dispose(); },
  };
};
