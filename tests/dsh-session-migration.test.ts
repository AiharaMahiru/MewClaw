/** 在临时目录通过官方 Provider 验证 v0 日志迁移，不读取生产会话。 */
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("官方 v0 完整回合只读迁移不落盘，写打开保留旧代并发布 v3", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-migration-test-"));
  const id = SessionId("upgrade-fixture");
  const dir = join(root, "_no-cwd", id);
  const source = join(dir, "session.jsonl");
  const header = { type: "session", version: 0, id, createdAt: 1, delegationDepth: 0 };
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", surfaceOp: "append", data: { role: "user", id: "message-test", source: { kind: "user" }, content: [{ type: "text", text: "升级回放验证" }] } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 1 }));
  const original = [header, ...events].map((row) => JSON.stringify(row)).join("\n") + "\n";
  const ctx = new Context();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(source, original);
    await ctx.plugin(Jsonl, { root, compression: "none" });
    const reader = await ctx.sessionPersistence.open(id, "read");
    try {
      expect(reader.header.version).toBe(3);
      const restored = (await reader.read()).events;
      expect(restored.map((event) => event.type)).toEqual([
        "turn/start", "step/start", "system/message", "user/message", "step/end", "turn/end",
      ]);
      expect(restored.find((event) => event.type === "user/message")?.data.content).toEqual([{ type: "text", text: "升级回放验证" }]);
    } finally { await reader.close(); }
    expect(await readdir(dir)).toEqual(["session.jsonl"]);
    const writer = await ctx.sessionPersistence.open(id, "write");
    try { await writer.flush(); } finally { await writer.close(); }
    expect(await readFile(source, "utf8")).toBe(original);
    expect(await readdir(dir)).toContain("session.v3.jsonl");
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
