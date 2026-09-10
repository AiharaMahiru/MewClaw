/**
 * dsh-lark-commands 测试（SPEC lark-commands.md §8）：
 * 解析（合法/非法）、命令路由、/runtime 读写、未知命令、降级视图。
 */
import { describe, expect, it, vi } from "vitest";

import { makeChatId, makeTenantId, makeBotId, makeDeploymentId, makeUserId, makeConversationId, scopeKey, type Scope } from "dsh-lark-contracts";

import { parseGatewayCommand } from "./parse.js";
import { CardActionRegistry } from "./card-actions.js";
import { apply, type LarkCommandsService } from "./index.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

const overview = {
  exists: true,
  todos: [
    { content: "检查迁移", status: "completed" as const },
    { content: "执行验证", status: "in_progress" as const },
  ],
  usage: {
    runs: 2,
    modelCalls: 3,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
  },
  lastActivityAt: "2026-08-14T01:02:03.000Z",
};

function makeCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const provided: Record<string, unknown> = {};
  return {
    emit: vi.fn(),
    credentials: { resolve: vi.fn(async () => ({ value: "pairing-secret" })) },
    larkRunClient: {
      sessionOverview: vi.fn(async () => overview),
      sessionCurrent: vi.fn(async () => ({ mode: "deterministic" as const })),
      // 返回类型放宽到 unknown：各用例按 wire 形态注入不同响应。
      cronControl: vi.fn(async (_command: unknown): Promise<unknown> => ({ jobs: [], runs: [] })),
    },
    provide: vi.fn((key: string, value: unknown) => {
      provided[key] = value;
    }),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return () => undefined;
    }),
    logger: { warn: vi.fn() },
    emits: (event: string, payload: never) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    service: () => provided.larkCommands as LarkCommandsService,
  };
}

describe("parseGatewayCommand", () => {
  it("合法命令：小写名 + 原文参数", () => {
    expect(parseGatewayCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseGatewayCommand("/RUNTIME long")).toEqual({ name: "runtime", args: "long" });
    expect(parseGatewayCommand("  /clear  ")).toEqual({ name: "clear", args: "" });
  });

  it("非命令/畸形输入返回 undefined", () => {
    for (const text of ["你好", "/", "//", "   ", "/ 空格开头"]) {
      expect(parseGatewayCommand(text)).toBeUndefined();
    }
  });
});

describe("命令处理：基础", () => {
  it("/help 返回命令清单", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "help", args: "" } });
    expect(result?.markdown).toContain("/clear");
    expect(result?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "开启新会话",
        command: "/clear",
        style: "danger",
        confirm: expect.any(String),
        actionId: expect.any(String),
      }),
    ]));
  });

  it("/clear 发出 clear-session 事件（旧会话保留语义）", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "clear", args: "" } });
    expect(result?.markdown).toContain("新会话");
    expect(env.emit).toHaveBeenCalledWith("lark/command/clear-session", { scope, chatId: "oc_1" });
  });

  it("/runtime 读写（scope 隔离、非法参数拒绝）", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const read = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "runtime", args: "" } });
    expect(read?.markdown).toContain("standard");
    expect(read?.actions?.map((action) => action.command)).toEqual(expect.arrayContaining([
      "/runtime quick",
      "/runtime standard",
      "/runtime long",
    ]));

    const set = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "runtime", args: "long" } });
    expect(set?.markdown).toContain("long");
    expect(env.service().getProfile(scope)).toBe("long");

    const bad = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "runtime", args: "nope" } });
    expect(bad?.markdown).toContain("用法");

    const other = { ...scope, conversationId: makeConversationId("oc_2") };
    expect(env.service().getProfile(other)).toBe("standard");
  });
});

