import { createHash } from "node:crypto";

const ACCOUNT_STORAGE_KEY = "dsh.auth.account.v1";
const ACCOUNT_SCOPED_STORAGE_KEYS = ["dsh.sessions.current", "dsh.workspace.view.v5", "dsh.conversation.chat"];
const USER_HIDDEN_CLIENT_PLUGINS = new Set([
  "@deepseek-ai/dsh-cordis-client-runner",
  "@deepseek-ai/dsh-client-ui-cordis",
]);
// 第三方聚合包的 remote-web-ui 宿主能力在生产 profile 中已关闭；客户端
// 仍随聚合包注入会不断请求不存在的 /remote/*，因此从 Web manifest 一并移除。
const DISABLED_CLIENT_PLUGINS = new Set(["@linxin666/dsh-web-all", "@deepseek-ai/dsh-client-ui-settings"]);

export function injectRemoteSettings(body: Buffer, userId: string, admin: boolean): Buffer {
  const html = body.toString("utf8");
  const marker = "</head>";
  const account = JSON.stringify(userId).replace(/</gu, "\\u003c");
  const keys = JSON.stringify(ACCOUNT_SCOPED_STORAGE_KEYS);
  // DSH 的会话选择存储是浏览器级键；账号切换时必须先清除旧账号的
  // 会话/工作区状态，避免客户端在权限列表加载前请求旧 sessionId。
  const flags = admin ? "{remoteSettings:true,remoteAdminSettings:true}" : "{remoteSettings:true}";
  // 自有客户端 Provider 消费此标记；Connection 保持真实的公网语义。
  const script = `<script>(()=>{const k=${JSON.stringify(ACCOUNT_STORAGE_KEY)},u=${account};try{if(localStorage.getItem(k)!==u){for(const x of ${keys})localStorage.removeItem(x);localStorage.setItem(k,u)}}catch{}globalThis.__DSH_AUTH_EDGE__=${flags};})()</script>`;
  const injected = html.includes(marker) ? html.replace(marker, `${script}${marker}`) : `${script}${html}`;
  return Buffer.from(injected, "utf8");
}

export function filterClientPlugins(body: Buffer, hideUserPlugins: boolean): Buffer {
  const html = body.toString("utf8");
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start < 0) return body;
  const valueStart = start + prefix.length;
  const scriptEnd = html.indexOf("</script>", valueStart);
  if (scriptEnd < 0) throw new Error("INVALID_DSH_BOOT_MANIFEST");
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/, "");
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) throw new Error("INVALID_DSH_BOOT_MANIFEST");
  const graph = parsed as { rev?: unknown; entries: unknown[]; batches?: unknown[] };
  const entries = graph.entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const id = String((entry as { id?: unknown }).id ?? "");
    return !DISABLED_CLIENT_PLUGINS.has(id) && (!hideUserPlugins || !USER_HIDDEN_CLIENT_PLUGINS.has(id));
  }).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const row = entry as Record<string, unknown>;
    if (!Array.isArray(row.inject)) return entry;
    return { ...row, inject: row.inject.map((id) => id === "@deepseek-ai/dsh-client-ui-settings" ? "dsh-lark-web-auth" : id) };
  });
  const next = {
    ...graph,
    rev: createHash("sha1").update(JSON.stringify({ entries, batches: graph.batches })).digest("hex").slice(0, 12),
    entries,
    batches: Array.isArray(graph.batches)
      ? graph.batches
        .map((batch) => {
          if (!batch || typeof batch !== "object" || !Array.isArray((batch as { entries?: unknown }).entries)) return batch;
          const batchEntries = (batch as { entries: unknown[] }).entries.filter((id) => entries.some((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === id));
          return { ...batch, entries: batchEntries };
        })
        .filter((batch) => !batch || typeof batch !== "object" || !Array.isArray((batch as { entries?: unknown }).entries) || (batch as { entries: unknown[] }).entries.length > 0)
      : graph.batches,
  };
  return Buffer.from(`${html.slice(0, valueStart)}${JSON.stringify(next)}${html.slice(scriptEnd)}`, "utf8");
}
