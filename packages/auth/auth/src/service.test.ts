import { describe, expect, it } from "vitest";

import { accessPolicy, hashOpaqueToken } from "./index.js";
import { MemoryAuthStore } from "./memory-store.js";
import { AuthService } from "./service.js";
import type { AuthUser, MailSender } from "./types.js";

class FakeMail implements MailSender {
  readonly verification: string[] = [];
  readonly reset: string[] = [];
  async sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void> { this.verification.push(input.code); }
  async sendPasswordReset(input: { to: string; displayName: string; token: string }): Promise<void> { this.reset.push(input.token); }
}

type PairingFaultStage = "identity" | "session-resource" | "web-session";

class FaultingMemoryAuthStore extends MemoryAuthStore {
  faultStage: PairingFaultStage | undefined;

  protected override pairingCheckpoint(stage: PairingFaultStage): void { this.fail(stage); }

  private fail(stage: PairingFaultStage): void {
    if (this.faultStage === stage) throw new Error(`PAIRING_FAULT_${stage}`);
  }
}

function makeService(store: MemoryAuthStore, mail: MailSender, clock: { now: number }): AuthService {
  let sequence = 0;
  return new AuthService({
    store,
    mail,
    now: () => clock.now,
    randomBytes: (size) => Buffer.alloc(size, sequence++ % 255),
    sessionTtlMs: 60_000,
    emailTokenTtlMs: 60_000,
    oauthStateTtlMs: 60_000,
    userModelEncryptionKey: Buffer.alloc(32, 17).toString("base64url"),
  });
}

const metadata = { requestId: "req-1", ip: "127.0.0.1", userAgent: "vitest" };

