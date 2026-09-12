import type { FeishuBotStore } from "./feishu-bot-store.js";

export type AuthRole = "admin" | "user";
export type AuthStatus = "pending" | "active" | "disabled";
export type AuthMode = "full" | "lightweight";
export type AuthTokenPurpose = "verify-email" | "reset-password";
export type AuthResourceType = "session" | "workspace";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: AuthRole;
  status: AuthStatus;
  defaultMode: AuthMode;
  createdAt: string;
  updatedAt: string;
}

export interface ImportedWorkspaceCleanupInput {
  runId: string;
  operatorUserId: string;
  operatorSessionId: string;
  requestId: string;
  now: string;
}

/** 管理面允许修改的用户字段；角色与默认模式由 Auth 事务共同约束。 */
export interface AdminUserPatch {
  role?: AuthRole;
  status?: Extract<AuthStatus, "active" | "disabled">;
  defaultMode?: AuthMode;
}

export type AdminUserStoreUpdateResult =
  | { status: "updated"; user: AuthUser }
  | { status: "not-found" }
  | { status: "last-admin" }
  | { status: "mode-not-allowed" };

export interface AdminAccountRecoveryResult {
  user: AuthUser;
  revokedSessionCount: number;
}

export interface AdminUserSummary extends AuthUser {
  sessionCount: number;
  workspaceCount: number;
  identityCount: number;
}

