import type { IncomingMessage, ServerResponse } from "node:http";

import { constantTimeEqual } from "dsh-lark-auth";
import type { AuthService, AuthUser } from "dsh-lark-auth";

import type { AuthEdgeConfig } from "./config.js";
import { appendCookie, CSRF_COOKIE, newCsrfToken, OAUTH_STATE_COOKIE, readCookie, sessionCookieName } from "./cookies.js";
import { desktopInference, type DesktopSharedRuntime } from "./desktop-inference.js";
import { buildFeishuAuthorizeUrl, exchangeFeishuCode } from "./feishu.js";
import { handleBotAccount } from "./feishu-bots.js";
import { httpError, readJson, sendError, sendHtml, sendJson, sessionToken } from "./http-utils.js";
import { messagePage, pairPage, resetPage } from "./login-page.js";
import type { PromptAuditor } from "./prompt-audit.js";
import type { LoginGuard, RateLimiter } from "./rate-limit.js";
import {
  assertPublicUserModelUrl,
  publicModelDispatcher,
  clearOAuthStateCookie,
  clientKey,
  isLoopbackAddress,
  loginKey,
  maskEmail,
  metadata,
  OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  parseIdentityRequest,
  parseUserModelProfileDraft,
  parseUserModelProfilePatch,
  parseUserModelProfileRevision,
  publicIdentity,
  publicUser,
  sessionCookies,
  string,
  userModelProfileId,
} from "./server-helpers.js";

export interface AuthRouteDeps {
  config: AuthEdgeConfig;
  service: AuthService;
  loginLimiter: RateLimiter;
  loginGuard: LoginGuard;
  generalLimiter: RateLimiter;
  promptAuditor?: PromptAuditor | undefined;
  /** 部署侧共享模型目录（apps/auth 装配）；未装配时 `shared/*` 选择器 404。 */
  sharedModels?: DesktopSharedRuntime | undefined;
  current(req: IncomingMessage): Promise<{ user: AuthUser } | undefined>;
  ensureCsrf(req: IncomingMessage, cookies: string[]): void;
  refreshSessionCookie(req: IncomingMessage, cookies: string[]): void;
}

