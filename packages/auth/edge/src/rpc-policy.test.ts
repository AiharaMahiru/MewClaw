import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthService, MemoryAuthStore, accessPolicy, type AuthUser } from "dsh-lark-auth";

import { authorizeRpc, filterRpcResponse } from "./rpc-policy.js";

const roots = { user: "D:/workspaces/users", admin: "D:/workspaces/admin" };
const userA: AuthUser = { id: "user-a", email: "a@example.com", displayName: "A", role: "user", status: "active", defaultMode: "lightweight", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const adminUser: AuthUser = { id: "admin-a", email: "admin@example.com", displayName: "Admin", role: "admin", status: "active", defaultMode: "full", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

describe("RPC authorization policy", () => {
  it("新版预设选择仅允许本人会话和白名单预设，保留官方参数", async () => {
    const service = new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    for (const [resourceId, userId] of [["owned", userA.id], ["foreign", "user-b"]] as const) {
      await service.saveResource({ resourceType: "session", resourceId, userId, resourcePath: `${roots.user}/${userId}/project`, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    const method = "agentPresets/select";
    const check = (args: Record<string, unknown>) => authorizeRpc({ method, payload: { args } }, { service, user: userA, roots }, method);
    const args = { agentId: "owned", agentPreset: "standard" };
    const decision = await check(args);
    expect(decision.denied).toBeUndefined();
    expect(decision.args).toEqual(args);
    expect(decision.body).toEqual({ method, payload: { args } });
    await expect(check({ agentId: "foreign", agentPreset: "standard" })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(check({ agentId: "foreign", sessionId: "owned", agentPreset: "standard" })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(check({ agentId: "missing", agentPreset: "standard" })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(check({ agentId: "owned", agentPreset: "../../private" })).resolves.toMatchObject({ denied: "PRESET_NOT_ALLOWED" });
    for (const invalid of [{ agentPreset: "standard" }, { agentId: "owned" }, { sessionId: "owned", agentPreset: "standard" }, { agentId: "owned", agentPreset: "" }]) {
      await expect(check(invalid)).resolves.toMatchObject({ denied: "INVALID_RPC" });
    }
  });

  it("新版工作区创建保留 request 契约并拒绝目录越界", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-workspace-contract-"));
    const localRoots = { user: join(root, "users"), admin: join(root, "admin") };
    const userRoot = join(localRoots.user, userA.id);
    const outside = join(root, "outside");
    const service = new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    try {
      await mkdir(userRoot, { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(userRoot, "escape"), "dir");
      const authorize = (args: Record<string, unknown>, user = userA) => authorizeRpc(
        { method: "workspace/create", payload: { args } },
        { service, user, roots: localRoots }, "workspace/create",
      );
      for (const [user, path] of [[userA, userRoot], [adminUser, outside]] as const) {
        const args = { request: { path } };
        const result = await authorize(args, user);
        expect(result.denied).toBeUndefined();
        expect(result.args).toEqual(args);
        expect(result.body).toEqual({ method: "workspace/create", payload: { args } });
      }
      for (const path of [outside, join(userRoot, "escape"), join(userRoot, "..", "other")]) {
        await expect(authorize({ request: { path }, path: userRoot })).resolves.toMatchObject({ denied: "WORKSPACE_PATH_NOT_ALLOWED" });
      }
      for (const args of [{}, { path: userRoot }, { request: {} }, { request: { path: 123 } }]) {
        await expect(authorize(args)).resolves.toMatchObject({ denied: "INVALID_REQUEST" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows all system presets but rejects outside paths and another user's resources", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "session-b", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    await expect(authorizeRpc({ method: "session.history", payload: { args: { sessionId: "session-b" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    for (const agentPreset of ["lark-lightweight", "lark-standard", "liangshen", "standard", "ptc", "minimal", "cordis"]) {
      await expect(authorizeRpc({ method: "session.create", payload: { args: { agentPreset } } }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
      await expect(authorizeRpc({ method: "agentPreset.select", payload: { args: { agentPreset } } }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
    }
    const slashCreate = await authorizeRpc(
      { method: "session/create", payload: { args: { request: {} } } },
      { service, user: userA, roots },
      "session/create",
    );
    expect(slashCreate).toMatchObject({ method: "session.create", args: { request: {} } });
    expect((slashCreate.args.request as Record<string, unknown>).agentPreset).toBeUndefined();
    expect(slashCreate.denied).toBeUndefined();
    const nestedPreset = await authorizeRpc(
      { method: "session/create", payload: { args: { request: { cwd: "D:/workspaces/users/user-a", agentPreset: "lark-lightweight" } } } },
      { service, user: userA, roots },
      "session/create",
    );
    expect(nestedPreset.denied).toBeUndefined();
    expect((nestedPreset.args.request as Record<string, unknown>).agentPreset).toBeUndefined();
    await expect(authorizeRpc({ method: "session.create", payload: { args: { cwd: "D:/other" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "WORKSPACE_PATH_NOT_ALLOWED" });
  });

  it("allows administrators to create workspaces and sessions at any local path", async () => {
    const service = new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const path = "C:/Users/ATWER";
    const workspace = await authorizeRpc({ method: "workspace.create", payload: { args: { path } } }, { service, user: adminUser, roots });
    expect(workspace.denied).toBeUndefined();
    expect(workspace.args.path).toBe(path);

    const session = await authorizeRpc({ method: "session.create", payload: { args: { cwd: path } } }, { service, user: adminUser, roots });
    expect(session.denied).toBeUndefined();
    expect(session.args.cwd).toBe(path);
  });

  it("filters session lists and injects the role default for a new session", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const decision = await authorizeRpc({ method: "session.create", payload: { args: {} } }, { service, user: userA, roots });
    expect(decision.args.agentPreset).toBe("lark-lightweight");
    const filtered = await filterRpcResponse({ result: { value: { items: [{ sessionId: "owned", cwd: "D:/workspaces/users/user-a" }, { sessionId: "foreign", cwd: "D:/other" }] } } }, { ...decision, method: "session.list" }, { service, user: userA, roots });
    expect((filtered.result as { value: { items: unknown[] } }).value.items).toHaveLength(1);
  });

  it("exposes a paired Feishu session even when its cwd is outside the Web root", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const sessionId = `session-${"c".repeat(64)}`;
    expect(await service.saveResource({ resourceType: "session", resourceId: sessionId, userId: userA.id, resourcePath: null, createdAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
    const decision = { method: "session.list", args: {}, body: { method: "session.list" } };
    const filtered = await filterRpcResponse({ result: { value: { items: [{ sessionId, cwd: "D:/AI/dsh/.workspaces/feishu-scope" }, { sessionId: "foreign", cwd: "D:/AI/dsh/.workspaces/other" }] } } }, decision, { service, user: userA, roots });
    expect((filtered.result as { value: { items: Array<{ sessionId: string }> } }).value.items.map((item) => item.sessionId)).toEqual([sessionId]);
    await expect(authorizeRpc({ method: "session.history", payload: { args: { sessionId } } }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
    expect(await service.saveResource({ resourceType: "session", resourceId: sessionId, userId: "user-b", resourcePath: null, createdAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("filters search results while preserving the full system preset roster for a user", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "owned", userId: "user-a", resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const searchDecision = await authorizeRpc({ method: "session.search", payload: { query: "secret" } }, { service, user: userA, roots });
    const searched = await filterRpcResponse({ result: { value: { items: [{ sessionId: "owned", snippet: "mine" }, { sessionId: "foreign", snippet: "private" }] } } }, searchDecision, { service, user: userA, roots });
    expect((searched.result as { value: { items: unknown[] } }).value.items).toHaveLength(1);

    const presetDecision = await authorizeRpc({ method: "agentPreset.list", payload: {} }, { service, user: userA, roots });
    const presets = await filterRpcResponse({ result: { value: { presets: [{ id: "lark-lightweight" }, { id: "lark-standard" }, { id: "liangshen" }, { id: "standard" }, { id: "ptc" }, { id: "minimal" }, { id: "cordis" }, { id: "user-experiment" }] } } }, presetDecision, { service, user: userA, roots });
    expect((presets.result as { value: { presets: Array<{ id: string }> } }).value.presets.map((item) => item.id)).toEqual(["lark-lightweight", "lark-standard", "liangshen", "standard", "ptc", "minimal", "cordis"]);
  });

  it("filters nested workspace sessions and archived session ids", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "workspace", resourceId: "own-workspace", userId: "user-a", resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "workspace", resourceId: "foreign-workspace", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: "user-a", resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign-session", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    const decision = await authorizeRpc({ method: "workspace.list", payload: {} }, { service, user: userA, roots });
    const filtered = await filterRpcResponse({ result: { value: {
      items: [
        { workspaceId: "own-workspace", path: "D:/workspaces/users/user-a", sessionIds: ["foreign-session", "own-session"] },
        { workspaceId: "foreign-workspace", path: "D:/workspaces/users/user-b", sessionIds: ["foreign-session"] },
      ],
      archivedSessionIds: ["foreign-session", "own-session"],
    } } }, decision, { service, user: userA, roots });
    const value = (filtered.result as { value: { items: Array<{ sessionIds: string[] }>; archivedSessionIds: string[] } }).value;
    expect(value.items).toHaveLength(1);
    expect(value.items[0]?.sessionIds).toEqual(["own-session"]);
    expect(value.archivedSessionIds).toEqual(["own-session"]);
  });

  it("allows read-only model catalog data but denies configuration writes", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    for (const method of ["settings.describe", "credentials.describe", "llm.providers", "llm.models"]) {
      await expect(authorizeRpc({ method, payload: {} }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
    }
    await expect(authorizeRpc(
      { method: "dsh-web-ui-settings/describe", payload: {} },
      { service, user: userA, roots },
      "dsh-web-ui-settings/describe",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    for (const method of ["credentials.set", "llm.discoverModels"]) {
      await expect(authorizeRpc({ method, payload: {} }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    }
    await expect(authorizeRpc({ method: "settings.mutate", payload: {} }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    await expect(authorizeRpc({
      method: "settings.mutate",
      payload: { ns: "ui-onboarding", ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "2026-08-13.1" }] },
    }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
    for (const payload of [
      { ns: "ui-onboarding", ops: [{ op: "unset", path: ["welcomeNoticeVersion"] }] },
      { ns: "ui-onboarding", ops: [{ op: "set", path: ["other"], value: "2026-08-13.1" }] },
      { ns: "ui-onboarding", ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "arbitrary" }] },
      { ns: "llm-pi-ai", ops: [{ op: "set", path: ["model"], value: "other" }] },
    ]) {
      await expect(authorizeRpc({ method: "settings.mutate", payload }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    }
    await expect(authorizeRpc(
      { method: "dsh-web-ui-settings/mutate", payload: {} },
      { service, user: userA, roots },
      "dsh-web-ui-settings/mutate",
    )).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    const settingsDecision = await authorizeRpc({ method: "settings.describe", payload: {} }, { service, user: userA, roots });
    const settings = await filterRpcResponse({ result: { value: { writable: true, hasDocument: true, namespaces: [{ ns: "llm-pi-ai" }, { ns: "billing" }] } } }, settingsDecision, { service, user: userA, roots });
    expect((settings.result as { value: { writable: boolean } }).value.writable).toBe(false);
    expect((settings.result as { value: { namespaces: Array<{ ns: string }> } }).value.namespaces.map((item) => item.ns)).toEqual(["llm-pi-ai"]);
    const credentialsDecision = await authorizeRpc({ method: "credentials.describe", payload: {} }, { service, user: userA, roots });
    const credentials = await filterRpcResponse({ result: { value: { credentials: { OPENAI_API_KEY: { configured: true, source: "environment", writable: true } } } } }, credentialsDecision, { service, user: userA, roots });
    expect((credentials.result as { value: { credentials: Record<string, { writable: boolean }> } }).value.credentials.OPENAI_API_KEY?.writable).toBe(false);
    await expect(authorizeRpc({ method: "session.create", payload: { sessionId: "foreign" } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
  });

  it("accepts official slash remotes while checking nested session identities", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "owned", userId: "user-a", resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });

    for (const method of [
      "agentPresets/list",
      "credentials/describe",
      "llm/listConfigurableProviders",
      "llm/listProviders",
      "pluginInventory/list",
      "session/canOpenWorkspacePath",
      "session/create",
      "session/list",
      "session/modelCatalog",
      "session/search",
      "settings/canOpenAgentPresetDirectory",
      "settings/describe",
    ]) {
      await expect(authorizeRpc({ method, payload: { args: { request: { query: "" } } } }, { service, user: userA, roots }, method)).resolves.toMatchObject({ method: method.replace("/", ".") });
    }
    await expect(authorizeRpc(
      { method: "agentPresets/list", payload: { args: {} } },
      { service, user: userA, roots },
      "agentPresets/list",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });

    const rosterDecision = await authorizeRpc(
      { method: "agentPresets/list", payload: { args: {} } },
      { service, user: userA, roots },
      "agentPresets/list",
    );
    const roster = await filterRpcResponse({ result: { value: {
      presets: [{ id: "lark-lightweight" }, { id: "user-private" }],
      authorable: true,
    } } }, rosterDecision, { service, user: userA, roots });
    expect((roster.result as { value: { presets: Array<{ id: string }> } }).value.presets.map((item) => item.id)).toEqual(["lark-lightweight"]);

    await expect(authorizeRpc(
      { method: "agentPresets/read", payload: { args: { agentPreset: "standard" } } },
      { service, user: userA, roots },
      "agentPresets/read",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    await expect(authorizeRpc(
      { method: "agentPresets/read", payload: { args: { agentPreset: "user-private" } } },
      { service, user: userA, roots },
      "agentPresets/read",
    )).resolves.toMatchObject({ denied: "PRESET_NOT_ALLOWED" });
    await expect(authorizeRpc(
      { method: "agentPresets/read", payload: { args: {} } },
      { service, user: userA, roots },
      "agentPresets/read",
    )).resolves.toMatchObject({ denied: "INVALID_RPC" });

    await expect(authorizeRpc(
      { method: "session/page", payload: { args: { request: { sessionId: "owned" } } } },
      { service, user: userA, roots },
      "session/page",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    await expect(authorizeRpc(
      { method: "session/page", payload: { args: { request: { sessionId: "foreign" } } } },
      { service, user: userA, roots },
      "session/page",
    )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(authorizeRpc(
      { method: "skills/list", payload: { args: { request: { sessionId: "owned" } } } },
      { service, user: userA, roots },
      "skills/list",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    await expect(authorizeRpc(
      { method: "skills/list", payload: { args: { request: { sessionId: "foreign" } } } },
      { service, user: userA, roots },
      "skills/list",
    )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(authorizeRpc(
      { method: "skills/list", payload: { args: { request: {} } } },
      { service, user: userA, roots },
      "skills/list",
    )).resolves.toMatchObject({ denied: "INVALID_RPC" });

    await expect(authorizeRpc({ method: "commands/list", payload: { args: { agentId: "owned" } } }, { service, user: userA, roots })).resolves.toMatchObject({ method: "commands.list" });
    await expect(authorizeRpc({ method: "commands/list", payload: { args: { agentId: "foreign" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    for (const method of ["fileReferences/list", "sessionReferenceResolver/candidates"]) {
      await expect(authorizeRpc({ method, payload: { args: { agentId: "owned", query: "src" } } }, { service, user: userA, roots })).resolves.not.toMatchObject({ denied: expect.any(String) });
      await expect(authorizeRpc({ method, payload: { args: { agentId: "foreign", query: "src" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
      await expect(authorizeRpc({ method, payload: { args: { query: "src" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "INVALID_RPC" });
    }
    for (const method of [
      "agentPresets/copy",
      "agentPresets/deletePreset",
      "credentials/set",
      "llm/discoverModels",
      "session/openWorkspacePath",
      "settings/mutate",
    ]) {
      await expect(authorizeRpc({ method, payload: { args: {} } }, { service, user: userA, roots }, method)).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    }
    await expect(authorizeRpc({ method: "messageFeedback/list", payload: { args: { request: { sessionId: "foreign" } } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    await expect(authorizeRpc({ method: "dynamicCordisRunner/invoke", payload: { args: { pluginId: "p", pluginRunId: "r", method: "read", args: {} } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
    await expect(authorizeRpc({ method: "unknownRemote/run", payload: { args: {} } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
  });

  it("filters @ session candidates to resources owned by the current user", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "owned", userId: userA.id, resourcePath: "D:/workspaces/users/user-a/project", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "user-b", resourcePath: "D:/workspaces/users/user-b/project", createdAt: "2026-01-01T00:00:00.000Z" });
    const decision = await authorizeRpc(
      { method: "sessionReferenceResolver/candidates", payload: { args: { agentId: "owned", query: "" } } },
      { service, user: userA, roots },
    );
    const filtered = await filterRpcResponse({ result: { value: [
      { sessionId: "owned", label: "Mine", cwd: "D:/workspaces/users/user-a/project" },
      { sessionId: "foreign", label: "Other", cwd: "D:/workspaces/users/user-b/project" },
    ] } }, decision, { service, user: userA, roots });
    expect((filtered.result as { value: Array<{ sessionId: string; cwd?: string }> }).value).toEqual([
      { sessionId: "owned", label: "Mine", cwd: "~/project" },
    ]);
  });

  it("allows subagent UI calls only for sessions owned by the current user", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "owned-parent", userId: userA.id, resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "owned-child", userId: userA.id, resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign-child", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "workspace", resourceId: "owned-workspace", userId: userA.id, resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "workspace", resourceId: "foreign-workspace", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });

    await expect(authorizeRpc(
      { method: "subagent.list", payload: { parentSessionId: "owned-parent" } },
      { service, user: userA, roots },
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    await expect(authorizeRpc(
      { method: "subagent.history", payload: { parentSessionId: "owned-parent", childSessionId: "owned-child" } },
      { service, user: userA, roots },
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    await expect(authorizeRpc(
      { method: "subagent.history", payload: { parentSessionId: "owned-parent", childSessionId: "foreign-child" } },
      { service, user: userA, roots },
    )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });

    // 官方新版客户端使用复数命名空间和嵌套 request；两种形态都必须
    // 通过普通用户能力检查，并继续校验父/子会话归属。
    for (const method of ["subagents/list", "subagents/prompt", "subagents/interruptByParent"]) {
      await expect(authorizeRpc(
        { method, payload: { args: { request: { parentSessionId: "owned-parent", childSessionId: "owned-child" } } } },
        { service, user: userA, roots },
        method,
      )).resolves.not.toMatchObject({ denied: expect.any(String) });
    }
    await expect(authorizeRpc(
      { method: "subagents/prompt", payload: { args: { request: { parentSessionId: "owned-parent", childSessionId: "foreign-child" } } } },
      { service, user: userA, roots },
      "subagents/prompt",
    )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });

    await expect(authorizeRpc(
      { method: "session/prompt", payload: { args: { request: { sessionId: "owned-parent" } } } },
      { service, user: userA, roots },
      "session/prompt",
    )).resolves.not.toMatchObject({ denied: expect.any(String) });
    // 官方新版客户端通过 slash Remote 取消和归档会话；能力放行后仍须
    // 继续执行会话归属检查，不能让普通用户操作他人的会话。
    for (const method of [
      "session/attachment", "session/cancel", "session/fork", "session/rename",
      "session/selectModel", "session/updateQueue", "workspace/archiveSession",
    ]) {
      await expect(authorizeRpc(
        { method, payload: { args: { request: { sessionId: "owned-parent" } } } },
        { service, user: userA, roots },
        method,
      )).resolves.not.toMatchObject({ denied: expect.any(String) });
      await expect(authorizeRpc(
        { method, payload: { args: { request: { sessionId: "foreign-child" } } } },
        { service, user: userA, roots },
        method,
      )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    }
    for (const method of ["workspace/insertBefore", "workspace/insertSessionBefore", "workspace/rename", "workspace/delete"]) {
      await expect(authorizeRpc(
        { method, payload: { args: { workspaceId: "owned-workspace", beforeWorkspaceId: "owned-workspace", beforeSessionId: "owned-parent" } } },
        { service, user: userA, roots },
        method,
      )).resolves.not.toMatchObject({ denied: expect.any(String) });
      await expect(authorizeRpc(
        { method, payload: { args: { workspaceId: "foreign-workspace", beforeWorkspaceId: "foreign-workspace", beforeSessionId: "foreign-child" } } },
        { service, user: userA, roots },
        method,
      )).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
    }
  });

  it("allows host.describe for users but removes host-wide details", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const decision = await authorizeRpc({ method: "host.describe", payload: {} }, { service, user: userA, roots });
    expect(decision.denied).toBeUndefined();
    const filtered = await filterRpcResponse({ result: { value: { version: "0.1.0", cwd: "D:/private", provider: "openai", model: "secret-model", attachedSessions: 9, canOpenPath: true } } }, decision, { service, user: userA, roots });
    expect((filtered.result as { value: Record<string, unknown> }).value).toEqual({
      version: "0.1.0",
      cwd: accessPolicy(userA, roots).workspaceRoot,
      home: accessPolicy(userA, roots).workspaceRoot,
      attachedSessions: 0,
      canOpenPath: false,
    });
  });

  it("keeps the full roster and protects session export ownership", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    expect(accessPolicy({ ...userA, role: "admin", defaultMode: "full" }, roots).allowedPresets).toEqual(["lark-standard", "liangshen", "standard", "ptc", "minimal", "cordis"]);
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "user-b", resourcePath: "D:/workspaces/users/user-b", createdAt: "2026-01-01T00:00:00.000Z" });
    await expect(authorizeRpc({ method: "session.export", payload: { sessionId: "foreign" } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "RESOURCE_NOT_ALLOWED" });
  });

  it("preserves array-shaped remote results", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const decision = await authorizeRpc({ method: "dynamicCordisRunner/inventory", payload: {} }, { service, user: { ...userA, role: "admin" }, roots });
    const value = [{ pluginId: "plugin", agentId: "session", packages: [] }];
    const filtered = await filterRpcResponse({ result: { ok: true, value } }, decision, { service, user: { ...userA, role: "admin" }, roots });
    expect(filtered.result).toEqual({ ok: true, value });
    expect(Array.isArray((filtered.result as { value: unknown }).value)).toBe(true);
  });

  it("keeps explicit foreign ownership ahead of path visibility and protects preset text", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    await service.saveResource({ resourceType: "session", resourceId: "foreign-in-root", userId: "user-b", resourcePath: "D:/workspaces/users/user-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const decision = { method: "session.list", args: {}, body: { method: "session.list" } };
    const filtered = await filterRpcResponse({ result: { value: { items: [{ sessionId: "foreign-in-root", cwd: "D:/workspaces/users/user-a" }] } } }, decision, { service, user: userA, roots });
    expect((filtered.result as { value: { items: unknown[] } }).value.items).toHaveLength(0);
    await expect(authorizeRpc({ method: "agentPreset.read", payload: { args: { agentPreset: "standard" } } }, { service, user: userA, roots })).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
  });

  it("lets a lightweight user browse and create only inside its own root", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-auth-policy-"));
    const outside = await mkdtemp(join(tmpdir(), "dsh-auth-outside-"));
    const localRoots = { user: root, admin: join(root, "admin") };
    const userRoot = join(root, userA.id);
    await mkdir(userRoot, { recursive: true });
    try {
      const list = await authorizeRpc({ method: "host.listDirectory", payload: {} }, { service: new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } }), user: userA, roots: localRoots });
      expect(list.denied).toBeUndefined();
      expect(list.args.path).toBe(userRoot);

      const create = await authorizeRpc({ method: "host.createDirectory", payload: { args: { path: userRoot, name: "project" } } }, { service: new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } }), user: userA, roots: localRoots });
      expect(create.denied).toBeUndefined();
      await expect(authorizeRpc({ method: "host.createDirectory", payload: { args: { path: outside, name: "escape" } } }, { service: new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } }), user: userA, roots: localRoots })).resolves.toMatchObject({ denied: "WORKSPACE_PATH_NOT_ALLOWED" });
      await expect(authorizeRpc({ method: "host.createDirectory", payload: { args: { path: userRoot, name: "../escape" } } }, { service: new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } }), user: userA, roots: localRoots })).resolves.toMatchObject({ denied: "INVALID_REQUEST" });
      await expect(authorizeRpc({ method: "workspace.create", payload: { args: { path: outside } } }, { service: new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } }), user: userA, roots: localRoots })).resolves.toMatchObject({ denied: "WORKSPACE_PATH_NOT_ALLOWED" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("authorizes the official directoryPicker remotes with the same user-root boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-auth-directory-picker-"));
    const outside = await mkdtemp(join(tmpdir(), "dsh-auth-directory-picker-outside-"));
    const localRoots = { user: root, admin: join(root, "admin") };
    const userRoot = join(root, userA.id);
    await mkdir(userRoot, { recursive: true });
    const service = new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
    const options = { service, user: userA, roots: localRoots };
    try {
      const list = await authorizeRpc(
        { method: "directoryPicker/list", payload: { args: {} } },
        options,
        "directoryPicker/list",
      );
      expect(list.denied).toBeUndefined();
      expect(list.method).toBe("directoryPicker.list");
      expect(list.args.path).toBe(userRoot);

      const listedOutside = await authorizeRpc(
        { method: "directoryPicker/list", payload: { args: { path: outside } } },
        options,
        "directoryPicker/list",
      );
      expect(listedOutside.denied).toBe("WORKSPACE_PATH_NOT_ALLOWED");

      const create = await authorizeRpc(
        { method: "directoryPicker/createDirectory", payload: { args: { path: userRoot, name: "project" } } },
        options,
        "directoryPicker/createDirectory",
      );
      expect(create.denied).toBeUndefined();
      expect(create.args).toEqual({ path: userRoot, name: "project" });

      await expect(authorizeRpc(
        { method: "directoryPicker/createDirectory", payload: { args: { path: outside, name: "escape" } } },
        options,
        "directoryPicker/createDirectory",
      )).resolves.toMatchObject({ denied: "WORKSPACE_PATH_NOT_ALLOWED" });
      await expect(authorizeRpc(
        { method: "directoryPicker/createDirectory", payload: { args: { path: userRoot, name: "../escape" } } },
        options,
        "directoryPicker/createDirectory",
      )).resolves.toMatchObject({ denied: "INVALID_REQUEST" });

      await expect(authorizeRpc(
        { method: "directoryPicker/pick", payload: {} },
        options,
        "directoryPicker/pick",
      )).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });
      await expect(authorizeRpc(
        { method: "directoryPicker.pick", payload: {} },
        options,
      )).resolves.toMatchObject({ denied: "CAPABILITY_NOT_ALLOWED" });

      const filtered = await filterRpcResponse({ result: { value: {
        path: userRoot,
        home: outside,
        crumbs: [{ name: "mine", path: userRoot }, { name: "outside", path: outside }],
        entries: [{ name: "project", path: join(userRoot, "project") }, { name: "leak", path: outside }],
        truncated: false,
      } } }, list, options);
      const value = (filtered.result as { value: { home: string; entries: Array<{ path: string }>; crumbs: Array<{ path: string }> } }).value;
      expect(value.home).toBe(userRoot);
      expect(value.entries.map((entry) => entry.path)).toEqual([join(userRoot, "project")]);
      expect(value.crumbs.map((entry) => entry.path)).toEqual([userRoot]);

      const adminOptions = { ...options, user: adminUser };
      await expect(authorizeRpc(
        { method: "directoryPicker/pick", payload: {} },
        adminOptions,
        "directoryPicker/pick",
      )).resolves.not.toMatchObject({ denied: expect.any(String) });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("removes host paths outside a user's root from directory responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-auth-list-"));
    const outside = await mkdtemp(join(tmpdir(), "dsh-auth-list-outside-"));
    const localRoots = { user: root, admin: join(root, "admin") };
    const userRoot = join(root, userA.id);
    await mkdir(userRoot, { recursive: true });
    try {
      const service = new AuthService({ store: new MemoryAuthStore(), mail: { sendVerification: async () => undefined, sendPasswordReset: async () => undefined } });
      const decision = await authorizeRpc({ method: "host.listDirectory", payload: { path: userRoot } }, { service, user: userA, roots: localRoots });
      const filtered = await filterRpcResponse({ result: { value: { path: userRoot, home: "D:/private", crumbs: [{ name: "user", path: userRoot }, { name: "outside", path: outside }], entries: [{ name: "mine", path: join(userRoot, "mine") }, { name: "leak", path: outside }], truncated: false } } }, decision, { service, user: userA, roots: localRoots });
      const value = (filtered.result as { value: { home: string; entries: Array<{ path: string }>; crumbs: Array<{ path: string }> } }).value;
      expect(value.home).toBe(userRoot);
      expect(value.entries.map((entry) => entry.path)).toEqual([join(userRoot, "mine")]);
      expect(value.crumbs.map((entry) => entry.path)).toEqual([userRoot]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
