import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import type { AppConfig } from "./config.js";
import { PreviewManager } from "./manager.js";
import type { PreviewRuntime, RuntimeCreateInput } from "./podman.js";

const roots: string[] = [];
const scope = (user: string): Scope => ({
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId(user), conversationId: makeConversationId("conversation"),
});

class FakeRuntime implements PreviewRuntime {
  creates: RuntimeCreateInput[] = [];
  removes: string[] = [];
  async cleanupOrphans(): Promise<void> {}
  async create(input: RuntimeCreateInput): Promise<string> { this.creates.push(input); return `container-${input.id}`; }
  async remove(container: string): Promise<void> { this.removes.push(container); }
  bridge(): ChildProcessWithoutNullStreams { throw new Error("unused"); }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PreviewManager", () => {
  it("绑定工作区所有者，并拒绝跨用户撤销", async () => {
    const events: unknown[] = [];
    const { manager, runtime, workspace } = await fixture(2, undefined, (event) => events.push(event));
    const descriptor = await manager.publish({ scope: scope("user-a"), workspace, command: "node server.js", port: 3000 });
    expect(runtime.creates[0]).toMatchObject({ workspace, userId: "user-a", command: "node server.js", port: 3000 });
    await expect(manager.revoke(scope("user-b"), descriptor.id)).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
    await manager.revoke(scope("user-a"), descriptor.id);
    expect(runtime.removes).toEqual([`container-${descriptor.id}`]);
    expect(events).toEqual([
      expect.objectContaining({ type: "preview/created", id: descriptor.id, userId: "user-a" }),
      expect.objectContaining({ type: "preview/revoked", id: descriptor.id, userId: "user-a", reason: "revoked" }),
    ]);
  });

  it("执行 per-user 配额，其他用户不共享配额", async () => {
    const { manager, workspace, root } = await fixture(1);
    await manager.publish({ scope: scope("user-a"), workspace, command: "node server.js", port: 3000 });
    await expect(manager.publish({ scope: scope("user-a"), workspace, command: "node server.js", port: 3001 })).rejects.toMatchObject({ code: "PREVIEW_QUOTA" });
    const other = join(root, "users", "user-b", "project");
    await mkdir(other, { recursive: true });
    await expect(manager.publish({ scope: scope("user-b"), workspace: other, command: "python app.py", port: 8000 })).resolves.toBeDefined();
    await manager.dispose();
  });

  it("到期后统一返回 not found 并回收容器", async () => {
    let now = 1_000;
    const { manager, runtime, workspace } = await fixture(2, () => now);
    const descriptor = await manager.publish({ scope: scope("user-a"), workspace, command: "node server.js", port: 3000, ttlMinutes: 1 });
    now += 60_001;
    await expect(manager.resolvePublic(descriptor.id)).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    expect(runtime.removes).toHaveLength(1);
  });

  it("到期回收发布脱敏审计事件", async () => {
    let now = 1_000;
    const events: unknown[] = [];
    const { manager, workspace } = await fixture(2, () => now, (event) => events.push(event));
    const descriptor = await manager.publish({ scope: scope("user-a"), workspace, command: "node server.js", port: 3000, ttlMinutes: 1 });
    now += 60_001;
    await expect(manager.resolvePublic(descriptor.id)).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "preview/expired", id: descriptor.id, reason: "expired" }));
    expect(JSON.stringify(events)).not.toContain("node server.js");
    expect(JSON.stringify(events)).not.toContain(workspace);
  });
});

async function fixture(quota: number, now?: () => number, audit?: ConstructorParameters<typeof PreviewManager>[3]) {
  const root = await mkdtemp(join(tmpdir(), "dsh-preview-manager-"));
  roots.push(root);
  const workspace = join(root, "users", "user-a", "project");
  await mkdir(workspace, { recursive: true });
  const runtime = new FakeRuntime();
  const config = {
    workspaceRoot: root, publicBaseUrl: "https://chat.rwr.ink", maxSharesPerUser: quota,
    defaultTtlMinutes: 60, maxTtlMinutes: 1440,
  } as AppConfig;
  const manager = new PreviewManager(config, runtime, now, audit);
  return { root, workspace, runtime, manager };
}
