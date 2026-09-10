import { randomUUID } from "node:crypto";

import { createPostgresMigrationDatabase, runMigrations } from "dsh-lark-postgres-runtime";
import { Pool, type PoolClient } from "pg";

import { AUTH_MIGRATIONS } from "./migrations.js";
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
  CreateSessionInput,
  CreateUserModelProfileRecord,
  CreateUserInput,
  DeleteIdentityOptions,
  DeleteIdentityResult,
  EmailTokenRecord,
  FeishuPairingTokenRecord,
  OAuthStateRecord,
  PasswordCredential,
  PromoteAndPurgeUsersResult,
  UpdateUserModelProfileRecord,
} from "./types.js";
import type { ImportedWorkspaceCleanupInput } from "./types.js";
import { purgeImportedWorkspaceResources } from "./postgres-imported-workspace-cleanup.js";

type Row = Record<string, unknown>;
type PairingAbortStatus = Exclude<CommitFeishuPairingResult["status"], "paired">;

interface PairingIdentityWrite {
  openId: string;
  userId: string;
  now: string;
}

interface PairingResourceWrite {
  sessionId: string | null;
  userId: string;
  now: string;
}

class PairingCommitAbort extends Error {
  constructor(readonly status: PairingAbortStatus) {
    super(`PAIRING_COMMIT_ABORT:${status}`);
  }
}

function text(value: unknown): string { return typeof value === "string" ? value : String(value); }
function nullableText(value: unknown): string | null { return typeof value === "string" ? value : null; }

function userFromRow(row: Row): AuthUser {
  return {
    id: text(row.id),
    email: text(row.email_normalized),
    displayName: text(row.display_name),
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "pending" || row.status === "disabled" ? row.status : "active",
    defaultMode: row.default_mode === "full" ? "full" : "lightweight",
    createdAt: new Date(text(row.created_at)).toISOString(),
    updatedAt: new Date(text(row.updated_at)).toISOString(),
  };
}

function sessionFromRow(row: Row): AuthSession {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    tokenHash: text(row.token_hash),
    createdAt: new Date(text(row.created_at)).toISOString(),
    expiresAt: new Date(text(row.expires_at)).toISOString(),
    lastSeenAt: new Date(text(row.last_seen_at)).toISOString(),
    revokedAt: row.revoked_at ? new Date(text(row.revoked_at)).toISOString() : null,
    ipHash: nullableText(row.ip_hash),
    userAgentHash: nullableText(row.user_agent_hash),
  };
}

function userModelProfileFromRow(row: Row): AuthUserModelProfileRecord {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    baseUrl: text(row.base_url),
    modelIds: textArray(row.model_ids),
    defaultModel: text(row.default_model),
    keyVersion: Number(row.key_version),
    apiKeyIv: text(row.api_key_iv),
    apiKeyTag: text(row.api_key_tag),
    apiKeyCiphertext: text(row.api_key_ciphertext),
    revision: Number(row.revision),
    createdAt: new Date(text(row.created_at)).toISOString(),
    updatedAt: new Date(text(row.updated_at)).toISOString(),
  };
}

function textArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("INVALID_USER_MODEL_PROFILE_ROW");
  return [...parsed];
}

export class PostgresAuthStore implements AuthStore {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async migrate(): Promise<void> {
    await runMigrations(createPostgresMigrationDatabase(this.pool), AUTH_MIGRATIONS);
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:auth-bootstrap', 0))");
      const count = await client.query<Row>("SELECT count(*)::int AS count FROM auth_users WHERE role = 'admin'");
      const role = input.status === "active" && Number(count.rows[0]?.count ?? 0) === 0 ? "admin" : "user";
      const id = randomUUID();
      const result = await client.query<Row>(
        "INSERT INTO auth_users (id, email_normalized, display_name, role, status, default_mode, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *",
        [id, input.email, input.displayName, role, input.status, role === "admin" ? "full" : "lightweight", input.now],
      );
      await client.query("COMMIT");
      return userFromRow(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findUserByEmail(email: string): Promise<AuthUser | undefined> { return this.oneUser("email_normalized", email); }
  async findUserById(userId: string): Promise<AuthUser | undefined> { return this.oneUser("id", userId); }

  async listUsers(): Promise<AuthUser[]> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_users ORDER BY created_at, id");
    return result.rows.map(userFromRow);
  }

