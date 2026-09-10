import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";

import { accessPolicy, constantTimeEqual, hashOpaqueToken, isPathWithinReal } from "dsh-lark-auth";
import type { AdminUserPatch, AuthService, AuthUser, UserModelProfileDraft, UserModelProfilePatch } from "dsh-lark-auth";
import { FAVICON_PATH as BRAND_FAVICON_PATH, MANIFEST_PATH as BRAND_MANIFEST_PATH } from "dsh-lark-atw-brand";
import { UrlPolicy } from "dsh-lark-url-policy";

import { DEFAULT_PREVIEW_URL, type AuthEdgeConfig } from "./config.js";
import { appendCookie, CSRF_COOKIE, newCsrfToken, OAUTH_STATE_COOKIE, readCookie, sessionCookieName } from "./cookies.js";
import { exchangeFeishuCode, buildFeishuAuthorizeUrl } from "./feishu.js";
import { csrfToken, httpError, readBody, readJson, sendError, sendHtml, sendJson, sessionToken } from "./http-utils.js";
import { loginPage, messagePage, pairPage, resetPage } from "./login-page.js";
import { csrfValid, proxyCsrfValid, trustedOrigin } from "./origin.js";
import { createUserEventFilter, createUserRemoteMuxPolicy } from "./event-policy.js";
import { authorizeClientResponse, authorizeRpc, filterRpcResponse } from "./rpc-policy.js";
import { proxyUpgrade, requestUpstream, streamUpstream, writeProxyResponse } from "./proxy.js";
import { LoginGuard, RateLimiter } from "./rate-limit.js";
import { UPGRADE_ABORTED, UpgradeTaskTracker } from "./upgrade-tasks.js";
import { promptAuditInput, type PromptAuditor } from "./prompt-audit.js";
import { RemoteEventResults } from "./remote-event-results.js";