describe("AuthService", () => {
  it("registers pending users, verifies email, and gives the first user admin/full", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);

    await expect(service.register(" Admin@Example.com ", "correct horse battery staple", "Admin", metadata)).resolves.toEqual({ accepted: true, duplicate: false });
    const pending = [...store.users.values()][0]!;
    expect(pending.role).toBe("user");
    expect(pending.status).toBe("pending");
    expect(mail.verification).toHaveLength(1);

    const result = await service.verifyEmailCode("admin@example.com", mail.verification[0]!, metadata);
    expect(result?.user.status).toBe("active");
    expect(result?.user.defaultMode).toBe("full");
    expect(result?.token).toBeTruthy();
    expect(await service.current(result?.token, metadata)).toMatchObject({ user: { role: "admin" } });
  });

  it("does not disclose duplicate registration and revokes sessions on password reset", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    await service.register("user@example.com", "correct horse battery staple", "User", metadata);
    await service.verifyEmailCode("user@example.com", mail.verification.at(-1)!, metadata);
    const login = await service.login("USER@example.com", "correct horse battery staple", metadata);
    expect(login).toBeTruthy();
    await service.forgotPassword("user@example.com", metadata);
    const resetUrl = mail.reset.at(-1)!;
    const reset = await service.resetPassword(new URL(resetUrl, "http://test").searchParams.get("token")!, "new correct horse battery staple", metadata);
    expect(reset).toBeTruthy();
    expect(await service.current(login!.token, metadata)).toBeUndefined();
    expect(await service.login("user@example.com", "new correct horse battery staple", metadata)).toBeTruthy();
    expect(await service.register("USER@example.com", "another correct horse battery staple", "Other", metadata)).toEqual({ accepted: true, duplicate: true });
  });

  it("按用户隔离私有模型档案，密钥不回显且更新会重封装", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-09-01T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    await service.register("model-owner@example.com", "correct horse battery staple", "Owner", metadata);
    const owner = await service.verifyEmailCode("model-owner@example.com", mail.verification.at(-1)!, metadata);
    await service.register("model-other@example.com", "correct horse battery staple", "Other", metadata);
    const other = await service.verifyEmailCode("model-other@example.com", mail.verification.at(-1)!, metadata);

    const created = await service.createMyModelProfile(owner!.user.id, {
      displayName: "我的兼容接口",
      baseUrl: "https://models.example.test/v1",
      modelIds: ["chat-a", "chat-b"],
      defaultModel: "chat-a",
      apiKey: "secret-api-key-never-returned",
    }, metadata);
    expect(created).toMatchObject({ keyConfigured: true, defaultModel: "chat-a", revision: 1 });
    expect(JSON.stringify(created)).not.toContain("secret-api-key-never-returned");
    expect(await service.listMyModelProfiles(other!.user.id)).toEqual([]);
    expect(await service.resolveMyDefaultModelRoute(other!.user.id)).toBeUndefined();
    await expect(service.setMyModelDefault(other!.user.id, created.id, metadata)).resolves.toBe(false);

    const before = await store.findUserModelProfile(owner!.user.id, created.id);
    const updated = await service.updateMyModelProfile(owner!.user.id, created.id, {
      expectedRevision: created.revision,
      displayName: "我的新版接口",
      defaultModel: "chat-b",
    }, metadata);
    expect(updated).toMatchObject({ status: "updated", profile: { revision: 2, defaultModel: "chat-b", keyConfigured: true } });
    const after = await store.findUserModelProfile(owner!.user.id, created.id);
    expect(after?.apiKeyCiphertext).not.toBe(before?.apiKeyCiphertext);
    await expect(service.resolveMyDefaultModelRoute(owner!.user.id)).resolves.toMatchObject({
      profileId: created.id,
      baseUrl: "https://models.example.test/v1",
      model: "chat-b",
      apiKey: "secret-api-key-never-returned",
      revision: 2,
    });
    await expect(service.updateMyModelProfile(owner!.user.id, created.id, { expectedRevision: 1 }, metadata)).resolves.toEqual({ status: "conflict" });
    await expect(service.getMyDefaultModelProfileId(owner!.user.id)).resolves.toBe(created.id);
    await expect(service.deleteMyModelProfile(owner!.user.id, created.id, 2, metadata)).resolves.toBe("deleted");
    await expect(service.getMyDefaultModelProfileId(owner!.user.id)).resolves.toBeUndefined();
    await expect(service.resolveMyDefaultModelRouteRef(owner!.user.id)).resolves.toBeUndefined();
  });

  it("builds admin user/session summaries and protects the last administrator", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", metadata);
    const admin = await service.verifyEmailCode("admin@example.com", mail.verification.at(-1)!, metadata);
    await service.register("member@example.com", "correct horse battery staple", "Member", metadata);
    const member = await service.verifyEmailCode("member@example.com", mail.verification.at(-1)!, metadata);
    await service.saveResource({ resourceType: "workspace", resourceId: "member-workspace", userId: member!.user.id, resourcePath: "D:/users/member", createdAt: "2026-08-19T00:00:00.000Z" });
    const users = await service.listAdminUsers();
    expect(users).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "admin@example.com", role: "admin", sessionCount: 1 }),
      expect.objectContaining({ email: "member@example.com", workspaceCount: 1, identityCount: 0 }),
    ]));
    const sessions = await service.listAdminSessions();
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ userId: admin!.user.id, email: "admin@example.com" })]));
    await expect(service.updateUserForAdmin(member!.user.id, { defaultMode: "full" }, metadata)).resolves.toEqual({ status: "mode-not-allowed" });
    await expect(service.updateUserForAdmin(member!.user.id, { role: "admin" }, metadata)).resolves.toMatchObject({ status: "updated", user: { role: "admin", defaultMode: "full" } });
    await expect(service.updateUserForAdmin(admin!.user.id, { role: "user" }, metadata)).resolves.toMatchObject({ status: "updated", user: { role: "user", defaultMode: "lightweight" } });
    await expect(service.updateUserForAdmin(member!.user.id, { role: "user" }, metadata)).resolves.toEqual({ status: "last-admin" });
    await expect(service.updateUserForAdmin(admin!.user.id, { status: "disabled" }, metadata)).resolves.toMatchObject({ status: "updated", user: { status: "disabled" } });
    expect((await service.listAdminSessions()).find((session) => session.userId === admin!.user.id)?.revokedAt).toEqual(expect.any(String));
    const revoked = await service.revokeAdminSession(admin!.session.id, metadata);
    expect(revoked).toMatchObject({ id: admin!.session.id, revokedAt: expect.any(String) });
  });

  it("revokes every active session for an administrator-managed user", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", metadata);
    const admin = await service.verifyEmailCode("admin@example.com", mail.verification.at(-1)!, metadata);
    expect(admin).toBeTruthy();
    const secondSession = await service.login("admin@example.com", "correct horse battery staple", metadata);
    expect(secondSession).toBeTruthy();
    const result = await service.revokeAdminUserSessions(admin!.user.id, metadata);
    expect(result).toEqual({ userId: admin!.user.id, revokedCount: 2 });
    expect((await service.listAdminSessions()).filter((session) => session.userId === admin!.user.id).every((session) => session.revokedAt)).toBe(true);
    expect(secondSession!.session.id).not.toBe(admin!.session.id);
  });

  it("keeps one active administrator when two disable requests race", async () => {
    const store = new MemoryAuthStore();
    const service = makeService(store, new FakeMail(), { now: Date.parse("2026-08-19T00:00:00.000Z") });
    const first = activeAdmin("admin-1", "first-admin@example.com");
    const second = activeAdmin("admin-2", "second-admin@example.com");
    store.users.set(first.id, first);
    store.users.set(second.id, second);

    const results = await Promise.all([
      service.updateUserForAdmin(first.id, { status: "disabled" }, metadata),
      service.updateUserForAdmin(second.id, { status: "disabled" }, metadata),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["last-admin", "updated"]);
    expect([...store.users.values()].filter((user) => user.role === "admin" && user.status === "active")).toHaveLength(1);
  });

  it("issues a short-lived migration operator session only for an active administrator", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("admin-operator@example.com", "correct horse battery staple", "Admin", metadata);
    const admin = await service.verifyEmailCode("admin-operator@example.com", mail.verification.at(-1)!, metadata);
    await service.register("member-operator@example.com", "correct horse battery staple", "Member", metadata);
    const member = await service.verifyEmailCode("member-operator@example.com", mail.verification.at(-1)!, metadata);

    await expect(service.issueMigrationOperatorSession(member!.user.id, metadata)).resolves.toBeUndefined();
    await expect(service.issueMigrationOperatorSession(admin!.user.id, metadata)).resolves.toMatchObject({
      userId: admin!.user.id,
      expiresAt: "2026-08-19T00:10:00.000Z",
      revokedAt: null,
    });
  });

  it("resends a pairing verification for a pending account with the matching password", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    await service.register("pending@example.com", "correct horse battery staple", "Pending", metadata);

    const resent = await service.register("pending@example.com", "correct horse battery staple", "Pending", metadata, { pairingToken: "pair-token" });
    expect(resent).toEqual({ accepted: true, duplicate: true, resent: true });
    expect(mail.verification).toHaveLength(2);
    expect(mail.verification.at(-1)).toMatch(/^\d{6}$/);
  });

  it("rejects malformed, superseded, and replayed verification codes", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("codes@example.com", "correct horse battery staple", "Codes", metadata);
    const firstCode = mail.verification[0]!;

    await expect(service.verifyEmailCode("codes@example.com", "12345", metadata)).rejects.toThrow("INVALID_VERIFICATION_CODE");
    await expect(service.verifyEmailCode("codes@example.com", "999999", metadata)).resolves.toBeUndefined();

    await expect(service.register("codes@example.com", "correct horse battery staple", "Codes", metadata)).resolves.toMatchObject({ resent: true });
    const secondCode = mail.verification.at(-1)!;
    expect(secondCode).not.toBe(firstCode);
    await expect(service.verifyEmailCode("codes@example.com", firstCode, metadata)).resolves.toBeUndefined();

    const verified = await service.verifyEmailCode("codes@example.com", secondCode, metadata);
    expect(verified?.user.email).toBe("codes@example.com");
    await expect(service.verifyEmailCode("codes@example.com", secondCode, metadata)).resolves.toBeUndefined();
  });

  it("maps verification mail failures to a non-sensitive delivery error", async () => {
    const store = new MemoryAuthStore();
    const mail: MailSender = { sendVerification: async () => { throw new Error("smtp detail"); }, sendPasswordReset: async () => undefined };
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });

    await expect(service.register("mail-failure@example.com", "correct horse battery staple", "Mail Failure", metadata)).rejects.toMatchObject({ code: "MAIL_DELIVERY_FAILED" });
  });

  it("binds Feishu identity without merging an existing email account", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    await service.register("existing@example.com", "correct horse battery staple", "Existing", metadata);
    await service.verifyEmailCode("existing@example.com", mail.verification.at(-1)!, metadata);
    const state = await service.beginOAuth(undefined, "/");
    const result = await service.completeFeishu(state.state, { openId: "ou_new", email: "existing@example.com", name: "Feishu" }, metadata);
    expect(result?.created).toBe(true);
    expect((await store.findUserByEmail("existing@example.com"))?.id).not.toBe(result?.user.id);
    expect(await store.findIdentity("feishu", "ou_new")).toMatchObject({ userId: result?.user.id });
  });

  it("rejects a Feishu union identity collision and tolerates an invalid provider email", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    const first = await service.beginOAuth(undefined, "/");
    const created = await service.completeFeishu(first.state, { openId: "ou_first", unionId: "on_same", email: "not-an-email", name: "Feishu" }, metadata);
    expect(created?.created).toBe(true);
    expect(created?.user.email).toMatch(/^feishu-[a-f0-9]{24}@invalid\.local$/);

    const second = await service.beginOAuth(undefined, "/");
    await expect(service.completeFeishu(second.state, { openId: "ou_second", unionId: "on_same" }, metadata)).rejects.toThrow("FEISHU_IDENTITY_CONFLICT");
  });

  it("lists and unlinks a password-backed Feishu identity with an audit entry", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("bound@example.com", "correct horse battery staple", "Bound", metadata);
    const verified = await service.verifyEmailCode("bound@example.com", mail.verification.at(-1)!, metadata);
    const state = await service.beginOAuth(verified!.user.id, "/");
    await service.completeFeishu(state.state, { openId: "ou_bound", unionId: "on_bound" }, metadata);

    expect(await service.listIdentities(verified!.user.id)).toHaveLength(1);
    const owners = await service.listIdentityOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.user.email).toBe("bound@example.com");
    await expect(service.unlinkIdentity(verified!.user.id, "feishu", "ou_bound", metadata)).resolves.toMatchObject({ status: "unlinked" });
    expect(await service.listIdentities(verified!.user.id)).toHaveLength(0);
    expect(store.auditLog.at(-1)?.action).toBe("feishu-identity-unlinked");
    expect(store.auditLog.at(-1)?.metadata?.identityHash).toHaveLength(64);
  });

  it("protects an OAuth-only account's last Feishu login method and rejects cross-user unlinking", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    const first = await service.beginOAuth(undefined, "/");
    const oauthUser = await service.completeFeishu(first.state, { openId: "ou_only" }, metadata);
    const second = await service.beginOAuth(undefined, "/");
    const other = await service.completeFeishu(second.state, { openId: "ou_other" }, metadata);

    await expect(service.unlinkIdentity(other!.user.id, "feishu", "ou_only", metadata)).resolves.toEqual({ status: "not-found" });
    await expect(service.unlinkIdentity(oauthUser!.user.id, "feishu", "ou_only", metadata)).resolves.toEqual({ status: "last-login-method" });
    expect(await store.findIdentity("feishu", "ou_only")).toMatchObject({ userId: oauthUser!.user.id });
  });

  it("promotes the requested account and purges every other account atomically", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("old@example.com", "correct horse battery staple", "Old", metadata);
    const old = await service.verifyEmailCode("old@example.com", mail.verification.at(-1)!, metadata);
    const oldState = await service.beginOAuth(old!.user.id, "/");
    await service.completeFeishu(oldState.state, { openId: "ou_old" }, metadata);
    await service.saveResource({ resourceType: "session", resourceId: "old-session", userId: old!.user.id, resourcePath: "D:/old", createdAt: "2026-08-19T00:00:00.000Z" });

    await service.register("target@example.com", "correct horse battery staple", "Target", metadata);
    const target = await service.verifyEmailCode("target@example.com", mail.verification.at(-1)!, metadata);
    const result = await service.promoteUserAndPurgeOthers(target!.user.id, metadata);

    expect(result).toMatchObject({ user: { id: target!.user.id, role: "admin", defaultMode: "full", status: "active" }, deletedUserIds: [old!.user.id] });
    expect([...store.users.keys()]).toEqual([target!.user.id]);
    expect(await store.findIdentity("feishu", "ou_old")).toBeUndefined();
    expect(await store.findResource("session", "old-session")).toBeUndefined();
    expect(store.auditLog.at(-1)).toMatchObject({ action: "admin-user-purge", userId: target!.user.id, metadata: { deletedUserCount: "1" } });
  });

  it("recovers one administrator with a validated DSH credential and revokes old sessions", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("target@example.com", "old target password", "Target", metadata);
    const target = await service.verifyEmailCode("target@example.com", mail.verification.at(-1)!, metadata);
    await service.register("source@example.com", "correct horse battery staple", "Source", metadata);
    const source = await service.verifyEmailCode("source@example.com", mail.verification.at(-1)!, metadata);
    const oldSession = await service.login("target@example.com", "old target password", metadata);
    const encoded = (await store.getPassword(source!.user.id))!.encoded;

    const recovered = await service.recoverAdminAccount(target!.user.id, encoded, metadata);

    expect(recovered).toMatchObject({ user: { id: target!.user.id, role: "admin", status: "active", defaultMode: "full" }, revokedSessionCount: 2 });
    expect(await service.current(oldSession!.token, metadata)).toBeUndefined();
    await expect(service.login("target@example.com", "correct horse battery staple", metadata)).resolves.toBeTruthy();
    expect((await service.listAdminUsers())).toHaveLength(2);
    expect(store.auditLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "admin-account-recovery", userId: target!.user.id, metadata: { credentialProfile: "dsh-native", revokedSessionCount: "2" } }),
    ]));
  });

  it("rejects non-native recovery credentials without changing the account", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("target@example.com", "correct horse battery staple", "Target", metadata);
    const target = await service.verifyEmailCode("target@example.com", mail.verification.at(-1)!, metadata);

    await expect(service.recoverAdminAccount(target!.user.id, "scrypt:invalid", metadata)).rejects.toThrow("CREDENTIAL_UNSUPPORTED");

    expect((await store.findUserById(target!.user.id))?.role).toBe("admin");
    expect((await store.findUserById(target!.user.id))?.defaultMode).toBe("full");
    expect(store.auditLog.at(-1)).toMatchObject({ action: "admin-account-recovery-rejected", metadata: { reason: "CREDENTIAL_UNSUPPORTED" } });
  });

  it("requires a Web account before consuming a Feishu pairing token", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    const token = await service.beginFeishuPairing(" ou_pair ", metadata);
    expect(await service.peekFeishuPairing(token)).toMatchObject({ openId: "ou_pair", consumedAt: null });
    expect(await service.completeFeishuPairing(token, undefined, metadata)).toBeUndefined();
    expect(await service.peekFeishuPairing(token)).toBeTruthy();

    await service.register("pair@example.com", "correct horse battery staple", "Pair User", metadata, { pairingToken: token });
    const verified = await service.verifyEmailCode("pair@example.com", mail.verification.at(-1)!, metadata, token);
    expect(verified?.pairingBound).toBe(true);
    expect(verified?.user.email).toBe("pair@example.com");
    expect(await service.peekFeishuPairing(token)).toBeUndefined();
    expect(await service.completeFeishuPairing(token, undefined, metadata)).toBeUndefined();

    const next = await service.beginFeishuPairing("ou_pair", metadata);
    const resumed = await service.loginAndPair("pair@example.com", "correct horse battery staple", next, metadata);
    expect(resumed?.created).toBe(false);
    expect(resumed?.user.id).toBe(verified?.user.id);
  });

  it("binds the current Feishu session to the paired user and rejects a conflicting owner", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    const sessionId = `session-${"b".repeat(64)}`;
    await service.register("link@example.com", "correct horse battery staple", "Link User", metadata);
    const verified = await service.verifyEmailCode("link@example.com", mail.verification.at(-1)!, metadata);
    const token = await service.beginFeishuPairing("ou_link", metadata, sessionId);
    const paired = await service.completeFeishuPairing(token, verified!.user.id, metadata);
    expect(await service.findResource("session", sessionId)).toMatchObject({ userId: paired?.user.id, resourcePath: null });

    await service.register("other@example.com", "correct horse battery staple", "Other User", metadata);
    const other = await service.verifyEmailCode("other@example.com", mail.verification.at(-1)!, metadata);
    const identityConflict = await service.beginFeishuPairing("ou_link", metadata);
    await expect(service.completeFeishuPairing(identityConflict, other!.user.id, metadata)).rejects.toThrow("FEISHU_IDENTITY_CONFLICT");
    expect(await service.peekFeishuPairing(identityConflict)).toBeTruthy();

    const conflicting = await service.beginFeishuPairing("ou_other", metadata, sessionId);
    await expect(service.completeFeishuPairing(conflicting, other!.user.id, metadata)).rejects.toThrow("FEISHU_SESSION_CONFLICT");
    expect(await service.peekFeishuPairing(conflicting)).toBeTruthy();
    expect(await store.findIdentity("feishu", "ou_other")).toBeUndefined();
  });

  it.each<PairingFaultStage>(["identity", "session-resource", "web-session"])(
    "rolls back the complete Feishu pairing when %s persistence fails",
    async (stage) => {
      const store = new FaultingMemoryAuthStore();
      const mail = new FakeMail();
      const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
      const service = makeService(store, mail, clock);
      await service.register(`${stage}@example.com`, "correct horse battery staple", stage, metadata);
      const verified = await service.verifyEmailCode(`${stage}@example.com`, mail.verification.at(-1)!, metadata);
      const sessionId = `session-${({ identity: "c", "session-resource": "d", "web-session": "e" } as const)[stage].repeat(64)}`;
      const openId = `ou_fault_${stage}`;
      const token = await service.beginFeishuPairing(openId, metadata, sessionId);
      const baselineSessions = store.sessions.size;

      store.faultStage = stage;
      await expect(service.completeFeishuPairing(token, verified!.user.id, metadata)).rejects.toThrow(`PAIRING_FAULT_${stage}`);

      expect(await service.peekFeishuPairing(token)).toBeTruthy();
      expect(await store.findIdentity("feishu", openId)).toBeUndefined();
      expect(await store.findResource("session", sessionId)).toBeUndefined();
      expect(store.sessions).toHaveLength(baselineSessions);

      store.faultStage = undefined;
      await expect(service.completeFeishuPairing(token, verified!.user.id, metadata)).resolves.toBeTruthy();
    },
  );

  it("commits a Feishu pairing exactly once under concurrent confirmation", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = makeService(store, mail, { now: Date.parse("2026-08-19T00:00:00.000Z") });
    await service.register("pair-race@example.com", "correct horse battery staple", "Pair race", metadata);
    const verified = await service.verifyEmailCode("pair-race@example.com", mail.verification.at(-1)!, metadata);
    const sessionId = `session-${"f".repeat(64)}`;
    const token = await service.beginFeishuPairing("ou_pair_race", metadata, sessionId);
    const baselineSessions = store.sessions.size;

    const results = await Promise.all([
      service.completeFeishuPairing(token, verified!.user.id, metadata),
      service.completeFeishuPairing(token, verified!.user.id, metadata),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.findIdentity("feishu", "ou_pair_race")).toMatchObject({ userId: verified!.user.id });
    expect(await store.findResource("session", sessionId)).toMatchObject({ userId: verified!.user.id });
    expect(store.sessions).toHaveLength(baselineSessions + 1);
    expect(await service.peekFeishuPairing(token)).toBeUndefined();
  });

  it("does not bootstrap a replacement admin after the first admin is disabled", async () => {
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const clock = { now: Date.parse("2026-08-19T00:00:00.000Z") };
    const service = makeService(store, mail, clock);
    const first = await service.beginOAuth(undefined, "/");
    const admin = await service.completeFeishu(first.state, { openId: "ou_admin" }, metadata);
    const adminRecord = [...store.users.values()].find((user) => user.id === admin?.user.id)!;
    store.users.set(adminRecord.id, { ...adminRecord, status: "disabled" });
    const second = await service.beginOAuth(undefined, "/");
    const user = await service.completeFeishu(second.state, { openId: "ou_user" }, metadata);
    expect(user?.user.role).toBe("user");
    expect(user?.user.defaultMode).toBe("lightweight");
  });

  it("keeps preset and workspace policy separate from the Worker profile", async () => {
    const user: AuthUser = { id: "u1", email: "u@example.com", displayName: "U", role: "user", status: "active", defaultMode: "lightweight", createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" };
    const policy = accessPolicy(user, { user: "D:/workspaces", admin: "D:/admin" });
    expect(policy.defaultPreset).toBe("lark-lightweight");
    expect(policy.allowedPresets).toEqual(["lark-lightweight", "lark-standard", "liangshen", "standard", "ptc", "minimal", "cordis"]);
    expect(policy.workspaceRoot.replaceAll("\\", "/")).toContain("D:/workspaces/u1");
    expect(hashOpaqueToken("secret")).toHaveLength(64);
  });
});

function activeAdmin(id: string, email: string): AuthUser {
  return {
    id,
    email,
    displayName: email,
    role: "admin",
    status: "active",
    defaultMode: "full",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}
