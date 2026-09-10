import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";

import {
  makeBotId,
  makeChatId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import { RunClientError, type LarkRunClient } from "dsh-lark-run-client";

import { CardActionRegistry } from "./card-actions.js";
import { GatewayCommands } from "./service.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};
const chatId = makeChatId("oc_1");
const firstId = SessionId("web-1");
const secondId = SessionId("web-2");
const base = { scope, sessionGeneration: 3 };
const overview = {
  exists: true,
  todos: [],
  usage: {
    runs: 2,
    modelCalls: 3,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
  },
  lastActivityAt: "2026-08-18T01:02:03.000Z",
};
const sessions = {
  sessions: [
    {
      sessionId: firstId,
      selected: true,
      claimedAt: "2026-08-18T00:00:00.000Z",
      lastUsedAt: "2026-08-18T02:00:00.000Z",
    },
    {
      sessionId: secondId,
      selected: false,
      claimedAt: "2026-08-17T00:00:00.000Z",
      lastUsedAt: "2026-08-17T02:00:00.000Z",
    },
  ],
};

function makeEnv() {
  const runClient = {
    sessionOverview: vi.fn(async () => overview),
    sessionCurrent: vi.fn(async () => ({ mode: "shared" as const, sessionId: firstId })),
    sessionList: vi.fn(async () => sessions),
    sessionClaim: vi.fn(async () => ({ mode: "shared" as const, sessionId: firstId })),
    sessionUse: vi.fn(async () => ({ mode: "shared" as const, sessionId: secondId })),
    sessionNew: vi.fn(async () => ({ mode: "deterministic" as const })),
    sessionUnlink: vi.fn(async () => ({ mode: "deterministic" as const })),
  };
  const cardActions = new CardActionRegistry({ ttlMs: 60_000, maxEntries: 32 });
  const commands = new GatewayCommands({
    ctx: { emit: vi.fn(), logger: { warn: vi.fn() } } as never,
    runClient: runClient as unknown as LarkRunClient,
    defaultProfile: "standard",
    cardActions,
  });
  return { commands, runClient };
}

function handle(env: ReturnType<typeof makeEnv>, args: string) {
  return env.commands.handle({
    scope,
    chatId,
    command: { name: "session", args },
    sessionGeneration: 3,
  });
}

describe("/session 子命令", () => {
  it("无参数与 current 同时读取目录目标和当前持久化投影", async () => {
    const env = makeEnv();

    const implicit = await handle(env, "");
    const explicit = await handle(env, "current");

    expect(implicit?.markdown).toContain("Web 共享会话");
    expect(explicit?.markdown).toContain("输入 token：120");
    expect(env.runClient.sessionCurrent).toHaveBeenCalledTimes(2);
    expect(env.runClient.sessionCurrent).toHaveBeenLastCalledWith(base);
    expect(env.runClient.sessionOverview).toHaveBeenLastCalledWith(base);
  });

  it("list 生成序号切换按钮，sessionId 只保存在服务端命令引用中", async () => {
    const env = makeEnv();

    const result = await handle(env, "list");

    expect(result?.markdown).toContain("1. 当前");
    expect(result?.markdown).toContain("2. 可切换");
    expect(result?.actions?.map((action) => action.command)).toEqual(expect.arrayContaining([
      `/session use-id ${firstId}`,
      `/session use-id ${secondId}`,
      "/session new",
    ]));
    expect(result?.actions?.every((action) => typeof action.actionId === "string")).toBe(true);
    expect(env.runClient.sessionList).toHaveBeenCalledWith(base);
  });

  it("use 先重读当前 Scope 列表，再把所选 sessionId 交给 Worker 复核", async () => {
    const env = makeEnv();

    const result = await handle(env, "use 2");

    expect(result?.markdown).toContain("已切换到会话 2");
    expect(env.runClient.sessionList).toHaveBeenCalledWith(base);
    expect(env.runClient.sessionUse).toHaveBeenCalledWith({ ...base, sessionId: secondId });

    const invalid = await handle(env, "use 3");
    expect(invalid?.markdown).toContain("用法");
    expect(env.runClient.sessionUse).toHaveBeenCalledTimes(1);
  });

  it("会话列表用户可见输出保持稳定且不暴露 Scope", async () => {
    const result = await handle(makeEnv(), "list");
    const visible = {
      markdown: result?.markdown,
      actions: result?.actions?.map(({ label, style, confirm }) => ({ label, style, confirm })),
    };

    expect(visible).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "confirm": undefined,
            "label": "切换到 1",
            "style": "primary",
          },
          {
            "confirm": undefined,
            "label": "切换到 2",
            "style": "default",
          },
          {
            "confirm": undefined,
            "label": "当前会话",
            "style": undefined,
          },
          {
            "confirm": undefined,
            "label": "会话列表",
            "style": undefined,
          },
          {
            "confirm": undefined,
            "label": "使用飞书会话",
            "style": undefined,
          },
          {
            "confirm": "解除后不会删除 Web 会话记录。",
            "label": "解除绑定",
            "style": "danger",
          },
        ],
        "markdown": "**可接续会话**
      1. 当前 · 最近使用 2026-08-18T02:00:00.000Z
      2. 可切换 · 最近使用 2026-08-17T02:00:00.000Z",
      }
    `);
    expect(JSON.stringify(visible)).not.toContain(scope.userId);
  });

  it("claim/new/unlink 使用各自窄端点并拒绝多余或畸形参数", async () => {
    const env = makeEnv();
    const code = "A".repeat(24);

    expect((await handle(env, `claim ${code}`))?.markdown).toContain("已接续 Web 会话");
    expect((await handle(env, "new"))?.markdown).toContain("飞书会话");
    expect((await handle(env, "unlink"))?.markdown).toContain("已解除");
    expect(env.runClient.sessionClaim).toHaveBeenCalledWith({ ...base, code });
    expect(env.runClient.sessionNew).toHaveBeenCalledWith(base);
    expect(env.runClient.sessionUnlink).toHaveBeenCalledWith(base);

    for (const args of ["claim bad", `claim ${code} extra`, "new extra", "unlink extra", "current extra"]) {
      expect((await handle(env, args))?.markdown).toContain("用法");
    }
    expect(env.runClient.sessionClaim).toHaveBeenCalledTimes(1);
    expect(env.runClient.sessionNew).toHaveBeenCalledTimes(1);
    expect(env.runClient.sessionUnlink).toHaveBeenCalledTimes(1);
  });

  it("列表卡片回调仍调用 Worker 复核，拒绝时不切换", async () => {
    const env = makeEnv();
    const listed = await handle(env, "list");
    const useAction = listed!.actions!.find((action) => action.command === `/session use-id ${secondId}`)!;
    env.runClient.sessionList.mockResolvedValueOnce({ sessions: [...sessions.sessions].reverse() });
    env.runClient.sessionUse.mockRejectedValueOnce(new Error("SESSION_NOT_AVAILABLE"));

    const result = await env.commands.handleCardAction({
      scope,
      chatId,
      actionId: useAction.actionId!,
      sessionGeneration: 3,
    });

    expect(result.markdown).toContain("暂不可用");
    expect(env.runClient.sessionUse).toHaveBeenCalledWith({ ...base, sessionId: secondId });
  });

  it("claim 区分无效分享码与 Worker 不可达", async () => {
    const env = makeEnv();
    const code = "B".repeat(24);
    env.runClient.sessionClaim.mockRejectedValueOnce(new RunClientError("HTTP_ERROR", "worker 返回 400", 400));
    expect((await handle(env, `claim ${code}`))?.markdown).toContain("无效或已过期");

    env.runClient.sessionClaim.mockRejectedValueOnce(new RunClientError("CONNECT_FAILED", "连接 worker 失败"));
    expect((await handle(env, `claim ${code}`))?.markdown).toContain("暂不可用");
  });
});
