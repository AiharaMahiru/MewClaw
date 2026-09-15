import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";

import { accessPolicy } from "dsh-lark-auth";
import type { AuthService, AuthUser } from "dsh-lark-auth";
import { FAVICON_PATH as BRAND_FAVICON_PATH, MANIFEST_PATH as BRAND_MANIFEST_PATH } from "dsh-lark-atw-brand";

import { handleAdminData } from "./admin-routes.js";
import { AuthRouteHandlers } from "./auth-routes.js";
import type { DesktopSharedRuntime } from "./desktop-inference.js";
import { filterClientPlugins, injectRemoteSettings } from "./client-manifest.js";
import { DEFAULT_PREVIEW_URL, DEFAULT_PROXY_BODY_LIMIT, DEFAULT_SESSION_TTL_MS, type AuthEdgeConfig } from "./config.js";
import { appendCookie, CSRF_COOKIE, newCsrfToken, readCookie, sessionCookieName } from "./cookies.js";
import { proxyDesktopWorkspace } from "./desktop-workspace.js";
import { createUserEventFilter, createUserRemoteMuxPolicy } from "./event-policy.js";
import { handleBotInternal } from "./feishu-bots.js";
import { csrfToken, httpError, readBody, sendError, sendHtml, sendJson, sessionToken } from "./http-utils.js";
import { loginPage } from "./login-page.js";
import { INTERNAL_MODEL_RESOLVE_PATH, ModelRouteBridge } from "./model-routes.js";
import { trustedOrigin } from "./origin.js";
import { authorizeGitRequest, authorizeSidebarRequest, isSidebarRequest, sidebarDecision, type ProxyAuthzDeps } from "./proxy-authz.js";
import { proxyUpgrade, requestUpstream, streamUpstream, writeProxyResponse } from "./proxy.js";
import { promptAuditInput, type PromptAuditor } from "./prompt-audit.js";
import { LoginGuard, RateLimiter } from "./rate-limit.js";
import { RemoteEventResults } from "./remote-event-results.js";
import { authorizeClientResponse, authorizeRpc, filterRpcResponse } from "./rpc-policy.js";
import {
  apiEndpoint,
  applySecurityHeaders,
  hasBody,
  isAdminDataPath,
  isHtml,
  isInputError,
  isJson,
  isJsonHeader,
  isPublicAssetRequest,
  isUnsafe,
  isWebUiSettingsBridge,
  metadata,
  mutationAllowed,
  parseJson,
  publicSharePrefix,
  sendRpcFailure,
} from "./server-helpers.js";
import { UPGRADE_ABORTED, UpgradeTaskTracker } from "./upgrade-tasks.js";

const AUTHENTICATED_USER_HEADER = "x-dsh-auth-user-id";
const SHARE_BLOCKED_RESPONSE_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
] as const;

export interface AuthEdgeServerOptions {
  config: AuthEdgeConfig;
  service: AuthService;
  roots?: { user: string; admin: string };
  promptAuditor?: PromptAuditor;
  /** 部署侧共享模型目录；未装配时桌面 `shared/*` 选择器 fail-closed 404。 */
  sharedModels?: DesktopSharedRuntime;
}

export class AuthEdgeServer {
  readonly server: Server;
  readonly #config: AuthEdgeConfig;
  readonly #service: AuthService;
  readonly #promptAuditor: PromptAuditor | undefined;
  readonly #roots: { user: string; admin: string };
  readonly #loginLimiter = new RateLimiter(12, 60_000);
  readonly #loginGuard = new LoginGuard();
  readonly #generalLimiter = new RateLimiter(30, 60_000);
  readonly #authRoutes: AuthRouteHandlers;
  readonly #modelRoutes: ModelRouteBridge;
  readonly #authz: ProxyAuthzDeps;
  readonly #upgradedSockets = new Set<Duplex>();
  readonly #upgradeTasks = new UpgradeTaskTracker();
  readonly #remoteEventResults = new RemoteEventResults();
  #workerCookiePromise: Promise<string> | undefined;

  /** Worker 代理路径的请求体上限；独立于认证端点的小 JSON 限制。 */
  get #proxyBodyLimit(): number { return this.#config.proxyBodyLimit ?? DEFAULT_PROXY_BODY_LIMIT; }

