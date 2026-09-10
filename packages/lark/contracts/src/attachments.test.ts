/**
 * 附件契约解析测试（wire 边界）：严格拒绝未知键/非法形态/超限/归属不符。
 */
import { describe, expect, it } from "vitest";

import { parseRunAttachments, type RunAttachment } from "./attachments.js";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "./ids.js";
import { scopeKey, type Scope } from "./scope.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

function valid(): RunAttachment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "notes.md",
    mimeType: "text/markdown",
    sha256: "a".repeat(64),
    size: 10,
    encryption: "none",
    storageKey: `${scopeKey(scope)}/11111111-1111-4111-8111-111111111111-${"a".repeat(64)}.md`,
  };
}

describe("parseRunAttachments", () => {
  it("合法附件通过；未知键拒绝", () => {
    expect(parseRunAttachments([valid()], scopeKey(scope))).toHaveLength(1);
    expect(parseRunAttachments([{ ...valid(), extra: 1 }], scopeKey(scope))).toBeUndefined();
  });

  it("非法 sha256 / 非法 storageKey / 路径分隔文件名拒绝", () => {
    expect(parseRunAttachments([{ ...valid(), sha256: "xyz" }], scopeKey(scope))).toBeUndefined();
    expect(parseRunAttachments([{ ...valid(), storageKey: "../evil" }], scopeKey(scope))).toBeUndefined();
    expect(parseRunAttachments([{ ...valid(), fileName: "a/b.md" }], scopeKey(scope))).toBeUndefined();
  });

  it("归属不符（其他 scope 的 storageKey）拒绝", () => {
    const other: Scope = { ...scope, conversationId: makeConversationId("oc_2") };
    expect(parseRunAttachments([valid()], scopeKey(other))).toBeUndefined();
  });

  it("超上限（>10）拒绝；空数组拒绝", () => {
    expect(parseRunAttachments(Array.from({ length: 11 }, () => valid()), scopeKey(scope))).toBeUndefined();
    expect(parseRunAttachments([], scopeKey(scope))).toBeUndefined();
  });

  it("加密标记白名单", () => {
    expect(parseRunAttachments([{ ...valid(), encryption: "cdg" }], scopeKey(scope))).toHaveLength(1);
    expect(parseRunAttachments([{ ...valid(), encryption: "aes" }], scopeKey(scope))).toBeUndefined();
  });

  it("不安全的附件字节数拒绝", () => {
    expect(parseRunAttachments([{ ...valid(), size: Number.MAX_SAFE_INTEGER + 1 }], scopeKey(scope))).toBeUndefined();
  });
});
