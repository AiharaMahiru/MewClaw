/** 客户端只消费官方主题与设置槽位，不接触会话或私有布局。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import { createElement as h, useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentType, CSSProperties, ReactElement } from "react";
import LiquidGlassExport from "liquid-glass-react";
import { CONFIG_ID, PLUGIN_ID, resolveConfig } from "./config.js";
import type { GlassConfig } from "./config.js";
import { GLASS_STYLES } from "./styles.js";
import { GLASS_TOKENS, OPAQUE_TOKENS } from "./tokens.js";
import { SURFACE_STYLES } from "./surfaces.js";
import { GlassPreference, parseAccountId } from "./preference.js";

export const inject = ["theme", "slots"];
const STILL_POINTER = { x: 0, y: 0 };
const PREFERENCES = ["(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)", "(forced-colors: active)"];
// 上游发布的 CJS 元数据与 ESM default 声明不一致；浏览器构建解析 module 入口。
// 仅在这个第三方包边界修正类型，不引入另一份 React 或改动上游文件。
const LiquidGlass = LiquidGlassExport as unknown as ComponentType<{
  displacementScale: number; blurAmount: number; saturation: number; aberrationIntensity: number;
  elasticity: number; cornerRadius: number; padding: string; mode: "standard";
  globalMousePos: typeof STILL_POINTER; mouseOffset: typeof STILL_POINTER; overLight: boolean;
  style: CSSProperties; children: ReactElement;
}>;

function useOptics(config: GlassConfig): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const queries = PREFERENCES.map((query) => matchMedia(query));
    const update = (): void => setSupported(config.refraction && CSS.supports("backdrop-filter", "blur(1px)") && !queries.some((query) => query.matches));
    update();
    for (const query of queries) query.addEventListener("change", update);
    return () => { for (const query of queries) query.removeEventListener("change", update); };
  }, [config.refraction]);
  return supported;
}

/**
 * 挂载 token Provider 与主题页；所有效果随 Cordis fiber 释放。
 * @param ctx - 已就绪的官方 theme、slots 服务。
 */
