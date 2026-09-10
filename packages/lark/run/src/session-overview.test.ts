import { describe, expect, it, vi } from "vitest";

import { parseScope } from "dsh-lark-contracts";

import { readSessionOverview, sessionIdForScope } from "./session-overview.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scope = parsedScope.value;

describe("readSessionOverview", () => {
  it("从持久化事件折叠 TODO、运行次数与 token 用量", async () => {
    const id = sessionIdForScope(scope, 2);
    const persistence = {
      listSnapshots: vi.fn(async () => [{ header: { id } }]),
      inspect: vi.fn(async () => ({
        meta: { id },
        events: [
          { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
          { type: "lark/message/in", seq: 1, time: 2, data: { scope } },
          { type: "todo/write", seq: 2, time: 3, data: { todos: [{ content: "验证迁移", status: "in_progress" }] } },
          {
            type: "assistant/message", seq: 3, time: 4,
            data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5 } },
          },
        ],
      })),
    };

    const directory = { resolve: vi.fn(async () => ({ mode: "deterministic" })) };
    const result = await readSessionOverview(persistence as never, directory as never, { scope, sessionGeneration: 2 });

    expect(result).toEqual({
      exists: true,
      todos: [{ content: "验证迁移", status: "in_progress" }],
      usage: {
        runs: 1,
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
      },
      lastActivityAt: new Date(4).toISOString(),
    });
  });

  it("不同完整 Scope 派生不同 session，不读取其他用户日志", async () => {
    const other = { ...scope, userId: "ou_2" as typeof scope.userId };
    const persistence = {
      listSnapshots: vi.fn(async () => [{ header: { id: sessionIdForScope(scope, 0) } }]),
      inspect: vi.fn(),
    };

    const directory = { resolve: vi.fn(async () => ({ mode: "deterministic" })) };
    await expect(readSessionOverview(persistence as never, directory as never, { scope: other, sessionGeneration: 0 }))
      .resolves.toEqual({ exists: false });
    expect(persistence.inspect).not.toHaveBeenCalled();
  });

  it("已选择 shared session 时读取授权后的 Web 会话投影", async () => {
    const sharedId = "web-shared-overview" as never;
    const persistence = {
      listSnapshots: vi.fn(async () => [{ header: { id: sharedId } }]),
      inspect: vi.fn(async () => ({
        meta: { id: sharedId },
        events: [{ type: "todo/write", seq: 0, time: 5, data: { todos: [{ content: "接续 Web", status: "pending" }] } }],
      })),
    };
    const directory = {
      resolve: vi.fn(async () => ({ mode: "shared", sessionId: sharedId, cwd: "D:/web/project" })),
    };

    await expect(readSessionOverview(persistence as never, directory as never, { scope, sessionGeneration: 0 }))
      .resolves.toMatchObject({ exists: true, todos: [{ content: "接续 Web", status: "pending" }] });
    expect(persistence.inspect).toHaveBeenCalledWith(sharedId);
  });
});
