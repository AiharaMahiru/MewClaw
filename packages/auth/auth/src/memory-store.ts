import { randomUUID } from "node:crypto";

import type {
  AuditEntry,
  AuthIdentity,
  AuthResource,
  AuthSession,
  AuthStore,
  AuthTokenPurpose,
  AuthUser,
  AuthUserModelProfileRecord,
  AdminAccountRecoveryResult,
  AdminUserPatch,
  AdminUserStoreUpdateResult,
  CommitFeishuPairingInput,
  CommitFeishuPairingResult,
  FeishuPairingTokenRecord,
  CreateSessionInput,
  CreateUserModelProfileRecord,
  CreateUserInput,
  EmailTokenRecord,
  OAuthStateRecord,
  PasswordCredential,
  PromoteAndPurgeUsersResult,
  UpdateUserModelProfileRecord,
} from "./types.js";
import type { ImportedWorkspaceCleanupInput } from "./types.js";

type PairingCheckpoint = "identity" | "session-resource" | "web-session";

interface MemoryPairingContext {
  token: FeishuPairingTokenRecord;
  user: AuthUser;
  identityKey: string;
  identity: AuthIdentity | undefined;
  resourceKey: string | null;
  resource: AuthResource | undefined;
}

export class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly passwords = new Map<string, PasswordCredential>();
  readonly sessions = new Map<string, AuthSession>();
  readonly emailTokens = new Map<string, EmailTokenRecord>();
  readonly oauthStates = new Map<string, OAuthStateRecord>();
  readonly identities = new Map<string, AuthIdentity>();
  readonly resources = new Map<string, AuthResource>();
  readonly userModelProfiles = new Map<string, AuthUserModelProfileRecord>();
  readonly userModelDefaults = new Map<string, string>();
  readonly auditLog: AuditEntry[] = [];

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const role = input.status === "active" && ![...this.users.values()].some((item) => item.role === "admin") ? "admin" : "user";
    const now = input.now;
    const user: AuthUser = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      role,
      status: input.status,
      defaultMode: role === "admin" ? "full" : "lightweight",
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<AuthUser | undefined> {
    return [...this.users.values()].find((user) => user.email === email);
  }

  async findUserById(userId: string): Promise<AuthUser | undefined> {
    return this.users.get(userId);
  }

  async listUsers(): Promise<AuthUser[]> {
    return [...this.users.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async activateUser(userId: string, now: string): Promise<AuthUser | undefined> {
    const user = this.users.get(userId);
    if (!user || user.status === "disabled") return undefined;
    const claimAdmin = ![...this.users.values()].some((item) => item.role === "admin");
    for (const [id, item] of this.users) {
      if (claimAdmin && id !== userId && item.role === "admin" && item.status !== "active") this.users.set(id, { ...item, role: "user", defaultMode: "lightweight", updatedAt: now });
    }
    const next = { ...user, role: claimAdmin ? "admin" as const : user.role, defaultMode: claimAdmin ? "full" as const : user.defaultMode, status: "active" as const, updatedAt: now };
    this.users.set(userId, next);
    return next;
  }

  async getPassword(userId: string): Promise<PasswordCredential | undefined> { return this.passwords.get(userId); }

  async setPassword(userId: string, encoded: string, now: string): Promise<void> {
    this.passwords.set(userId, { userId, encoded, updatedAt: now });
  }

  async createSession(input: CreateSessionInput): Promise<AuthSession> {
    const session: AuthSession = { id: randomUUID(), revokedAt: null, lastSeenAt: input.createdAt, ...input };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSession(tokenHash: string): Promise<AuthSession | undefined> {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
  }

  async listSessions(): Promise<AuthSession[]> {
    return [...this.sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, lastSeenAt, expiresAt });
  }

  async revokeSession(sessionId: string, now: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, revokedAt: now });
  }

  async revokeUserSessions(userId: string, now: string): Promise<void> {
    for (const [id, session] of this.sessions) if (session.userId === userId && !session.revokedAt) {
      this.sessions.set(id, { ...session, revokedAt: now });
    }
  }

  async updateUserForAdmin(userId: string, patch: AdminUserPatch, now: string): Promise<AdminUserStoreUpdateResult> {
    const current = this.users.get(userId);
    if (!current) return { status: "not-found" };
    const role = patch.role ?? current.role;
    const status = patch.status ?? current.status;
    if (patch.defaultMode === "full" && role !== "admin") return { status: "mode-not-allowed" };
    if (current.role === "admin" && current.status === "active" && (role !== "admin" || status !== "active")) {
      const activeAdmins = [...this.users.values()].filter((user) => user.role === "admin" && user.status === "active");
      if (activeAdmins.length <= 1) return { status: "last-admin" };
    }
    const next = {
      ...current,
      role,
      status,
      defaultMode: role === "admin" ? "full" as const : "lightweight" as const,
      updatedAt: now,
    };
    this.users.set(userId, next);
    if (status === "disabled") await this.revokeUserSessions(userId, now);
    return { status: "updated", user: next };
  }

  async recoverAdminAccount(userId: string, encoded: string, now: string): Promise<AdminAccountRecoveryResult | undefined> {
    const current = this.users.get(userId);
    if (!current) return undefined;
    const user = { ...current, role: "admin" as const, status: "active" as const, defaultMode: "full" as const, updatedAt: now };
    this.users.set(userId, user);
    this.passwords.set(userId, { userId, encoded, updatedAt: now });
    let revokedSessionCount = 0;
    for (const [id, session] of this.sessions) {
      if (session.userId === userId && !session.revokedAt) {
        this.sessions.set(id, { ...session, revokedAt: now });
        revokedSessionCount += 1;
      }
    }
    return { user, revokedSessionCount };
  }

  async issueEmailToken(record: EmailTokenRecord): Promise<void> {
    for (const [hash, token] of this.emailTokens) {
      if (token.userId === record.userId && token.purpose === record.purpose && !token.consumedAt) this.emailTokens.delete(hash);
    }
    this.emailTokens.set(record.tokenHash, record);
  }

  async consumeEmailToken(tokenHash: string, purpose: AuthTokenPurpose, now: string): Promise<string | undefined> {
    const token = this.emailTokens.get(tokenHash);
    if (!token || token.purpose !== purpose || token.consumedAt || token.expiresAt <= now) return undefined;
    this.emailTokens.set(tokenHash, { ...token, consumedAt: now });
    return token.userId;
  }

  async issueOAuthState(record: OAuthStateRecord): Promise<void> { this.oauthStates.set(record.stateHash, record); }

  async consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | undefined> {
    const state = this.oauthStates.get(stateHash);
    if (!state || state.consumedAt || state.expiresAt <= now) return undefined;
    this.oauthStates.set(stateHash, { ...state, consumedAt: now });
    return state;
  }

  async issueFeishuPairingToken(record: FeishuPairingTokenRecord): Promise<void> { this.pairingTokens.set(record.tokenHash, record); }

  async findFeishuPairingToken(tokenHash: string, now: string): Promise<FeishuPairingTokenRecord | undefined> {
    const token = this.pairingTokens.get(tokenHash);
    return token && !token.consumedAt && token.expiresAt > now ? token : undefined;
  }

  async commitFeishuPairing(input: CommitFeishuPairingInput): Promise<CommitFeishuPairingResult> {
    const token = this.pairingTokens.get(input.tokenHash);
    if (!token || token.consumedAt || token.expiresAt <= input.now) return { status: "failed" };
    const identityKey = `feishu:${token.openId}`;
    const identity = this.identities.get(identityKey);
    const userId = input.currentUserId ?? identity?.userId;
    if (!userId) return { status: "failed" };
    const user = this.users.get(userId);
    if (!user || user.status !== "active") return { status: "user-unavailable" };
    if (identity && identity.userId !== userId) return { status: "identity-conflict" };
    const resourceKey = token.sessionId ? `session:${token.sessionId}` : null;
    const resource = resourceKey ? this.resources.get(resourceKey) : undefined;
    if (resource && resource.userId !== userId) return { status: "session-conflict" };
    return this.applyPairing(input, { token, user, identityKey, identity, resourceKey, resource });
  }

  /** 允许测试在内存事务的持久化阶段注入故障。 */
  protected pairingCheckpoint(_stage: PairingCheckpoint): void {}

  private applyPairing(input: CommitFeishuPairingInput, context: MemoryPairingContext): CommitFeishuPairingResult {
    const session: AuthSession = {
      id: randomUUID(), userId: context.user.id, tokenHash: input.sessionTokenHash,
      createdAt: input.now, expiresAt: input.sessionExpiresAt, lastSeenAt: input.now,
      revokedAt: null, ipHash: input.ipHash, userAgentHash: input.userAgentHash,
    };
    const previousSession = this.sessions.get(session.id);
    try {
      this.pairingTokens.set(input.tokenHash, { ...context.token, consumedAt: input.now });
      if (!context.identity) {
        this.identities.set(context.identityKey, { provider: "feishu", subject: context.token.openId, unionId: null, userId: context.user.id, createdAt: input.now });
        this.pairingCheckpoint("identity");
      }
      if (context.resourceKey && context.token.sessionId) {
        this.resources.set(context.resourceKey, { resourceType: "session", resourceId: context.token.sessionId, userId: context.user.id, resourcePath: null, createdAt: context.resource?.createdAt ?? input.now });
        this.pairingCheckpoint("session-resource");
      }
      this.sessions.set(session.id, session);
      this.pairingCheckpoint("web-session");
      return { status: "paired", user: context.user, session };
    } catch (error) {
      restoreEntry(this.pairingTokens, input.tokenHash, context.token);
      restoreEntry(this.identities, context.identityKey, context.identity);
      if (context.resourceKey) restoreEntry(this.resources, context.resourceKey, context.resource);
      restoreEntry(this.sessions, session.id, previousSession);
      throw error;
    }
  }

  async findIdentity(provider: "feishu", subject: string): Promise<AuthIdentity | undefined> {
    return this.identities.get(`${provider}:${subject}`);
  }

  async findIdentityByUnion(provider: "feishu", unionId: string): Promise<AuthIdentity | undefined> {
    return [...this.identities.values()].find((identity) => identity.provider === provider && identity.unionId === unionId);
  }

  async createIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    const key = `${identity.provider}:${identity.subject}`;
    if (this.identities.has(key)) throw new Error("identity already exists");
    this.identities.set(key, identity);
    return identity;
  }

  async listIdentities(userId: string): Promise<AuthIdentity[]> {
    return [...this.identities.values()].filter((identity) => identity.userId === userId);
  }

  async listAllIdentities(): Promise<AuthIdentity[]> {
    return [...this.identities.values()];
  }

  async deleteIdentity(userId: string, provider: "feishu", subject: string, options: { protectLastLoginMethod: boolean }): Promise<{ identity?: AuthIdentity; reason?: "not-found" | "last-login-method" }> {
    const key = `${provider}:${subject}`;
    const identity = this.identities.get(key);
    if (!identity || identity.userId !== userId) return { reason: "not-found" };
    if (options.protectLastLoginMethod && [...this.identities.values()].filter((item) => item.userId === userId).length <= 1) return { reason: "last-login-method" };
    this.identities.delete(key);
    return { identity };
  }

  async promoteUserAndPurgeOthers(userId: string, now: string): Promise<PromoteAndPurgeUsersResult | undefined> {
    const target = this.users.get(userId);
    if (!target) return undefined;
    const deletedUserIds = [...this.users.keys()].filter((id) => id !== userId);
    const deleted = new Set(deletedUserIds);
    for (const id of deletedUserIds) this.users.delete(id);
    for (const [id, session] of this.sessions) if (deleted.has(session.userId)) this.sessions.delete(id);
    for (const [id, credential] of this.passwords) if (deleted.has(credential.userId)) this.passwords.delete(id);
    for (const [id, token] of this.emailTokens) if (deleted.has(token.userId)) this.emailTokens.delete(id);
    for (const [id, state] of this.oauthStates) if (state.userId && deleted.has(state.userId)) this.oauthStates.delete(id);
    for (const [id, identity] of this.identities) if (deleted.has(identity.userId)) this.identities.delete(id);
    for (const [id, resource] of this.resources) if (deleted.has(resource.userId)) this.resources.delete(id);
    for (const [key, profile] of this.userModelProfiles) if (deleted.has(profile.userId)) this.userModelProfiles.delete(key);
    for (const userId of deletedUserIds) this.userModelDefaults.delete(userId);
    const user: AuthUser = { ...target, role: "admin", defaultMode: "full", status: "active", updatedAt: now };
    this.users.set(userId, user);
    return { user, deletedUserIds };
  }

  async saveResource(resource: AuthResource): Promise<boolean> {
    const key = `${resource.resourceType}:${resource.resourceId}`;
    const existing = this.resources.get(key);
    if (existing && existing.userId !== resource.userId) return false;
    this.resources.set(key, resource);
    return true;
  }

  async findResource(resourceType: AuthResource["resourceType"], resourceId: string): Promise<AuthResource | undefined> {
    return this.resources.get(`${resourceType}:${resourceId}`);
  }

  async purgeImportedWorkspaceResources(input: ImportedWorkspaceCleanupInput): Promise<number> {
    const session = this.sessions.get(input.operatorSessionId);
    const user = this.users.get(input.operatorUserId);
    if (!session || session.userId !== input.operatorUserId || session.revokedAt
      || session.expiresAt <= input.now || user?.role !== "admin" || user.status !== "active") {
      throw new Error("IMPORT_NOT_AUTHORIZED");
    }
    return 0;
  }

  async listResources(userId: string, resourceType: AuthResource["resourceType"]): Promise<AuthResource[]> {
    return [...this.resources.values()].filter((item) => item.userId === userId && item.resourceType === resourceType);
  }

  async listUserModelProfiles(userId: string): Promise<AuthUserModelProfileRecord[]> {
    return [...this.userModelProfiles.values()]
      .filter((profile) => profile.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(copyUserModelProfile);
  }

  async findUserModelProfile(userId: string, profileId: string): Promise<AuthUserModelProfileRecord | undefined> {
    const profile = this.userModelProfiles.get(userModelProfileKey(userId, profileId));
    return profile ? copyUserModelProfile(profile) : undefined;
  }

  async createUserModelProfile(record: CreateUserModelProfileRecord): Promise<AuthUserModelProfileRecord> {
    const key = userModelProfileKey(record.userId, record.id);
    if (this.userModelProfiles.has(key)) throw new Error("USER_MODEL_PROFILE_EXISTS");
    const stored = copyUserModelProfile(record);
    this.userModelProfiles.set(key, stored);
    return copyUserModelProfile(stored);
  }

  async updateUserModelProfile(record: UpdateUserModelProfileRecord): Promise<AuthUserModelProfileRecord | undefined> {
    const key = userModelProfileKey(record.userId, record.id);
    const current = this.userModelProfiles.get(key);
    if (!current || current.revision !== record.expectedRevision) return undefined;
    const stored = copyUserModelProfile(record);
    this.userModelProfiles.set(key, stored);
    return copyUserModelProfile(stored);
  }

  async deleteUserModelProfile(userId: string, profileId: string, expectedRevision: number): Promise<boolean> {
    const key = userModelProfileKey(userId, profileId);
    const current = this.userModelProfiles.get(key);
    if (!current || current.revision !== expectedRevision) return false;
    this.userModelProfiles.delete(key);
    if (this.userModelDefaults.get(userId) === profileId) this.userModelDefaults.delete(userId);
    return true;
  }

  async getUserModelDefault(userId: string): Promise<string | undefined> {
    return this.userModelDefaults.get(userId);
  }

  async setUserModelDefault(userId: string, profileId: string, _now: string): Promise<boolean> {
    if (!this.userModelProfiles.has(userModelProfileKey(userId, profileId))) return false;
    this.userModelDefaults.set(userId, profileId);
    return true;
  }

  async audit(entry: AuditEntry): Promise<void> { this.auditLog.push(entry); }

  readonly pairingTokens = new Map<string, FeishuPairingTokenRecord>();
}

function restoreEntry<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}

function userModelProfileKey(userId: string, profileId: string): string {
  return `${userId}:${profileId}`;
}

function copyUserModelProfile(profile: AuthUserModelProfileRecord): AuthUserModelProfileRecord {
  return { ...profile, modelIds: [...profile.modelIds] };
}