/** `/auth/*` 端点子树与 loopback 配对端点；凭据签发全部落在本模块。 */
export class AuthRouteHandlers {
  constructor(private readonly deps: AuthRouteDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { config, service } = this.deps;
    if (["/auth/feishu-bot", "/auth/feishu-bot/test", "/auth/feishu-bot/connection"].includes(url.pathname)) {
      const current = await this.deps.current(req);
      if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
      if (req.method !== "GET" && !this.deps.generalLimiter.allow(`feishu-bot:${current.user.id}`)) throw httpError(429, "RATE_LIMITED");
      return handleBotAccount(req, res, url.pathname, current.user.id, service.feishuBots, config);
    }
    if (req.method === "POST" && url.pathname === "/auth/desktop-inference/chat/completions") {
      const current = await this.deps.current(req);
      if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
      if (!this.deps.generalLimiter.allow(`desktop-inference:${current.user.id}`)) throw httpError(429, "RATE_LIMITED");
      return desktopInference(req, res, { userId: current.user.id, service, shared: this.deps.sharedModels,
        maxBytes: config.desktopBodyLimit ?? 8 * 1024 * 1024, timeoutMs: config.desktopInferenceTimeoutMs ?? 120000,
        audit: text => config.promptAudit?.enabled === false ? Promise.resolve('allow') : this.deps.promptAuditor?.audit(text) ?? Promise.resolve('unavailable'),
        assertPublicUrl: assertPublicUserModelUrl, dispatcher: publicModelDispatcher() });
    }
    if (req.method === "GET" && url.pathname === "/auth/account") return this.redirectLegacyAccount(req, res);
    if (req.method === "GET" && url.pathname === "/auth/me") { const current = await this.deps.current(req); if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; } const cookies: string[] = []; this.deps.refreshSessionCookie(req, cookies); sendJson(res, 200, { user: publicUser(current.user) }, cookies); return; }
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
    if (req.method === "GET" && (url.pathname === "/auth/reset" || url.pathname === "/auth/password/reset")) return this.sendResetPage(res, url.searchParams.get("token"));
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
    const { config, service } = this.deps;
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (req.method === "GET") {
      const [profiles, defaultProfileId, sharedModels] = await Promise.all([
        service.listMyModelProfiles(current.user.id),
        service.getMyDefaultModelProfileId(current.user.id),
        this.deps.sharedModels?.listModels().catch(() => []) ?? Promise.resolve([]),
      ]);
      sendJson(res, 200, { profiles, sharedModels, ...(defaultProfileId ? { defaultProfileId } : {}) });
      return;
    }
    const body = await readJson(req, config.requestBodyLimit);
    const draft = parseUserModelProfileDraft(body);
    await assertPublicUserModelUrl(draft.baseUrl);
    const profile = await service.createMyModelProfile(current.user.id, draft, metadata(req));
    sendJson(res, 201, { profile });
  }

  private async modelProfile(req: IncomingMessage, res: ServerResponse, profileId: string, setDefault: boolean): Promise<void> {
    const { config, service } = this.deps;
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (setDefault) {
      const body = await readJson(req, config.requestBodyLimit);
      if (Object.keys(body).length !== 0) throw httpError(400, "INVALID_REQUEST");
      if (!await service.setMyModelDefault(current.user.id, profileId, metadata(req))) { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
    const body = await readJson(req, config.requestBodyLimit);
    if (req.method === "PATCH") {
      const patch = parseUserModelProfilePatch(body);
      if (patch.baseUrl !== undefined) await assertPublicUserModelUrl(patch.baseUrl);
      const result = await service.updateMyModelProfile(current.user.id, profileId, patch, metadata(req));
      if (result.status === "not-found") { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
      if (result.status === "conflict") { sendError(res, 409, "MODEL_PROFILE_CONFLICT"); return; }
      sendJson(res, 200, { profile: result.profile });
      return;
    }
    const result = await service.deleteMyModelProfile(current.user.id, profileId, parseUserModelProfileRevision(body), metadata(req));
    if (result === "not-found") { sendError(res, 404, "MODEL_PROFILE_NOT_FOUND"); return; }
    if (result === "conflict") { sendError(res, 409, "MODEL_PROFILE_CONFLICT"); return; }
    sendJson(res, 200, { ok: true });
  }

  private async identities(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const identities = await this.deps.service.listIdentities(current.user.id);
    sendJson(res, 200, { identities: identities.map(publicIdentity) });
  }

  private async adminIdentities(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (current.user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    const identities = await this.deps.service.listIdentityOwners();
    sendJson(res, 200, { identities: identities.map(({ identity, user }) => ({ ...publicIdentity(identity), user: publicUser(user) })) });
  }

  private async unlinkIdentity(req: IncomingMessage, res: ServerResponse, admin: boolean): Promise<void> {
    const { config, service } = this.deps;
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    if (admin && current.user.role !== "admin") { sendError(res, 403, "ADMIN_REQUIRED"); return; }
    const body = await readJson(req, config.requestBodyLimit);
    const input = parseIdentityRequest(body, admin);
    const userId = input.userId ?? current.user.id;
    const result = await service.unlinkIdentity(userId, input.provider, input.subject, metadata(req));
    if (result.status === "last-login-method") { sendError(res, 409, "IDENTITY_LAST_LOGIN_METHOD"); return; }
    if (result.status === "not-found") { sendError(res, 404, "IDENTITY_NOT_FOUND"); return; }
    sendJson(res, 200, { ok: true, identity: publicIdentity(result.identity) });
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    if (!this.deps.generalLimiter.allow(`register:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, config.requestBodyLimit);
    await service.register(string(body.email), string(body.password), string(body.displayName), metadata(req));
    sendJson(res, 202, { accepted: true });
  }

  async beginPairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const configured = config.pairingToken;
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!isLoopbackAddress(req.socket.remoteAddress)) { sendError(res, 403, "LOOPBACK_REQUIRED"); return; }
    if (!configured) { sendError(res, 503, "PAIRING_NOT_CONFIGURED"); return; }
    if (!authorization.startsWith("Bearer ") || !constantTimeEqual(authorization.slice(7), configured)) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, config.requestBodyLimit);
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
      token = await service.beginFeishuPairing(string(body.openId), metadata(req), sessionId);
    } catch (error) {
      if (error instanceof Error && (error.message === "INVALID_FEISHU_OPEN_ID" || error.message === "INVALID_FEISHU_SESSION_ID")) {
        sendError(res, 400, "INVALID_REQUEST");
        return;
      }
      throw error;
    }
    const pairingUrl = new URL("/auth/pair", config.publicOrigin);
    pairingUrl.searchParams.set("token", token);
    const owner = await service.findIdentityOwner("feishu", string(body.openId));
    sendJson(res, 201, {
      url: pairingUrl.toString(),
      binding: owner
        ? { status: "bound", displayName: owner.user.displayName, email: maskEmail(owner.user.email) }
        : { status: "unbound" },
    });
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const body = await readJson(req, config.requestBodyLimit);
    const key = loginKey(req, string(body.email));
    if (!this.deps.loginLimiter.allow(`login:${clientKey(req)}`) || !this.deps.loginGuard.allow(key)) throw httpError(429, "RATE_LIMITED");
    const result = await service.login(string(body.email), string(body.password), metadata(req));
    if (!result) { this.deps.loginGuard.failure(key); sendError(res, 401, "INVALID_CREDENTIALS"); return; }
    this.deps.loginGuard.success(key);
    sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(config, result.token));
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    await service.logout(sessionToken(req, config.sessionCookieSecure), metadata(req));
    const cookies: string[] = []; appendCookie(cookies, sessionCookieName(config.sessionCookieSecure), "", { httpOnly: true, secure: config.sessionCookieSecure, maxAge: 0 }); sendJson(res, 200, { ok: true }, cookies);
  }

  private async forgot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    if (!this.deps.generalLimiter.allow(`forgot:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, config.requestBodyLimit); await service.forgotPassword(string(body.email), metadata(req)); sendJson(res, 202, { accepted: true });
  }

  private async reset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const body = await readJson(req, config.requestBodyLimit); const result = await service.resetPassword(string(body.token), string(body.password), metadata(req));
    if (!result) { sendError(res, 400, "RESET_TOKEN_INVALID"); return; } sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(config, result.token));
  }

  private async changePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const current = await this.deps.current(req); if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, config.requestBodyLimit); const ok = await service.changePassword(current.user.id, string(body.oldPassword), string(body.newPassword), metadata(req));
    if (!ok) { sendError(res, 400, "PASSWORD_INVALID"); return; } sendJson(res, 200, { ok: true });
  }

  private redirectLegacyAccount(req: IncomingMessage, res: ServerResponse): void {
    const cookies: string[] = [];
    this.deps.ensureCsrf(req, cookies);
    res.writeHead(302, { location: "/", "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
    res.end();
  }

  private verifyLink(res: ServerResponse): void {
    const page = messagePage("验证邮箱", "请返回注册页面，输入邮件中的 6 位验证码。", 400);
    sendHtml(res, page.status, page.html);
  }

  private async verifyCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    if (!this.deps.generalLimiter.allow(`verify:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, config.requestBodyLimit);
    const pairingToken = string(body.pairingToken) || undefined;
    const result = await service.verifyEmailCode(string(body.email), string(body.code), metadata(req), pairingToken);
    if (!result) { sendError(res, 400, "VERIFICATION_CODE_INVALID"); return; }
    sendJson(res, 200, { user: publicUser(result.user), pairingBound: Boolean(result.pairingBound) }, sessionCookies(config, result.token));
  }

  private async pair(req: IncomingMessage, res: ServerResponse, token: string | null): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const switchAccount = url.searchParams.get("switch") === "1";
    const current = await this.deps.current(req);
    const pairing = token ? await this.deps.service.peekFeishuPairing(token) : undefined;
    if (!pairing || !token) { const page = messagePage("配对失败", "配对链接无效或已过期，请回到飞书重新发送 `/login`。", 400); sendHtml(res, page.status, page.html); return; }
    const cookies: string[] = [];
    this.deps.ensureCsrf(req, cookies);
    const currentUser = current && !switchAccount ? { email: current.user.email, displayName: current.user.displayName } : undefined;
    sendHtml(res, 200, pairPage(token, currentUser, switchAccount), cookies);
  }

  private async pairLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    if (!this.deps.generalLimiter.allow(`pair-login:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, config.requestBodyLimit);
    const token = string(body.token);
    if (!await service.peekFeishuPairing(token)) { sendError(res, 400, "PAIRING_INVALID"); return; }
    try {
      const result = await service.loginAndPair(string(body.email), string(body.password), token, metadata(req));
      if (!result) { sendError(res, 401, "INVALID_CREDENTIALS"); return; }
      sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(config, result.token));
    } catch (error) {
      this.sendPairingError(res, error);
    }
  }

  private async pairRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    if (!this.deps.generalLimiter.allow(`pair-register:${clientKey(req)}`)) throw httpError(429, "RATE_LIMITED");
    const body = await readJson(req, config.requestBodyLimit);
    const token = string(body.token);
    if (!await service.peekFeishuPairing(token)) { sendError(res, 400, "PAIRING_INVALID"); return; }
    const result = await service.register(string(body.email), string(body.password), string(body.displayName), metadata(req), { pairingToken: token });
    if (result.duplicate && !result.resent) { sendError(res, 409, "ACCOUNT_EXISTS"); return; }
    sendJson(res, 202, { accepted: true });
  }

  private async pairConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const current = await this.deps.current(req);
    if (!current) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const body = await readJson(req, config.requestBodyLimit);
    const token = string(body.token);
    try {
      const result = await service.completeFeishuPairing(token, current.user.id, metadata(req));
      if (!result) { sendError(res, 400, "PAIRING_INVALID"); return; }
      sendJson(res, 200, { user: publicUser(result.user) }, sessionCookies(config, result.token));
    } catch (error) {
      this.sendPairingError(res, error);
    }
  }

  private sendPairingError(res: ServerResponse, error: unknown): void {
    if (error instanceof Error && error.message === "FEISHU_IDENTITY_CONFLICT") { sendError(res, 409, "FEISHU_IDENTITY_CONFLICT"); return; }
    if (error instanceof Error && error.message === "FEISHU_SESSION_CONFLICT") { sendError(res, 409, "FEISHU_SESSION_CONFLICT"); return; }
    throw error;
  }

  private async sendResetPage(res: ServerResponse, token: string | null): Promise<void> {
    const { config } = this.deps;
    if (!token) { const page = messagePage("重置密码", "重置链接缺少 token。", 400); sendHtml(res, page.status, page.html); return; }
    const cookies: string[] = []; appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: config.sessionCookieSecure });
    sendHtml(res, 200, resetPage(token), cookies);
  }

  private async feishuStart(req: IncomingMessage, res: ServerResponse, returnPath: string | null): Promise<void> {
    const { config, service } = this.deps;
    if (!config.feishu) { sendError(res, 503, "FEISHU_OAUTH_NOT_CONFIGURED"); return; }
    const current = await this.deps.current(req); const state = await service.beginOAuth(current?.user.id, returnPath ?? "/");
    const cookies: string[] = [];
    appendCookie(cookies, OAUTH_STATE_COOKIE, state.state, { httpOnly: true, secure: config.sessionCookieSecure, maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS });
    res.writeHead(302, { location: buildFeishuAuthorizeUrl(config.feishu, state.state), "set-cookie": cookies, "cache-control": "no-store" }); res.end();
  }

  private async feishuCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { config, service } = this.deps;
    if (!config.feishu) { sendError(res, 503, "FEISHU_OAUTH_NOT_CONFIGURED"); return; }
    res.setHeader("set-cookie", clearOAuthStateCookie(config));
    const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
    const expectedState = readCookie(req.headers.cookie, OAUTH_STATE_COOKIE);
    if (!code || !state || !expectedState || !constantTimeEqual(expectedState, state)) { sendError(res, 400, "OAUTH_INVALID"); return; }
    const profile = await exchangeFeishuCode(config.feishu, code); const result = await service.completeFeishu(state, profile, metadata(req));
    if (!result) { const page = messagePage("飞书登录失败", "授权无效或已过期。", 400); sendHtml(res, page.status, page.html); return; }
    res.writeHead(302, { location: result.returnPath, "set-cookie": [...sessionCookies(config, result.token), ...clearOAuthStateCookie(config)], "cache-control": "no-store" }); res.end();
  }
}
