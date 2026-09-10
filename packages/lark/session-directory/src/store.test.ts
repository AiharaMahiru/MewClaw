import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseScope, type Scope } from "dsh-lark-contracts";

import { FileSessionDirectory } from "./store.js";

const parsedScope = parseScope({
  tenantId: "tenant", botId: "bot", deploymentId: "deployment",
  userId: "ou_owner", conversationId: "oc_chat",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scope = parsedScope.value;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-session-directory-"));
  roots.push(root);
  return root;
}

function header(id: ReturnType<typeof SessionId>, cwd: string): SessionHeader {
  return { version: 0, id, cwd, createdAt: 1, agentPreset: "code", isSeeded: false };
}

function request(targetScope: Scope = scope) {
  return { scope: targetScope, sessionGeneration: 0 };
}

function makePersistence(records: Map<string, { meta: SessionHeader; events: SessionEvent[] }>) {
  return {
    inspect: vi.fn(async (id: ReturnType<typeof SessionId>) => {
      const record = records.get(String(id));
      if (!record) throw new Error("session missing");
      return record;
    }),
  };
}

async function openDirectory(root: string, now: () => number, sessionId: ReturnType<typeof SessionId>) {
  const events = [{
    type: "request/header", seq: 0, time: 1,
    data: { reason: "initial", header: { config: { provider: "deepseek", model: "deepseek-chat" } } },
  }] as SessionEvent[];
  const persistence = makePersistence(new Map([
    [String(sessionId), { meta: header(sessionId, root), events }],
  ]));
  const directory = await FileSessionDirectory.open({
    filePath: join(root, "session-directory.json"),
    persistence: persistence as never,
    claimTtlMs: 600_000,
    maxEntries: 20,
    now,
    randomBytes: () => Buffer.alloc(18, 7),
  });
  return { directory, persistence };
}

describe("FileSessionDirectory", () => {
  it("一次性 claim 只授权当前完整 Scope，持久化文件不含 code", async () => {
    const root = await makeRoot();
    const sessionId = SessionId("web-session-1");
    const { directory } = await openDirectory(root, () => 1_000, sessionId);

    const claim = await directory.issueClaim(sessionId);
    expect(claim.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await expect(directory.claim({ ...request(), code: claim.code })).resolves.toEqual({
      mode: "shared", sessionId,
    });
    await expect(directory.claim({ ...request(), code: claim.code })).rejects.toMatchObject({
      code: "SESSION_CLAIM_INVALID",
    });

    const otherScope = { ...scope, userId: "ou_other" as Scope["userId"] };
    await expect(directory.list(request(otherScope))).resolves.toEqual({ sessions: [] });
    await expect(directory.use({ ...request(otherScope), sessionId })).rejects.toMatchObject({
      code: "SESSION_NOT_AVAILABLE",
    });
    expect(await readFile(join(root, "session-directory.json"), "utf8")).not.toContain(claim.code);
  });

  it("过期 code 和不可用 cwd 均 fail closed", async () => {
    const root = await makeRoot();
    const sessionId = SessionId("web-session-expired");
    let now = 1_000;
    const { directory } = await openDirectory(root, () => now, sessionId);
    const claim = await directory.issueClaim(sessionId);
    now += 600_001;

    await expect(directory.claim({ ...request(), code: claim.code })).rejects.toMatchObject({
      code: "SESSION_CLAIM_INVALID",
    });

    const missingId = SessionId("web-session-no-cwd");
    const persistence = makePersistence(new Map([
      [String(missingId), { meta: { version: 0, id: missingId, createdAt: 1, isSeeded: false }, events: [] }],
    ]));
    const missing = await FileSessionDirectory.open({
      filePath: join(root, "missing.json"), persistence: persistence as never,
      claimTtlMs: 600_000, maxEntries: 20,
    });
    await expect(missing.issueClaim(missingId)).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
  });

  it("合法目录可重启恢复；损坏或未知版本阻止启动", async () => {
    const root = await makeRoot();
    const sessionId = SessionId("web-session-restored");
    const { directory } = await openDirectory(root, () => 1_000, sessionId);
    const claim = await directory.issueClaim(sessionId);
    await directory.claim({ ...request(), code: claim.code });

    const reopened = await openDirectory(root, () => 2_000, sessionId);
    await expect(reopened.directory.current(request())).resolves.toEqual({ mode: "shared", sessionId });

    await writeFile(join(root, "session-directory.json"), "{broken", "utf8");
    await expect(openDirectory(root, () => 3_000, sessionId)).rejects.toMatchObject({
      code: "SESSION_DIRECTORY_FAILED",
    });
    await writeFile(join(root, "session-directory.json"), JSON.stringify({ version: 99, bindings: [], selections: [] }), "utf8");
    await expect(openDirectory(root, () => 3_000, sessionId)).rejects.toMatchObject({
      code: "SESSION_DIRECTORY_FAILED",
    });
  });

  it("new 只清除选择，unlink 才移除当前授权", async () => {
    const root = await makeRoot();
    const sessionId = SessionId("web-session-switch");
    const { directory } = await openDirectory(root, () => 1_000, sessionId);
    const claim = await directory.issueClaim(sessionId);
    await directory.claim({ ...request(), code: claim.code });

    await expect(directory.newSession(request())).resolves.toEqual({ mode: "deterministic" });
    await expect(directory.list(request())).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId, selected: false })],
    });
    await directory.use({ ...request(), sessionId });
    await expect(directory.unlink(request())).resolves.toEqual({ mode: "deterministic" });
    await expect(directory.list(request())).resolves.toEqual({ sessions: [] });
  });
});
