import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileCredentialRollbackStore } from "./credential-rollback-store.js";

const KEY = Buffer.alloc(32, 9).toString("base64url");
const SNAPSHOT = {
  snapshotRef: "vault:dsh/dooragent/credential-sync/epoch/source",
  targetUserId: "target-user",
  encoded: `scrypt$16384$8$1$${"a".repeat(22)}$${"b".repeat(43)}`,
  sourceDigest: "a".repeat(64),
  snapshotDigest: "b".repeat(64),
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileCredentialRollbackStore", () => {
  it("encrypts atomically with restrictive permissions and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-rollback-"));
    roots.push(root);
    const first = new FileCredentialRollbackStore(root, KEY);
    await first.save(SNAPSHOT);
    first.close();

    const files = await readdir(root);
    expect(files).toHaveLength(1);
    const path = join(root, files[0]!);
    const encrypted = await readFile(path, "utf8");
    expect(encrypted).not.toContain(SNAPSHOT.encoded);
    expect(encrypted).not.toContain(SNAPSHOT.targetUserId);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }

    const second = new FileCredentialRollbackStore(root, KEY);
    await expect(second.load(SNAPSHOT.snapshotRef)).resolves.toEqual(SNAPSHOT);
    second.close();
  });

  it("rejects tampering and does not overwrite a different snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-rollback-"));
    roots.push(root);
    const store = new FileCredentialRollbackStore(root, KEY);
    await store.save(SNAPSHOT);
    const path = join(root, (await readdir(root))[0]!);
    const content = await readFile(path);
    content[content.length - 1]! ^= 1;
    await writeFile(path, content);

    await expect(store.load(SNAPSHOT.snapshotRef)).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(store.save({ ...SNAPSHOT, encoded: "different" }))
      .rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("is idempotent for the same snapshot and rejects invalid key or use after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-rollback-"));
    roots.push(root);
    expect(() => new FileCredentialRollbackStore(root, "short")).toThrowError(
      expect.objectContaining({ code: "INVALID_KEY" }),
    );
    const store = new FileCredentialRollbackStore(root, KEY);
    await store.save(SNAPSHOT);
    await expect(store.save(SNAPSHOT)).resolves.toBeUndefined();
    store.close();
    await expect(store.load(SNAPSHOT.snapshotRef)).rejects.toMatchObject({ code: "CLOSED" });
  });
});
