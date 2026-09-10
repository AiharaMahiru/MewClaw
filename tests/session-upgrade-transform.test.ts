import { expect, it } from "vitest";
import { migrateRows } from "../scripts/session-upgrade/transform.js";

const scope = { tenantId: "tenant", botId: "bot", deploymentId: "deploy", userId: "user", conversationId: "chat" };
const extensionRows = [
  { type: "lark/message/in", data: { scope, messageId: "message", text: "你好，原文\n第二行" } },
  { type: "lark/run/preset", data: { scope, preset: "standard", revision: "revision", version: "1", skills: ["humanizer"] } },
  { type: "lark/memory/recalled", data: { scope, count: 2 } },
];
const inbox = { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [] } };

/** 无密钥完整回合，不依赖真实会话正文。 */
export function fixture(prefix: object[] = extensionRows): unknown[] {
  const header = { type: "session", version: 0, id: "migration-fixture", createdAt: 1, delegationDepth: 0 };
  return [header, ...[
    ...prefix, inbox,
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "user/message", surfaceOp: "append", data: { role: "user", id: "message-test", source: { kind: "user" }, content: [{ type: "text", text: "回放验证" }] } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))];
}

it("三种扩展原位保留正文、Scope 和顺序，官方事件经完整新版校验", () => {
  const input = fixture();
  const original = structuredClone(input);
  const { artifact, report } = migrateRows(input);
  expect(artifact.header.version).toBe(3);
  expect(report.extensions).toBe(3);
  expect(artifact.events.slice(0, 3)).toEqual(input.slice(1, 4));
  expect(artifact.events[3]?.type).toBe("agent/inbox/spliced");
  expect(artifact.events.filter((event) => event.type === "system/message")).toHaveLength(1);
  expect(input).toEqual(original);
});
it("描述版本仅从2变3且其它字段完全不变", () => {
  const data = { version: 2, mode: "continuable", provider: "spawn", label: "测试子代理", agentProvider: "deepseek", agentModel: "flash" };
  const { artifact, report } = migrateRows(fixture([{ type: "subagent/descriptor", data }]));
  expect(artifact.events[0]?.data).toEqual({ ...data, version: 3 });
  expect(report.descriptors).toBe(1);
  expect(() => migrateRows(fixture([{ type: "subagent/descriptor", data: { ...data, extra: "不可丢弃" } }]))).toThrow();
});
it("拒绝未知扩展与不完整Scope", () => {
  expect(() => migrateRows(fixture([{ type: "lark/unknown", data: {} }]))).toThrow();
  expect(() => migrateRows(fixture([{ type: "lark/message/in", data: { ...extensionRows[0]!.data, scope: { userId: "user" } } }]))).toThrow("Scope");
});
it("拒绝没有锚点或锚点重复，禁止按时间猜位置", () => {
  const missing = fixture();
  missing[4] = { ...(missing[4] as object), type: "approval/policy" };
  expect(() => migrateRows(missing)).toThrow("anchor");
  const duplicate = fixture();
  duplicate.push({ ...(duplicate[4] as object), seq: duplicate.length - 1 });
  expect(() => migrateRows(duplicate)).toThrow("ambiguous");
});
it("引用扩展序号、扩展surface和超量输入都拒绝", () => {
  const rows = fixture();
  rows.push({ type: "session/title", seq: rows.length - 1, time: 50, data: { title: "标题", messageSeqs: [0] } });
  expect(() => migrateRows(rows)).toThrow("reference target missing");
  expect(() => migrateRows(fixture([{ ...extensionRows[0], surfaceOp: "append" }]))).toThrow();
  expect(() => migrateRows(fixture(), 2)).toThrow("event limit");
});