  private async oneUser(column: "id" | "email_normalized", value: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query<Row>(`SELECT * FROM auth_users WHERE ${column} = $1`, [value]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async activateUser(userId: string, now: string): Promise<AuthUser | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:auth-bootstrap', 0))");
      const activeAdmin = await client.query<Row>("SELECT 1 FROM auth_users WHERE role = 'admin' LIMIT 1");
      const claimAdmin = activeAdmin.rowCount === 0;
      if (claimAdmin) await client.query("UPDATE auth_users SET role = 'user', default_mode = 'lightweight', updated_at = $2 WHERE role = 'admin' AND status <> 'active' AND id <> $1", [userId, now]);
      const result = await client.query<Row>(
        "UPDATE auth_users SET status = 'active', role = $2, default_mode = $3, updated_at = $4 WHERE id = $1 AND status <> 'disabled' RETURNING *",
        [userId, claimAdmin ? "admin" : "user", claimAdmin ? "full" : "lightweight", now],
      );
      await client.query("COMMIT");
      return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPassword(userId: string): Promise<PasswordCredential | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_password_credentials WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    return row ? { userId: text(row.user_id), encoded: text(row.encoded), updatedAt: new Date(text(row.updated_at)).toISOString() } : undefined;
  }

  async setPassword(userId: string, encoded: string, now: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO auth_password_credentials (user_id, encoded, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET encoded = EXCLUDED.encoded, updated_at = EXCLUDED.updated_at",
      [userId, encoded, now],
    );
  }

  async createSession(input: CreateSessionInput): Promise<AuthSession> {
    const id = randomUUID();
    const result = await this.pool.query<Row>(
      "INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at,last_seen_at,ip_hash,user_agent_hash) VALUES ($1,$2,$3,$4,$5,$4,$6,$7) RETURNING *",
      [id, input.userId, input.tokenHash, input.createdAt, input.expiresAt, input.ipHash, input.userAgentHash],
    );
    return sessionFromRow(result.rows[0]!);
  }

  async findSession(tokenHash: string): Promise<AuthSession | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async listSessions(): Promise<AuthSession[]> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_sessions ORDER BY created_at DESC, id DESC");
    return result.rows.map(sessionFromRow);
  }

  async touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    await this.pool.query("UPDATE auth_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL", [sessionId, lastSeenAt, expiresAt]);
  }

