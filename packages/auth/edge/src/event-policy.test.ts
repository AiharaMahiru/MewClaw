import { describe, expect, it } from "vitest";

import { AuthService, MemoryAuthStore, type MailSender } from "dsh-lark-auth";

import { createUserEventFilter, createUserRemoteMuxPolicy } from "./event-policy.js";

class FakeMail implements MailSender {
  readonly verification: string[] = [];
  async sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void> { this.verification.push(input.code); }
  async sendPasswordReset(): Promise<void> {}
}

describe("user WebSocket event policy", () => {
  it("only forwards owned session frames and filters foreign workspace ids", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("user@example.com", "correct horse battery staple", "User", { requestId: "test" });
    const user = (await service.verifyEmailCode("user@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    await service.saveResource({ resourceType: "workspace", resourceId: "own-workspace", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    const filter = await createUserEventFilter(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });

    const own = envelope({ type: "session/event", sessionId: "own-session", event: { type: "user/message" } });
    const foreign = envelope({ type: "session/event", sessionId: "foreign-session", event: { type: "user/message" } });
    expect(await filter(own)).toBe(own);
    expect(await filter(foreign)).toBeNull();

    const order = envelope({ type: "host/workspace-order-changed", workspaceIds: ["foreign-workspace", "own-workspace"] });
    const filtered = JSON.parse((await filter(order))!);
    expect(filtered.payload.workspaceIds).toEqual(["own-workspace"]);
    await service.saveResource({ resourceType: "workspace", resourceId: "foreign-in-root", userId: "other-user", resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    expect(await filter(envelope({ type: "host/workspace-changed", workspace: { workspaceId: "foreign-in-root", path: `D:/workspaces/users/${user.id}`, sessionIds: [] } }))).toBeNull();
    const changed = envelope({
      type: "host/workspace-changed",
      workspace: { workspaceId: "own-workspace", path: `D:/workspaces/users/${user.id}`, sessionIds: ["foreign-session", "own-session"] },
    });
    const changedFiltered = JSON.parse((await filter(changed))!);
    expect(changedFiltered.payload.workspace.sessionIds).toEqual(["own-session"]);
    expect(await filter(envelope({ type: "host/remote-event", event: "secret", args: ["foreign"] }))).toBeNull();
    const streamError = JSON.parse((await filter(envelope({ type: "stream/error", error: { code: "agent-preset-invalid", message: "private", details: { agentPreset: "secret" } } })))!);
    expect(streamError.payload.error).toEqual({ code: "internal", message: "stream unavailable", details: {} });
  });

  it("learns a newly-created session only when its cwd is inside the user's root", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("user@example.com", "correct horse battery staple", "User", { requestId: "test" });
    const user = (await service.verifyEmailCode("user@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    const filter = await createUserEventFilter(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    const added = envelope({ type: "host/session-added", sessionId: "new-session", parentSessionId: "foreign-parent", blank: true, cwd: `D:/workspaces/users/${user.id}` });
    const addedFiltered = JSON.parse((await filter(added))!);
    expect(addedFiltered.payload.parentSessionId).toBeUndefined();
    expect(await filter(envelope({ type: "session/status", sessionId: "new-session" }))).toBeNull();
    expect(await filter(envelope({ type: "session/event", sessionId: "new-session", event: { type: "user/message" } }))).toBeDefined();
  });

  it("保留新版 Remote mux 传输帧，只隔离其中的用户会话事件", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("remote@example.com", "correct horse battery staple", "Remote User", { requestId: "test" });
    const user = (await service.verifyEmailCode("remote@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    policy.observeClientFrames(remoteOpen("events-stream", "$events"));
    policy.observeClientFrames(remoteOpen("business-stream", "acme/custom-stream"));
    policy.observeClientFrames(remoteOpen("error-stream", "acme/custom-stream"));
    const filter = policy.filterServerFrames;

    const ready = remoteFrame({ type: "ready", clientId: "client-1", host: { home: "/var/lib/dsh" } });
    expect(await filter(ready)).toBe(ready);
    const businessItem = remoteFrame({ type: "workspace/list", items: [{ workspaceId: "foreign-workspace" }] }, "business-stream");
    expect(await filter(businessItem)).toBe(businessItem);
    policy.observeClientFrames(remoteOpen("workspace-stream", "workspace/follow"));
    const workspaceBaseline = remoteFrame({ type: "baseline", value: {
      items: [
        { workspaceId: "own-workspace", path: `D:/workspaces/users/${user.id}`, sessionIds: ["own-session", "foreign-session"] },
        { workspaceId: "foreign-workspace", path: "D:/private", sessionIds: [] },
      ],
      archivedSessionIds: ["own-session", "foreign-session"],
    } }, "workspace-stream");
    const filteredWorkspace = JSON.parse((await filter(workspaceBaseline))!);
    expect(filteredWorkspace.value.value.items.map((item: { workspaceId: string }) => item.workspaceId)).toEqual(["own-workspace"]);
    expect(filteredWorkspace.value.value.items[0].sessionIds).toEqual(["own-session"]);
    expect(filteredWorkspace.value.value.archivedSessionIds).toEqual(["own-session"]);
    const end = remoteTerminal("end", "business-stream");
    expect(await filter(end)).toBe(end);
    const error = remoteTerminal("error", "error-stream", { code: "failed", message: "unavailable", details: {} });
    expect(await filter(error)).toBe(error);

    const ownEmit = remoteFrame({ type: "emit", event: "api-session/status", args: ["own-session", true] });
    expect(await filter(ownEmit)).toBe(ownEmit);
    expect(await filter(remoteFrame({ type: "emit", event: "api-session/status", args: ["foreign-session", true] }))).toBeNull();
    const ownWaterfall = remoteFrame({ type: "waterfall", event: "approval/request", eventId: "approval-1", agentId: "own-session", request: {} });
    expect(await filter(ownWaterfall)).toBe(ownWaterfall);
    expect(await filter(remoteFrame({ type: "waterfall", event: "approval/request", eventId: "approval-2", agentId: "foreign-session", request: {} }))).toBeNull();

    const added = remoteFrame({ type: "emit", event: "api-session/added", args: [{ sessionId: "new-session", cwd: `D:/workspaces/users/${user.id}`, blank: true }] });
    expect(await filter(added)).toBe(added);
    expect(await service.findResource("session", "new-session")).toMatchObject({ userId: user.id });
  });

  it("拒绝 $events ready 之前的事件帧，并阻断该流后续事件", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("early-event@example.com", "correct horse battery staple", "Early Event", { requestId: "test" });
    const user = (await service.verifyEmailCode("early-event@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    policy.observeClientFrames(remoteOpen("events-stream", "$events"));
    const foreign = remoteFrame({ type: "emit", event: "api-session/status", args: ["foreign-session", true] });
    expect(await policy.filterServerFrames(foreign)).toBeNull();
    expect(await policy.filterServerFrames(remoteFrame({ type: "ready", clientId: "client-1", host: { home: "/var/lib/dsh" } }))).toBeNull();
    expect(await policy.filterServerFrames(foreign)).toBeNull();
    const end = remoteTerminal("end", "events-stream");
    expect(await policy.filterServerFrames(end)).toBe(end);
  });

  it("不会把普通 RPC 的伪造 ready 流误判为事件流", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("fake-ready@example.com", "correct horse battery staple", "Fake Ready", { requestId: "test" });
    const user = (await service.verifyEmailCode("fake-ready@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    policy.observeClientFrames(remoteOpen("business-stream", "acme/custom-stream"));
    const fakeReady = remoteFrame({ type: "ready", clientId: "client-1", host: { home: "/var/lib/dsh" } }, "business-stream");
    const foreignEmit = remoteFrame({ type: "emit", event: "api-session/status", args: ["foreign-session", true] }, "business-stream");
    expect(await policy.filterServerFrames(fakeReady)).toBe(fakeReady);
    expect(await policy.filterServerFrames(foreignEmit)).toBe(foreignEmit);
    const end = remoteTerminal("end", "business-stream");
    expect(await policy.filterServerFrames(end)).toBe(end);
  });

  it("session/follow 与 workspaceFiles/changes 按 open 声明的会话归属放行或拒绝", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("scoped@example.com", "correct horse battery staple", "Scoped", { requestId: "test" });
    const user = (await service.verifyEmailCode("scoped@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });

    const open = (streamId: string, endpoint: string, args: Record<string, unknown>) =>
      policy.observeClientFrames(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));

    // 自有会话的 follow 全量透传（含 subagent 地址按父会话归属）。
    open("follow-own", "session/follow", { request: { address: { kind: "session", sessionId: "own-session" } } });
    const ownItem = remoteFrame({ type: "snapshot", seq: 1 }, "follow-own");
    expect(await policy.filterServerFrames(ownItem)).toBe(ownItem);
    open("follow-sub", "session/follow", { request: { address: { kind: "subagent", parentSessionId: "own-session", childSessionId: "child-1", mode: "continuable" } } });
    const subItem = remoteFrame({ type: "events", events: [] }, "follow-sub");
    expect(await policy.filterServerFrames(subItem)).toBe(subItem);

    // 他人会话：首个 item 回 forbidden error 帧显式终止，后续帧丢弃。
    open("follow-foreign", "session/follow", { request: { address: { kind: "session", sessionId: "foreign-session" } } });
    const denied = JSON.parse((await policy.filterServerFrames(remoteFrame({ type: "snapshot", seq: 1 }, "follow-foreign")))!);
    expect(denied).toMatchObject({ type: "error", streamId: "follow-foreign", error: { code: "forbidden" } });
    expect(await policy.filterServerFrames(remoteFrame({ type: "snapshot", seq: 2 }, "follow-foreign"))).toBeNull();

    // 缺 address 的畸形 open 同样 fail closed。
    open("follow-bad", "session/follow", {});
    const badDenied = JSON.parse((await policy.filterServerFrames(remoteFrame({ type: "x" }, "follow-bad")))!);
    expect(badDenied.error.code).toBe("forbidden");

    // workspaceFiles/changes 以 workspaceFileScopeId 判定归属。
    open("changes-own", "workspaceFiles/changes", { workspaceFileScopeId: "own-session" });
    const changeItem = remoteFrame({ type: "changed", path: "a.ts" }, "changes-own");
    expect(await policy.filterServerFrames(changeItem)).toBe(changeItem);
    open("changes-foreign", "workspaceFiles/changes", { workspaceFileScopeId: "foreign-session" });
    const changeDenied = JSON.parse((await policy.filterServerFrames(remoteFrame({ type: "changed", path: "b.ts" }, "changes-foreign")))!);
    expect(changeDenied.error.code).toBe("forbidden");

    // 终端流端点生产禁用：无论参数一律拒绝。
    open("term", "terminal/follow", { id: "t1" });
    const termDenied = JSON.parse((await policy.filterServerFrames(remoteFrame({ type: "snapshot", screen: "sh" }, "term")))!);
    expect(termDenied.error.code).toBe("forbidden");
  });

  it("session/control 全局流按会话归属裁剪 baseline 与增量帧", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("control@example.com", "correct horse battery staple", "Control", { requestId: "test" });
    const user = (await service.verifyEmailCode("control@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    policy.observeClientFrames(remoteOpen("control", "session/control"));

    const baseline = remoteFrame({ type: "baseline", value: {
      jobs: { "own-session": [{ id: "j1" }], "foreign-session": [{ id: "j2" }] },
      projections: { "own-session": { agentPreset: "standard" }, "foreign-session": { agentPreset: "x" } },
    } }, "control");
    const filtered = JSON.parse((await policy.filterServerFrames(baseline))!);
    expect(Object.keys(filtered.value.value.jobs)).toEqual(["own-session"]);
    expect(Object.keys(filtered.value.value.projections)).toEqual(["own-session"]);

    const ownJobs = remoteFrame({ type: "jobs", sessionId: "own-session", jobs: [] }, "control");
    expect(await policy.filterServerFrames(ownJobs)).toBe(ownJobs);
    expect(await policy.filterServerFrames(remoteFrame({ type: "jobs", sessionId: "foreign-session", jobs: [] }, "control"))).toBeNull();
    expect(await policy.filterServerFrames(remoteFrame({ type: "projection", sessionId: "foreign-session", key: "k", value: 1, seq: 3 }, "control"))).toBeNull();
    const ownProjection = remoteFrame({ type: "projection", sessionId: "own-session", key: "agentPreset", value: "standard", seq: 4 }, "control");
    expect(await policy.filterServerFrames(ownProjection)).toBe(ownProjection);
    // 未知控制帧 fail closed。
    expect(await policy.filterServerFrames(remoteFrame({ type: "surprise", sessionId: "own-session" }, "control"))).toBeNull();
  });

  it("限制活动 Remote 流状态并在终态与 cancel 时释放", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("bounded@example.com", "correct horse battery staple", "Bounded", { requestId: "test" });
    const user = (await service.verifyEmailCode("bounded@example.com", mail.verification[1]!, { requestId: "test" }))!.user;
    const policy = await createUserRemoteMuxPolicy(service, user, { user: "D:/workspaces/users", admin: "D:/workspaces/admin" });
    for (let index = 0; index < 1_024; index += 1) policy.observeClientFrames(remoteOpen(`stream-${index}`, "session/follow"));
    expect(() => policy.observeClientFrames(remoteOpen("overflow", "session/follow"))).toThrow("Remote mux stream limit exceeded");
    const firstEnd = remoteTerminal("end", "stream-0");
    expect(await policy.filterServerFrames(firstEnd)).toBe(firstEnd);
    expect(() => policy.observeClientFrames(remoteOpen("overflow", "session/follow"))).not.toThrow();
    const secondEnd = remoteTerminal("end", "stream-1");
    expect(await policy.filterServerFrames(secondEnd)).toBe(secondEnd);
    policy.observeClientFrames(remoteOpen("cancelled", "$events"));
    policy.observeClientFrames(JSON.stringify({ type: "cancel", streamId: "cancelled" }));
    expect(await policy.filterServerFrames(remoteFrame({ type: "ready", clientId: "client", host: { home: "/var/lib/dsh" } }, "cancelled"))).toBeNull();
  });
});

function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "server-request", rpcId: "event-test", method: "events.mux", payload });
}

function remoteOpen(streamId: string, endpoint: string): string {
  return JSON.stringify({ type: "open", streamId, endpoint, payload: { args: {} } });
}

function remoteFrame(value: Record<string, unknown>, streamId = "events-stream"): string {
  return JSON.stringify({ type: "item", streamId, value });
}

function remoteTerminal(type: "end" | "error", streamId: string, error?: Record<string, unknown>): string {
  return JSON.stringify(error ? { type, streamId, error } : { type, streamId });
}