export function apply(ctx: Context): void {
  const bootstrap = document.getElementById(CONFIG_ID);
  if (!bootstrap) return; // Host 未启用本可选插件，不猜测部署配置。
  const config = resolveConfig(JSON.parse(bootstrap.textContent || "null"));
  if (!config.enabled) return;
  const preference = new GlassPreference(config.defaultEnabled);
  let releaseTokens: (() => void) | undefined;
  const opaqueQueries = ["(prefers-reduced-transparency: reduce)", "(forced-colors: active)"].map((query) => matchMedia(query));
  let opaque = !CSS.supports("backdrop-filter", "blur(1px)") || opaqueQueries.some((query) => query.matches);
  const setEnabled = (enabled: boolean): void => {
    if (enabled === (releaseTokens !== undefined)) return;
    releaseTokens?.();
    releaseTokens = enabled ? ctx.theme.overrideTokens(PLUGIN_ID, opaque ? OPAQUE_TOKENS : GLASS_TOKENS) : undefined;
    document.documentElement.toggleAttribute("data-mew-glass", enabled);
    if (enabled) document.documentElement.setAttribute("data-mew-glass", "on");
  };
  ctx.effect(() => {
    const unsubscribe = preference.subscribe(() => setEnabled(preference.getSnapshot().enabled));
    return () => { unsubscribe(); releaseTokens?.(); releaseTokens = undefined; document.documentElement.removeAttribute("data-mew-glass"); };
  });
  ctx.effect(() => {
    const paint = (): void => { document.documentElement.setAttribute("data-mew-glass-scheme", ctx.theme.getTheme().active.colorScheme); };
    const update = (): void => {
      opaque = !CSS.supports("backdrop-filter", "blur(1px)") || opaqueQueries.some((query) => query.matches);
      releaseTokens?.(); releaseTokens = undefined;
      setEnabled(preference.getSnapshot().enabled);
    };
    paint();
    const off = ctx.on("theme/change", paint);
    for (const query of opaqueQueries) query.addEventListener("change", update);
    return () => {
      off();
      for (const query of opaqueQueries) query.removeEventListener("change", update);
      document.documentElement.removeAttribute("data-mew-glass-scheme");
    };
  });
  ctx.effect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.identityTimeoutMs);
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch("/auth/me", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("身份读取失败");
        const accountId = parseAccountId(await response.json());
        if (!disposed) preference.bind(accountId, window.localStorage);
      } catch {
        if (!disposed) preference.useSession("暂时无法读取账号或浏览器存储，开关仅在当前页面有效。");
      } finally { clearTimeout(timer); }
    })();
    const storageChanged = (event: StorageEvent): void => {
      try { if (event.storageArea === window.localStorage) preference.acceptStorage(event.key, event.newValue); }
      catch { /* 浏览器撤销存储访问权限时保持本页偏好，不读取其他账户。 */ }
    };
    window.addEventListener("storage", storageChanged);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); window.removeEventListener("storage", storageChanged); };
  });
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.mewclawLiquidGlass = "";
    style.textContent = GLASS_STYLES + SURFACE_STYLES;
    document.head.appendChild(style);
    return () => style.remove();
  });

  function ThemePage(): ReactElement {
    const [snapshot, setSnapshot] = useState(() => ctx.theme.getTheme());
    const { enabled, loading, notice } = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
    const optics = useOptics(config) && enabled;
    useEffect(() => {
      const off = ctx.on("theme/change", setSnapshot);
      return () => { off(); };
    }, []);
    const button = h("button", {
      className: "mew-glass-switch", type: "button", role: "switch", disabled: loading,
      onClick: () => preference.setEnabled(!enabled), "aria-checked": enabled,
      "aria-label": "启用液态玻璃主题", "aria-describedby": "mew-glass-save-status",
    }, h("span", { className: "mew-glass-switch-thumb", "aria-hidden": true }));
    const card = h("div", { className: "mew-glass-card" },
      h("strong", null, "留一点空间，给灵感。"),
      h("p", null, "轻透的表面，清晰的思绪。Mew 陪你把下一步变简单。"));
    return h("section", { className: "mew-glass-page", "data-scheme": snapshot.active.colorScheme, "aria-label": "液态玻璃主题" },
      h("p", { className: "mew-glass-kicker" }, "MEWCLAW / APPEARANCE"),
      h("h2", { className: "mew-glass-title" }, "清透一点，专注一点。"),
      h("p", { className: "mew-glass-description" }, "雾白与石墨色随外观切换，折射只留在轻量控件里。聊天、工具和你的工作方式保持原样。"),
      h("div", { className: "mew-glass-control" },
        h("div", null, h("strong", null, "液态玻璃主题"), h("p", { className: "mew-glass-note" }, enabled ? "已开启" : "已关闭 · 使用原主题")), button),
      h("p", { className: "mew-glass-note", id: "mew-glass-save-status", role: "status" }, notice),
      h("div", { className: "mew-glass-scene" }, optics
        ? h("div", { className: "mew-glass-optics", "data-refraction": "on" }, h(LiquidGlass, {
          displacementScale: config.displacementScale, blurAmount: config.blurAmount,
          saturation: config.saturation, aberrationIntensity: config.aberrationIntensity,
          elasticity: 0, cornerRadius: 22, padding: "0", mode: "standard",
          globalMousePos: STILL_POINTER, mouseOffset: STILL_POINTER,
          overLight: snapshot.active.colorScheme === "light",
          style: { position: "absolute", top: "50%", left: "50%", width: "270px", maxWidth: "100%", clipPath: "inset(0 round 22px)" },
          children: card,
        })) : h("div", { className: "mew-glass-surface", "data-refraction": "off" }, card)),
      h("div", { className: "mew-glass-actions" },
        h("span", { className: "mew-glass-note", role: "status" }, enabled ? "主题层已启用" : "已恢复原主题")),
      h("p", { className: "mew-glass-note" }, optics
        ? "液态折射已启用。Safari / Firefox 可能仅显示磨砂效果。"
        : "当前使用静态表面：主题已关闭、部署禁用折射或浏览器无障碍偏好要求降级。"),
      h("p", { className: "mew-glass-note" }, "明暗与字号请在「通用」中设置。主题开关按当前浏览器、当前账号保存，不跨设备同步。"));
  }
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: PLUGIN_ID, order: 80, label: "液态玻璃",
  }, ThemePage));
}
