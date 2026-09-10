/**
 * parseRunRequest 测试（SPEC lark-run.md §8）：wire 校验拒绝用例。
 */
import { describe, expect, it } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  scopeKey,
  type Scope,
} from "dsh-lark-contracts";

import { parseRunRequest } from "./request.js";

const valid = {
  runId: "run-1",
  scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1" },
  messageId: "om_1",
  prompt: "帮我做点事",
};

describe("parseRunRequest", () => {
  it("解析合法请求并保留 profile", () => {
    expect(parseRunRequest(valid)).toEqual({ ok: true, value: valid });
    const withProfile = parseRunRequest({ ...valid, profile: "quick" });
    expect(withProfile).toEqual({ ok: true, value: { ...valid, profile: "quick" } });
  });

  it("拒绝非对象与数组", () => {
    for (const value of [null, undefined, 42, "x", []]) {
      expect(parseRunRequest(value).ok).toBe(false);
    }
  });

  it("拒绝未知键（防拼写错误静默丢字段）", () => {
    expect(parseRunRequest({ ...valid, extra: 1 }).ok).toBe(false);
  });

  it("拒绝缺失/非法字段", () => {
    for (const key of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[key as keyof typeof valid];
      expect(parseRunRequest(missing).ok).toBe(false);
    }
    expect(parseRunRequest({ ...valid, messageId: "" }).ok).toBe(false);
    expect(parseRunRequest({ ...valid, scope: { ...valid.scope, userId: "" } }).ok).toBe(false);
  });

  it("prompt 非空且 ≤32KiB", () => {
    expect(parseRunRequest({ ...valid, prompt: "" }).ok).toBe(false);
    expect(parseRunRequest({ ...valid, prompt: "   " }).ok).toBe(false);
    expect(parseRunRequest({ ...valid, prompt: "x".repeat(32_001) }).ok).toBe(false);
    expect(parseRunRequest({ ...valid, prompt: "x".repeat(32_000) }).ok).toBe(true);
  });

  it("profile 白名单", () => {
    expect(parseRunRequest({ ...valid, profile: "nope" }).ok).toBe(false);
    expect(parseRunRequest({ ...valid, profile: 42 }).ok).toBe(false);
  });

  it("附件：合法通过；非法整体拒绝（fail closed）", () => {
    const brandedScope: Scope = {
      tenantId: makeTenantId("t"),
      botId: makeBotId("b"),
      deploymentId: makeDeploymentId("d"),
      userId: makeUserId("ou_1"),
      conversationId: makeConversationId("oc_1"),
    };
    const attachment = {
      id: "11111111-1111-4111-8111-111111111111",
      fileName: "notes.md",
      mimeType: "text/markdown",
      sha256: "a".repeat(64),
      size: 10,
      encryption: "none",
      storageKey: `${scopeKey(brandedScope)}/11111111-1111-4111-8111-111111111111-${"a".repeat(64)}.md`,
    };
    expect(parseRunRequest({ ...valid, attachments: [attachment] }).ok).toBe(true);
    // 任一附件非法 → 整个请求拒绝。
    expect(parseRunRequest({ ...valid, attachments: [{ ...attachment, sha256: "bad" }] }).ok).toBe(false);
    // 归属不符（其他 scope 的 storageKey）→ 拒绝。
    expect(parseRunRequest({
      ...valid,
      attachments: [{ ...attachment, storageKey: `${"b".repeat(64)}/x-${"a".repeat(64)}.md` }],
    }).ok).toBe(false);
  });
});
