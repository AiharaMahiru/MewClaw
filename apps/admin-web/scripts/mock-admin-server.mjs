import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const HOST = "127.0.0.1";
const PORT = 4174;
const DIST_ROOT = resolve(process.cwd(), "apps/admin-web/dist");
const OBSERVED_AT = "2026-08-16T08:00:00.000Z";
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const CURRENT_AGENT = {
  target: { id: "current-agent", label: "Current agent" },
  generation: 3,
  observedAt: OBSERVED_AT,
  session: {
    exists: true,
    todos: [
      { content: "Review the dashboard state", status: "in_progress" },
      { content: "Archive accepted evidence", status: "pending" },
    ],
    usage: {
      runs: 7,
      modelCalls: 18,
      inputTokens: 12640,
      outputTokens: 3294,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    lastActivityAt: OBSERVED_AT,
  },
};

const NEW_AGENT = {
  target: { id: "new-agent", label: "New agent" },
  generation: 0,
  observedAt: OBSERVED_AT,
  session: { exists: false },
};

const TARGETS = [CURRENT_AGENT, NEW_AGENT];

function writeJson(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function mockStatus(request, response) {
  const authorization = request.headers.authorization;
  if (authorization === "Bearer unavailable-token") {
    writeJson(response, 503, { error: "WORKER_UNAVAILABLE" });
    return true;
  }
  if (authorization !== "Bearer valid-token") {
    writeJson(response, 401, { error: "UNAUTHORIZED" });
    return true;
  }
  return false;
}

function dashboardSnapshot() {
  return {
    worker: { ok: true, queueDepth: 2, observedAt: OBSERVED_AT },
    targets: TARGETS,
  };
}

function conversationSnapshot(url) {
  const targetId = url.pathname.split("/").at(-1);
  const generation = Number(url.searchParams.get("generation"));
  return TARGETS.find((item) => item.target.id === targetId && item.generation === generation);
}

function knowledgeSnapshot() {
  return {
    documents: [],
    summary: {
      totalVersions: 0,
      activeDocuments: 0,
      privateDocuments: 0,
      sharedDocuments: 0,
      archivedDocuments: 0,
      totalChunks: 0,
      totalBytes: 0,
    },
  };
}

function serveApi(request, response, url) {
  if (mockStatus(request, response)) return;
  if (request.method !== "GET") return writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
  if (url.pathname === "/api/admin/dashboard") return writeJson(response, 200, dashboardSnapshot());
  if (url.pathname === "/api/admin/knowledge") return writeJson(response, 200, knowledgeSnapshot());
  if (url.pathname === "/api/admin/knowledge/uploads") return writeJson(response, 200, { runs: [] });
  if (url.pathname.startsWith("/api/admin/control/conversations/")) {
    const snapshot = conversationSnapshot(url);
    return snapshot
      ? writeJson(response, 200, snapshot)
      : writeJson(response, 404, { error: "TARGET_NOT_FOUND" });
  }
  return writeJson(response, 404, { error: "NOT_FOUND" });
}

function staticPath(pathname) {
  if (pathname.startsWith("/admin/assets/")) {
    const relative = pathname.slice("/admin/".length);
    const candidate = resolve(DIST_ROOT, normalize(relative));
    if (candidate.startsWith(`${DIST_ROOT}${sep}`)) return candidate;
  }
  return join(DIST_ROOT, "index.html");
}

async function serveStatic(response, pathname) {
  const filePath = staticPath(pathname);
  try {
    const content = await readFile(filePath);
    const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  console.info(`[mock-admin] ${request.method} ${url.pathname}`);
  if (url.pathname.startsWith("/api/admin/")) return serveApi(request, response, url);
  if (url.pathname === "/admin/") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return serveStatic(response, url.pathname);
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(PORT, HOST, () => {
  console.info(`mock admin server listening on http://${HOST}:${PORT}/admin`);
});
