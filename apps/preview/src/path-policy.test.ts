import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import { authorizeWorkspace } from "./path-policy.js";

const roots: string[] = [];
const scope = (user: string): Scope => ({
  tenantId: makeTenantId("tenant"),
  botId: makeBotId("bot"),
  deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId(user),
  conversationId: makeConversationId("conversation"),
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authorizeWorkspace", () => {
  it("只接受当前用户真实目录内的工作区", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-preview-path-"));
    roots.push(root);
    const workspace = join(root, "users", "user-a", "project");
    await mkdir(workspace, { recursive: true });
    await expect(authorizeWorkspace(root, workspace, scope("user-a"))).resolves.toBe(workspace);
    await expect(authorizeWorkspace(root, workspace, scope("user-b"))).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
  });

  it("拒绝词法穿越与符号链接逃逸", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-preview-path-"));
    roots.push(root);
    const userRoot = join(root, "users", "user-a");
    const outside = join(root, "outside");
    await mkdir(userRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(userRoot, "escape"));
    await expect(authorizeWorkspace(root, join(userRoot, "escape"), scope("user-a"))).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
    await expect(authorizeWorkspace(root, join(userRoot, "..", "outside"), scope("user-a"))).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
  });

  it("只允许精确 admin 根，不允许其子目录或符号链接替身", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-preview-path-"));
    roots.push(root);
    const admin = join(root, "admin");
    await mkdir(join(admin, "project"), { recursive: true });
    await expect(authorizeWorkspace(root, admin, scope("admin-user"))).resolves.toBe(admin);
    await expect(authorizeWorkspace(root, join(admin, "project"), scope("admin-user"))).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
  });
});