  constructor(options: AuthEdgeServerOptions) {
    this.#config = options.config;
    this.#service = options.service;
    this.#promptAuditor = options.promptAuditor;
    this.#roots = options.roots ?? { user: options.config.userWorkspaceRoot, admin: options.config.adminWorkspaceRoot };
    this.#authz = { config: this.#config, service: this.#service };
    this.#modelRoutes = new ModelRouteBridge({ config: this.#config, service: this.#service });
    this.#authRoutes = new AuthRouteHandlers({
      config: this.#config,
      service: this.#service,
      loginLimiter: this.#loginLimiter,
      loginGuard: this.#loginGuard,
      generalLimiter: this.#generalLimiter,
      promptAuditor: options.promptAuditor,
      sharedModels: options.sharedModels,
      current: (req) => this.current(req),
      ensureCsrf: (req, cookies) => this.ensureCsrf(req, cookies),
      refreshSessionCookie: (req, cookies) => this.refreshSessionCookie(req, cookies),
    });
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.on("connection", (socket) => socket.on("error", () => undefined));
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    this.server.on("upgrade", (req, socket, head) => {
      this.trackUpgradedSocket(socket);
      this.#upgradeTasks.run(socket, () => this.handleUpgrade(req, socket, head));
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.#config.port, this.#config.host, () => { this.server.off("error", reject); resolve(); });
    });
  }

  async close(): Promise<void> {
    this.#upgradeTasks.beginClose();
    const serverClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    const upgradedClosed = [...this.#upgradedSockets].map((socket) => destroyAndWait(socket));
    await Promise.all([serverClosed, this.#upgradeTasks.wait(), ...upgradedClosed]);
  }

  private trackUpgradedSocket(socket: Duplex): void {
    this.#upgradedSockets.add(socket);
    socket.once("close", () => this.#upgradedSockets.delete(socket));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.on("error", () => undefined);
    applySecurityHeaders(res, req.url);
    try { await this.dispatch(req, res); } catch (error) { this.handleError(res, error); }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const sharePrefix = publicSharePrefix(url.pathname);
    if (sharePrefix) { await this.proxyShare(req, res, sharePrefix); return; }
    if (url.pathname === "/share" || url.pathname === "/share/") { sendError(res, 404, "NOT_FOUND"); return; }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/healthz" && req.method === "GET") { sendJson(res, 200, { ok: true }); return; }
    if (req.method === "POST" && url.pathname === "/internal/pairing/start") { return this.#authRoutes.beginPairing(req, res); }
    if (req.method === "POST" && url.pathname === INTERNAL_MODEL_RESOLVE_PATH) { return this.#modelRoutes.resolveInternal(req, res); }
    if (url.pathname === "/internal/feishu-bots" || url.pathname === "/internal/feishu-bots/claim") {
      return handleBotInternal(req, res, url.pathname, this.#service.feishuBots, this.#config);
    }
    if (isUnsafe(req) && !mutationAllowed(req, url, this.#config.trustedOrigins)) throw httpError(403, "CSRF_INVALID");
    if (url.pathname.startsWith("/auth/")) { await this.#authRoutes.handle(req, res, url); return; }
    if (isPublicAssetRequest(req, url)) { await this.proxyPublicAsset(req, res); return; }
    if (url.pathname === "/admin/") { sendError(res, 404, "NOT_FOUND"); return; }
    if (url.pathname === "/" && req.method === "GET") { await this.handleHome(req, res); return; }
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (url.pathname === "/desktop-workspace") return proxyDesktopWorkspace(req, res, {
      userId: current.user.id, workerBaseUrl: this.#config.workerBaseUrl, workerToken: this.#config.workerToken,
      requestBodyLimit: this.#config.desktopBodyLimit ?? 8 * 1024 * 1024, findResource: (type, id) => this.#service.findResource(type, id),
    });
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) { await this.proxyAdmin(req, res, current.user); return; }
    if (isAdminDataPath(url.pathname)) { await handleAdminData(this.#authz, req, res, url, current.user); return; }
    if (url.pathname.startsWith("/api/admin/")) { await this.proxyAdmin(req, res, current.user); return; }
    if (url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/")) { await this.proxyBilling(req, res, current.user); return; }
    await this.proxyWorker(req, res, current.user);
  }

  private async proxyShare(req: IncomingMessage, res: ServerResponse, sharePrefix: string): Promise<void> {
    if (req.method === "TRACE" || req.method === "CONNECT") { sendError(res, 405, "METHOD_NOT_ALLOWED"); return; }
    if (!this.#config.workerToken) { sendError(res, 503, "PREVIEW_NOT_CONFIGURED"); return; }
    const originalOrigin = typeof req.headers.origin === "string" ? { origin: req.headers.origin } : {};
    await streamUpstream(this.#config.previewBaseUrl ?? DEFAULT_PREVIEW_URL, req, res, {
      authorization: `Bearer ${this.#config.workerToken}`,
      "x-forwarded-prefix": sharePrefix,
      ...originalOrigin,
    }, { stripResponseHeaders: SHARE_BLOCKED_RESPONSE_HEADERS });
  }

  private async handleHome(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req);
    if (!current) { const cookies: string[] = []; this.ensureCsrf(req, cookies); sendHtml(res, 200, loginPage(), cookies); return; }
    // 登录后的旧会话可能只有 dsh_session（例如升级前由服务端签发），
    // 首次打开首页时补发 CSRF Cookie，避免随后所有 POST RPC 被 403 拦截。
    const cookies: string[] = [];
    this.ensureCsrf(req, cookies);
    this.refreshSessionCookie(req, cookies);
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    await this.proxyWorker(req, res, current.user);
  }

  private async proxyWorker(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
    if (!trustedOrigin(req, this.#config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
    let body: Buffer | undefined; let decision;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (isSidebarRequest(url.pathname)) {
      const sidebar = await authorizeSidebarRequest(this.#authz, req, url, user);
      if (sidebar.denied) { sendError(res, 403, sidebar.denied); return; }
      body = sidebar.body;
    }
    if (url.pathname.startsWith("/git/")) {
      const git = await authorizeGitRequest(this.#authz, req, url, user);
      if (git.denied) { sendError(res, 403, git.denied); return; }
      body = git.body;
    }
    const endpoint = apiEndpoint(url.pathname);
    if (endpoint === "$events/result") {
      if (req.method !== "POST" || !isJsonHeader(req.headers["content-type"])) { sendError(res, 400, "INVALID_RPC"); return; }
      body = await readBody(req, this.#proxyBodyLimit);
      const denied = await this.#remoteEventResults.authorize(parseJson(body), user, this.#service);
      if (denied) { sendError(res, 403, denied); return; }
      // 已投递的交互结果不是新提示词；保留官方信封及上游outcome校验。
      const headers = await this.workerHeaders();
      writeProxyResponse(res, await requestUpstream(this.#config.workerBaseUrl, req, body, headers));
      return;
    }
    if (this.#config.promptAudit?.enabled !== false && endpoint && /^(?:session[/.](?:prompt|updateQueue)|subagents?[/.]prompt|goals?[/.](?:create|edit)|commands[/.]execute)$/u.test(endpoint)
      && (req.method !== "POST" || !isJsonHeader(req.headers["content-type"]))) {
      sendError(res, 400, "INVALID_RPC"); return;
    }
    if (endpoint === "respond" && req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#proxyBodyLimit); const parsed = parseJson(body); decision = authorizeClientResponse(parsed); if (decision.denied) { sendError(res, 403, decision.denied); return; } body = Buffer.from(JSON.stringify(decision.body));
    } else if (endpoint === "session.export" && (req.method === "GET" || req.method === "HEAD")) {
      decision = await authorizeRpc({ method: "session.export", payload: { sessionId: url.searchParams.get("sessionId") ?? "" } }, { service: this.#service, user, roots: this.#roots }); if (decision.denied) { sendError(res, 403, decision.denied); return; }
    } else if (isWebUiSettingsBridge(endpoint) && req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#proxyBodyLimit);
      const parsed = parseJson(body);
      if (endpoint === "dsh-web-ui-settings/mutate" && user.role !== "admin") { sendError(res, 403, "CAPABILITY_NOT_ALLOWED"); return; }
      decision = {
        body: parsed,
        method: endpoint.replace("/", "."),
        args: parsed,
      };
    } else if (endpoint && !endpoint.startsWith("events.") && req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#proxyBodyLimit); const parsed = parseJson(body); decision = await authorizeRpc(parsed, { service: this.#service, user, roots: this.#roots }, endpoint); if (decision.denied) { sendError(res, 403, decision.denied); return; } body = Buffer.from(JSON.stringify(decision.body));
    }
    // 审计在授权之后且早于任何 Worker 转发，管理员同样受限。
    if (decision && this.#config.promptAudit?.enabled !== false) {
      const input = promptAuditInput(decision);
      if (input.kind !== "skip") {
        const result = input.kind === "text" && this.#promptAuditor
          ? await this.#promptAuditor.audit(input.text).catch(() => "unavailable" as const)
          : "unavailable";
        if (result !== "allow") {
          // 这是已认证 RPC 的业务拒绝，不是 HTTP transport 故障。返回官方
          // Connection 信封后，Conversation 会通过公开 promptError/Toast 展示固定文案。
          sendRpcFailure(res, decision.body, result === "block"
            ? { code: "prompt/security-blocked", message: "禁止网络攻防、恶意攻击和破解类请求，本次提示词未发送。请修改内容后重试。" }
            : { code: "prompt/security-unavailable", message: "安全审计暂时不可用，本次提示词未发送。请稍后重试。" });
          return;
        }
        if (res.destroyed) return;
      }
    }
    const headers: IncomingHttpHeaders = await this.workerHeaders();
    if (decision?.method === "session.prompt") {
      // 官方 Typert descriptor 将 sessionId 放在 request 中；兼容旧版
      // 直接放在 args 顶层的调用，确保模型路由和 scope 都能拿到同一会话。
      const request = decision.args.request;
      const nestedSessionId = request && typeof request === "object" && !Array.isArray(request)
        ? (request as Record<string, unknown>).sessionId
        : undefined;
      const sessionId = typeof decision.args.sessionId === "string"
        ? decision.args.sessionId
        : typeof nestedSessionId === "string" ? nestedSessionId : "";
      const rpcId = typeof decision.body.rpcId === "string" ? decision.body.rpcId : "";
      if (!sessionId || !rpcId || rpcId.length > 256) { sendError(res, 400, "INVALID_RPC"); return; }
      const routeRef = await this.#service.resolveMyDefaultModelRouteRef(user.id);
      const modelRoute = routeRef
        ? { mode: "private" as const, ...routeRef, capability: this.#modelRoutes.issue({ userId: user.id, sessionId, rpcId, ...routeRef }) }
        : { mode: "shared" as const };
      const binding = {
        sessionId,
        rpcId,
        scope: {
          tenantId: "dsh-web",
          botId: "dsh-web",
          deploymentId: "auth-edge",
          userId: user.id,
          conversationId: sessionId,
        },
        modelRoute,
      };
      await this.#modelRoutes.bindScope(binding);
    }
    const csrf = csrfToken(req); if (csrf) headers["x-csrf-token"] = csrf;
    const upstream = await requestUpstream(this.#config.workerBaseUrl, req, body, headers);
    if (decision && decision.method !== "client-response" && req.method !== "HEAD" && isJson(upstream.headers)) { const parsed = parseJson(upstream.body); const filtered = await filterRpcResponse(parsed, decision, { service: this.#service, user, roots: this.#roots }); upstream.body = Buffer.from(JSON.stringify(filtered)); }
    if (req.method === "GET" && url.pathname === "/" && isHtml(upstream.headers)) {
      upstream.body = filterClientPlugins(upstream.body, user.role !== "admin");
      upstream.body = injectRemoteSettings(upstream.body, user.id, user.role === "admin");
      upstream.headers["cache-control"] = "private, no-store";
    }
    writeProxyResponse(res, upstream);
  }

  private async proxyPublicAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: IncomingHttpHeaders = await this.workerHeaders();
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    const pathOverride = pathname === "/favicon.ico" || pathname === "/favicon.svg"
      ? BRAND_FAVICON_PATH
      : pathname === "/manifest.webmanifest" ? BRAND_MANIFEST_PATH : undefined;
    const upstream = await requestUpstream(this.#config.workerBaseUrl, req, undefined, headers, pathOverride);
    writeProxyResponse(res, upstream);
  }

  private async proxyAdmin(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
    if (!trustedOrigin(req, this.#config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
    if (user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    if (!this.#config.adminBaseUrl || !this.#config.adminToken) { sendError(res, 503, "ADMIN_PROXY_NOT_CONFIGURED"); return; }
    const body = hasBody(req) ? await readBody(req, this.#config.requestBodyLimit) : undefined; const upstream = await requestUpstream(this.#config.adminBaseUrl, req, body, { authorization: `Bearer ${this.#config.adminToken}` }); writeProxyResponse(res, upstream);
  }

  private async proxyBilling(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
    if (!trustedOrigin(req, this.#config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
    if (!this.#config.adminBaseUrl || !this.#config.adminToken) { sendError(res, 503, "BILLING_PROXY_NOT_CONFIGURED"); return; }
    if (req.method !== "GET" || new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname !== "/api/billing/usage") {
      sendError(res, 404, "NOT_FOUND");
      return;
    }
    const identities = await this.#service.listIdentities(user.id);
    const billingUserIds = JSON.stringify([user.id, ...identities.map((identity) => identity.subject)]);
    const upstream = await requestUpstream(this.#config.adminBaseUrl, req, undefined, {
      authorization: `Bearer ${this.#config.adminToken}`,
      [AUTHENTICATED_USER_HEADER]: billingUserIds,
    });
    writeProxyResponse(res, upstream);
  }

  /** 用内部凭证换取官方 Connection 签名 Cookie；Cookie 仅保存在 Auth 进程内。 */
  private async workerHeaders(): Promise<IncomingHttpHeaders> {
    if (!this.#config.workerToken) return {};
    this.#workerCookiePromise ??= this.createWorkerCookie().catch((error) => {
      this.#workerCookiePromise = undefined;
      throw error;
    });
    return { cookie: await this.#workerCookiePromise };
  }

  private async createWorkerCookie(): Promise<string> {
    const exchange = await fetch(new URL("/internal/web-auth/session", this.#config.workerBaseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.#config.workerToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await exchange.json() as { url?: unknown };
    if (!exchange.ok || typeof payload.url !== "string") throw new Error("WORKER_AUTH_BRIDGE_UNAVAILABLE");
    const launch = new URL(payload.url);
    const worker = new URL(this.#config.workerBaseUrl);
    if (launch.origin !== worker.origin || launch.pathname !== "/") throw new Error("WORKER_AUTH_BRIDGE_INVALID");
    const response = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0]?.trim();
    if (response.status !== 303 || !cookie || !cookie.includes("=")) throw new Error("WORKER_AUTH_EXCHANGE_FAILED");
    return cookie;
  }

  private async current(req: IncomingMessage): Promise<{ user: AuthUser } | undefined> {
    const current = await this.#service.current(sessionToken(req, this.#config.sessionCookieSecure), metadata(req));
    if (!current) return undefined;
    await mkdir(accessPolicy(current.user, this.#roots).workspaceRoot, { recursive: true });
    return { user: current.user };
  }

  private ensureCsrf(req: IncomingMessage, cookies: string[]): void { if (!readCookie(req.headers.cookie, CSRF_COOKIE)) appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: this.#config.sessionCookieSecure }); }

  /** 服务端会话随 current() 滑动续期；页面加载与身份查询时同步滚动 Cookie Max-Age，保持两侧过期语义一致。 */
  private refreshSessionCookie(req: IncomingMessage, cookies: string[]): void {
    const token = sessionToken(req, this.#config.sessionCookieSecure);
    if (!token) return;
    appendCookie(cookies, sessionCookieName(this.#config.sessionCookieSecure), token, { httpOnly: true, secure: this.#config.sessionCookieSecure, maxAge: Math.floor((this.#config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 1000) });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const sharePrefix = publicSharePrefix(url.pathname);
    if (sharePrefix) {
      if (this.#upgradeTasks.closing || req.method !== "GET" || !this.#config.workerToken) { socket.destroy(); return; }
      const originalOrigin = typeof req.headers.origin === "string" ? { origin: req.headers.origin } : {};
      await proxyUpgrade(this.#config.previewBaseUrl ?? DEFAULT_PREVIEW_URL, req, socket, head, {
        authorization: `Bearer ${this.#config.workerToken}`,
        "x-forwarded-prefix": sharePrefix,
        ...originalOrigin,
      }, { stripResponseHeaders: SHARE_BLOCKED_RESPONSE_HEADERS });
      return;
    }
    const eventSocket = url.pathname === "/api/events.mux" || url.pathname === "/api/events.host" || url.pathname === "/api/remote.mux";
    const sidebarSocket = url.pathname === "/sidebar/ws/terminal"
      || url.pathname === "/sidebar/ws/agent-terminals"
      || url.pathname === "/sidebar/ws/agent-opens";
    if (this.#upgradeTasks.closing || !trustedOrigin(req, this.#config.trustedOrigins) || (!eventSocket && !sidebarSocket)) { socket.destroy(); return; }
    const csrf = csrfToken(req);
    const current = await this.#upgradeTasks.waitFor(this.current(req));
    if (current === UPGRADE_ABORTED || !current) { socket.destroy(); return; }
    const headers = { ...await this.workerHeaders(), ...(csrf ? { "x-csrf-token": csrf } : {}) };
    if (sidebarSocket) {
      const sessionId = url.searchParams.get("sessionId");
      const decision = await this.#upgradeTasks.waitFor(sidebarDecision(this.#service, current.user, sessionId));
      if (decision === UPGRADE_ABORTED || decision.denied || (!sessionId && current.user.role !== "admin")) { socket.destroy(); return; }
      await proxyUpgrade(this.#config.workerBaseUrl, req, socket, head, headers);
      return;
    }
    if (url.pathname === "/api/remote.mux") {
      const policy = await this.#upgradeTasks.waitFor(createUserRemoteMuxPolicy(this.#service, current.user, this.#roots));
      if (policy === UPGRADE_ABORTED) { socket.destroy(); return; }
      const events = this.#remoteEventResults.connection(current.user.id);
      socket.once("close", events.dispose);
      try {
        await proxyUpgrade(this.#config.workerBaseUrl, req, socket, head, headers, {
          filterServerFrames: async (text) => {
            const filtered = await policy.filterServerFrames(text);
            if (filtered !== null) events.server(filtered);
            return filtered;
          },
          observeClientFrames: (text) => { policy.observeClientFrames(text); events.client(text); },
        });
      } finally {
        socket.off("close", events.dispose);
        events.dispose();
      }
      return;
    }
    const pendingFilter = current.user.role === "admin" ? Promise.resolve(undefined) : createUserEventFilter(this.#service, current.user, this.#roots);
    const filter = await this.#upgradeTasks.waitFor(pendingFilter);
    if (filter === UPGRADE_ABORTED) { socket.destroy(); return; }
    await proxyUpgrade(this.#config.workerBaseUrl, req, socket, head, headers, filter ? { filterServerFrames: filter } : undefined);
  }

  private handleError(res: ServerResponse, error: unknown): void {
    const typed = error as { status?: number; code?: string; message?: string };
    if (res.headersSent) { res.destroy(); return; }
    const code = typed.code ?? typed.message;
    const status = typed.status ?? (code === "FEISHU_IDENTITY_CONFLICT" || code === "FEISHU_SESSION_CONFLICT" ? 409 : code === "MAIL_DELIVERY_FAILED" ? 503 : isInputError(code) ? 400 : 500);
    const publicCode = code === "MAIL_DELIVERY_FAILED" ? code : status >= 500 ? "INTERNAL_ERROR" : code ?? "INVALID_REQUEST";
    sendError(res, status, publicCode);
  }
}

function destroyAndWait(socket: Duplex): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  });
}

export function createAuthEdgeServer(options: AuthEdgeServerOptions): AuthEdgeServer { return new AuthEdgeServer(options); }
