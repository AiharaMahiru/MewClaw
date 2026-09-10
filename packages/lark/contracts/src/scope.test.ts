/**
 * Scope 解析/哈希/相等测试（SPEC contracts.md §8）。
 */
import { describe, expect, it } from "vitest";

import { deterministicSessionIdForScope, parseScope, scopeEquals, scopeKey } from "./scope.js";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "./ids.js";

const valid = {
  tenantId: "t-1",
  botId: "b-1",
  deploymentId: "d-1",
  userId: "ou_user1",
  conversationId: "oc_chat1",
};

describe("parseScope", () => {
  it("解析合法 Scope 并逐字段校验", () => {
    const result = parseScope(valid);
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("拒绝非对象与数组", () => {
    for (const value of [null, undefined, 42, "scope", [], ["tenantId"]]) {
      expect(parseScope(value).ok).toBe(false);
    }
  });

  it("拒绝缺失字段", () => {
    for (const key of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[key as keyof typeof valid];
      expect(parseScope(missing).ok).toBe(false);
    }
  });

  it("拒绝未知键（防拼写错误静默丢字段）", () => {
    expect(parseScope({ ...valid, extra: "x" }).ok).toBe(false);
    // 对象展开不会把 __proto__ 变成自有键；用 JSON.parse 构造真正的原型污染键。
    const polluted = JSON.parse(
      `{"tenantId":"t-1","botId":"b-1","deploymentId":"d-1","userId":"ou_user1","conversationId":"oc_chat1","__proto__":"x"}`,
    );
    expect(parseScope(polluted).ok).toBe(false);
  });

  it("拒绝非法字段值（透传 INVALID_REQUEST）", () => {
    const result = parseScope({ ...valid, userId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });
});

describe("scopeKey / scopeEquals", () => {
  it("确定性：同值同哈希，不同字段不同哈希", () => {
    const first = parseScope(valid);
    const second = parseScope(valid);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(scopeKey(first.value)).toBe(scopeKey(second.value));
    const other = parseScope({ ...valid, conversationId: "oc_chat2" });
    if (!other.ok) throw new Error("unreachable");
    expect(scopeKey(other.value)).not.toBe(scopeKey(first.value));
  });

  it("结构化相等与品牌化（不同 ID 不可互换）", () => {
    const a = parseScope(valid);
    if (!a.ok) throw new Error("unreachable");
    const same = parseScope({ ...valid });
    if (!same.ok) throw new Error("unreachable");
    expect(scopeEquals(a.value, same.value)).toBe(true);

    const typed = {
      tenantId: makeTenantId("t-1"),
      botId: makeBotId("b-1"),
      deploymentId: makeDeploymentId("d-1"),
      userId: makeUserId("ou_user1"),
      conversationId: makeConversationId("oc_chat1"),
    };
    expect(scopeEquals(a.value, typed)).toBe(true);
  });
});

describe("deterministicSessionIdForScope", () => {
  it("shares the worker session id format across Gateway and Worker", () => {
    const result = parseScope(valid);
    if (!result.ok) throw new Error("unreachable");
    expect(deterministicSessionIdForScope(result.value, 0)).toBe(`session-${scopeKey(result.value)}`);
    expect(deterministicSessionIdForScope(result.value, 2)).toBe(`session-${scopeKey(result.value)}:2`);
  });
});
