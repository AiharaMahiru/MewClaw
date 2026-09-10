/** Worker Web 的 Auth Edge 桥接，仅使用 WebServer 与 Connection 的公开契约。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";
import z from "@deepseek-ai/schemastery";
import { constantTimeEqual } from "dsh-lark-auth";

export interface Config { tokenEnv: string }
export const Config: z<Config> = z.object({ tokenEnv: z.string().required() });
export const name = "lark-web-auth";
export const inject = ["credentials", "webServer", "larkScopeIndex", "connection"];
interface WebScopeIndex { bindWeb(input: unknown): void }

/** Auth Edge 换取官方启动 URL、提交已验证 scope；普通流量仍归官方 Connection。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = await ctx.credentials!.resolve(config.tokenEnv as CredentialRef);
  if (!resolved?.value) throw new Error(`lark-web-auth: 凭证引用未配置（${config.tokenEnv}）`);
  const scopeIndex = (ctx as Context & { larkScopeIndex?: WebScopeIndex }).larkScopeIndex;
  if (!scopeIndex) throw new Error("lark-web-auth: larkScopeIndex 未挂载");
  const token = resolved.value;
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/internal/web-auth/session", handler: (req, res) => {
    if (!authorized(req, token) || req.method !== "POST") return send(res, 401, { code: "UNAUTHORIZED" });
    send(res, 200, { url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`) });
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/internal/web-auth/scope", handler: async (req, res) => {
    if (!authorized(req, token) || req.method !== "POST") return send(res, 401, { code: "UNAUTHORIZED" });
    try {
      scopeIndex.bindWeb(JSON.parse((await readBody(req)).toString("utf8")) as unknown);
      send(res, 204);
    } catch { send(res, 400, { code: "INVALID_WEB_SCOPE" }); }
  } }));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") && constantTimeEqual(value.slice(7), token);
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += value.length;
    if (total > 8192) throw new Error("body too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function send(res: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "cache-control": "no-store", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) });
  res.end(payload);
}
