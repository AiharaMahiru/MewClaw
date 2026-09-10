import { describe, expect, it } from "vitest";

import { SessionId } from "@deepseek-ai/dsh-session";

import { parseScope } from "./scope.js";
import { requireLarkRunScope } from "./context.js";

const parsed = parseScope({
  tenantId: "tenant-a",
  botId: "bot-a",
  deploymentId: "deployment-a",
  userId: "user-a",
  conversationId: "conversation-a",
});
if (!parsed.ok) throw new Error("unreachable");

const webIndex = {
  bindWeb: () => undefined,
  webModelRouteFor: () => undefined,
  webModelRouteForCurrentSelection: () => undefined,
  webModelSelectionFor: () => undefined,
};

describe("requireLarkRunScope", () => {
  it("只从 agent.id 命中的 Worker 索引返回完整 Scope", () => {
    const sessionId = SessionId("session-a");
    const ctx = { larkScopeIndex: { ...webIndex, get: (id: string) => id === sessionId ? parsed.value : undefined } };
    expect(requireLarkRunScope(ctx, { agent: { id: sessionId } }, "knowledge_search")).toBe(parsed.value);
  });

  it("无 Agent 或索引未命中时 fail closed", () => {
    expect(() => requireLarkRunScope({}, {}, "generate_image")).toThrow(/agent context/);
    expect(() => requireLarkRunScope({ larkScopeIndex: { ...webIndex, get: () => undefined } }, { agent: { id: SessionId("unknown") } }, "memory_manage"))
      .toThrow(/lark run scope.*Scope 信封/);
  });
});