describe("飞书 Web 配对登录", () => {
  it("/login 通过服务端凭证返回一次性配对 URL，不启动 Worker", async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:3080/internal/pairing/start");
      expect(init?.headers).toEqual({ authorization: "Bearer pairing-secret", "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ openId: "ou_1", sessionId: `session-${scopeKey(scope)}` });
      return new Response(JSON.stringify({
        url: "http://127.0.0.1:3080/auth/pair?token=opaque",
        binding: { status: "bound", displayName: "Pair User", email: "pair****@example.com" },
      }), { status: 201 });
    });
    vi.stubGlobal("fetch", request);
    try {
      const env = makeCtx();
      apply(env as never, { pairingEndpoint: "http://127.0.0.1:3080/internal/pairing/start", pairingTokenEnv: "AUTH_PAIRING_TOKEN" });
      const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "login", args: "" } });
      expect(result?.markdown).toContain("[打开 MewClaw Web](http://127.0.0.1:3080/auth/pair?token=opaque)");
      expect(result?.markdown).toContain("当前绑定状态：已绑定");
      expect(result?.markdown).toContain("Pair User");
      expect(result?.markdown).toContain("pair****@example.com");
      expect(result?.markdown).toContain("切换到已绑定 Web 账户");
      expect(env.credentials.resolve).toHaveBeenCalledWith("AUTH_PAIRING_TOKEN");
      expect(env.larkRunClient.sessionOverview).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("配对配置缺失或 auth-edge 不可用时返回明确失败卡", async () => {
    const missing = makeCtx();
    apply(missing as never, {});
    await expect(missing.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "login", args: "" } })).resolves.toMatchObject({ markdown: expect.stringContaining("尚未配置") });

    const request = vi.fn(async () => new Response(JSON.stringify({ error: "PAIRING_NOT_CONFIGURED" }), { status: 503 }));
    vi.stubGlobal("fetch", request);
    try {
      const unavailable = makeCtx();
      apply(unavailable as never, { pairingEndpoint: "http://127.0.0.1:3080/internal/pairing/start" });
      const result = await unavailable.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "login", args: "" } });
      expect(result?.markdown).toContain("服务端配对凭证尚未配置");
      expect(unavailable.logger.warn).toHaveBeenCalledWith(expect.stringContaining("PAIRING_NOT_CONFIGURED"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("个人机器人 /login 明确说明账号已归属", async () => {
    const env = makeCtx();
    apply(env as never, { pairingUnavailableMessage: "该个人机器人已归属当前 MewClaw 账号，无需再次绑定。" });
    const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "login", args: "" } });
    expect(result?.markdown).toContain("已归属当前 MewClaw 账号");
    expect(result?.markdown).not.toContain("尚未配置");
  });
});

describe("命令操作卡", () => {
  it("/help 返回注册的 actionId，卡片动作只能消费一次", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({
      scope,
      chatId: makeChatId("oc_1"),
      command: { name: "help", args: "" },
    });
    const runtime = result?.actions?.find((action) => action.command === "/runtime");
    expect(runtime?.actionId).toMatch(/^[0-9a-f-]{36}$/);

    const first = await env.service().handleCardAction({
      scope,
      chatId: makeChatId("oc_1"),
      actionId: runtime!.actionId!,
    });
    const replay = await env.service().handleCardAction({
      scope,
      chatId: makeChatId("oc_1"),
      actionId: runtime!.actionId!,
    });
    expect(first.markdown).toContain("当前运行档位");
    expect(replay.markdown).toContain("过期");
  });

  it("操作卡 actionId 与完整 Scope 绑定", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({
      scope,
      chatId: makeChatId("oc_1"),
      command: { name: "help", args: "" },
    });
    const actionId = result!.actions![0]!.actionId!;
    const otherScope = { ...scope, conversationId: makeConversationId("oc_other") };

    const rejected = await env.service().handleCardAction({
      scope: otherScope,
      chatId: makeChatId("oc_other"),
      actionId,
    });
    expect(rejected.markdown).toContain("无效");
    expect(env.emit).not.toHaveBeenCalled();
    const original = await env.service().handleCardAction({
      scope,
      chatId: makeChatId("oc_1"),
      actionId,
    });
    expect(original.markdown).not.toContain("无效");
  });
});

describe("CardActionRegistry", () => {
  it("TTL、容量和同一 action 的并发消费均 fail closed", () => {
    let now = 100;
    const registry = new CardActionRegistry({ ttlMs: 10, maxEntries: 2, now: () => now });
    const first = registry.register(scope, "/runtime quick");
    const second = registry.register(scope, "/runtime standard");
    const third = registry.register(scope, "/runtime long");
    expect(registry.consume(scope, first)).toBeUndefined();
    const [winner, replay] = [registry.consume(scope, third), registry.consume(scope, third)];
    expect(winner).toBe("/runtime long");
    expect(replay).toBeUndefined();

    const expiring = registry.register(scope, "/todo");
    now += 11;
    expect(registry.consume(scope, expiring)).toBeUndefined();
    expect(registry.consume(scope, second)).toBeUndefined();
  });
});

