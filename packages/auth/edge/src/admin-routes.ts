import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthService, AuthUser } from "dsh-lark-auth";

import type { AuthEdgeConfig } from "./config.js";
import { readJson, sendError, sendJson } from "./http-utils.js";
import { trustedOrigin } from "./origin.js";
import { metadata, parseAdminUserPatch } from "./server-helpers.js";

export interface AdminRouteDeps {
  config: AuthEdgeConfig;
  service: AuthService;
}

/** Edge 本地处理的 Admin 数据端点（非代理路径），仅 admin 角色可达。 */
export async function handleAdminData(deps: AdminRouteDeps, req: IncomingMessage, res: ServerResponse, url: URL, user: AuthUser): Promise<void> {
  if (!trustedOrigin(req, deps.config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
  if (user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/admin/users") {
    sendJson(res, 200, { users: await deps.service.listAdminUsers() });
    return;
  }
  if (req.method === "GET" && path === "/api/admin/sessions") {
    sendJson(res, 200, { sessions: await deps.service.listAdminSessions() });
    return;
  }
  if (req.method === "GET" && path === "/api/admin/summary") {
    await sendAdminSummary(deps.service, res);
    return;
  }
  const userMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
  if (req.method === "PATCH" && userMatch) {
    await updateAdminUser(deps, req, res, userMatch[1]!);
    return;
  }
  const userSessionsMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/sessions\/revoke$/.exec(path);
  if (req.method === "POST" && userSessionsMatch) {
    const result = await deps.service.revokeAdminUserSessions(userSessionsMatch[1]!, metadata(req));
    if (!result) { sendError(res, 404, "USER_NOT_FOUND"); return; }
    sendJson(res, 200, result);
    return;
  }
  const sessionMatch = /^\/api\/admin\/sessions\/([0-9a-f-]{36})\/revoke$/.exec(path);
  if (req.method === "POST" && sessionMatch) {
    const session = await deps.service.revokeAdminSession(sessionMatch[1]!, metadata(req));
    if (!session) { sendError(res, 404, "SESSION_NOT_FOUND"); return; }
    sendJson(res, 200, { session });
    return;
  }
  sendError(res, 404, "NOT_FOUND");
}

async function updateAdminUser(deps: AdminRouteDeps, req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const patch = parseAdminUserPatch(await readJson(req, deps.config.requestBodyLimit));
  const result = await deps.service.updateUserForAdmin(userId, patch, metadata(req));
  if (result.status === "not-found") { sendError(res, 404, "USER_NOT_FOUND"); return; }
  if (result.status === "last-admin") { sendError(res, 409, "LAST_ADMIN_REQUIRED"); return; }
  if (result.status === "mode-not-allowed") { sendError(res, 400, "MODE_NOT_ALLOWED"); return; }
  const user = (await deps.service.listAdminUsers()).find((item) => item.id === result.user.id);
  if (!user) { sendError(res, 404, "USER_NOT_FOUND"); return; }
  sendJson(res, 200, { user });
}

async function sendAdminSummary(service: AuthService, res: ServerResponse): Promise<void> {
  const [users, sessions] = await Promise.all([service.listAdminUsers(), service.listAdminSessions()]);
  sendJson(res, 200, {
    observedAt: new Date().toISOString(),
    users: {
      total: users.length,
      active: users.filter((item) => item.status === "active").length,
      admins: users.filter((item) => item.role === "admin").length,
    },
    sessions: {
      total: sessions.length,
      active: sessions.filter((item) => !item.revokedAt && item.expiresAt > new Date().toISOString()).length,
    },
    resources: {
      workspaces: users.reduce((total, item) => total + item.workspaceCount, 0),
      identities: users.reduce((total, item) => total + item.identityCount, 0),
    },
  });
}
