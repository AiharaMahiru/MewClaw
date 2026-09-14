/**
 * admin-web 本地预览桩：serve dist/ 静态资源 + 全部 /api/admin 与 /auth 读接口的仿真数据。
 * 启动：node scripts/mock-admin-server.mjs（在 apps/admin-web 构建后），
 * 浏览器访问 http://127.0.0.1:4174/admin 并在控制台执行
 * sessionStorage.setItem("mewclaw-admin-token","valid-token") 后刷新。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const HOST = "127.0.0.1";
const PORT = 4174;
const DIST_ROOT = resolve(new URL("..", import.meta.url).pathname, "dist");
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const USERS = [
  { id: "u-1", email: "admin@mewclaw.dev", displayName: "运维管理员", role: "admin", status: "active", defaultMode: "full", createdAt: iso(86400000 * 90), updatedAt: iso(3600000), sessionCount: 3, workspaceCount: 2, identityCount: 1 },
  { id: "u-2", email: "598527647@qq.com", displayName: "MewTwo", role: "user", status: "active", defaultMode: "lightweight", createdAt: iso(86400000 * 45), updatedAt: iso(7200000), sessionCount: 1, workspaceCount: 1, identityCount: 1 },
  { id: "u-3", email: "pending@example.com", displayName: "待验证用户", role: "user", status: "pending", defaultMode: "lightweight", createdAt: iso(86400000 * 2), updatedAt: iso(86400000 * 2), sessionCount: 0, workspaceCount: 0, identityCount: 0 },
  { id: "u-4", email: "disabled@example.com", displayName: "停用账号", role: "user", status: "disabled", defaultMode: "lightweight", createdAt: iso(86400000 * 120), updatedAt: iso(86400000 * 10), sessionCount: 0, workspaceCount: 1, identityCount: 0 },
];

const SESSIONS = [
  { id: "s-1", userId: "u-1", email: "admin@mewclaw.dev", displayName: "运维管理员", role: "admin", createdAt: iso(3600000), expiresAt: new Date(NOW + 86400000).toISOString(), lastSeenAt: iso(60000), revokedAt: null },
  { id: "s-2", userId: "u-2", email: "598527647@qq.com", displayName: "MewTwo", role: "user", createdAt: iso(7200000), expiresAt: new Date(NOW + 43200000).toISOString(), lastSeenAt: iso(300000), revokedAt: null },
  { id: "s-3", userId: "u-1", email: "admin@mewclaw.dev", displayName: "运维管理员", role: "admin", createdAt: iso(86400000 * 3), expiresAt: iso(86400000), lastSeenAt: iso(86400000 * 2), revokedAt: iso(86400000) },
  { id: "s-4", userId: "u-2", email: "598527647@qq.com", displayName: "MewTwo", role: "user", createdAt: iso(86400000 * 5), expiresAt: iso(86400000 * 4), lastSeenAt: iso(86400000 * 4), revokedAt: null },
];

const TARGETS = [
  {
    target: { id: "current-agent", label: "Current agent" },
    generation: 3,
    observedAt: iso(30000),
    session: {
      exists: true,
      todos: [
        { content: "Review the dashboard state", status: "in_progress" },
        { content: "Archive accepted evidence", status: "pending" },
      ],
      usage: { runs: 7, modelCalls: 18, inputTokens: 12640, outputTokens: 3294, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      lastActivityAt: iso(30000),
    },
  },
  { target: { id: "new-agent", label: "New agent" }, generation: 0, observedAt: iso(30000), session: { exists: false } },
];

const BILLING_ROWS = [
  { periodStart: "2026-09-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "u-2", provider: "deepseek", model: "deepseek-v4.1-flash", calls: 142, inputTokens: 920000, outputTokens: 310000, cacheReadTokens: 40000, cacheWriteTokens: 0, reasoningTokens: 120000, totalUsd: 4.231 },
  { periodStart: "2026-09-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "u-1", provider: "openai", model: "gpt-6-astra", calls: 38, inputTokens: 240000, outputTokens: 98000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 44000, totalUsd: 2.871 },
  { periodStart: "2026-09-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "u-2", provider: "sol", model: "sol-max", calls: 21, inputTokens: 180000, outputTokens: 62000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 30000, totalUsd: 1.944 },
];

const PRICES = [
  { provider: "deepseek", model: "deepseek-v4.1-flash", inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1, cacheReadUsdPerMillion: 0.07, cacheWriteUsdPerMillion: 0.0, reasoningUsdPerMillion: 1.1, updatedAt: iso(86400000) },
  { provider: "openai", model: "gpt-6-astra", inputUsdPerMillion: 2.5, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 1.25, cacheWriteUsdPerMillion: 0, reasoningUsdPerMillion: 10, updatedAt: iso(86400000) },
];

const CUBES = [
  { id: "c-1", key: "user:u-2", name: "MewTwo 的记忆", visibility: "user_private", ownerUserId: "u-2", revision: 4, createdAt: iso(86400000 * 30), updatedAt: iso(3600000) },
  { id: "c-2", key: "project:mewclaw", name: "MewClaw 项目知识", visibility: "project_shared", projectKey: "mewclaw", ownerUserId: "u-1", revision: 11, createdAt: iso(86400000 * 60), updatedAt: iso(7200000) },
  { id: "c-3", key: "tenant:main", name: "租户共享记忆", visibility: "tenant_shared", ownerUserId: "u-1", revision: 2, createdAt: iso(86400000 * 90), updatedAt: iso(86400000) },
];

const NODES = [
  { id: "n-1", cubeId: "c-1", kind: "preference", parts: [{ modality: "text", text: "偏好使用中文回复，代码注释也用中文。" }], confidence: 0.92, source: { kind: "conversation" }, revision: 1, status: "active", createdAt: iso(86400000 * 20), updatedAt: iso(86400000) },
  { id: "n-2", cubeId: "c-1", kind: "fact", parts: [{ modality: "text", text: "生产域名是 chat.rwr.ink，admin 挂载在 /admin。" }], confidence: 0.98, source: { kind: "import" }, revision: 2, status: "active", createdAt: iso(86400000 * 25), updatedAt: iso(3600000) },
];

const EDGES = [
  { id: "e-1", cubeId: "c-1", fromId: "n-2", toId: "n-1", relation: "supports", createdAt: iso(86400000 * 20) },
];

function writeJson(response, status, body) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
}

async function serveApi(request, response, url) {
  if (request.headers.authorization !== "Bearer valid-token") return writeJson(response, 401, { error: "UNAUTHORIZED" });
  const path = url.pathname;
  if (path === "/api/admin/summary") return writeJson(response, 200, { observedAt: iso(60000), users: { total: USERS.length, active: 2, admins: 1 }, sessions: { total: SESSIONS.length, active: 2 }, resources: { workspaces: 4, identities: 2 } });
  if (path === "/api/admin/users") {
    if (request.method === "GET") return writeJson(response, 200, { users: USERS });
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)(\/sessions\/revoke)?$/);
  if (userMatch) {
    const user = USERS.find((item) => item.id === userMatch[1]);
    if (!user) return writeJson(response, 404, { error: "USER_NOT_FOUND" });
    if (userMatch[2] && request.method === "POST") return writeJson(response, 200, { userId: user.id, revokedCount: user.sessionCount });
    if (request.method === "PATCH") return writeJson(response, 200, { user: { ...user, ...(await readBody(request)) } });
  }
  if (path === "/api/admin/sessions") return writeJson(response, 200, { sessions: SESSIONS });
  if (path.startsWith("/api/admin/sessions/") && path.endsWith("/revoke") && request.method === "POST") {
    const session = SESSIONS.find((item) => item.id === path.split("/").at(-2));
    return session ? writeJson(response, 200, { session: { ...session, revokedAt: new Date(NOW).toISOString() } }) : writeJson(response, 404, { error: "SESSION_NOT_FOUND" });
  }
  if (path === "/api/admin/dashboard") return writeJson(response, 200, { worker: { ok: true, queueDepth: 2, observedAt: iso(30000) }, targets: TARGETS });
  if (path.startsWith("/api/admin/control/conversations/")) {
    const snapshot = TARGETS.find((item) => item.target.id === path.split("/").at(-1) && item.generation === Number(url.searchParams.get("generation")));
    return snapshot ? writeJson(response, 200, snapshot) : writeJson(response, 404, { error: "TARGET_NOT_FOUND" });
  }
  if (path === "/api/admin/billing/summary") return writeJson(response, 200, { rows: BILLING_ROWS });
  if (path === "/api/admin/billing/prices") {
    if (request.method === "PUT") return writeJson(response, 200, { price: await readBody(request) });
    return writeJson(response, 200, { prices: PRICES });
  }
  if (path === "/api/admin/billing/quota") {
    if (request.method === "PUT") { const body = await readBody(request); return writeJson(response, 200, { scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: body.userId }, periodStart: "2026-09-01", monthlyLimitUsd: body.monthlyLimitUsd, usedUsd: 9.91, remainingUsd: Math.max(0, body.monthlyLimitUsd - 9.91) }); }
    return writeJson(response, 200, { scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: url.searchParams.get("userId") }, periodStart: "2026-09-01", monthlyLimitUsd: 20, usedUsd: 9.91, remainingUsd: 10.09 });
  }
  if (path === "/api/admin/knowledge") return writeJson(response, 200, { documents: [{ docId: "d-1", baseId: "b-1", documentKey: "deploy-runbook", name: "deploy-runbook.md", mimeType: "text/markdown", size: 42000, sha256: "ab12", visibility: "bot_shared", status: "active", version: 2, chunkCount: 18, category: "technical_spec", tags: ["deploy"], createdAt: iso(86400000 * 7), activatedAt: iso(86400000 * 7), canManage: true }], summary: { totalVersions: 2, activeDocuments: 1, privateDocuments: 0, sharedDocuments: 1, archivedDocuments: 0, totalChunks: 18, totalBytes: 42000 } });
  if (path === "/api/admin/knowledge/uploads") return writeJson(response, 200, { runs: [{ runId: "r-1", visibility: "bot_shared", fileName: "deploy-runbook.md", mimeType: "text/markdown", sourceSize: 42000, category: "technical_spec", tags: ["deploy"], stage: "completed", progress: 100, status: "completed", documentId: "d-1", errorCode: null, createdAt: iso(86400000 * 7), updatedAt: iso(86400000 * 7), completedAt: iso(86400000 * 7) }] });
  if (path === "/api/admin/memory/cubes") return writeJson(response, 200, { cubes: CUBES });
  const cubeMatch = path.match(/^\/api\/admin\/memory\/cubes\/([^/]+)$/);
  if (cubeMatch) {
    const cube = CUBES.find((item) => item.id === cubeMatch[1]);
    if (!cube) return writeJson(response, 404, { error: "CUBE_NOT_FOUND" });
    if (request.method === "PATCH") return writeJson(response, 200, { op: "update", ok: true });
    if (request.method === "DELETE") return writeJson(response, 200, { op: "delete", ok: true });
    return writeJson(response, 200, { cube });
  }
  if (path === "/api/admin/memory/search") return writeJson(response, 200, { nodes: NODES, edges: EDGES });
  const nodeMatch = path.match(/^\/api\/admin\/memory\/nodes\/([^/]+)$/);
  if (nodeMatch) { const node = NODES.find((item) => item.id === nodeMatch[1]); return node ? writeJson(response, 200, { node, edges: EDGES }) : writeJson(response, 404, { error: "NODE_NOT_FOUND" }); }
  if (path === "/api/admin/memory/command" && request.method === "POST") return writeJson(response, 200, { op: "delete", ok: true });
  if (path === "/auth/admin/identities") {
    if (request.method === "DELETE") return writeJson(response, 200, { ok: true });
    return writeJson(response, 200, { identities: [{ provider: "feishu", subject: "ou_8f2c91aa", unionId: "on_51aa", createdAt: iso(86400000 * 40), user: { id: "u-2", email: "598527647@qq.com", displayName: "MewTwo", role: "user" } }] });
  }
  return writeJson(response, 404, { error: "NOT_FOUND" });
}

function staticPath(pathname) {
  if (pathname.startsWith("/admin/assets/")) {
    const candidate = resolve(DIST_ROOT, normalize(pathname.slice("/admin/".length)));
    if (candidate.startsWith(`${DIST_ROOT}${sep}`)) return candidate;
  }
  return join(DIST_ROOT, "index.html");
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  console.info(`[mock-admin] ${request.method} ${url.pathname}`);
  if (url.pathname === "/auth/me") return writeJson(response, 200, { user: { id: "u-1", email: "admin@mewclaw.dev", displayName: "运维管理员", role: "admin", defaultMode: "full" } });
  if (url.pathname === "/auth/logout" && request.method === "POST") return writeJson(response, 200, { ok: true });
  if (url.pathname.startsWith("/api/admin/") || url.pathname === "/auth/admin/identities") return serveApi(request, response, url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    const filePath = staticPath(url.pathname);
    try {
      let content = await readFile(filePath);
      if (extname(filePath) === ".html") {
        content = Buffer.from(content.toString("utf-8").replace("<head>", `<head><script>sessionStorage.setItem("mewclaw-admin-token","valid-token");</script>`));
      }
      response.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
      return response.end(content);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Not found");
    }
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

createServer((request, response) => { void handleRequest(request, response); }).listen(PORT, HOST, () => {
  console.info(`mock admin server listening on http://${HOST}:${PORT}/admin`);
});
