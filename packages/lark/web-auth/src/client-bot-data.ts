import type { ReactApi, ResourceState } from "./client-contracts.js";
import { readCsrfToken } from "./client-data.js";

export interface AccountBot {
  id: string; appId: string; domain: string; authorizedOpenIds: string[];
  secretConfigured: boolean; enabled: boolean; revision: number;
  state: "connected" | "reconnecting" | "failed" | "unknown" | "disabled";
}
export function decodeAccountBot(input: unknown): AccountBot | null {
  const b = (input as { bot?: unknown } | null)?.bot;
  if (b === null) return null;
  if (!b || typeof b !== "object") throw Error("INVALID_BOT_RESPONSE");
  const bot = b as AccountBot;
  if (typeof bot.id !== "string" || typeof bot.appId !== "string" || typeof bot.domain !== "string" || !Array.isArray(bot.authorizedOpenIds) || bot.authorizedOpenIds.some(id => typeof id !== "string") || typeof bot.enabled !== "boolean" || typeof bot.secretConfigured !== "boolean" || !Number.isSafeInteger(bot.revision) || !["connected", "reconnecting", "failed", "unknown", "disabled"].includes(bot.state)) throw Error("INVALID_BOT_RESPONSE");
  return { id: bot.id, appId: bot.appId, domain: bot.domain, authorizedOpenIds: [...bot.authorizedOpenIds], secretConfigured: bot.secretConfigured, enabled: bot.enabled, revision: bot.revision, state: bot.state };
}
export function useAccountBot(React: ReactApi, revision: number): ResourceState<AccountBot | null> {
  const [state, setState] = React.useState<ResourceState<AccountBot | null>>({ status: "loading" });
  React.useEffect(() => {
    let active = true; let busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const response = await fetch("/auth/feishu-bot", { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw Error("BOT_READ_FAILED");
        const data = decodeAccountBot(await response.json());
        if (active) setState({ status: "ready", data });
      } catch { if (active) setState({ status: "error" }); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [revision]);
  return state;
}
export async function mutateBot(path: string, method: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "BOT_REQUEST_FAILED");
  return result;
}
export function botError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  return ({ BOT_CONFIG_CONFLICT: "配置已变更或此应用已被使用，请刷新后重试。", BOT_APP_RESERVED: "这是部署管理员正在使用的应用，请勿重复连接。", BOT_DISCONNECT_FIRST: "请先断开机器人，再修改配置。", BOT_SECRET_REQUIRED: "首次配置或更换应用时，请填写 App Secret。", BOT_CHECK_FAILED: "校验失败，请检查 App ID、App Secret、机器人能力及应用发布状态后重试。", INVALID_BOT_CONFIG: "请检查应用 ID、域名和授权 Open ID 的格式。", BOT_STORAGE_UNAVAILABLE: "凭证存储暂不可用，请联系管理员。", CSRF_INVALID: "登录状态已过期，请刷新页面重新登录。" } as Record<string, string>)[code] ?? "操作未完成，请检查网络并刷新状态后重试。";
}