export interface AdminSessionSummary {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: AuthRole;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface AdminUserSessionRevokeResult {
  userId: string;
  revokedCount: number;
}

export interface PasswordCredential {
  userId: string;
  encoded: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface EmailTokenRecord {
  tokenHash: string;
  userId: string;
  purpose: AuthTokenPurpose;
  expiresAt: string;
  consumedAt: string | null;
}

export interface OAuthStateRecord {
  stateHash: string;
  userId: string | null;
  returnPath: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface FeishuPairingTokenRecord {
  tokenHash: string;
  openId: string;
  /** 配对发起时当前飞书 deterministic session；缺省表示只登录不映射会话。 */
  sessionId: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface AuthIdentity {
  provider: "feishu";
  subject: string;
  unionId: string | null;
  userId: string;
  createdAt: string;
}

export interface DeleteIdentityOptions {
  protectLastLoginMethod: boolean;
}

export interface DeleteIdentityResult {
  identity?: AuthIdentity;
  reason?: "not-found" | "last-login-method";
}

export interface PromoteAndPurgeUsersResult {
  user: AuthUser;
  deletedUserIds: string[];
}

export interface AuthResource {
  resourceType: AuthResourceType;
  resourceId: string;
  userId: string;
  resourcePath: string | null;
  createdAt: string;
}

/**
 * 仅服务端持有的用户私有模型档案。密文字段绝不能透过 Edge、审计或前端返回。
 * `revision` 同时是乐观并发版本，且参与 API Key 的 AEAD 关联数据。
 */
export interface AuthUserModelProfileRecord {
  id: string;
  userId: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  keyVersion: number;
  apiKeyIv: string;
  apiKeyTag: string;
  apiKeyCiphertext: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 可安全返回浏览器的用户私有模型档案。 */
export interface AuthUserModelProfilePublic {
  id: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  keyConfigured: true;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateUserModelProfileRecord = AuthUserModelProfileRecord;

export interface UpdateUserModelProfileRecord extends AuthUserModelProfileRecord {
  expectedRevision: number;
}

/** 浏览器写入的私有档案草稿；密钥只在这条入站链路中出现一次。 */
export interface UserModelProfileDraft {
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  apiKey: string;
}

/** 更新时 omission 表示不改字段；缺少 apiKey 表示保留已配置的密钥。 */
export interface UserModelProfilePatch {
  expectedRevision: number;
  displayName?: string;
  baseUrl?: string;
  modelIds?: string[];
  defaultModel?: string;
  apiKey?: string;
}

/** 仅 Auth Edge 到 Worker 的短生命周期路由，调用结束后不得保留。 */
export interface UserModelRuntimeRoute {
  profileId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  revision: number;
}

/** 可放入受信任 scope 的无密钥引用；Worker 必须再向 Auth Edge 换取一次性路由。 */
export interface UserModelRuntimeRouteRef {
  profileId: string;
  revision: number;
  model: string;
}

export type UserModelProfileUpdateResult =
  | { status: "updated"; profile: AuthUserModelProfilePublic }
  | { status: "not-found" }
  | { status: "conflict" };

export interface AuditEntry {
  action: string;
  userId: string | null;
  requestId: string;
  ipHash: string | null;
  userAgentHash: string | null;
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  status: AuthStatus;
  now: string;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface CommitFeishuPairingInput {
  tokenHash: string;
  currentUserId: string | null;
  now: string;
  sessionTokenHash: string;
  sessionExpiresAt: string;
  ipHash: string | null;
  userAgentHash: string | null;
}

export type CommitFeishuPairingResult =
  | { status: "paired"; user: AuthUser; session: AuthSession }
  | { status: "failed" }
  | { status: "user-unavailable" }
  | { status: "identity-conflict" }
  | { status: "session-conflict" };

export interface AuthStore {
  readonly feishuBots: FeishuBotStore;
  createUser(input: CreateUserInput): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<AuthUser | undefined>;
  findUserById(userId: string): Promise<AuthUser | undefined>;
  listUsers(): Promise<AuthUser[]>;
  activateUser(userId: string, now: string): Promise<AuthUser | undefined>;
  getPassword(userId: string): Promise<PasswordCredential | undefined>;
  setPassword(userId: string, encoded: string, now: string): Promise<void>;
  createSession(input: CreateSessionInput): Promise<AuthSession>;
  findSession(tokenHash: string): Promise<AuthSession | undefined>;
  listSessions(): Promise<AuthSession[]>;
  touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  revokeSession(sessionId: string, now: string): Promise<void>;
  revokeUserSessions(userId: string, now: string): Promise<void>;
  updateUserForAdmin(userId: string, patch: AdminUserPatch, now: string): Promise<AdminUserStoreUpdateResult>;
  recoverAdminAccount(userId: string, encoded: string, now: string): Promise<AdminAccountRecoveryResult | undefined>;
  issueEmailToken(record: EmailTokenRecord): Promise<void>;
  consumeEmailToken(tokenHash: string, purpose: AuthTokenPurpose, now: string): Promise<string | undefined>;
  issueOAuthState(record: OAuthStateRecord): Promise<void>;
  consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | undefined>;
  issueFeishuPairingToken(record: FeishuPairingTokenRecord): Promise<void>;
  findFeishuPairingToken(tokenHash: string, now: string): Promise<FeishuPairingTokenRecord | undefined>;
  commitFeishuPairing(input: CommitFeishuPairingInput): Promise<CommitFeishuPairingResult>;
  findIdentity(provider: "feishu", subject: string): Promise<AuthIdentity | undefined>;
  findIdentityByUnion(provider: "feishu", unionId: string): Promise<AuthIdentity | undefined>;
  createIdentity(identity: AuthIdentity): Promise<AuthIdentity>;
  listIdentities(userId: string): Promise<AuthIdentity[]>;
  listAllIdentities(): Promise<AuthIdentity[]>;
  deleteIdentity(userId: string, provider: "feishu", subject: string, options: DeleteIdentityOptions): Promise<DeleteIdentityResult>;
  promoteUserAndPurgeOthers(userId: string, now: string): Promise<PromoteAndPurgeUsersResult | undefined>;
  saveResource(resource: AuthResource): Promise<boolean>;
  findResource(resourceType: AuthResourceType, resourceId: string): Promise<AuthResource | undefined>;
  purgeImportedWorkspaceResources(input: ImportedWorkspaceCleanupInput): Promise<number>;
  listResources(userId: string, resourceType: AuthResourceType): Promise<AuthResource[]>;
  listUserModelProfiles(userId: string): Promise<AuthUserModelProfileRecord[]>;
  findUserModelProfile(userId: string, profileId: string): Promise<AuthUserModelProfileRecord | undefined>;
  createUserModelProfile(record: CreateUserModelProfileRecord): Promise<AuthUserModelProfileRecord>;
  updateUserModelProfile(record: UpdateUserModelProfileRecord): Promise<AuthUserModelProfileRecord | undefined>;
  deleteUserModelProfile(userId: string, profileId: string, expectedRevision: number): Promise<boolean>;
  getUserModelDefault(userId: string): Promise<string | undefined>;
  setUserModelDefault(userId: string, profileId: string, now: string): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
  close?(): Promise<void>;
}

export interface MailSender {
  sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void>;
  sendPasswordReset(input: { to: string; displayName: string; token: string }): Promise<void>;
}

export interface FeishuProfile {
  openId: string;
  unionId?: string;
  email?: string;
  name?: string;
}

export interface AuthServiceOptions {
  store: AuthStore;
  mail: MailSender;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  sessionTtlMs?: number;
  emailTokenTtlMs?: number;
  oauthStateTtlMs?: number;
  pairingTokenTtlMs?: number;
  resetBaseUrl?: string;
  /** 独立于系统凭据的 32-byte 用户模型 AES-256-GCM 主密钥。 */
  userModelEncryptionKey?: string;
}

export interface SessionResult {
  user: AuthUser;
  session: AuthSession;
  token: string;
  pairingBound?: boolean;
}

export interface OAuthLoginResult extends SessionResult {
  created: boolean;
  returnPath: string;
}

export interface FeishuPairingResult extends SessionResult {
  created: boolean;
}