const AUTHENTICATED_USER_HEADER = "x-dsh-auth-user-id";
const INTERNAL_MODEL_RESOLVE_PATH = "/internal/models/resolve";
const MODEL_ROUTE_CAPABILITY_TTL_MS = 5 * 60_000;
const MAX_MODEL_ROUTE_CAPABILITIES = 10_000;
const USER_MODEL_URL_POLICY = new UrlPolicy();
const ACCOUNT_STORAGE_KEY = "dsh.auth.account.v1";
const ACCOUNT_SCOPED_STORAGE_KEYS = ["dsh.sessions.current", "dsh.workspace.view.v5", "dsh.conversation.chat"];
const USER_HIDDEN_CLIENT_PLUGINS = new Set([
  "@deepseek-ai/dsh-cordis-client-runner",
  "@deepseek-ai/dsh-client-ui-cordis",
]);
// 第三方聚合包的 remote-web-ui 宿主能力在生产 profile 中已关闭；客户端
// 仍随聚合包注入会不断请求不存在的 /remote/*，因此从 Web manifest 一并移除。
const DISABLED_CLIENT_PLUGINS = new Set(["@linxin666/dsh-web-all"]);
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
  /** Worker 解析私有路由必须同时出示的短期、一次性能力。 */
  readonly #modelRouteCapabilities = new Map<string, ModelRouteCapability>();
  readonly #upgradedSockets = new Set<Duplex>();
  readonly #upgradeTasks = new UpgradeTaskTracker();
  readonly #remoteEventResults = new RemoteEventResults();
  #workerCookiePromise: Promise<string> | undefined;

  constructor(options: AuthEdgeServerOptions) {
    this.#config = options.config;
    this.#service = options.service;
    this.#promptAuditor = options.promptAuditor;
    this.#roots = options.roots ?? { user: options.config.userWorkspaceRoot, admin: options.config.adminWorkspaceRoot };
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
    if (req.method === "POST" && url.pathname === "/internal/pairing/start") { return this.beginPairing(req, res); }
    if (req.method === "POST" && url.pathname === INTERNAL_MODEL_RESOLVE_PATH) { return this.resolveInternalModelRoute(req, res); }
    if (isUnsafe(req) && !mutationAllowed(req, url, this.#config.trustedOrigins)) throw httpError(403, "CSRF_INVALID");
    if (url.pathname.startsWith("/auth/")) { await this.handleAuth(req, res, url); return; }
    if (isPublicAssetRequest(req, url)) { await this.proxyPublicAsset(req, res); return; }
    if (url.pathname === "/admin/") { sendError(res, 404, "NOT_FOUND"); return; }
    if (url.pathname === "/" && req.method === "GET") { await this.handleHome(req, res); return; }
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) { await this.proxyAdmin(req, res, current.user); return; }
    if (isAdminDataPath(url.pathname)) { await this.handleAdminData(req, res, url, current.user); return; }
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
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    await this.proxyWorker(req, res, current.user);
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/auth/account") return this.redirectLegacyAccount(req, res);
    if (req.method === "GET" && url.pathname === "/auth/me") { const current = await this.current(req); if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; } sendJson(res, 200, { user: publicUser(current.user) }); return; }
    if (url.pathname === "/auth/models" && (req.method === "GET" || req.method === "POST")) return this.models(req, res);
    const modelProfileId = userModelProfileId(url.pathname);
    if (modelProfileId && (req.method === "PATCH" || req.method === "DELETE" || (req.method === "POST" && url.pathname.endsWith("/default")))) {
      return this.modelProfile(req, res, modelProfileId, url.pathname.endsWith("/default"));
    }
    if (req.method === "GET" && url.pathname === "/auth/identities") return this.identities(req, res);
    if (req.method === "DELETE" && url.pathname === "/auth/identities") return this.unlinkIdentity(req, res, false);
    if (req.method === "GET" && url.pathname === "/auth/admin/identities") return this.adminIdentities(req, res);
    if (req.method === "DELETE" && url.pathname === "/auth/admin/identities") return this.unlinkIdentity(req, res, true);
    if (req.method === "POST" && url.pathname === "/auth/register") return this.register(req, res);
    if (req.method === "POST" && url.pathname === "/auth/login") return this.login(req, res);
    if (req.method === "POST" && url.pathname === "/auth/logout") return this.logout(req, res);
    if (req.method === "POST" && (url.pathname === "/auth/forgot" || url.pathname === "/auth/password/forgot")) return this.forgot(req, res);
    if (req.method === "GET" && (url.pathname === "/auth/reset" || url.pathname === "/auth/password/reset")) return this.resetPage(res, url.searchParams.get("token"));
    if (req.method === "POST" && (url.pathname === "/auth/reset" || url.pathname === "/auth/password/reset")) return this.reset(req, res);
    if (req.method === "POST" && url.pathname === "/auth/password/change") return this.changePassword(req, res);
    if (req.method === "GET" && url.pathname === "/auth/verify") return this.verifyLink(res);
    if (req.method === "POST" && url.pathname === "/auth/verify") return this.verifyCode(req, res);
    if (req.method === "GET" && url.pathname === "/auth/pair") return this.pair(req, res, url.searchParams.get("token"));
    if (req.method === "POST" && url.pathname === "/auth/pair/login") return this.pairLogin(req, res);
    if (req.method === "POST" && url.pathname === "/auth/pair/register") return this.pairRegister(req, res);
    if (req.method === "POST" && url.pathname === "/auth/pair/confirm") return this.pairConfirm(req, res);
    if (req.method === "GET" && url.pathname === "/auth/feishu/start") return this.feishuStart(req, res, url.searchParams.get("return"));
    if (req.method === "GET" && url.pathname === "/auth/feishu/callback") return this.feishuCallback(req, res, url);
    sendError(res, 404, "NOT_FOUND");
  }

  /** 浏览器侧私有模型 CRUD：用户 ID 一律由会话派生，响应从不含密钥。 */
  private async models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (req.method === "GET") {
      const [profiles, defaultProfileId] = await Promise.all([
        this.#service.listMyModelProfiles(current.user.id),
        this.#service.getMyDefaultModelProfileId(current.user.id),
      ]);
      sendJson(res, 200, { profiles, ...(defaultProfileId ? { defaultProfileId } : {}) });
      return;
    }
    const body = await readJson(req, this.#config.requestBodyLimit);
    const draft = parseUserModelProfileDraft(body);
    await assertPublicUserModelUrl(draft.baseUrl);
    const profile = await this.#service.createMyModelProfile(current.user.id, draft, metadata(req));
    sendJson(res, 201, { profile });
  }

  private async modelProfile(req: IncomingMessage, res: ServerResponse, profileId: string, setDefault: boolean): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (setDefault) {
      const body = await readJson(req, this.#config.requestBodyLimit);
      if (Object.keys(body).length !== 0) throw httpError(400, "INVALID_REQUEST");
      if (!await this.#service.setMyModelDefault(current.user.id, profileId, metadata(req))) { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
    const body = await readJson(req, this.#config.requestBodyLimit);
    if (req.method === "PATCH") {
      const patch = parseUserModelProfilePatch(body);
      if (patch.baseUrl !== undefined) await assertPublicUserModelUrl(patch.baseUrl);
      const result = await this.#service.updateMyModelProfile(current.user.id, profileId, patch, metadata(req));
      if (result.status === "not-found") { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
      if (result.status === "conflict") { sendError(res, 409, "MODEL_PROFILE_CONFLICT"); return; }
      sendJson(res, 200, { profile: result.profile });
      return;
    }
    const result = await this.#service.deleteMyModelProfile(current.user.id, profileId, parseUserModelProfileRevision(body), metadata(req));
    if (result === "not-found") { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
    if (result === "conflict") { sendError(res, 409, "MODEL_PROFILE_CONFLICT"); return; }
    sendJson(res, 200, { ok: true });
  }

  /**
   * Worker 仅能经 loopback + WORKER_TOKEN 换取一条短生命周期路由。此接口不
   * 接受浏览器 Cookie，且 scope 中的无密钥 routeRef 与当前 Profile 版本必须一致。
   */
  private async resolveInternalModelRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = this.#config.workerToken;
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!isLoopbackAddress(req.socket.remoteAddress)) { sendError(res, 403, "LOOPBACK_REQUIRED"); return; }
    if (!token) { sendError(res, 503, "MODEL_ROUTE_NOT_CONFIGURED"); return; }
    if (!authorization.startsWith("Bearer ") || !constantTimeEqual(authorization.slice(7), token)) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const input = parseInternalModelRouteRequest(await readJson(req, this.#config.requestBodyLimit));
    const capability = this.consumeModelRouteCapability(input);
    if (!capability) { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    const route = await this.#service.resolveMyModelRoute(capability.userId, input.profileId, input.revision, input.model);
    if (!route) { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    // 每次实际出站前重新解析，不能只依赖保存配置时的 DNS 结果。
    try { await assertPublicUserModelUrl(route.baseUrl); } catch { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    // 此响应仅送往 Worker loopback；不写审计/日志，调用方必须在 stream 结束后释放。
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, { route });
  }

  private issueModelRouteCapability(input: Omit<ModelRouteCapability, "expiresAt">): string {
    this.pruneModelRouteCapabilities();
    while (this.#modelRouteCapabilities.size >= MAX_MODEL_ROUTE_CAPABILITIES) {
      const oldest = this.#modelRouteCapabilities.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#modelRouteCapabilities.delete(oldest);
    }
    const capability = randomBytes(32).toString("base64url");
    this.#modelRouteCapabilities.set(capability, { ...input, expiresAt: Date.now() + MODEL_ROUTE_CAPABILITY_TTL_MS });
    return capability;
  }

  private consumeModelRouteCapability(input: InternalModelRouteRequest): ModelRouteCapability | undefined {
    this.pruneModelRouteCapabilities();
    const hit = this.#modelRouteCapabilities.get(input.capability);
    if (!hit || hit.expiresAt < Date.now()
      || hit.sessionId !== input.sessionId || hit.rpcId !== input.rpcId
      || hit.profileId !== input.profileId || hit.revision !== input.revision || hit.model !== input.model) return undefined;
    // 首次解析后立即消费；工具续轮由同一 Worker stream 保持临时路由，绝不再取 Key。
    this.#modelRouteCapabilities.delete(input.capability);
    return hit;
  }

  private pruneModelRouteCapabilities(now = Date.now()): void {
    for (const [capability, entry] of this.#modelRouteCapabilities) if (entry.expiresAt < now) this.#modelRouteCapabilities.delete(capability);
  }

  private async identities(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const identities = await this.#service.listIdentities(current.user.id);
    sendJson(res, 200, { identities: identities.map(publicIdentity) });
  }

  private async adminIdentities(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (current.user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    const identities = await this.#service.listIdentityOwners();
    sendJson(res, 200, { identities: identities.map(({ identity, user }) => ({ ...publicIdentity(identity), user: publicUser(user) })) });
  }

  private async unlinkIdentity(req: IncomingMessage, res: ServerResponse, admin: boolean): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (admin && current.user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    const body = await readJson(req, this.#config.requestBodyLimit);
    const input = parseIdentityRequest(body, admin);
    const userId = input.userId ?? current.user.id;
    const result = await this.#service.unlinkIdentity(userId, input.provider, input.subject, metadata(req));
    if (result.status === "last-login-method") { sendError(res, 409, "IDENTITY_LAST_LOGIN_METHOD"); return; }
    if (result.status === "not-found") { sendError(res, 404, "IDENTITY_NOT_FOUND"); return; }
    sendJson(res, 200, { ok: true, identity: publicIdentity(result.identity) });
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#generalLimiter.allow(`register:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, this.#config.requestBodyLimit);
    await this.#service.register(string(body.email), string(body.password), string(body.displayName), metadata(req));
    sendJson(res, 202, { accepted: true });
  }

  private async beginPairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const configured = this.#config.pairingToken;
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!isLoopbackAddress(req.socket.remoteAddress)) { sendError(res, 403, "LOOPBACK_REQUIRED"); return; }
    if (!configured) { sendError(res, 503, "PAIRING_NOT_CONFIGURED"); return; }
    if (!authorization.startsWith("Bearer ") || !constantTimeEqual(authorization.slice(7), configured)) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, this.#config.requestBodyLimit);
    if (Object.keys(body).some((key) => key !== "openId" && key !== "sessionId") || !Object.hasOwn(body, "openId") || typeof body.openId !== "string") {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (Object.hasOwn(body, "sessionId") && typeof body.sessionId !== "string") {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    let token: string;
    try {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      token = await this.#service.beginFeishuPairing(string(body.openId), metadata(req), sessionId);
    } catch (error) {
      if (error instanceof Error && (error.message === "INVALID_FEISHU_OPEN_ID" || error.message === "INVALID_FEISHU_SESSION_ID")) {
        sendError(res, 400, "INVALID_REQUEST");
        return;
      }
      throw error;
    }
    const pairingUrl = new URL("/auth/pair", this.#config.publicOrigin);
    pairingUrl.searchParams.set("token", token);
    const owner = await this.#service.findIdentityOwner("feishu", string(body.openId));
    sendJson(res, 201, {
      url: pairingUrl.toString(),
      binding: owner
        ? { status: "bound", displayName: owner.user.displayName, email: maskEmail(owner.user.email) }
        : { status: "unbound" },
    });
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, this.#config.requestBodyLimit);
    const key = loginKey(req, string(body.email));
    if (!this.#loginLimiter.allow(`login:${clientKey(req)}`) || !this.#loginGuard.allow(key)) throw httpError(429, "RATE_LIMITED");
    const result = await this.#service.login(string(body.email), string(body.password), metadata(req));
    if (!result) { this.#loginGuard.failure(key); sendError(res, 401, "INVALID_CREDENTIALS"); return; }
    this.#loginGuard.success(key);
    sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(this.#config, result.token));
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.#service.logout(sessionToken(req, this.#config.sessionCookieSecure), metadata(req));
    const cookies: string[] = []; appendCookie(cookies, sessionCookieName(this.#config.sessionCookieSecure), "", { httpOnly: true, secure: this.#config.sessionCookieSecure, maxAge: 0 }); sendJson(res, 200, { ok: true }, cookies);
  }

  private async forgot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#generalLimiter.allow(`forgot:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, this.#config.requestBodyLimit); await this.#service.forgotPassword(string(body.email), metadata(req)); sendJson(res, 202, { accepted: true });
  }

  private async reset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, this.#config.requestBodyLimit); const result = await this.#service.resetPassword(string(body.token), string(body.password), metadata(req));
    if (!result) { sendError(res, 400, "RESET_TOKEN_INVALID"); return; } sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(this.#config, result.token));
  }

  private async changePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req); if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, this.#config.requestBodyLimit); const ok = await this.#service.changePassword(current.user.id, string(body.oldPassword), string(body.newPassword), metadata(req));
    if (!ok) { sendError(res, 400, "PASSWORD_INVALID"); return; } sendJson(res, 200, { ok: true });
  }

  private redirectLegacyAccount(req: IncomingMessage, res: ServerResponse): void {
    const cookies: string[] = [];
    this.ensureCsrf(req, cookies);
    res.writeHead(302, { location: "/", "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
    res.end();
  }

  private verifyLink(res: ServerResponse): void {
    const page = messagePage("验证邮箱", "请返回注册页面，输入邮件中的 6 位验证码。", 400);
    sendHtml(res, page.status, page.html);
  }

  private async verifyCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#generalLimiter.allow(`verify:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, this.#config.requestBodyLimit);
    const pairingToken = string(body.pairingToken) || undefined;
    const result = await this.#service.verifyEmailCode(string(body.email), string(body.code), metadata(req), pairingToken);
    if (!result) { sendError(res, 400, "VERIFICATION_CODE_INVALID"); return; }
    sendJson(res, 200, { user: publicUser(result.user), pairingBound: Boolean(result.pairingBound) }, sessionCookies(this.#config, result.token));
  }

  private async pair(req: IncomingMessage, res: ServerResponse, token: string | null): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const switchAccount = url.searchParams.get("switch") === "1";
    const current = await this.current(req);
    const pairing = token ? await this.#service.peekFeishuPairing(token) : undefined;
    if (!pairing || !token) { const page = messagePage("配对失败", "配对链接无效或已过期，请回到飞书重新发送 `/login`。", 400); sendHtml(res, page.status, page.html); return; }
    const cookies: string[] = [];
    this.ensureCsrf(req, cookies);
    const currentUser = current && !switchAccount ? { email: current.user.email, displayName: current.user.displayName } : undefined;
    sendHtml(res, 200, pairPage(token, currentUser, switchAccount), cookies);
  }

  private async pairLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#generalLimiter.allow(`pair-login:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, this.#config.requestBodyLimit);
    const token = string(body.token);
    if (!await this.#service.peekFeishuPairing(token)) { sendError(res, 400, "PAIRING_INVALID"); return; }
    try {
      const result = await this.#service.loginAndPair(string(body.email), string(body.password), token, metadata(req));
      if (!result) { sendError(res, 401, "INVALID_CREDENTIALS"); return; }
      sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(this.#config, result.token));
    } catch (error) {
      this.sendPairingError(res, error);
    }
  }

  private async pairRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#generalLimiter.allow(`pair-register:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, this.#config.requestBodyLimit);
    const token = string(body.token);
    if (!await this.#service.peekFeishuPairing(token)) { sendError(res, 400, "PAIRING_INVALID"); return; }
    const result = await this.#service.register(string(body.email), string(body.password), string(body.displayName), metadata(req), { pairingToken: token });
    if (result.duplicate && !result.resent) { sendError(res, 409, "ACCOUNT_EXISTS"); return; }
    sendJson(res, 202, { accepted: true });
  }

  private async pairConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, this.#config.requestBodyLimit);
    const token = string(body.token);
    try {
      const result = await this.#service.completeFeishuPairing(token, current.user.id, metadata(req));
      if (!result) { sendError(res, 400, "PAIRING_INVALID"); return; }
      sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(this.#config, result.token));
    } catch (error) {
      this.sendPairingError(res, error);
    }
  }

  private sendPairingError(res: ServerResponse, error: unknown): void {
    if (error instanceof Error && error.message === "FEISHU_IDENTITY_CONFLICT") { sendError(res, 409, "FEISHU_IDENTITY_CONFLICT"); return; }
    if (error instanceof Error && error.message === "FEISHU_SESSION_CONFLICT") { sendError(res, 409, "FEISHU_SESSION_CONFLICT"); return; }
    throw error;
  }

  private async resetPage(res: ServerResponse, token: string | null): Promise<void> {
    if (!token) { const page = messagePage("重置密码", "重置链接缺少 token。", 400); sendHtml(res, page.status, page.html); return; }
    const cookies: string[] = []; appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: this.#config.sessionCookieSecure });
    sendHtml(res, 200, resetPage(token), cookies);
  }

  private async feishuStart(req: IncomingMessage, res: ServerResponse, returnPath: string | null): Promise<void> {
    if (!this.#config.feishu) { sendError(res, 503, "FEISHU_OAUTH_NOT_CONFIGURED"); return; }
    const current = await this.current(req); const state = await this.#service.beginOAuth(current?.user.id, returnPath ?? "/");
    const cookies: string[] = [];
    appendCookie(cookies, OAUTH_STATE_COOKIE, state.state, { httpOnly: true, secure: this.#config.sessionCookieSecure, maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS });
    res.writeHead(302, { location: buildFeishuAuthorizeUrl(this.#config.feishu, state.state), "set-cookie": cookies, "cache-control": "no-store" }); res.end();
  }

  private async feishuCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#config.feishu) { sendError(res, 503, "FEISHU_OAUTH_NOT_CONFIGURED"); return; }
    res.setHeader("set-cookie", clearOAuthStateCookie(this.#config));
    const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
    const expectedState = readCookie(req.headers.cookie, OAUTH_STATE_COOKIE);
    if (!code || !state || !expectedState || !constantTimeEqual(expectedState, state)) { sendError(res, 400, "OAUTH_INVALID"); return; }
    const profile = await exchangeFeishuCode(this.#config.feishu, code); const result = await this.#service.completeFeishu(state, profile, metadata(req));
    if (!result) { const page = messagePage("飞书登录失败", "授权无效或已过期。", 400); sendHtml(res, page.status, page.html); return; }
    res.writeHead(302, { location: result.returnPath, "set-cookie": [...sessionCookies(this.#config, result.token), ...clearOAuthStateCookie(this.#config)], "cache-control": "no-store" }); res.end();
  }

  private async proxyWorker(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
    if (!trustedOrigin(req, this.#config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
    let body: Buffer | undefined; let decision;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (isSidebarRequest(url.pathname)) {
      const sidebar = await this.authorizeSidebarRequest(req, url, user);
      if (sidebar.denied) { sendError(res, 403, sidebar.denied); return; }
      body = sidebar.body;
    }
    if (url.pathname.startsWith("/git/")) {
      const git = await this.authorizeGitRequest(req, url, user);
      if (git.denied) { sendError(res, 403, git.denied); return; }
      body = git.body;
    }
    const endpoint = apiEndpoint(url.pathname);
    if (endpoint === "$events/result") {
      if (req.method !== "POST" || !isJsonHeader(req.headers["content-type"])) { sendError(res, 400, "INVALID_RPC"); return; }
      body = await readBody(req, this.#config.requestBodyLimit);
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
      body = await readBody(req, this.#config.requestBodyLimit); const parsed = parseJson(body); decision = authorizeClientResponse(parsed); if (decision.denied) { sendError(res, 403, decision.denied); return; } body = Buffer.from(JSON.stringify(decision.body));
    } else if (endpoint === "session.export" && (req.method === "GET" || req.method === "HEAD")) {
      decision = await authorizeRpc({ method: "session.export", payload: { sessionId: url.searchParams.get("sessionId") ?? "" } }, { service: this.#service, user, roots: this.#roots }); if (decision.denied) { sendError(res, 403, decision.denied); return; }
    } else if (isWebUiSettingsBridge(endpoint) && req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#config.requestBodyLimit);
      const parsed = parseJson(body);
      if (endpoint === "dsh-web-ui-settings/mutate" && user.role !== "admin") { sendError(res, 403, "CAPABILITY_NOT_ALLOWED"); return; }
      decision = {
        body: parsed,
        method: endpoint.replace("/", "."),
        args: parsed,
      };
    } else if (endpoint && !endpoint.startsWith("events.") && req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#config.requestBodyLimit); const parsed = parseJson(body); decision = await authorizeRpc(parsed, { service: this.#service, user, roots: this.#roots }, endpoint); if (decision.denied) { sendError(res, 403, decision.denied); return; } body = Buffer.from(JSON.stringify(decision.body));
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
        ? { mode: "private" as const, ...routeRef, capability: this.issueModelRouteCapability({ userId: user.id, sessionId, rpcId, ...routeRef }) }
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
      await this.bindWorkerScope(binding);
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

  private async authorizeSidebarRequest(req: IncomingMessage, url: URL, user: AuthUser): Promise<{ body?: Buffer; denied?: string }> {
    if (url.pathname.startsWith("/sidebar/bundle")) return {};
    if (url.pathname.startsWith("/sidebar/file")) return this.sidebarDecision(user, url.searchParams.get("sessionId"));
    if (url.pathname.startsWith("/sidebar/html")) return this.sidebarDecision(user, sidebarHtmlSessionId(url.pathname));
    if (!url.pathname.startsWith("/sidebar/api/")) return {};
    if (req.method !== "POST") return { denied: "CAPABILITY_NOT_ALLOWED" };
    const method = url.pathname.slice("/sidebar/api/".length);
    const body = await readBody(req, this.#config.requestBodyLimit);
    const parsed = parseJson(body);
    if (SIDEBAR_PUBLIC_METHODS.has(method)) return { body };
    // `subagents.live` uses the topology root name rather than the generic
    // sessionId field. It still must be fenced to the same owning session.
    const sessionId = typeof parsed.sessionId === "string"
      ? parsed.sessionId
      : method === "subagents.live" && typeof parsed.rootSessionId === "string"
        ? parsed.rootSessionId
        : undefined;
    const decision = await this.sidebarDecision(user, sessionId);
    return decision.denied ? decision : { body };
  }

  private async authorizeGitRequest(req: IncomingMessage, url: URL, user: AuthUser): Promise<{ body?: Buffer; denied?: string }> {
    if (req.method === "POST" && url.pathname === "/git/config") {
      return { body: await readBody(req, this.#config.requestBodyLimit) };
    }
    let body: Buffer | undefined;
    let path: string | null = null;
    if (req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
      body = await readBody(req, this.#config.requestBodyLimit);
      const parsed = parseJson(body);
      path = typeof parsed.path === "string" ? parsed.path : null;
    } else if (req.method === "GET" && url.pathname === "/git/events") {
      path = url.searchParams.get("path");
    }
    const forwarded = body ? { body } : {};
    if (!path) return { ...forwarded, denied: "RESOURCE_NOT_ALLOWED" };
    if (user.role === "admin") return forwarded;
    const workspaces = await this.#service.listResources(user.id, "workspace");
    for (const workspace of workspaces) {
      const ownedPath = workspace.resourcePath;
      if (!ownedPath) continue;
      if (await isPathWithinReal(ownedPath, path) && await isPathWithinReal(path, ownedPath)) return forwarded;
    }
    return { ...forwarded, denied: "RESOURCE_NOT_ALLOWED" };
  }

  private async sidebarDecision(user: AuthUser, sessionId: string | null | undefined): Promise<{ denied?: string }> {
    if (!sessionId || user.role === "admin") return user.role === "admin" ? {} : { denied: "RESOURCE_NOT_ALLOWED" };
    const resource = await this.#service.findResource("session", sessionId);
    return resource?.userId === user.id ? {} : { denied: "RESOURCE_NOT_ALLOWED" };
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

  private async handleAdminData(req: IncomingMessage, res: ServerResponse, url: URL, user: AuthUser): Promise<void> {
    if (!trustedOrigin(req, this.#config.trustedOrigins)) { sendError(res, 403, "ORIGIN_NOT_ALLOWED"); return; }
    if (user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/admin/users") {
      sendJson(res, 200, { users: await this.#service.listAdminUsers() });
      return;
    }
    if (req.method === "GET" && path === "/api/admin/sessions") {
      sendJson(res, 200, { sessions: await this.#service.listAdminSessions() });
      return;
    }
    if (req.method === "GET" && path === "/api/admin/summary") {
      await this.sendAdminSummary(res);
      return;
    }
    const userMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === "PATCH" && userMatch) {
      await this.updateAdminUser(req, res, userMatch[1]!);
      return;
    }
    const userSessionsMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/sessions\/revoke$/.exec(path);
    if (req.method === "POST" && userSessionsMatch) {
      const result = await this.#service.revokeAdminUserSessions(userSessionsMatch[1]!, metadata(req));
      if (!result) { sendError(res, 404, "USER_NOT_FOUND"); return; }
      sendJson(res, 200, result);
      return;
    }
    const sessionMatch = /^\/api\/admin\/sessions\/([0-9a-f-]{36})\/revoke$/.exec(path);
    if (req.method === "POST" && sessionMatch) {
      const session = await this.#service.revokeAdminSession(sessionMatch[1]!, metadata(req));
      if (!session) { sendError(res, 404, "SESSION_NOT_FOUND"); return; }
      sendJson(res, 200, { session });
      return;
    }
    sendError(res, 404, "NOT_FOUND");
  }

  private async updateAdminUser(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    const patch = parseAdminUserPatch(await readJson(req, this.#config.requestBodyLimit));
    const result = await this.#service.updateUserForAdmin(userId, patch, metadata(req));
    if (result.status === "not-found") { sendError(res, 404, "USER_NOT_FOUND"); return; }
    if (result.status === "last-admin") { sendError(res, 409, "LAST_ADMIN_REQUIRED"); return; }
    if (result.status === "mode-not-allowed") { sendError(res, 400, "MODE_NOT_ALLOWED"); return; }
    const user = (await this.#service.listAdminUsers()).find((item) => item.id === result.user.id);
    if (!user) { sendError(res, 404, "USER_NOT_FOUND"); return; }
    sendJson(res, 200, { user });
  }

  private async sendAdminSummary(res: ServerResponse): Promise<void> {
    const [users, sessions] = await Promise.all([this.#service.listAdminUsers(), this.#service.listAdminSessions()]);
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

  private async bindWorkerScope(binding: unknown): Promise<void> {
    if (!this.#config.workerToken) throw new Error("WORKER_AUTH_BRIDGE_UNAVAILABLE");
    const response = await fetch(new URL("/internal/web-auth/scope", this.#config.workerBaseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.#config.workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(binding),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("WORKER_SCOPE_BRIDGE_UNAVAILABLE");
  }

  private async current(req: IncomingMessage): Promise<{ user: AuthUser } | undefined> {
    const current = await this.#service.current(sessionToken(req, this.#config.sessionCookieSecure), metadata(req));
    if (!current) return undefined;
    await mkdir(accessPolicy(current.user, this.#roots).workspaceRoot, { recursive: true });
    return { user: current.user };
  }

  private ensureCsrf(req: IncomingMessage, cookies: string[]): void { if (!readCookie(req.headers.cookie, CSRF_COOKIE)) appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: this.#config.sessionCookieSecure }); }

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
      const decision = await this.#upgradeTasks.waitFor(this.sidebarDecision(current.user, sessionId));
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

function sendRpcFailure(res: ServerResponse, request: Record<string, unknown>, error: { code: string; message: string }): void {
  const rpcId = typeof request.rpcId === "string" ? request.rpcId : "";
  sendJson(res, 200, {
    type: "server-response",
    rpcId,
    result: { ok: false, error: { ...error, details: {} } },
  });
}

export function createAuthEdgeServer(options: AuthEdgeServerOptions): AuthEdgeServer { return new AuthEdgeServer(options); }

function sessionCookies(config: AuthEdgeConfig, token: string): string[] { const cookies: string[] = []; appendCookie(cookies, sessionCookieName(config.sessionCookieSecure), token, { httpOnly: true, secure: config.sessionCookieSecure }); appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: config.sessionCookieSecure }); return cookies; }
function clearOAuthStateCookie(config: AuthEdgeConfig): string[] { const cookies: string[] = []; appendCookie(cookies, OAUTH_STATE_COOKIE, "", { httpOnly: true, secure: config.sessionCookieSecure, maxAge: 0 }); return cookies; }
function publicUser(user: AuthUser): Record<string, unknown> { return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, defaultMode: user.defaultMode }; }
function publicIdentity(identity: { provider: "feishu"; subject: string; unionId: string | null; createdAt: string }): Record<string, unknown> {
  return { provider: identity.provider, subject: identity.subject, unionId: identity.unionId, createdAt: identity.createdAt };
}
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "****";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 4);
  return `${visible}${"*".repeat(Math.max(4, local.length - visible.length))}@${domain}`;
}
function metadata(req: IncomingMessage) {
  const result: { requestId: string; ip?: string; userAgent?: string } = { requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 128) : "edge" };
  if (req.socket.remoteAddress) result.ip = req.socket.remoteAddress.slice(0, 128);
  if (typeof req.headers["user-agent"] === "string") result.userAgent = req.headers["user-agent"].slice(0, 512);
  return result;
}
function clientKey(req: IncomingMessage): string { return req.socket.remoteAddress || "unknown"; }
function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
function loginKey(req: IncomingMessage, email: string): string { return `${clientKey(req)}:${hashOpaqueToken(email.trim().toLocaleLowerCase("en-US"))}`; }
function isUnsafe(req: IncomingMessage): boolean { return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"; }
function mutationAllowed(req: IncomingMessage, url: URL, origins: readonly string[]): boolean {
  if (url.pathname.startsWith("/auth/")) return csrfValid(req, csrfToken(req), origins);
  return proxyCsrfValid(req, csrfToken(req), origins);
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function userModelProfileId(pathname: string): string | undefined {
  const match = /^\/auth\/models\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/default)?$/iu.exec(pathname);
  return match?.[1]?.toLowerCase();
}
function parseUserModelProfileDraft(body: Record<string, unknown>): UserModelProfileDraft {
  requireOnlyKeys(body, ["displayName", "baseUrl", "modelIds", "defaultModel", "apiKey"]);
  if (typeof body.displayName !== "string" || typeof body.baseUrl !== "string" || !Array.isArray(body.modelIds)
    || body.modelIds.some((model) => typeof model !== "string") || typeof body.defaultModel !== "string" || typeof body.apiKey !== "string") {
    throw httpError(400, "INVALID_REQUEST");
  }
  return { displayName: body.displayName, baseUrl: body.baseUrl, modelIds: [...body.modelIds] as string[], defaultModel: body.defaultModel, apiKey: body.apiKey };
}
function parseUserModelProfilePatch(body: Record<string, unknown>): UserModelProfilePatch {
  requireOnlyKeys(body, ["expectedRevision", "displayName", "baseUrl", "modelIds", "defaultModel", "apiKey"]);
  const expectedRevision = parsePositiveInteger(body.expectedRevision);
  if (Object.keys(body).length === 1) throw httpError(400, "INVALID_REQUEST");
  if (body.displayName !== undefined && typeof body.displayName !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.baseUrl !== undefined && typeof body.baseUrl !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.modelIds !== undefined && (!Array.isArray(body.modelIds) || body.modelIds.some((model) => typeof model !== "string"))) throw httpError(400, "INVALID_REQUEST");
  if (body.defaultModel !== undefined && typeof body.defaultModel !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw httpError(400, "INVALID_REQUEST");
  return {
    expectedRevision,
    ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
    ...(Array.isArray(body.modelIds) ? { modelIds: [...body.modelIds] as string[] } : {}),
    ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
    ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
  };
}
function parseUserModelProfileRevision(body: Record<string, unknown>): number {
  requireOnlyKeys(body, ["expectedRevision"]);
  return parsePositiveInteger(body.expectedRevision);
}
interface ModelRouteCapability {
  userId: string;
  sessionId: string;
  rpcId: string;
  profileId: string;
  revision: number;
  model: string;
  expiresAt: number;
}

interface InternalModelRouteRequest {
  sessionId: string;
  rpcId: string;
  capability: string;
  profileId: string;
  revision: number;
  model: string;
}

function parseInternalModelRouteRequest(body: Record<string, unknown>): InternalModelRouteRequest {
  requireOnlyKeys(body, ["sessionId", "rpcId", "capability", "profileId", "revision", "model"]);
  if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256
    || typeof body.rpcId !== "string" || !body.rpcId || body.rpcId.length > 256
    || typeof body.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.capability)
    || typeof body.profileId !== "string" || !userModelProfileId(`/auth/models/${body.profileId}`)
    || typeof body.model !== "string" || !body.model || body.model.length > 256) {
    throw httpError(400, "INVALID_REQUEST");
  }
  return {
    sessionId: body.sessionId,
    rpcId: body.rpcId,
    capability: body.capability,
    profileId: body.profileId.toLowerCase(),
    revision: parsePositiveInteger(body.revision),
    model: body.model,
  };
}
function parsePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw httpError(400, "INVALID_REQUEST");
  return value;
}
async function assertPublicUserModelUrl(value: string): Promise<void> {
  try {
    const url = await USER_MODEL_URL_POLICY.assertAllowed(value, true);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw httpError(400, "INVALID_USER_MODEL_BASE_URL");
  }
}
function requireOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw httpError(400, "INVALID_REQUEST");
}
function parseIdentityRequest(body: Record<string, unknown>, admin: boolean): { provider: "feishu"; subject: string; userId?: string } {
  const allowed = admin ? ["provider", "subject", "userId"] : ["provider", "subject"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || (admin && !Object.hasOwn(body, "userId"))) throw httpError(400, "INVALID_REQUEST");
  if (body.provider !== "feishu" || typeof body.subject !== "string" || !body.subject.trim()) throw httpError(400, "INVALID_REQUEST");
  if (admin && (typeof body.userId !== "string" || !body.userId.trim())) throw httpError(400, "INVALID_REQUEST");
  return { provider: "feishu", subject: body.subject, ...(admin ? { userId: body.userId as string } : {}) };
}
function parseJson(body: Buffer): Record<string, unknown> { const value: unknown = JSON.parse(body.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "INVALID_REQUEST"); return value as Record<string, unknown>; }
function isJson(headers: Record<string, unknown>): boolean { const contentType = headers["content-type"]; return typeof contentType === "string" && contentType.includes("application/json"); }
function isJsonHeader(contentType: string | string[] | undefined): boolean { return typeof contentType === "string" && contentType.toLowerCase().includes("application/json"); }
function isHtml(headers: IncomingHttpHeaders): boolean {
  const contentType = headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}
function injectRemoteSettings(body: Buffer, userId: string, admin: boolean): Buffer {
  const html = body.toString("utf8");
  const marker = "</head>";
  const account = JSON.stringify(userId).replace(/</gu, "\\u003c");
  const keys = JSON.stringify(ACCOUNT_SCOPED_STORAGE_KEYS);
  // DSH 的会话选择存储是浏览器级键；账号切换时必须先清除旧账号的
  // 会话/工作区状态，避免客户端在权限列表加载前请求旧 sessionId。
  const flags = admin ? "{remoteSettings:true,remoteAdminSettings:true}" : "{remoteSettings:true}";
  const script = `<script>(()=>{const k=${JSON.stringify(ACCOUNT_STORAGE_KEY)},u=${account};try{if(localStorage.getItem(k)!==u){for(const x of ${keys})localStorage.removeItem(x);localStorage.setItem(k,u)}}catch{}globalThis.__DSH_AUTH_EDGE__=${flags};})()</script>`;
  const injected = html.includes(marker) ? html.replace(marker, `${script}${marker}`) : `${script}${html}`;
  return Buffer.from(injected, "utf8");
}
function apiEndpoint(pathname: string): string | undefined { return pathname.startsWith("/api/") ? decodeURIComponent(pathname.slice("/api/".length)) : undefined; }
function isWebUiSettingsBridge(endpoint: string | undefined): endpoint is "dsh-web-ui-settings/describe" | "dsh-web-ui-settings/mutate" {
  return endpoint === "dsh-web-ui-settings/describe" || endpoint === "dsh-web-ui-settings/mutate";
}
function hasBody(req: IncomingMessage): boolean { return req.method === "POST" || req.method === "PUT" || req.method === "PATCH"; }
function isAdminDataPath(pathname: string): boolean {
  return pathname === "/api/admin/summary"
    || pathname === "/api/admin/users"
    || pathname.startsWith("/api/admin/users/")
    || pathname === "/api/admin/sessions"
    || pathname.startsWith("/api/admin/sessions/");
}
function parseAdminUserPatch(body: Record<string, unknown>): AdminUserPatch {
  const allowed = ["role", "status", "defaultMode"];
  if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) throw httpError(400, "INVALID_REQUEST");
  if (body.role !== undefined && body.role !== "admin" && body.role !== "user") throw httpError(400, "INVALID_REQUEST");
  if (body.status !== undefined && body.status !== "active" && body.status !== "disabled") throw httpError(400, "INVALID_REQUEST");
  if (body.defaultMode !== undefined && body.defaultMode !== "full" && body.defaultMode !== "lightweight") throw httpError(400, "INVALID_REQUEST");
  const role: AdminUserPatch["role"] = body.role === "admin" || body.role === "user" ? body.role : undefined;
  const status: AdminUserPatch["status"] = body.status === "active" || body.status === "disabled" ? body.status : undefined;
  const defaultMode: AdminUserPatch["defaultMode"] = body.defaultMode === "full" || body.defaultMode === "lightweight" ? body.defaultMode : undefined;
  return {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(defaultMode ? { defaultMode } : {}),
  };
}
const SIDEBAR_PUBLIC_METHODS = new Set(["terminal.deps", "shell.get", "settings.get", "settings.update", "browser.probe"]);
function isSidebarRequest(pathname: string): boolean { return pathname === "/sidebar" || pathname.startsWith("/sidebar/"); }
function sidebarHtmlSessionId(pathname: string): string | undefined {
  if (!pathname.startsWith("/sidebar/html/")) return undefined;
  const value = pathname.slice("/sidebar/html/".length).split("/", 1)[0];
  try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
}
function isPublicAssetRequest(req: IncomingMessage, url: URL): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/plugins/");
}
function publicSharePrefix(pathname: string): string | undefined {
  const match = /^\/share\/([^/]+)(?:\/|$)/u.exec(pathname);
  return match ? `/share/${match[1]}` : undefined;
}
function isInputError(code: unknown): boolean { return code === "INVALID_EMAIL" || code === "INVALID_PASSWORD" || code === "INVALID_VERIFICATION_CODE" || code === "INVALID_REQUEST" || code === "RESET_TOKEN_INVALID" || code === "OAUTH_INVALID" || code === "INVALID_FEISHU_OPEN_ID" || code === "INVALID_FEISHU_SESSION_ID" || code === "PAIRING_INVALID" || (typeof code === "string" && code.startsWith("INVALID_USER_MODEL_")); }
function applySecurityHeaders(res: ServerResponse, requestUrl: string | undefined): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  const pathname = new URL(requestUrl ?? "/", "http://localhost").pathname;
  res.setHeader("x-frame-options", pathname.startsWith("/sidebar/html/") ? "SAMEORIGIN" : "DENY");
}

function filterClientPlugins(body: Buffer, hideUserPlugins: boolean): Buffer {
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

function destroyAndWait(socket: Duplex): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  });
}

const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
