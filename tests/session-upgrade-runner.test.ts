import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { migrateCopies } from "../scripts/session-upgrade/runner.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "session-upgrade-test-"));
  roots.push(root);
  const rows = [
    { type: "session", version: 0, id: "copy-test", createdAt: 1, delegationDepth: 0 },
    { type: "agent/inbox/spliced", seq: 0, time: 1, data: { target: "next-turn", start: 0, inserted: [] } },
  ];
  const bytes = Buffer.concat(rows.map((row) => zstdCompressSync(JSON.stringify(row) + "\n")));
  await writeFile(join(root, "session.jsonl.zstd"), bytes);
  const plan = { version: 1, entries: [{ relativePath: "session.jsonl.zstd", sourceSha256: createHash("sha256").update(bytes).digest("hex") }] };
  // 源树与输出树必须是兄弟；另建源根，不能在待迁移根内输出。
  const outputParent = await mkdtemp(join(tmpdir(), "session-upgrade-output-test-"));
  roots.push(outputParent);
  return { sourceRoot: root, outputRoot: join(outputParent, "result"), plan, bytes };
}
it("官方Provider跨实例读回一致，保留原件字节且源树不变", async () => {
  const options = await setup();
  const manifest = await migrateCopies(options);
  expect(manifest.status).toBe("copy-verified");
  expect(manifest.reports).toHaveLength(1);
  expect(await readFile(join(options.sourceRoot, "session.jsonl.zstd"))).toEqual(options.bytes);
  expect(await readdir(options.sourceRoot)).toEqual(["session.jsonl.zstd"]);
  expect(await readFile(join(options.outputRoot, manifest.reports[0]!.original))).toEqual(options.bytes);
  expect(await readdir(join(options.outputRoot, "sessions"), { recursive: true })).toContain("_no-cwd/copy-test/session.v3.jsonl.zstd");
});
it("摘要不符、越界、重复计划和源symlink均在输出建立前拒绝", async () => {
  const options = await setup();
  const entry = options.plan.entries[0]!;
  for (const entries of [
    [{ ...entry, sourceSha256: "0".repeat(64) }],
    [{ ...entry, relativePath: "../session.jsonl.zstd" }],
    [entry, entry],
  ]) await expect(migrateCopies({ ...options, plan: { version: 1, entries } })).rejects.toThrow();
  await symlink(join(options.sourceRoot, entry.relativePath), join(options.sourceRoot, "link.jsonl.zstd"));
  await expect(migrateCopies({ ...options, plan: { version: 1, entries: [{ ...entry, relativePath: "link.jsonl.zstd" }] } })).rejects.toThrow("symlink");
  await expect(readdir(options.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("拒绝覆盖输出、源下输出、生产路径和字节超限", async () => {
  const options = await setup();
  await expect(migrateCopies({ ...options, outputRoot: options.sourceRoot })).rejects.toThrow();
  await expect(migrateCopies({ ...options, outputRoot: join(options.sourceRoot, "output") })).rejects.toThrow();
  await expect(migrateCopies({ ...options, sourceRoot: "/var/lib/dsh" })).rejects.toThrow();
  await expect(migrateCopies({ ...options, maxSourceBytes: 1 })).rejects.toThrow("size");
  await writeFile(options.outputRoot, "保留");
  await expect(migrateCopies(options)).rejects.toThrow("exists");
  expect(await readFile(options.outputRoot, "utf8")).toBe("保留");
});