  async revokeSession(sessionId: string, now: string): Promise<void> { await this.pool.query("UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [sessionId, now]); }
  async revokeUserSessions(userId: string, now: string): Promise<void> { await this.pool.query("UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, now]); }

  async updateUserForAdmin(userId: string, patch: AdminUserPatch, now: string): Promise<AdminUserStoreUpdateResult> {
    const client = await this.pool.connect();
    try {
      return await withAuthTransaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:auth-bootstrap', 0))");
        const target = await client.query<Row>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [userId]);
        if (!target.rows[0]) return { status: "not-found" };
        const user = userFromRow(target.rows[0]);
        const role = patch.role ?? user.role;
        const status = patch.status ?? user.status;
        if (patch.defaultMode === "full" && role !== "admin") return { status: "mode-not-allowed" };
        if (user.role === "admin" && user.status === "active" && (role !== "admin" || status !== "active")) {
          const admins = await client.query("SELECT id FROM auth_users WHERE role = 'admin' AND status = 'active'");
          if ((admins.rowCount ?? 0) <= 1) return { status: "last-admin" };
        }
        const result = await client.query<Row>(
          "UPDATE auth_users SET role = $2, status = $3, default_mode = $4, updated_at = $5 WHERE id = $1 RETURNING *",
          [userId, role, status, role === "admin" ? "full" : "lightweight", now],
        );
        if (status === "disabled") await client.query("UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, now]);
        return { status: "updated", user: userFromRow(result.rows[0]!) };
      });
    } finally {
      client.release();
    }
  }

  async recoverAdminAccount(userId: string, encoded: string, now: string): Promise<AdminAccountRecoveryResult | undefined> {
    const client = await this.pool.connect();
    try {
      return await withAuthTransaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:auth-bootstrap', 0))");
        const target = await client.query<Row>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [userId]);
        if (!target.rows[0]) return undefined;
        const updated = await client.query<Row>(
          "UPDATE auth_users SET role = 'admin', status = 'active', default_mode = 'full', updated_at = $2 WHERE id = $1 RETURNING *",
          [userId, now],
        );
        await client.query(
          `INSERT INTO auth_password_credentials (user_id,encoded,updated_at) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET encoded = EXCLUDED.encoded, updated_at = EXCLUDED.updated_at`,
          [userId, encoded, now],
        );
        const revoked = await client.query(
          "UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
          [userId, now],
        );
        return { user: userFromRow(updated.rows[0]!), revokedSessionCount: revoked.rowCount ?? 0 };
      });
    } finally {
      client.release();
    }
  }

  async issueEmailToken(record: EmailTokenRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE auth_email_tokens SET consumed_at = COALESCE(consumed_at, now()) WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL", [record.userId, record.purpose]);
      await client.query(
        "INSERT INTO auth_email_tokens (token_hash,user_id,purpose,expires_at,consumed_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, purpose = EXCLUDED.purpose, expires_at = EXCLUDED.expires_at, consumed_at = EXCLUDED.consumed_at",
        [record.tokenHash, record.userId, record.purpose, record.expiresAt, record.consumedAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeEmailToken(tokenHash: string, purpose: AuthTokenPurpose, now: string): Promise<string | undefined> {
    const result = await this.pool.query<Row>("UPDATE auth_email_tokens SET consumed_at = $3 WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > $3 RETURNING user_id", [tokenHash, purpose, now]);
    const userId = result.rows[0]?.user_id;
    return userId ? text(userId) : undefined;
  }

  async issueOAuthState(record: OAuthStateRecord): Promise<void> { await this.pool.query("INSERT INTO auth_oauth_states (state_hash,user_id,return_path,expires_at) VALUES ($1,$2,$3,$4)", [record.stateHash, record.userId, record.returnPath, record.expiresAt]); }

  async consumeOAuthState(stateHash: string, now: string): Promise<OAuthStateRecord | undefined> {
    const result = await this.pool.query<Row>("UPDATE auth_oauth_states SET consumed_at = $2 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2 RETURNING *", [stateHash, now]);
    const row = result.rows[0];
    return row ? { stateHash: text(row.state_hash), userId: nullableText(row.user_id), returnPath: text(row.return_path), expiresAt: new Date(text(row.expires_at)).toISOString(), consumedAt: new Date(text(row.consumed_at)).toISOString() } : undefined;
  }

  async issueFeishuPairingToken(record: FeishuPairingTokenRecord): Promise<void> {
    await this.pool.query("INSERT INTO auth_feishu_pairing_tokens (token_hash,open_id,session_id,expires_at) VALUES ($1,$2,$3,$4)", [record.tokenHash, record.openId, record.sessionId, record.expiresAt]);
  }

  async findFeishuPairingToken(tokenHash: string, now: string): Promise<FeishuPairingTokenRecord | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_feishu_pairing_tokens WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2", [tokenHash, now]);
    const row = result.rows[0];
    return row ? { tokenHash: text(row.token_hash), openId: text(row.open_id), sessionId: nullableText(row.session_id), expiresAt: new Date(text(row.expires_at)).toISOString(), consumedAt: null } : undefined;
  }

  async commitFeishuPairing(input: CommitFeishuPairingInput): Promise<CommitFeishuPairingResult> {
    const client = await this.pool.connect();
    try {
      return await withAuthTransaction(client, () => this.commitPairingTransaction(client, input));
    } catch (error) {
      if (error instanceof PairingCommitAbort) return { status: error.status };
      throw error;
    } finally {
      client.release();
    }
  }

  private async commitPairingTransaction(client: PoolClient, input: CommitFeishuPairingInput): Promise<CommitFeishuPairingResult> {
    const tokenResult = await client.query<Row>(
      "SELECT * FROM auth_feishu_pairing_tokens WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2 FOR UPDATE",
      [input.tokenHash, input.now],
    );
    const token = tokenResult.rows[0];
    if (!token) throw new PairingCommitAbort("failed");
    const openId = text(token.open_id);
    const user = await this.resolvePairingUser(client, input.currentUserId, openId);
    await this.ensurePairingIdentity(client, { openId, userId: user.id, now: input.now });
    await this.linkPairingResource(client, { sessionId: nullableText(token.session_id), userId: user.id, now: input.now });
    await client.query("UPDATE auth_feishu_pairing_tokens SET consumed_at = $2 WHERE token_hash = $1", [input.tokenHash, input.now]);
    const sessionResult = await client.query<Row>(
      "INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at,last_seen_at,ip_hash,user_agent_hash) VALUES ($1,$2,$3,$4,$5,$4,$6,$7) RETURNING *",
      [randomUUID(), user.id, input.sessionTokenHash, input.now, input.sessionExpiresAt, input.ipHash, input.userAgentHash],
    );
    return { status: "paired", user, session: sessionFromRow(sessionResult.rows[0]!) };
  }

  private async resolvePairingUser(client: PoolClient, currentUserId: string | null, openId: string): Promise<AuthUser> {
    let userId = currentUserId;
    if (!userId) {
      const identity = await client.query<Row>("SELECT user_id FROM auth_identities WHERE provider = 'feishu' AND subject = $1", [openId]);
      if (!identity.rows[0]) throw new PairingCommitAbort("failed");
      userId = text(identity.rows[0].user_id);
    }
    const userResult = await client.query<Row>("SELECT * FROM auth_users WHERE id = $1 AND status = 'active' FOR UPDATE", [userId]);
    if (!userResult.rows[0]) throw new PairingCommitAbort("user-unavailable");
    await lockPairingKey(client, "identity", openId);
    const identity = await client.query<Row>("SELECT user_id FROM auth_identities WHERE provider = 'feishu' AND subject = $1 FOR UPDATE", [openId]);
    if (!currentUserId && !identity.rows[0]) throw new PairingCommitAbort("failed");
    if (identity.rows[0] && text(identity.rows[0].user_id) !== userId) throw new PairingCommitAbort("identity-conflict");
    return userFromRow(userResult.rows[0]);
  }

  private async ensurePairingIdentity(client: PoolClient, input: PairingIdentityWrite): Promise<void> {
    await client.query(
      "INSERT INTO auth_identities (provider,subject,union_id,user_id,created_at) VALUES ('feishu',$1,NULL,$2,$3) ON CONFLICT (provider,subject) DO NOTHING",
      [input.openId, input.userId, input.now],
    );
    const owner = await client.query<Row>("SELECT user_id FROM auth_identities WHERE provider = 'feishu' AND subject = $1 FOR UPDATE", [input.openId]);
    if (!owner.rows[0] || text(owner.rows[0].user_id) !== input.userId) throw new PairingCommitAbort("identity-conflict");
  }

  private async linkPairingResource(client: PoolClient, input: PairingResourceWrite): Promise<void> {
    if (!input.sessionId) return;
    await lockPairingKey(client, "session", input.sessionId);
    const result = await client.query(
      "INSERT INTO auth_resources (resource_type,resource_id,user_id,resource_path,created_at) VALUES ('session',$1,$2,NULL,$3) ON CONFLICT (resource_type,resource_id) DO UPDATE SET resource_path = EXCLUDED.resource_path WHERE auth_resources.user_id = EXCLUDED.user_id RETURNING resource_id",
      [input.sessionId, input.userId, input.now],
    );
    if (!result.rowCount) throw new PairingCommitAbort("session-conflict");
  }

  async findIdentity(provider: "feishu", subject: string): Promise<AuthIdentity | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_identities WHERE provider = $1 AND subject = $2", [provider, subject]);
    return result.rows[0] ? this.identityFromRow(result.rows[0]) : undefined;
  }

  async findIdentityByUnion(provider: "feishu", unionId: string): Promise<AuthIdentity | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_identities WHERE provider = $1 AND union_id = $2", [provider, unionId]);
    return result.rows[0] ? this.identityFromRow(result.rows[0]) : undefined;
  }

  async createIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    const result = await this.pool.query<Row>("INSERT INTO auth_identities (provider,subject,union_id,user_id,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *", [identity.provider, identity.subject, identity.unionId, identity.userId, identity.createdAt]);
    return this.identityFromRow(result.rows[0]!);
  }

  async listIdentities(userId: string): Promise<AuthIdentity[]> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_identities WHERE user_id = $1 ORDER BY created_at, provider, subject", [userId]);
    return result.rows.map((row) => this.identityFromRow(row));
  }

  async listAllIdentities(): Promise<AuthIdentity[]> {
    const result = await this.pool.query<Row>("SELECT * FROM auth_identities ORDER BY created_at, provider, subject");
    return result.rows.map((row) => this.identityFromRow(row));
  }

  async deleteIdentity(userId: string, provider: "feishu", subject: string, options: DeleteIdentityOptions): Promise<DeleteIdentityResult> {
    const client = await this.pool.connect();
    try {
      return await withAuthTransaction(client, async () => {
        const owner = await client.query("SELECT id FROM auth_users WHERE id = $1 FOR UPDATE", [userId]);
        if (!owner.rowCount) return { reason: "not-found" };
        const target = await client.query<Row>("SELECT * FROM auth_identities WHERE provider = $1 AND subject = $2 AND user_id = $3", [provider, subject, userId]);
        if (!target.rows[0]) return { reason: "not-found" };
        if (options.protectLastLoginMethod) {
          const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM auth_identities WHERE user_id = $1", [userId]);
          if (Number(count.rows[0]?.count ?? "0") <= 1) return { reason: "last-login-method" };
        }
        const deleted = await client.query<Row>("DELETE FROM auth_identities WHERE provider = $1 AND subject = $2 AND user_id = $3 RETURNING *", [provider, subject, userId]);
        return deleted.rows[0] ? { identity: this.identityFromRow(deleted.rows[0]) } : { reason: "not-found" };
      });
    } finally {
      client.release();
    }
  }

  async promoteUserAndPurgeOthers(userId: string, now: string): Promise<PromoteAndPurgeUsersResult | undefined> {
    const client = await this.pool.connect();
    try {
      return await withAuthTransaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dsh-lark:auth-bootstrap', 0))");
        const target = await client.query<Row>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [userId]);
        if (!target.rows[0]) return undefined;
        const deleted = await client.query<Row>("DELETE FROM auth_users WHERE id <> $1 RETURNING id", [userId]);
        const updated = await client.query<Row>("UPDATE auth_users SET role = 'admin', default_mode = 'full', status = 'active', updated_at = $2 WHERE id = $1 RETURNING *", [userId, now]);
        return { user: userFromRow(updated.rows[0]!), deletedUserIds: deleted.rows.map((row) => text(row.id)) };
      });
    } finally {
      client.release();
    }
  }

  private identityFromRow(row: Row): AuthIdentity {
    return { provider: "feishu", subject: text(row.subject), unionId: nullableText(row.union_id), userId: text(row.user_id), createdAt: new Date(text(row.created_at)).toISOString() };
  }

  async saveResource(resource: AuthResource): Promise<boolean> {
    const result = await this.pool.query("INSERT INTO auth_resources (resource_type,resource_id,user_id,resource_path,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (resource_type,resource_id) DO UPDATE SET resource_path = EXCLUDED.resource_path WHERE auth_resources.user_id = EXCLUDED.user_id", [resource.resourceType, resource.resourceId, resource.userId, resource.resourcePath, resource.createdAt]);
    return (result.rowCount ?? 0) > 0;
  }
  async findResource(resourceType: AuthResource["resourceType"], resourceId: string): Promise<AuthResource | undefined> { const result = await this.pool.query<Row>("SELECT * FROM auth_resources WHERE resource_type = $1 AND resource_id = $2", [resourceType, resourceId]); return result.rows[0] ? this.resourceFromRow(result.rows[0]) : undefined; }
  purgeImportedWorkspaceResources(input: ImportedWorkspaceCleanupInput): Promise<number> {
    return purgeImportedWorkspaceResources(this.pool, input);
  }
  async listResources(userId: string, resourceType: AuthResource["resourceType"]): Promise<AuthResource[]> { const result = await this.pool.query<Row>("SELECT * FROM auth_resources WHERE user_id = $1 AND resource_type = $2 ORDER BY created_at", [userId, resourceType]); return result.rows.map((row) => this.resourceFromRow(row)); }

  async listUserModelProfiles(userId: string): Promise<AuthUserModelProfileRecord[]> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM auth_user_model_profiles WHERE user_id = $1 ORDER BY updated_at DESC, id",
      [userId],
    );
    return result.rows.map(userModelProfileFromRow);
  }

  async findUserModelProfile(userId: string, profileId: string): Promise<AuthUserModelProfileRecord | undefined> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM auth_user_model_profiles WHERE user_id = $1 AND id = $2",
      [userId, profileId],
    );
    return result.rows[0] ? userModelProfileFromRow(result.rows[0]) : undefined;
  }

  async createUserModelProfile(record: CreateUserModelProfileRecord): Promise<AuthUserModelProfileRecord> {
    const result = await this.pool.query<Row>(
      `INSERT INTO auth_user_model_profiles
        (id,user_id,display_name,base_url,model_ids,default_model,key_version,api_key_iv,api_key_tag,api_key_ciphertext,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [record.id, record.userId, record.displayName, record.baseUrl, JSON.stringify(record.modelIds), record.defaultModel,
        record.keyVersion, record.apiKeyIv, record.apiKeyTag, record.apiKeyCiphertext, record.revision, record.createdAt, record.updatedAt],
    );
    return userModelProfileFromRow(result.rows[0]!);
  }

  async updateUserModelProfile(record: UpdateUserModelProfileRecord): Promise<AuthUserModelProfileRecord | undefined> {
    const result = await this.pool.query<Row>(
      `UPDATE auth_user_model_profiles
       SET display_name = $4, base_url = $5, model_ids = $6::jsonb, default_model = $7,
           key_version = $8, api_key_iv = $9, api_key_tag = $10, api_key_ciphertext = $11,
           revision = $12, updated_at = $13
       WHERE user_id = $1 AND id = $2 AND revision = $3 RETURNING *`,
      [record.userId, record.id, record.expectedRevision, record.displayName, record.baseUrl, JSON.stringify(record.modelIds),
        record.defaultModel, record.keyVersion, record.apiKeyIv, record.apiKeyTag, record.apiKeyCiphertext,
        record.revision, record.updatedAt],
    );
    return result.rows[0] ? userModelProfileFromRow(result.rows[0]) : undefined;
  }

  async deleteUserModelProfile(userId: string, profileId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM auth_user_model_profiles WHERE user_id = $1 AND id = $2 AND revision = $3",
      [userId, profileId, expectedRevision],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async getUserModelDefault(userId: string): Promise<string | undefined> {
    const result = await this.pool.query<Row>("SELECT profile_id FROM auth_user_model_defaults WHERE user_id = $1", [userId]);
    return result.rows[0] ? text(result.rows[0].profile_id) : undefined;
  }

  async setUserModelDefault(userId: string, profileId: string, now: string): Promise<boolean> {
    const result = await this.pool.query<Row>(
      `WITH owned AS (
         SELECT id FROM auth_user_model_profiles WHERE user_id = $1 AND id = $2
       )
       INSERT INTO auth_user_model_defaults (user_id, profile_id, updated_at)
       SELECT $1, id, $3 FROM owned
       ON CONFLICT (user_id) DO UPDATE
         SET profile_id = EXCLUDED.profile_id, updated_at = EXCLUDED.updated_at
       RETURNING profile_id`,
      [userId, profileId, now],
    );
    return Boolean(result.rows[0]);
  }

  private resourceFromRow(row: Row): AuthResource { return { resourceType: row.resource_type === "workspace" ? "workspace" : "session", resourceId: text(row.resource_id), userId: text(row.user_id), resourcePath: nullableText(row.resource_path), createdAt: new Date(text(row.created_at)).toISOString() }; }

  async audit(entry: AuditEntry): Promise<void> { await this.pool.query("INSERT INTO auth_audit_log (action,user_id,request_id,ip_hash,user_agent_hash,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [entry.action, entry.userId, entry.requestId, entry.ipHash, entry.userAgentHash, entry.metadata ?? {}, entry.createdAt]); }
  async close(): Promise<void> { await this.pool.end(); }
}

export async function withAuthTransaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try { const result = await run(); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function lockPairingKey(client: PoolClient, kind: "identity" | "session", value: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`dsh-lark:feishu-pairing:${kind}:${value}`]);
}
