/** 仅Auth边界处理账号机器人；内部端点绝不以浏览器会话代替服务凭证。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { constantTimeEqual, FeishuBotError, type BotState, type FeishuBotService } from "dsh-lark-auth";
import type { AuthEdgeConfig } from "./config.js";
import { readJson, sendJson, httpError } from "./http-utils.js";

export async function handleBotAccount(req: IncomingMessage, res: ServerResponse, path: string, userId: string, service: FeishuBotService, config: AuthEdgeConfig): Promise<void> {
  try {
    if (req.method === "GET" && path === "/auth/feishu-bot") { sendJson(res, 200, { bot: await service.read(userId) }); return; }
    const body = await readJson(req, config.requestBodyLimit);
    if (req.method === "PUT" && path === "/auth/feishu-bot") { sendJson(res, 200, { bot: await service.save(userId, body) }); return; }
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw httpError(400, "INVALID_REQUEST");
    if (req.method === "POST" && path.endsWith("/test") && Object.keys(body).length === 1) { sendJson(res, 200, await service.test(userId, body.expectedRevision as number)); return; }
    if (req.method === "POST" && path.endsWith("/connection") && Object.keys(body).length === 2 && typeof body.enabled === "boolean") { sendJson(res, 200, { bot: await service.setEnabled(userId, body.expectedRevision as number, body.enabled) }); return; }
    throw httpError(400, "INVALID_REQUEST");
  } catch (cause) {
    if (cause instanceof FeishuBotError) { sendJson(res, cause.status, { error: cause.code }); return; }
    throw cause;
  }
}

export async function handleBotInternal(req: IncomingMessage, res: ServerResponse, path: string, service: FeishuBotService, config: AuthEdgeConfig): Promise<void> {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || req.headers.origin || req.headers.cookie) throw httpError(403, "LOOPBACK_SERVICE_REQUIRED");
  const auth = req.headers.authorization ?? "";
  if (!config.pairingToken || !auth.startsWith("Bearer ") || !constantTimeEqual(auth.slice(7), config.pairingToken)) throw httpError(401, "UNAUTHORIZED");
  if (req.method === "GET" && path === "/internal/feishu-bots") { sendJson(res, 200, { bots: await service.runtime() }); return; }
  if (req.method !== "POST") throw httpError(405, "METHOD_NOT_ALLOWED");
  const body = await readJson(req, config.requestBodyLimit);
  if (typeof body.userId !== "string" || !Number.isSafeInteger(body.revision)) throw httpError(400, "INVALID_REQUEST");
  if (path.endsWith("/claim")) {
    await service.claim(body.userId, body.revision as number, body.scope, body.generation as number);
  } else {
    if (!["connected", "reconnecting", "failed"].includes(body.state as string)) throw httpError(400, "INVALID_REQUEST");
    await service.report(body.userId, body.revision as number, body.state as BotState);
  }
  sendJson(res, 200, { ok: true });
}
