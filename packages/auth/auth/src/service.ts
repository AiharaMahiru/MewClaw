import { randomBytes, randomUUID } from "node:crypto";

import {
  generateOpaqueToken,
  hashMetadata,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from "./crypto.js";
import { normalizeReturnPath } from "./policy.js";
import { inspectImportCredential } from "./credential-policy.js";
import { UserModelCrypto } from "./user-model-crypto.js";
import { FeishuBotService } from "./feishu-bots.js";
import type {
  AuthServiceOptions,
  AuthIdentity,
  AuthSession,
  AuthStore,
  AuthUser,
  AuthUserModelProfilePublic,
  AuthUserModelProfileRecord,
  AdminAccountRecoveryResult,
  AdminSessionSummary,
  AdminUserSessionRevokeResult,
  AdminUserPatch,
  AdminUserStoreUpdateResult,
  AdminUserSummary,
  FeishuPairingTokenRecord,
  FeishuPairingResult,
  FeishuProfile,
  OAuthLoginResult,
  PromoteAndPurgeUsersResult,
  SessionResult,
  UserModelProfileDraft,
  UserModelProfilePatch,
  UserModelProfileUpdateResult,
  UserModelRuntimeRoute,
  UserModelRuntimeRouteRef,
} from "./types.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
const MIGRATION_OPERATOR_SESSION_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_CODE_LENGTH = 6;

export interface RequestMetadata {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

export interface RegistrationResult {
  accepted: true;
  duplicate: boolean;
  resent?: boolean;
}

export type AdminUserUpdateResult = AdminUserStoreUpdateResult;

export interface RegistrationOptions {
  pairingToken?: string;
}

export interface OAuthStateResult {
  state: string;
  returnPath: string;
}

export type IdentityUnlinkResult =
  | { status: "unlinked"; identity: AuthIdentity }
  | { status: "not-found" }
  | { status: "last-login-method" };

export class AuthService {
  readonly feishuBots: FeishuBotService;
  readonly #store: AuthStore;
  readonly #mail: AuthServiceOptions["mail"];
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #sessionTtlMs: number;
  readonly #emailTokenTtlMs: number;
  readonly #oauthStateTtlMs: number;
  readonly #pairingTokenTtlMs: number;
  readonly #resetBaseUrl: string;
  readonly #userModelCrypto: UserModelCrypto | undefined;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#mail = options.mail;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#emailTokenTtlMs = options.emailTokenTtlMs ?? DEFAULT_EMAIL_TOKEN_TTL_MS;
    this.#oauthStateTtlMs = options.oauthStateTtlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;
    this.#pairingTokenTtlMs = options.pairingTokenTtlMs ?? DEFAULT_PAIRING_TOKEN_TTL_MS;
    this.#resetBaseUrl = options.resetBaseUrl ?? "/auth/reset";
    this.#userModelCrypto = options.userModelEncryptionKey
      ? new UserModelCrypto(options.userModelEncryptionKey)
      : undefined;
    this.feishuBots = new FeishuBotService(this.#store, this.#userModelCrypto);
  }

  async register(emailInput: string, password: string, displayNameInput: string, metadata: RequestMetadata, _options?: RegistrationOptions): Promise<RegistrationResult> {
    const email = normalizeEmail(emailInput);
    validatePassword(password);
    const displayName = normalizeDisplayName(displayNameInput, email);
    const existing = await this.#store.findUserByEmail(email);
    if (existing) {
      if (existing.status === "pending") {
        const credential = await this.#store.getPassword(existing.id);
        if (credential && await verifyPassword(password, credential.encoded)) {
          await this.sendVerification(existing);
          await this.audit("register-resend", existing.id, metadata);
          return { accepted: true, duplicate: true, resent: true };
        }
      }
      await this.audit("register-duplicate", null, metadata);
      return { accepted: true, duplicate: true };
    }
    const now = new Date(this.#now()).toISOString();
    let user: AuthUser;
    try {
      user = await this.#store.createUser({ email, displayName, status: "pending", now });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.audit("register-duplicate", null, metadata);
      return { accepted: true, duplicate: true };
    }
    await this.#store.setPassword(user.id, await hashPassword(password, this.#randomBytes), now);
    await this.sendVerification(user);
    await this.audit("register", user.id, metadata);
    return { accepted: true, duplicate: false };
  }

  async verifyEmailCode(emailInput: string, codeInput: string, metadata: RequestMetadata, pairingToken?: string): Promise<SessionResult | undefined> {
    const email = normalizeEmail(emailInput);
    const code = normalizeVerificationCode(codeInput);
    const user = await this.#store.findUserByEmail(email);
    const userId = user ? await this.#store.consumeEmailToken(hashVerificationCode(user.id, code), "verify-email", nowIso(this.#now())) : undefined;
    if (!user || userId !== user.id) { await this.audit("verify-email-code-failed", null, metadata); return undefined; }
    const activated = await this.#store.activateUser(userId, nowIso(this.#now()));
    if (!activated) return undefined;
    const paired = pairingToken ? await this.completeFeishuPairing(pairingToken, activated.id, metadata) : undefined;
    if (paired) return { ...paired, pairingBound: true };
    const result = await this.createSession(activated, metadata);
    await this.audit("verify-email-code", activated.id, metadata);
    return result;
  }

  async login(emailInput: string, password: string, metadata: RequestMetadata): Promise<SessionResult | undefined> {
    const user = await this.authenticateLogin(emailInput, password);
    if (!user) {
      await this.audit("login-failed", null, metadata);
      return undefined;
    }
    const result = await this.createSession(user, metadata);
    await this.audit("login", user.id, metadata);
    return result;
  }

  async loginAndPair(emailInput: string, password: string, pairingToken: string, metadata: RequestMetadata): Promise<FeishuPairingResult | undefined> {
    const user = await this.authenticateLogin(emailInput, password);
    if (!user) {
      await this.audit("login-failed", null, metadata);
      return undefined;
    }
    const result = await this.completeFeishuPairing(pairingToken, user.id, metadata);
    if (result) await this.audit("login", user.id, metadata);
    return result;
  }

  async current(rawToken: string | undefined, metadata: RequestMetadata): Promise<{ user: AuthUser; session: AuthSession } | undefined> {
    if (!rawToken) return undefined;
    const session = await this.#store.findSession(hashOpaqueToken(rawToken));
    if (!session || session.revokedAt || session.expiresAt <= nowIso(this.#now())) return undefined;
    const user = await this.#store.findUserById(session.userId);
    if (!user || user.status !== "active") return undefined;
    const lastSeenAt = nowIso(this.#now());
    await this.#store.touchSession(session.id, lastSeenAt, isoAfter(this.#now(), this.#sessionTtlMs));
    await this.audit("session-use", user.id, metadata);
    return { user, session: { ...session, lastSeenAt, expiresAt: isoAfter(this.#now(), this.#sessionTtlMs) } };
  }

  async logout(rawToken: string | undefined, metadata: RequestMetadata): Promise<void> {
    if (!rawToken) return;
    const session = await this.#store.findSession(hashOpaqueToken(rawToken));
    if (session) {
      await this.#store.revokeSession(session.id, nowIso(this.#now()));
      await this.audit("logout", session.userId, metadata);
    }
  }

  async listAdminUsers(): Promise<AdminUserSummary[]> {
    const [users, sessions, identities] = await Promise.all([
      this.#store.listUsers(),
      this.#store.listSessions(),
      this.#store.listAllIdentities(),
    ]);
    const resources = await Promise.all(users.map(async (user) => ({
      userId: user.id,
      sessions: (await this.#store.listResources(user.id, "session")).length,
      workspaces: (await this.#store.listResources(user.id, "workspace")).length,
    })));
    return users.map((user, index) => ({
      ...user,
      sessionCount: sessions.filter((session) => session.userId === user.id).length,
      identityCount: identities.filter((identity) => identity.userId === user.id).length,
      workspaceCount: resources[index]?.workspaces ?? 0,
    }));
  }

  async listAdminSessions(): Promise<AdminSessionSummary[]> {
    const users = new Map((await this.#store.listUsers()).map((user) => [user.id, user]));
    return (await this.#store.listSessions()).flatMap((session) => {
      const user = users.get(session.userId);
      return user ? [adminSessionSummary(session, user)] : [];
    });
  }

  async updateUserForAdmin(userId: string, patch: AdminUserPatch, metadata: RequestMetadata): Promise<AdminUserUpdateResult> {
    const result = await this.#store.updateUserForAdmin(userId, patch, nowIso(this.#now()));
    if (result.status !== "updated") return result;
    await this.audit("admin-user-update", userId, metadata, { fields: Object.keys(patch).sort().join(",") || "none" });
    return result;
  }

  async revokeAdminUserSessions(userId: string, metadata: RequestMetadata): Promise<AdminUserSessionRevokeResult | undefined> {
    const user = await this.#store.findUserById(userId);
    if (!user) {
      await this.audit("admin-user-sessions-missing", null, metadata);
      return undefined;
    }
    const sessions = await this.#store.listSessions();
    const revokedCount = sessions.filter((session) => session.userId === userId && !session.revokedAt).length;
    await this.#store.revokeUserSessions(userId, nowIso(this.#now()));
    await this.audit("admin-user-sessions-revoke", userId, metadata, { revokedCount: String(revokedCount) });
    return { userId, revokedCount };
  }

  async recoverAdminAccount(userId: string, encodedCredential: string, metadata: RequestMetadata): Promise<AdminAccountRecoveryResult | undefined> {
    const decision = inspectImportCredential({ sourceSystem: "dsh", encoded: encodedCredential });
    if (decision.action !== "reuse" || decision.profile !== "dsh-native") {
      await this.audit("admin-account-recovery-rejected", null, metadata, { reason: "CREDENTIAL_UNSUPPORTED" });
      throw new Error("CREDENTIAL_UNSUPPORTED");
    }
    const result = await this.#store.recoverAdminAccount(userId, decision.normalizedEncoded, nowIso(this.#now()));
    if (!result) {
      await this.audit("admin-account-recovery-missing", null, metadata);
      return undefined;
    }
    await this.audit("admin-account-recovery", userId, metadata, {
      credentialProfile: decision.profile,
      revokedSessionCount: String(result.revokedSessionCount),
    });
    return result;
  }

  async revokeAdminSession(sessionId: string, metadata: RequestMetadata): Promise<AuthSession | undefined> {
    const session = (await this.#store.listSessions()).find((item) => item.id === sessionId);
    if (!session) return undefined;
    await this.#store.revokeSession(session.id, nowIso(this.#now()));
    await this.audit("admin-session-revoke", session.userId, metadata, { sessionId });
    return { ...session, revokedAt: nowIso(this.#now()) };
  }

  async issueMigrationOperatorSession(
    userId: string,
    metadata: RequestMetadata,
  ): Promise<AuthSession | undefined> {
    const user = await this.#store.findUserById(userId);
    if (!user || user.role !== "admin" || user.status !== "active") {
      await this.audit("migration-operator-session-rejected", user?.id ?? null, metadata);
      return undefined;
    }
    const createdAt = nowIso(this.#now());
    const session = await this.#store.createSession({
      userId,
      tokenHash: hashOpaqueToken(generateOpaqueToken(32, this.#randomBytes)),
      createdAt,
      expiresAt: isoAfter(this.#now(), MIGRATION_OPERATOR_SESSION_TTL_MS),
      ipHash: null,
      userAgentHash: null,
    });
    await this.audit("migration-operator-session-issued", userId, metadata, { sessionId: session.id });
    return session;
  }

  purgeImportedWorkspaceResources(
    runId: string,
    operatorUserId: string,
    operatorSessionId: string,
    metadata: RequestMetadata,
  ): Promise<number> {
    return this.#store.purgeImportedWorkspaceResources({
      runId,
      operatorUserId,
      operatorSessionId,
      requestId: metadata.requestId,
      now: nowIso(this.#now()),
    });
  }

  async forgotPassword(emailInput: string, metadata: RequestMetadata): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.#store.findUserByEmail(email);
    if (!user || user.status !== "active") { await this.audit("password-forgot-ignored", null, metadata); return; }
    const token = generateOpaqueToken(32, this.#randomBytes);
    await this.#store.issueEmailToken({ tokenHash: hashOpaqueToken(token), userId: user.id, purpose: "reset-password", expiresAt: isoAfter(this.#now(), this.#emailTokenTtlMs), consumedAt: null });
    try {
      await this.#mail.sendPasswordReset({ to: user.email, displayName: user.displayName, token: `${this.#resetBaseUrl}?token=${encodeURIComponent(token)}` });
    } catch (error) {
      throw mailDeliveryError(error);
    }
    await this.audit("password-forgot", user.id, metadata);
  }

  async resetPassword(token: string, password: string, metadata: RequestMetadata): Promise<SessionResult | undefined> {
    validatePassword(password);
    const userId = await this.#store.consumeEmailToken(hashOpaqueToken(token), "reset-password", nowIso(this.#now()));
    if (!userId) { await this.audit("password-reset-failed", null, metadata); return undefined; }
    const user = await this.#store.findUserById(userId);
    if (!user || user.status !== "active") return undefined;
    await this.#store.setPassword(user.id, await hashPassword(password, this.#randomBytes), nowIso(this.#now()));
    await this.#store.revokeUserSessions(user.id, nowIso(this.#now()));
    const result = await this.createSession(user, metadata);
    await this.audit("password-reset", user.id, metadata);
    return result;
  }

  async changePassword(userId: string, oldPassword: string, nextPassword: string, metadata: RequestMetadata): Promise<boolean> {
    validatePassword(nextPassword);
    const credential = await this.#store.getPassword(userId);
    if (!credential || !(await verifyPassword(oldPassword, credential.encoded))) { await this.audit("password-change-failed", userId, metadata); return false; }
    await this.#store.setPassword(userId, await hashPassword(nextPassword, this.#randomBytes), nowIso(this.#now()));
    await this.#store.revokeUserSessions(userId, nowIso(this.#now()));
    await this.audit("password-change", userId, metadata);
    return true;
  }

  async beginOAuth(userId: string | undefined, returnPath: string | undefined): Promise<OAuthStateResult> {
    const state = generateOpaqueToken(32, this.#randomBytes);
    await this.#store.issueOAuthState({ stateHash: hashOpaqueToken(state), userId: userId ?? null, returnPath: normalizeReturnPath(returnPath), expiresAt: isoAfter(this.#now(), this.#oauthStateTtlMs), consumedAt: null });
    return { state, returnPath: normalizeReturnPath(returnPath) };
  }

  async completeFeishu(state: string, profile: FeishuProfile, metadata: RequestMetadata): Promise<OAuthLoginResult | undefined> {
    const record = await this.#store.consumeOAuthState(hashOpaqueToken(state), nowIso(this.#now()));
    const normalized = normalizeFeishuProfile(profile);
    if (!record || !normalized) { await this.audit("feishu-oauth-failed", null, metadata); return undefined; }
    const existing = await this.#store.findIdentity("feishu", normalized.openId);
    const unionExisting = normalized.unionId ? await this.#store.findIdentityByUnion("feishu", normalized.unionId) : undefined;
    assertFeishuIdentityConsistency(existing, unionExisting, normalized.unionId);
    if (record.userId && existing && existing.userId !== record.userId) throw new Error("FEISHU_IDENTITY_CONFLICT");
    if (record.userId && unionExisting && unionExisting.userId !== record.userId) throw new Error("FEISHU_IDENTITY_CONFLICT");
    if (record.userId) return this.bindExisting(record.userId, existing, normalized, metadata, record.returnPath);
    if (existing) {
      const user = await this.#store.findUserById(existing.userId);
      if (!user || user.status !== "active") return undefined;
      return { ...(await this.createSession(user, metadata)), created: false, returnPath: record.returnPath };
    }
    if (unionExisting) throw new Error("FEISHU_IDENTITY_CONFLICT");
    const user = await this.createOAuthUser(normalized);
    await this.createFeishuIdentity(normalized, user.id);
    return { ...(await this.createSession(user, metadata)), created: true, returnPath: record.returnPath };
  }

  async beginFeishuPairing(openIdInput: string, metadata: RequestMetadata, sessionIdInput?: string): Promise<string> {
    const openId = normalizeFeishuOpenId(openIdInput);
    const sessionId = sessionIdInput === undefined ? null : normalizeFeishuSessionId(sessionIdInput);
    const token = generateOpaqueToken(32, this.#randomBytes);
    await this.#store.issueFeishuPairingToken({
      tokenHash: hashOpaqueToken(token),
      openId,
      sessionId,
      expiresAt: isoAfter(this.#now(), this.#pairingTokenTtlMs),
      consumedAt: null,
    });
    await this.audit("feishu-pairing-issued", null, metadata);
    return token;
  }

  async peekFeishuPairing(tokenInput: string): Promise<FeishuPairingTokenRecord | undefined> {
    const token = tokenInput.trim();
    if (!token) return undefined;
    return this.#store.findFeishuPairingToken(hashOpaqueToken(token), nowIso(this.#now()));
  }

  async completeFeishuPairing(tokenInput: string, currentUserId: string | undefined, metadata: RequestMetadata): Promise<FeishuPairingResult | undefined> {
    const tokenHash = hashOpaqueToken(tokenInput.trim());
    const sessionToken = generateOpaqueToken(32, this.#randomBytes);
    const timestamp = this.#now();
    const result = await this.#store.commitFeishuPairing({
      tokenHash, currentUserId: currentUserId ?? null, now: nowIso(timestamp),
      sessionTokenHash: hashOpaqueToken(sessionToken), sessionExpiresAt: isoAfter(timestamp, this.#sessionTtlMs),
      ipHash: hashMetadata(metadata.ip), userAgentHash: hashMetadata(metadata.userAgent),
    });
    switch (result.status) {
      case "paired":
        await this.audit("feishu-pairing", result.user.id, metadata);
        return { user: result.user, session: result.session, token: sessionToken, created: false };
      case "failed":
        await this.audit("feishu-pairing-failed", null, metadata);
        return undefined;
      case "user-unavailable": return undefined;
      case "identity-conflict": throw new Error("FEISHU_IDENTITY_CONFLICT");
      case "session-conflict": throw new Error("FEISHU_SESSION_CONFLICT");
      default: return assertUnreachable(result);
    }
  }

  async saveResource(resource: Parameters<AuthStore["saveResource"]>[0]): Promise<boolean> { return this.#store.saveResource(resource); }
  async findResource(type: Parameters<AuthStore["findResource"]>[0], id: string): Promise<Awaited<ReturnType<AuthStore["findResource"]>>> { return this.#store.findResource(type, id); }
  async listResources(userId: string, type: Parameters<AuthStore["listResources"]>[1]): Promise<Awaited<ReturnType<AuthStore["listResources"]>>> { return this.#store.listResources(userId, type); }

  /** 仅返回脱敏投影；用户密钥从不离开 Auth Service。 */
  async listMyModelProfiles(userId: string): Promise<AuthUserModelProfilePublic[]> {
    return (await this.#store.listUserModelProfiles(userId)).map(publicUserModelProfile);
  }

  /** 仅返回当前用户默认 Profile 的不透明 ID；不存在时为 undefined。 */
  async getMyDefaultModelProfileId(userId: string): Promise<string | undefined> {
    return this.#store.getUserModelDefault(userId);
  }

  async createMyModelProfile(
    userId: string,
    input: UserModelProfileDraft,
    metadata: RequestMetadata,
  ): Promise<AuthUserModelProfilePublic> {
    const draft = normalizeUserModelDraft(input);
    const now = nowIso(this.#now());
    const id = randomUUID();
    const revision = 1;
    const secret = this.userModelCrypto().encrypt(draft.apiKey, { userId, profileId: id, revision });
    const profile = await this.#store.createUserModelProfile({
      id,
      userId,
      displayName: draft.displayName,
      baseUrl: draft.baseUrl,
      modelIds: draft.modelIds,
      defaultModel: draft.defaultModel,
      ...secret,
      revision,
      createdAt: now,
      updatedAt: now,
    });
    // 第一个档案自动成为账户默认值；后续创建由显式“设为默认”控制。
    if (!await this.#store.getUserModelDefault(userId)) {
      await this.#store.setUserModelDefault(userId, profile.id, now);
    }
    await this.audit("user-model-profile-created", userId, metadata, { profileId: profile.id });
    return publicUserModelProfile(profile);
  }

  async updateMyModelProfile(
    userId: string,
    profileId: string,
    patch: UserModelProfilePatch,
    metadata: RequestMetadata,
  ): Promise<UserModelProfileUpdateResult> {
    const current = await this.#store.findUserModelProfile(userId, profileId);
    if (!current) return { status: "not-found" };
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1) {
      throw new Error("INVALID_USER_MODEL_PROFILE_REVISION");
    }
    if (patch.expectedRevision !== current.revision) return { status: "conflict" };
    const next = normalizeUserModelPatch(current, patch);
    const revision = current.revision + 1;
    // 即使本次未替换 Key，也会以新的 revision 重封装，使 AEAD 绑定保持精确。
    const apiKey = next.apiKey ?? this.userModelCrypto().decrypt(current, {
      userId,
      profileId: current.id,
      revision: current.revision,
    });
    const secret = this.userModelCrypto().encrypt(apiKey, { userId, profileId: current.id, revision });
    const updated = await this.#store.updateUserModelProfile({
      ...current,
      displayName: next.displayName,
      baseUrl: next.baseUrl,
      modelIds: next.modelIds,
      defaultModel: next.defaultModel,
      ...secret,
      revision,
      updatedAt: nowIso(this.#now()),
      expectedRevision: patch.expectedRevision,
    });
    if (!updated) return { status: "conflict" };
    await this.audit("user-model-profile-updated", userId, metadata, { profileId: updated.id });
    return { status: "updated", profile: publicUserModelProfile(updated) };
  }

  async deleteMyModelProfile(userId: string, profileId: string, expectedRevision: number, metadata: RequestMetadata): Promise<"deleted" | "not-found" | "conflict"> {
    const current = await this.#store.findUserModelProfile(userId, profileId);
    if (!current) return "not-found";
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("INVALID_USER_MODEL_PROFILE_REVISION");
    if (current.revision !== expectedRevision) return "conflict";
    if (!await this.#store.deleteUserModelProfile(userId, profileId, expectedRevision)) return "conflict";
    await this.audit("user-model-profile-deleted", userId, metadata, { profileId });
    return "deleted";
  }

  async setMyModelDefault(userId: string, profileId: string, metadata: RequestMetadata): Promise<boolean> {
    const set = await this.#store.setUserModelDefault(userId, profileId, nowIso(this.#now()));
    if (set) await this.audit("user-model-profile-defaulted", userId, metadata, { profileId });
    return set;
  }

  /** 仅供 Auth Edge 组装可信 Worker scope，严禁透过浏览器响应调用。 */
  async resolveMyDefaultModelRoute(userId: string): Promise<UserModelRuntimeRoute | undefined> {
    const profileId = await this.#store.getUserModelDefault(userId);
    if (!profileId) return undefined;
    const profile = await this.#store.findUserModelProfile(userId, profileId);
    if (!profile) return undefined;
    return this.resolveUserModelRoute(profile, userId, profile.id, profile.revision, profile.defaultModel);
  }

  /** 供 Auth Edge 填充 scope：只读 Profile 元数据，绝不解密 API Key。 */
  async resolveMyDefaultModelRouteRef(userId: string): Promise<UserModelRuntimeRouteRef | undefined> {
    const profileId = await this.#store.getUserModelDefault(userId);
    if (!profileId) return undefined;
    const profile = await this.#store.findUserModelProfile(userId, profileId);
    return profile ? { profileId: profile.id, revision: profile.revision, model: profile.defaultModel } : undefined;
  }

  /**
   * 仅供 Worker loopback 回调。版本和模型必须与此前的 scope 引用相同，避免
   * 排队 prompt 被后来的账户设置重定向到别的端点或密钥。
   */
  async resolveMyModelRoute(
    userId: string,
    profileId: string,
    revision: number,
    model: string,
  ): Promise<UserModelRuntimeRoute | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1 || !model) return undefined;
    const profile = await this.#store.findUserModelProfile(userId, profileId);
    if (!profile || profile.revision !== revision || profile.defaultModel !== model) return undefined;
    return this.resolveUserModelRoute(profile, userId, profileId, revision, model);
  }

  private resolveUserModelRoute(
    profile: AuthUserModelProfileRecord,
    userId: string,
    profileId: string,
    revision: number,
    model: string,
  ): UserModelRuntimeRoute {
    return {
      profileId: profile.id,
      baseUrl: profile.baseUrl,
      model,
      apiKey: this.userModelCrypto().decrypt(profile, { userId, profileId, revision }),
      revision,
    };
  }

  async listIdentities(userId: string): Promise<AuthIdentity[]> {
    return this.#store.listIdentities(userId);
  }

  async findIdentityOwner(provider: "feishu", subjectInput: string): Promise<{ identity: AuthIdentity; user: AuthUser } | undefined> {
    const identity = await this.#store.findIdentity(provider, normalizeFeishuOpenId(subjectInput));
    if (!identity) return undefined;
    const user = await this.#store.findUserById(identity.userId);
    return user ? { identity, user } : undefined;
  }

  async listIdentityOwners(): Promise<Array<{ identity: AuthIdentity; user: AuthUser }>> {
    const identities = await this.#store.listAllIdentities();
    const owners = await Promise.all(identities.map(async (identity) => ({ identity, user: await this.#store.findUserById(identity.userId) })));
    return owners.filter((entry): entry is { identity: AuthIdentity; user: AuthUser } => Boolean(entry.user));
  }

  async unlinkIdentity(userId: string, provider: "feishu", subjectInput: string, metadata: RequestMetadata): Promise<IdentityUnlinkResult> {
    const subject = normalizeFeishuOpenId(subjectInput);
    const user = await this.#store.findUserById(userId);
    if (!user) return { status: "not-found" };
    const password = await this.#store.getPassword(userId);
    const result = await this.#store.deleteIdentity(userId, provider, subject, { protectLastLoginMethod: !password });
    if (!result.identity) {
      if (result.reason === "last-login-method") {
        await this.audit("feishu-identity-unlink-blocked", userId, metadata, { provider, identityHash: hashOpaqueToken(`${provider}:${subject}`) });
        return { status: "last-login-method" };
      }
      await this.audit("feishu-identity-unlink-missing", userId, metadata, { provider, identityHash: hashOpaqueToken(`${provider}:${subject}`) });
      return { status: "not-found" };
    }
    await this.audit("feishu-identity-unlinked", userId, metadata, { provider, identityHash: hashOpaqueToken(`${provider}:${subject}`) });
    return { status: "unlinked", identity: result.identity };
  }

  async promoteUserAndPurgeOthers(userId: string, metadata: RequestMetadata): Promise<PromoteAndPurgeUsersResult | undefined> {
    const result = await this.#store.promoteUserAndPurgeOthers(userId, nowIso(this.#now()));
    if (!result) {
      await this.audit("admin-user-purge-missing", null, metadata, { targetUserId: userId });
      return undefined;
    }
    await this.audit("admin-user-purge", result.user.id, metadata, { deletedUserCount: String(result.deletedUserIds.length) });
    return result;
  }

  private async authenticateLogin(emailInput: string, password: string): Promise<AuthUser | undefined> {
    const email = normalizeEmail(emailInput);
    const user = await this.#store.findUserByEmail(email);
    const credential = user ? await this.#store.getPassword(user.id) : undefined;
    const valid = credential ? await verifyPassword(password, credential.encoded) : false;
    return user && credential && valid && user.status === "active" ? user : undefined;
  }

  private userModelCrypto(): UserModelCrypto {
    if (!this.#userModelCrypto) throw new Error("USER_MODEL_ENCRYPTION_NOT_CONFIGURED");
    return this.#userModelCrypto;
  }

  private async bindExisting(userId: string, existing: Awaited<ReturnType<AuthStore["findIdentity"]>>, profile: FeishuProfile, metadata: RequestMetadata, returnPath: string): Promise<OAuthLoginResult | undefined> {
    if (!existing) await this.createFeishuIdentity(profile, userId);
    const user = await this.#store.findUserById(userId);
    if (!user || user.status !== "active") return undefined;
    return { ...(await this.createSession(user, metadata)), created: false, returnPath };
  }

  private async createOAuthUser(profile: FeishuProfile): Promise<AuthUser> {
    const email = normalizedFeishuEmail(profile.email, profile.openId);
    const existing = await this.#store.findUserByEmail(email);
    if (existing) {
      const unique = `feishu-${hashOpaqueToken(profile.openId).slice(0, 24)}@invalid.local`;
      return this.#store.createUser({ email: unique, displayName: normalizeDisplayName(profile.name ?? "Feishu user", unique), status: "active", now: nowIso(this.#now()) });
    }
    return this.#store.createUser({ email, displayName: normalizeDisplayName(profile.name ?? "Feishu user", email), status: "active", now: nowIso(this.#now()) });
  }

  private async createFeishuIdentity(profile: FeishuProfile, userId: string): Promise<void> {
    try {
      await this.#store.createIdentity({ provider: "feishu", subject: profile.openId, unionId: profile.unionId ?? null, userId, createdAt: nowIso(this.#now()) });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.#store.findIdentity("feishu", profile.openId);
      if (!existing || existing.userId !== userId) throw new Error("FEISHU_IDENTITY_CONFLICT");
    }
  }

  private async createSession(user: AuthUser, metadata: RequestMetadata): Promise<SessionResult> {
    const token = generateOpaqueToken(32, this.#randomBytes);
    const createdAt = nowIso(this.#now());
    const session = await this.#store.createSession({ userId: user.id, tokenHash: hashOpaqueToken(token), createdAt, expiresAt: isoAfter(this.#now(), this.#sessionTtlMs), ipHash: hashMetadata(metadata.ip), userAgentHash: hashMetadata(metadata.userAgent) });
    return { user, session, token };
  }

  private async sendVerification(user: AuthUser): Promise<void> {
    const code = generateVerificationCode(this.#randomBytes);
    await this.#store.issueEmailToken({ tokenHash: hashVerificationCode(user.id, code), userId: user.id, purpose: "verify-email", expiresAt: isoAfter(this.#now(), this.#emailTokenTtlMs), consumedAt: null });
    try {
      await this.#mail.sendVerification({ to: user.email, displayName: user.displayName, code, expiresInMinutes: Math.max(1, Math.ceil(this.#emailTokenTtlMs / 60_000)) });
    } catch (error) {
      throw mailDeliveryError(error);
    }
  }

  private async audit(action: string, userId: string | null, metadata: RequestMetadata, details?: Record<string, string>): Promise<void> {
    try { await this.#store.audit({ action, userId, requestId: metadata.requestId, ipHash: hashMetadata(metadata.ip), userAgentHash: hashMetadata(metadata.userAgent), ...(details ? { metadata: details } : {}), createdAt: nowIso(this.#now()) }); } catch { /* 审计故障不把凭证错误泄露给客户端。 */ }
  }
}

function nowIso(now: number): string { return new Date(now).toISOString(); }
function isoAfter(now: number, durationMs: number): string { return new Date(now + durationMs).toISOString(); }
function adminSessionSummary(session: AuthSession, user: AuthUser): AdminSessionSummary {
  return {
    id: session.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    revokedAt: session.revokedAt,
  };
}
function generateVerificationCode(source: (size: number) => Buffer): string {
  const bytes = source(4);
  const value = bytes.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(VERIFICATION_CODE_LENGTH, "0");
}
function normalizeVerificationCode(value: string): string {
  const code = value.trim();
  if (!new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`).test(code)) throw new Error("INVALID_VERIFICATION_CODE");
  return code;
}
function hashVerificationCode(userId: string, code: string): string { return hashOpaqueToken(`${userId}:${code}`); }
function normalizeDisplayName(value: string, email: string): string { const name = value.trim().slice(0, 120); return name || email.split("@")[0] || "用户"; }
function normalizeFeishuOpenId(value: string): string {
  const openId = value.trim();
  if (!openId || openId.length > 256 || /[\u0000-\u001f\u007f]/.test(openId)) throw new Error("INVALID_FEISHU_OPEN_ID");
  return openId;
}
function normalizeFeishuSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^session-[0-9a-f]{64}(?::[0-9]+)?$/.test(sessionId)) throw new Error("INVALID_FEISHU_SESSION_ID");
  return sessionId;
}
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505"); }
function assertUnreachable(value: never): never { throw new Error(`UNREACHABLE_AUTH_STATE:${JSON.stringify(value)}`); }
function mailDeliveryError(cause: unknown): Error & { code: "MAIL_DELIVERY_FAILED" } {
  const error = new Error("MAIL_DELIVERY_FAILED", { cause }) as Error & { code: "MAIL_DELIVERY_FAILED" };
  error.code = "MAIL_DELIVERY_FAILED";
  return error;
}
function normalizeFeishuProfile(profile: FeishuProfile): FeishuProfile | undefined {
  const openId = profile.openId.trim();
  if (!openId) return undefined;
  const unionId = profile.unionId?.trim();
  const email = profile.email?.trim();
  const name = profile.name?.trim();
  return { openId, ...(unionId ? { unionId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
}
function assertFeishuIdentityConsistency(existing: AuthUserIdentity | undefined, unionExisting: AuthUserIdentity | undefined, unionId: string | undefined): void {
  if (existing && unionExisting && existing.userId !== unionExisting.userId) throw new Error("FEISHU_IDENTITY_CONFLICT");
  if (existing && unionId && existing.unionId && existing.unionId !== unionId) throw new Error("FEISHU_IDENTITY_CONFLICT");
  if (unionExisting && unionId && unionExisting.unionId !== unionId) throw new Error("FEISHU_IDENTITY_CONFLICT");
}
function normalizedFeishuEmail(email: string | undefined, openId: string): string {
  if (email) {
    try { return normalizeEmail(email); } catch { /* provider email 不满足本地格式时使用不可登录的占位地址。 */ }
  }
  return `feishu-${hashOpaqueToken(openId).slice(0, 24)}@invalid.local`;
}

function publicUserModelProfile(profile: AuthUserModelProfileRecord): AuthUserModelProfilePublic {
  return {
    id: profile.id,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    modelIds: [...profile.modelIds],
    defaultModel: profile.defaultModel,
    keyConfigured: true,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function normalizeUserModelDraft(input: UserModelProfileDraft): Required<UserModelProfileDraft> {
  const modelIds = normalizeUserModelIds(input.modelIds);
  return {
    displayName: normalizeUserModelDisplayName(input.displayName),
    baseUrl: normalizeUserModelBaseUrl(input.baseUrl),
    modelIds,
    defaultModel: normalizeUserModelDefault(input.defaultModel, modelIds),
    apiKey: normalizeUserModelApiKey(input.apiKey),
  };
}

function normalizeUserModelPatch(current: AuthUserModelProfileRecord, input: UserModelProfilePatch): {
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  apiKey?: string;
} {
  const modelIds = input.modelIds === undefined ? [...current.modelIds] : normalizeUserModelIds(input.modelIds);
  return {
    displayName: input.displayName === undefined ? current.displayName : normalizeUserModelDisplayName(input.displayName),
    baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeUserModelBaseUrl(input.baseUrl),
    modelIds,
    defaultModel: normalizeUserModelDefault(input.defaultModel ?? current.defaultModel, modelIds),
    ...(input.apiKey === undefined ? {} : { apiKey: normalizeUserModelApiKey(input.apiKey) }),
  };
}

function normalizeUserModelDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("INVALID_USER_MODEL_PROFILE_NAME");
  return name;
}

function normalizeUserModelBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("INVALID_USER_MODEL_BASE_URL"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("INVALID_USER_MODEL_BASE_URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeUserModelIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("INVALID_USER_MODEL_LIST");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "string") throw new Error("INVALID_USER_MODEL_LIST");
    const model = raw.trim();
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model) || seen.has(model)) throw new Error("INVALID_USER_MODEL_LIST");
    seen.add(model);
    return model;
  });
}

function normalizeUserModelDefault(value: string, modelIds: readonly string[]): string {
  if (typeof value !== "string") throw new Error("INVALID_USER_MODEL_DEFAULT");
  const model = value.trim();
  if (!modelIds.includes(model)) throw new Error("INVALID_USER_MODEL_DEFAULT");
  return model;
}

function normalizeUserModelApiKey(value: string): string {
  if (typeof value !== "string") throw new Error("INVALID_USER_MODEL_KEY");
  const key = value.trim();
  if (!key || key.length > 16_384 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("INVALID_USER_MODEL_KEY");
  return key;
}

type AuthUserIdentity = Awaited<ReturnType<AuthStore["findIdentity"]>>;