describe("命令处理：会话视图", () => {
  it("/todo、/session 查询当前 scoped 会话投影", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const todo = await env.service().handle({
      scope,
      chatId: makeChatId("oc_1"),
      command: { name: "todo", args: "" },
      sessionGeneration: 2,
    });
    const session = await env.service().handle({
      scope,
      chatId: makeChatId("oc_1"),
      command: { name: "session", args: "" },
      sessionGeneration: 2,
    });

    expect(todo?.markdown).toContain("执行验证");
    expect(session?.markdown).toContain("120");
    expect(todo?.actions?.map((action) => action.command)).toEqual(expect.arrayContaining(["/session", "/todo", "/runtime"]));
    expect(session?.actions?.map((action) => action.command)).toEqual(expect.arrayContaining(["/session current", "/session list", "/session new"]));
    expect(env.larkRunClient.sessionOverview).toHaveBeenCalledWith({ scope, sessionGeneration: 2 });
  });

  it("/handoff 明确为只读归属视图，不接受旧版目标交接", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({
      scope,
      chatId: makeChatId("oc_1"),
      command: { name: "handoff", args: "交给人工处理" },
    });
    expect(result?.markdown).toContain("不会创建交接任务");
  });

  it("未知命令返回 undefined（网关回退为提示卡）", async () => {
    const env = makeCtx();
    apply(env as never, {});
    const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "nope", args: "" } });
    expect(result).toBeUndefined();
  });
});

describe("/cron 确定性管理（R-18）", () => {
  const JOB_ID = "0199aabb-ccdd-4ee1-8ff0-001122334455";

  /** 带 cronControl 桩的环境。 */
  function cronEnv() {
    const env = makeCtx();
    apply(env as never, {});
    return env;
  }

  function cronJob(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      scope,
      task: "每天站会提醒",
      schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      status: "active",
      nextRunAt: "2026-08-17T01:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("/cron list：渲染任务行与提示；空列表给新建指引", async () => {
    const env = cronEnv();
    env.larkRunClient.cronControl.mockResolvedValueOnce({ jobs: [cronJob()], runs: [] });
    const result = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: "list" } });
    expect(result?.markdown).toContain(JOB_ID.slice(0, 8));
    expect(result?.markdown).toContain("每天站会提醒");
    expect(result?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "/cron", actionId: expect.any(String) }),
      expect.objectContaining({ command: `/cron ${JOB_ID}`, actionId: expect.any(String) }),
    ]));

    const empty = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: "" } });
    expect(empty?.markdown).toContain("暂无定时任务");
  });

  it("/cron <jobId>：详情走 get；pause/resume/delete 映射 stop/start/delete", async () => {
    const env = cronEnv();
    env.larkRunClient.cronControl.mockResolvedValueOnce(cronJob());
    const detail = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: JOB_ID } });
    expect(env.larkRunClient.cronControl).toHaveBeenCalledWith({ kind: "get", scope, jobId: JOB_ID });
    expect(detail?.markdown).toContain("0 9 * * 1-5");
    expect(detail?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: `/cron pause ${JOB_ID}` }),
      expect.objectContaining({ command: `/cron delete ${JOB_ID}`, style: "danger", confirm: expect.any(String) }),
    ]));

    env.larkRunClient.cronControl.mockResolvedValueOnce(cronJob({ status: "paused" }));
    await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: `pause ${JOB_ID}` } });
    expect(env.larkRunClient.cronControl).toHaveBeenLastCalledWith({ kind: "stop", scope, jobId: JOB_ID });

    env.larkRunClient.cronControl.mockResolvedValueOnce({ removed: true });
    const removed = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: `delete ${JOB_ID}` } });
    expect(env.larkRunClient.cronControl).toHaveBeenLastCalledWith({ kind: "delete", scope, jobId: JOB_ID });
    expect(removed?.markdown).toContain("已删除");
  });

  it("非法 jobId / 控制面失败 → 用法或降级提示", async () => {
    const env = cronEnv();
    const usage = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: "pause not-a-uuid" } });
    expect(usage?.markdown).toContain("用法");

    for (const args of ["list extra", `${JOB_ID} extra`, `pause ${JOB_ID} extra`, "help extra"]) {
      const extra = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args } });
      expect(extra?.markdown).toContain("用法");
    }
    expect(env.larkRunClient.cronControl).not.toHaveBeenCalled();

    env.larkRunClient.cronControl.mockRejectedValueOnce(new Error("worker down"));
    const down = await env.service().handle({ scope, chatId: makeChatId("oc_1"), command: { name: "cron", args: "list" } });
    expect(down?.markdown).toContain("暂不可用");
  });
});
