import { describe, expect, it } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";

import { CardActionRegistry } from "./card-actions.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

describe("CardActionRegistry", () => {
  it("拒绝跨 Scope 消费且同一 action 只返回一次命令", () => {
    const registry = new CardActionRegistry({ ttlMs: 60_000, maxEntries: 8 });
    const actionId = registry.register(scope, "/clear");
    const other = { ...scope, userId: makeUserId("ou_2") };

    expect(registry.consume(other, actionId)).toBeUndefined();
    expect(registry.consume(scope, actionId)).toBe("/clear");
    expect(registry.consume(scope, actionId)).toBeUndefined();
  });
});
