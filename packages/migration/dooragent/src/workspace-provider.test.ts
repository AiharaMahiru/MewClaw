import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { auditWorkspaceTree } from "./workspace-copy.js";
import { createOfficialWorkspaceProvider } from "./workspace-provider.js";
import type { WorkspaceAggregate } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createOfficialWorkspaceProvider", () => {
  it("copies into the role root and calls the official workspace RPC", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-provider-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "dooragent-provider-target-"));
    roots.push(source, targetRoot);
    mkdirSync(join(source, "docs"));
    writeFileSync(join(source, "docs", "readme.md"), "hello");
    const aggregate = asAggregate(await auditWorkspaceTree(source));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string; payload: { path: string } };
      return new Response(JSON.stringify({
        rpcId: body.rpcId,
        result: { ok: true, value: { workspace: { workspaceId: "workspace-1", path: body.payload.path } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = createOfficialWorkspaceProvider({
      baseUrl: "http://127.0.0.1:13081/",
      token: "internal-token",
      userRoot: targetRoot,
      adminRoot: targetRoot,
      fetch: fetchMock,
    });

    const result = await provider.migrate({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
    });

    expect(result).toEqual({ result: "migrated", workspaceId: "workspace-1", path: join(targetRoot, "user-1") });
    expect(readFileSync(join(targetRoot, "user-1", "docs", "readme.md"), "utf8")).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:13081/api/workspace.create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer internal-token" }),
      }),
    );
  });

  it("fails closed for a target escape before copying", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-provider-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "dooragent-provider-target-"));
    roots.push(source, targetRoot);
    writeFileSync(join(source, "file.txt"), "hello");
    const aggregate = asAggregate(await auditWorkspaceTree(source));
    const provider = createOfficialWorkspaceProvider({
      baseUrl: "http://127.0.0.1:13081",
      token: "internal-token",
      userRoot: targetRoot,
      adminRoot: targetRoot,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(provider.migrate({
      sourcePath: source,
      targetUserId: "../escape",
      role: "user",
      aggregate,
    })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("deletes only an unchanged migrated workspace and unregisters it first", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-provider-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "dooragent-provider-target-"));
    roots.push(source, targetRoot);
    writeFileSync(join(source, "file.txt"), "hello");
    const aggregate = asAggregate(await auditWorkspaceTree(source));
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string };
      calls.push(body.method);
      return new Response(JSON.stringify({
        rpcId: body.rpcId,
        result: { ok: true, value: body.method === "workspace.create"
          ? { workspace: { workspaceId: "workspace-1", path: join(targetRoot, "user-1") } }
          : { deleted: true } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = createOfficialWorkspaceProvider({
      baseUrl: "http://127.0.0.1:13081",
      token: "internal-token",
      userRoot: targetRoot,
      adminRoot: targetRoot,
      fetch: fetchMock,
    });

    const migrated = await provider.migrate({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
    });
    const result = await provider.rollback({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
      targetWorkspaceId: migrated.workspaceId,
      result: migrated.result,
      createdTarget: true,
      cutoverEpochId: "epoch-1",
      expectedCutoverEpochId: "epoch-1",
    });

    expect(result).toEqual({ result: "rolled-back", reasonCode: null });
    expect(calls).toEqual(["workspace.create", "workspace.delete"]);
    await expect(provider.rollback({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
      targetWorkspaceId: migrated.workspaceId,
      result: migrated.result,
      createdTarget: true,
      cutoverEpochId: "epoch-1",
      expectedCutoverEpochId: "epoch-1",
    })).resolves.toEqual({ result: "rejected", reasonCode: "ROLLBACK_TARGET_MISSING" });
  });

  it("never removes a merged target or an epoch-mismatched target", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-provider-source-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "dooragent-provider-target-"));
    roots.push(source, targetRoot);
    writeFileSync(join(source, "file.txt"), "hello");
    const aggregate = asAggregate(await auditWorkspaceTree(source));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string };
      return new Response(JSON.stringify({
        rpcId: body.rpcId,
        result: { ok: true, value: body.method === "workspace.create"
          ? { workspace: { workspaceId: "workspace-1", path: join(targetRoot, "user-1") } }
          : { deleted: true } },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createOfficialWorkspaceProvider({
      baseUrl: "http://127.0.0.1:13081",
      token: "internal-token",
      userRoot: targetRoot,
      adminRoot: targetRoot,
      fetch: fetchMock,
    });
    const migrated = await provider.migrate({ sourcePath: source, targetUserId: "user-1", role: "user", aggregate });

    await expect(provider.rollback({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
      targetWorkspaceId: migrated.workspaceId,
      result: "merged",
      createdTarget: false,
      cutoverEpochId: "epoch-1",
      expectedCutoverEpochId: "epoch-1",
    })).resolves.toEqual({ result: "retained", reasonCode: "MERGED_TARGET" });
    await expect(provider.rollback({
      sourcePath: source,
      targetUserId: "user-1",
      role: "user",
      aggregate,
      targetWorkspaceId: migrated.workspaceId,
      result: "migrated",
      createdTarget: true,
      cutoverEpochId: "epoch-2",
      expectedCutoverEpochId: "epoch-1",
    })).resolves.toEqual({ result: "rejected", reasonCode: "ROLLBACK_EPOCH_MISMATCH" });
    expect(readFileSync(join(targetRoot, "user-1", "file.txt"), "utf8")).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function asAggregate(audit: Awaited<ReturnType<typeof auditWorkspaceTree>>): WorkspaceAggregate {
  return { ...audit, unreadableEntries: 0, unstableFiles: 0 };
}
