import { AccountCenterSection } from "./client-account.js";
import type { AccountUser, ClientContext, ModuleLoader, ReactApi } from "./client-contracts.js";
import { useAccountUser } from "./client-data.js";
import { installAccountStyles } from "./client-styles.js";
import { installRemoteSettings } from "./client-settings.js";

const loader = (globalThis as typeof globalThis & { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__;

type ObservableSource = {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
};

function isObservableSource(value: unknown): value is ObservableSource {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  return typeof source.getSnapshot === "function" && typeof source.subscribe === "function";
}

/**
 * 兼容不同 DSH 连接版本的可观察源；形状不完整时静默降级，不能阻断首屏。
 */
export function selectConnectionSource(connection: unknown): {
  source: ObservableSource;
  stateSource?: ObservableSource;
} | undefined {
  if (typeof connection !== "object" || connection === null) return undefined;
  const record = connection as Record<string, unknown>;
  const generation = isObservableSource(record.generation) ? record.generation : undefined;
  const state = isObservableSource(record.state) ? record.state : undefined;
  const hostDescription = isObservableSource(record.hostDescription) ? record.hostDescription : undefined;
  const source = generation ?? state ?? hostDescription;
  if (source === undefined) return undefined;
  return state === undefined ? { source } : { source, stateSource: state };
}

function installNetworkStatus(ctx: ClientContext): () => void {
  const connection = ctx.get("connection") as unknown;
  // Alpha 版官方连接包已将 hostDescription 拆为 generation/state；保留
  // 旧字段回退，避免插件因接口升级而阻断整个 Web 启动。
  const selected = selectConnectionSource(connection);
  if (selected === undefined) return () => {};
  const { source, stateSource } = selected;
  const status = document.createElement("div");
  status.className = "mewclaw-network-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  status.textContent = "网络连接已中断，正在重连...";
  document.body.appendChild(status);
  const isConnected = (): boolean => {
    let snapshot: unknown;
    try {
      snapshot = source.getSnapshot();
    } catch {
      return false;
    }
    if (source === stateSource) return snapshot === "connected";
    return snapshot !== undefined;
  };
  let connectedOnce = isConnected();
  const refresh = (): void => {
    if (isConnected()) {
      connectedOnce = true;
      status.hidden = true;
      return;
    }
    status.hidden = !connectedOnce;
  };
  let unsubscribe = (): void => {};
  try {
    unsubscribe = source.subscribe(refresh);
  } catch {
    // 旧缓存可能只暴露快照；不让网络提示影响主界面启动。
  }
  refresh();
  return () => {
    unsubscribe();
    status.remove();
  };
}

loader?.load({
  id: "dsh-lark-web-auth",
  factory: (require) => {
    const React = require("react") as ReactApi;
    installAccountStyles();

    function AccountTrigger({ wide }: { wide: boolean }): unknown {
      const state = useAccountUser(React);
      const user: AccountUser | undefined = state.data;
      const name = user?.displayName || "账户";
      const initial = Array.from(name.trim())[0] || "M";
      return React.createElement("span", {
        className: "mewclaw-settings-trigger",
        title: user?.displayName || "账户设置",
      },
      React.createElement("span", {
        className: "mewclaw-account-avatar",
        "aria-hidden": "true",
      }, initial),
      wide ? React.createElement("span", { className: "mewclaw-account-label" }, "设置") : null);
    }

    function apply(ctx: ClientContext): void {
      if ((globalThis as typeof globalThis & { __DSH_AUTH_EDGE__?: { remoteSettings?: boolean } }).__DSH_AUTH_EDGE__?.remoteSettings) {
        const { Service } = require("@deepseek-ai/cordis") as { Service: Parameters<typeof installRemoteSettings>[1] };
        installRemoteSettings(ctx as unknown as Parameters<typeof installRemoteSettings>[0], Service);
      }
      ctx.effect(() => installNetworkStatus(ctx), "dsh-lark-web-auth: network status");
      ctx.effect(() => ctx.slots.inject("settings.trigger", () => ctx.slots.register({
        name: "settings.trigger",
        id: "mewclaw-account",
        priority: -1,
      }, AccountTrigger)), "dsh-lark-web-auth: account trigger");
      ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "mewclaw-account",
        order: -30,
        label: () => "账户中心",
      }, () => AccountCenterSection(React))), "dsh-lark-web-auth: account center section");
    }

    return { apply, inject: ["slots", "connection", "remote", "remote.settings"] };
  },
});
