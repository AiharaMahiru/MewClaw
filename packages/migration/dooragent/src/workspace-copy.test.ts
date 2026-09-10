import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import {
  auditWorkspaceTree,
  copyWorkspaceTree,
  rollbackWorkspaceTree,
  type WorkspaceTreeAudit,
} from "./workspace-copy.js";
import type { WorkspaceAggregate } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("copyWorkspaceTree", () => {
  it("copies a stable tree and matches the namespaced DoorAgent Merkle contract", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-copy-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "dooragent-copy-target-"));
    roots.push(source, targetParent);
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "a.txt"), "a");
    writeFileSync(join(source, "nested", "z.txt"), "z");
    const expected = asAggregate(await auditWorkspaceTree(source));

    const result = await copyWorkspaceTree(source, join(targetParent, "user-1"), expected);

    expect(result.result).toBe("migrated");
    expect(readFileSync(join(targetParent, "user-1", "nested", "z.txt"), "utf8")).toBe("z");
    expect(result.audit.merkleRootSha256).toBe(doorAgentMerkle(source, [
      { path: "a.txt", content: "a" },
      { path: "nested/z.txt", content: "z" },
    ]));
  });

  it("is idempotent and rejects a non-empty conflicting target", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-copy-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "dooragent-copy-target-"));
    roots.push(source, targetParent);
    writeFileSync(join(source, "file.txt"), "source");
    const expected = asAggregate(await auditWorkspaceTree(source));
    const target = join(targetParent, "user-1");

    await expect(copyWorkspaceTree(source, target, expected)).resolves.toMatchObject({ result: "migrated" });
    await expect(copyWorkspaceTree(source, target, expected)).resolves.toMatchObject({ result: "merged" });
    writeFileSync(join(target, "extra.txt"), "conflict");
    await expect(copyWorkspaceTree(source, target, expected))
      .rejects.toMatchObject({ code: "TARGET_CONFLICT" });
  });

  it("rejects symlinks before copying", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-copy-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "dooragent-copy-target-"));
    roots.push(source, targetParent);
    writeFileSync(join(source, "file.txt"), "source");
    symlinkSync(join(source, "file.txt"), join(source, "link.txt"), "file");
    const expected = asAggregate({
      ...(await auditWorkspaceTreeWithoutUnsupported(source)),
      symlinkCount: 0,
    });

    await expect(copyWorkspaceTree(source, join(targetParent, "user-1"), expected))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
  });

  it("only removes a migrated tree when its audited content is unchanged", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-copy-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "dooragent-copy-target-"));
    roots.push(source, targetParent);
    writeFileSync(join(source, "file.txt"), "source");
    const expected = asAggregate(await auditWorkspaceTree(source));
    const target = join(targetParent, "user-1");
    await copyWorkspaceTree(source, target, expected);

    await expect(rollbackWorkspaceTree(source, target, expected)).resolves.toEqual({
      result: "rolled-back",
      reasonCode: null,
    });
    await expect(rollbackWorkspaceTree(source, target, expected)).resolves.toEqual({
      result: "rejected",
      reasonCode: "ROLLBACK_TARGET_MISSING",
    });
  });

  it("retains a target whose content changed after migration", async () => {
    const source = mkdtempSync(join(tmpdir(), "dooragent-copy-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "dooragent-copy-target-"));
    roots.push(source, targetParent);
    writeFileSync(join(source, "file.txt"), "source");
    const expected = asAggregate(await auditWorkspaceTree(source));
    const target = join(targetParent, "user-1");
    await copyWorkspaceTree(source, target, expected);
    writeFileSync(join(target, "file.txt"), "changed");

    await expect(rollbackWorkspaceTree(source, target, expected)).resolves.toEqual({
      result: "rejected",
      reasonCode: "ROLLBACK_TARGET_CHANGED",
    });
    expect(readFileSync(join(target, "file.txt"), "utf8")).toBe("changed");
  });
});

function asAggregate(audit: WorkspaceTreeAudit): WorkspaceAggregate {
  return { ...audit, unreadableEntries: 0, unstableFiles: 0 };
}

async function auditWorkspaceTreeWithoutUnsupported(root: string): Promise<WorkspaceTreeAudit> {
  try {
    return await auditWorkspaceTree(root);
  } catch (error) {
    if (error instanceof DoorAgentMigrationError && error.code === "UNSUPPORTED_FILE_TYPE") {
      return {
        bytes: 6,
        directoryCount: 1,
        fileCount: 1,
        merkleRootSha256: "a".repeat(64),
        specialFileCount: 0,
        symlinkCount: 0,
      };
    }
    throw error;
  }
}

function doorAgentMerkle(root: string, files: Array<{ path: string; content: string }>): string {
  const namespace = createHash("sha256").update(root, "utf8").digest();
  let level = files.map((file) => {
    const relativePathSha256 = createHash("sha256")
      .update(Buffer.concat([namespace, Buffer.from([0]), Buffer.from(file.path, "utf8")]))
      .digest("hex");
    const leafDigest = createHash("sha256").update(canonicalJson({
      content_sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      relative_path_sha256: relativePathSha256,
      size_bytes: Buffer.byteLength(file.content),
      type: "file",
    }), "utf8").digest("hex");
    return { leafDigest, relativePathSha256 };
  }).sort((left, right) => left.relativePathSha256.localeCompare(right.relativePathSha256)
    || left.leafDigest.localeCompare(right.leafDigest)).map((leaf) => leaf.leafDigest);
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1] ?? level[index]!;
      next.push(createHash("sha256").update(Buffer.from(level[index]! + right, "hex")).digest("hex"));
    }
    level = next;
  }
  return level[0]!;
}
