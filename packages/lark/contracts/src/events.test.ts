/**
 * SessionEventMap 声明合并测试（SPEC contracts.md §8 快照）：
 * lark/message/in 与 lark/artifact/created 的落盘 → 重放一致（无密钥）。
 */
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import "./index.js";
import { LARK_SESSION_EVENT_TYPES } from "./events.js";
import { makeArtifactId, makeMessageId, makeRunId } from "./ids.js";
import { parseScope } from "./scope.js";

const scope = parseScope({
  tenantId: "t-1",
  botId: "b-1",
  deploymentId: "d-1",
  userId: "ou_user1",
  conversationId: "oc_chat1",
});

function seedEvents() {
  if (!scope.ok) throw new Error("unreachable");
  const session = Session.create(SessionId("session-contracts-test"));
  session.append("lark/message/in", {
    scope: scope.value,
    messageId: makeMessageId("om_msg1"),
    text: "帮我查一下知识库",
  });
  session.append("lark/artifact/created", {
    scope: scope.value,
    artifactId: makeArtifactId("art-1"),
    name: "report.md",
    digest: "sha256:ab12",
    bytes: 42,
  });
  return session.snapshotEvents();
}

describe("lark/* 事件落盘与重放", () => {
  it("入口会注册全部声明的 lark session 事件", () => {
    expect(LARK_SESSION_EVENT_TYPES.every((type) => KNOWN_SESSION_EVENT_TYPES.has(type))).toBe(true);
  });

  it("append 后事件带 seq/time，data 无损", () => {
    const events = seedEvents();
    expect(events).toHaveLength(2);
    const message = events[0]!;
    const artifact = events[1]!;
    expect(message).toMatchObject({ type: "lark/message/in", seq: 0 });
    expect(typeof message.time).toBe("number");
    expect(message.data).toMatchObject({ text: "帮我查一下知识库" });
    expect(artifact).toMatchObject({ type: "lark/artifact/created", seq: 1, data: { bytes: 42 } });
  });

  it("JSON 落盘→重放一致（快照）", () => {
    // 时间戳随运行变化，快照前归一化，保证无密钥重放确定。
    const normalized = seedEvents().map((event) => ({ ...event, time: 0 }));
    expect(JSON.parse(JSON.stringify(normalized))).toMatchSnapshot();
  });

  it("以 seed 重建会话后事件流一致（重放）", () => {
    const seed = seedEvents();
    const replayed = Session.create(SessionId("session-contracts-replay"), seed);
    // 重建会追加生命周期标记 session/end-seed；种子部分必须逐事件一致。
    expect(replayed.snapshotEvents().slice(0, seed.length)).toEqual(seed);
    expect(replayed.snapshotEvents().at(-1)?.type).toBe("session/end-seed");
  });

  it("makeRunId 工厂产物可进入事件上下文（品牌化编译期约束）", () => {
    // 品牌化的编译期约束由类型系统保证；此处验证运行时仍是普通字符串。
    expect(makeRunId("run-1")).toBe("run-1");
  });
});
