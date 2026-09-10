/**
 * dsh-lark-gateway 插件测试（SPEC lark-gateway.md §8）：
 * mock 全部依赖服务 + 捕获 ctx.on 事件回调，
 * 覆盖授权拒绝、去重、命令分流、运行编排、终态替换、审批呈现与解答。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  makeBotId,
  makeArtifactId,
  makeChatId,
  makeConversationId,
  makeDeploymentId,
  makeInteractionId,
  makeMessageId,
  makeTenantId,
  makeUserId,
  scopeKey,
  type Scope,
} from "dsh-lark-contracts";
import type { InboundMessage } from "dsh-lark-ws";
import type { GatewayCommandResult } from "dsh-lark-commands";
import { RunClientError } from "dsh-lark-run-client";

import { apply } from "./index.js";

// 代次状态目录：测试前清理，避免跨运行残留累积。
const STATE_DIR = "var/test-gateway-state";

beforeEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(config.uploadsRoot, { recursive: true, force: true });
});

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

const config = {
  authorizedOpenIds: ["ou_1"],
  allowedChatIds: [],
  processingCardText: "正在思考…",
  failureCardTemplate: "运行失败（{{code}}）：{{hint}}",
  unauthorizedCardText: "未授权",
  stateDir: STATE_DIR,
  tenantId: "t",
  botId: "b",
  deploymentId: "d",
  uploadsRoot: "var/test-gateway-uploads",
  cronPollIntervalMs: 0, // 测试关闭投递轮询。
};

/** 组装假 ctx：捕获 on 回调，mock 服务。 */
function makeEnv() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const lark = {
    sendMessage: vi.fn(async (_chatId?: unknown, _content?: unknown) => makeMessageId("om_card")),
    uploadImage: vi.fn(),
    downloadResource: vi.fn(),
  };
  const card = {
    sendProcessing: vi.fn(async (_chatId?: unknown) => makeMessageId("om_processing")),
    append: vi.fn((_messageId?: unknown, _markdown?: unknown) => undefined),
    replace: vi.fn(async (_messageId?: unknown, _markdown?: unknown) => undefined),
    fail: vi.fn(async (_messageId?: unknown, _markdown?: unknown) => undefined),
    discard: vi.fn(),
  };
  const runClient = {
    submit: vi.fn(),
    readArtifact: vi.fn(),
    cancel: vi.fn(async () => undefined),
    resolveInteraction: vi.fn(async () => undefined),
  };
  const commands = {
    parse: vi.fn((text: string) => (text.startsWith("/") ? { name: text.slice(1).split(/\s+/)[0]!.toLowerCase(), args: text.slice(1).split(/\s+/).slice(1).join(" ") } : undefined)),
    handle: vi.fn(async (input: { command: { name: string } }): Promise<GatewayCommandResult | undefined> => input.command.name === "help" ? { markdown: "帮助" } : undefined),
    handleCardAction: vi.fn(async (): Promise<GatewayCommandResult> => ({ markdown: "操作结果" })),
    getProfile: vi.fn(() => "standard" as const),
  };
  const ctx = {
    lark,
    larkRunClient: runClient,
    larkCard: card,
    larkCommands: commands,
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return () => undefined;
    }),
    effect: vi.fn(() => () => undefined),
    logger: { warn: vi.fn() },
    emit: vi.fn(),
  };
  return {
    ctx,
    lark,
    card,
    runClient,
    commands,
    emit: (event: string, payload: unknown) => {
      // 方差吸收：存入的插件 handler 参数是 never（异构回调列表的存底形态）。
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload as never);
    },
    handlers: listeners,
  };
}

type MessageOverrides = Partial<{
  userId: string;
  chatId: string;
  eventId: string;
  text: string;
  messageId: string;
  resources: InboundMessage["resources"];
}>;
type StreamEvent = { type: string; data: unknown };

/** 一条入站消息。 */
function message(overrides: MessageOverrides = {}): InboundMessage {
  return {
    eventId: overrides.eventId ?? "ev-1",
    messageId: makeMessageId(overrides.messageId ?? "om_1"),
    userId: makeUserId(overrides.userId ?? "ou_1"),
    chatId: makeChatId(overrides.chatId ?? "oc_1"),
    delivery: "prompt",
    text: overrides.text ?? "你好",
    resources: overrides.resources ?? [],
  };
}

/** 构造一条流：事件行 + 终态行。 */
function stream(doneCode: string, events: StreamEvent[] = []): AsyncIterable<unknown> {
  const lines = [
    ...events.map((event, index) => ({ event: { ...event, seq: index, time: 1 }, envelope: { runId: "run-1", scope } })),
    { envelope: { runId: "run-1", scope }, outcome: doneCode === "OK" ? { code: "OK" } : { code: doneCode, message: doneCode } },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  };
}

describe("授权与去重", () => {
  it("授权与部署身份配置含非法 ID 时启动 fail loud", () => {
    for (const unsafe of [
      { authorizedOpenIds: ["ou_\nunsafe"] },
      { allowedChatIds: ["oc_\nunsafe"] },
      { tenantId: "tenant\nunsafe" },
    ]) {
      expect(() => apply(makeEnv().ctx as never, { ...config, ...unsafe })).toThrow();
    }
  });

  it("消息日志不记录用户、会话或正文", async () => {
    const env = makeEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    apply(env.ctx as never, config);
    env.runClient.submit.mockResolvedValue(stream("OK"));
    env.emit("lark/message/received", message({ text: "高度敏感正文" }));

    await vi.waitFor(() => expect(env.runClient.submit).toHaveBeenCalled());
    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain("ou_1");
    expect(output).not.toContain("oc_1");
    expect(output).not.toContain("高度敏感正文");
  });

  it("未授权用户：礼貌拒绝卡，不提交运行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.emit("lark/message/received", message({ userId: "ou_stranger" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("允许列表内的 chat 限制：陌生群拒绝", async () => {
    const env = makeEnv();
    apply(env.ctx as never, { ...config, allowedChatIds: ["oc_allowed"] });
    env.emit("lark/message/received", message({ chatId: "oc_other" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("同一 eventId 窗口内幂等（第二次忽略）", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.emit("lark/message/received", message({ text: "第一次" }));
    env.emit("lark/message/received", message({ text: "第二次" }));
    await vi.waitFor(() => expect(env.runClient.submit).toHaveBeenCalledTimes(1));
  });
});

describe("启动期状态恢复", () => {
  it("持久代次尚未读完时到达的消息仍使用已恢复的代次", async () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      join(STATE_DIR, "session-generations.json"),
      JSON.stringify({ [scopeKey(scope)]: 7 }),
      "utf8",
    );
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.submit.mockResolvedValue(stream("OK"));

    env.emit("lark/message/received", message({ eventId: "ev-restored" }));

    await vi.waitFor(() => expect(env.runClient.submit).toHaveBeenCalledTimes(1));
    expect((env.runClient.submit.mock.calls[0]![0] as { sessionGeneration: number }).sessionGeneration).toBe(7);
  });
});

describe("卡片回调授权", () => {
  it("未授权 form-submit/command 不产生副作用", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.emit("lark/card/action", { kind: "form-submit", submissionKind: "questionnaire.submit", messageId: makeMessageId("om_card"), chatId: makeChatId("oc_1"), userId: makeUserId("ou_stranger"), interactionId: makeInteractionId("0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c"), formValues: { q1: "继续" } });
    env.emit("lark/card/action", { kind: "command", messageId: makeMessageId("om_card"), chatId: makeChatId("oc_1"), userId: makeUserId("ou_stranger"), actionId: makeInteractionId("0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c") });
    await Promise.resolve();

    expect(env.runClient.resolveInteraction).not.toHaveBeenCalled();
    expect(env.commands.handle).not.toHaveBeenCalled();
    expect(env.runClient.submit).not.toHaveBeenCalled();
    expect(env.lark.sendMessage).not.toHaveBeenCalled();
  });
});

describe("命令卡 action 引用", () => {
  it("已授权 actionId 只交给 commands provider，绝不回退为 worker run", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const actionId = makeInteractionId("0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c");
    env.emit("lark/card/action", {
      kind: "command",
      messageId: makeMessageId("om_card"),
      chatId: makeChatId("oc_1"),
      userId: makeUserId("ou_1"),
      actionId,
    });

    await vi.waitFor(() => expect(env.commands.handleCardAction).toHaveBeenCalledWith(
      expect.objectContaining({ scope, actionId, sessionGeneration: 0 }),
    ));
    expect(env.commands.handle).not.toHaveBeenCalled();
    expect(env.runClient.submit).not.toHaveBeenCalled();
    expect(env.lark.sendMessage).toHaveBeenCalled();
  });
});

describe("命令分流", () => {
  it("/help：独立卡返回，不提交运行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.emit("lark/message/received", message({ text: "/help" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(env.commands.handle).toHaveBeenCalledWith(expect.objectContaining({ scope, sessionGeneration: 0 }));
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("命令结果动作卡只向飞书发送 actionId，不泄漏 command", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const actionId = makeInteractionId("0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c");
    env.commands.handle.mockResolvedValueOnce({
      markdown: "帮助",
      actions: [{
        label: "开启新会话",
        command: "/clear",
        actionId,
        style: "danger",
        confirm: "确认开启新会话？",
      }],
    });

    env.emit("lark/message/received", message({ text: "/help" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    const content = env.lark.sendMessage.mock.calls.at(-1)![1] as {
      card: { body: { elements: Array<{ behaviors?: Array<{ value: Record<string, string> }> }> } };
    };
    const button = content.card.body.elements[1]!;
    expect(button.behaviors?.[0]?.value).toEqual({ actionId });
    expect(JSON.stringify(content)).not.toContain("/clear");
  });

  it("未知命令：提示卡，不提交运行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.emit("lark/message/received", message({ text: "/nope" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("/clear：代次递增，下次提交带 sessionGeneration", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    // 先跑一轮（代次 0）。
    env.runClient.submit.mockResolvedValue(stream("OK", [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "回答" }] } } }]));
    env.emit("lark/message/received", message({ text: "第一轮" }));
    await vi.waitFor(() => expect(env.runClient.submit).toHaveBeenCalledTimes(1));
    expect((env.runClient.submit.mock.calls[0]![0] as { sessionGeneration: number }).sessionGeneration).toBe(0);

    // /clear：commands.handle 内发 clear-session 事件 → 代次 1。
    env.commands.handle.mockImplementation(async (input: { command: { name: string } }) => {
      if (input.command.name === "clear") {
        env.emit("lark/command/clear-session", { scope });
        return { markdown: "新会话" };
      }
      return undefined;
    });
    env.emit("lark/message/received", message({ eventId: "ev-clear", text: "/clear" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());

    env.emit("lark/message/received", message({ eventId: "ev-2", text: "第二轮" }));
    await vi.waitFor(() => expect(env.runClient.submit).toHaveBeenCalledTimes(2));
    expect((env.runClient.submit.mock.calls[1]![0] as { sessionGeneration: number }).sessionGeneration).toBe(1);
  });
});

describe("附件资源", () => {
  it("多个资源部分失败时清理此前未暂存附件且不提交运行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.lark.downloadResource
      .mockResolvedValueOnce({ stream: Readable.toWeb(Readable.from([Buffer.from("first")])) })
      .mockRejectedValueOnce(new Error("download failed"));

    env.emit("lark/message/received", message({
      eventId: "ev-partial-resources",
      resources: [
        { type: "file", key: "file_1", fileName: "first.txt" },
        { type: "file", key: "file_2", fileName: "second.txt" },
      ],
    }));

    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(readdirSync(join(config.uploadsRoot, scopeKey(scope)))).toEqual([]);
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });
});

describe("运行编排", () => {
  it("初始处理卡发送失败时返回独立失败卡且不提交运行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.card.sendProcessing.mockRejectedValueOnce(new Error("send failed"));

    env.emit("lark/message/received", message({ eventId: "ev-processing-failed" }));

    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    expect(JSON.stringify(env.lark.sendMessage.mock.calls.at(-1)![1])).toContain("CARD_SEND_FAILED");
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("事件流 → 卡片增量 + OK 终态替换", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.submit.mockResolvedValue(stream("OK", [
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "回答内容" }] } } },
      { type: "tool/call", data: { name: "bash", arguments: "{}", callId: "c1", turn: 1, step: 1 } },
      { type: "tool/result", data: { message: { content: [] } } },
    ]));
    env.emit("lark/message/received", message({ text: "帮我" }));
    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalled());
    expect(env.card.sendProcessing).toHaveBeenCalledWith("oc_1");
    expect(env.card.append).toHaveBeenCalledWith("om_processing", "回答内容");
    // 工具折叠行出现过。
    const appendCalls = env.card.append.mock.calls.map((call) => call[1] as string).join("\n");
    expect(appendCalls).toContain("`bash`");
    // 终态整卡替换（含统计行）。
    expect(env.card.replace.mock.calls[0]![1]).toContain("1 个工具");
  });

  it("assistant/chunk 只展示文本增量，reasoning/tool-call 不外泄且不重复完整消息", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.submit.mockResolvedValue(stream("OK", [
      { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "内部推理" } } },
      { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 1, id: "call_1", argumentsDelta: "{\"secret\":true}" } } },
      { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "早期" } } },
      { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "回复" } } },
      { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "早期回复" }] } } },
    ]));
    env.emit("lark/message/received", message({ eventId: "ev-stream-chunk" }));

    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalled());
    const appendText = env.card.append.mock.calls.map((call) => String(call[1])).join("\n");
    expect(appendText).toContain("早期");
    expect(appendText).toContain("回复");
    expect(appendText).not.toContain("内部推理");
    expect(appendText).not.toContain("secret");
    const finalText = String(env.card.replace.mock.calls[0]![1]);
    expect(finalText.match(/早期回复/g)).toHaveLength(1);
  });

  it("工具行折叠使用 Gateway 配置，而非硬编码默认", async () => {
    const env = makeEnv();
    apply(env.ctx as never, { ...config, maxToolLines: 1 });
    env.runClient.submit.mockResolvedValue(stream("OK", [
      { type: "tool/call", data: { name: "first", arguments: "{}", callId: "c1", turn: 1, step: 1 } },
      { type: "tool/result", data: { message: { content: [] } } },
      { type: "tool/call", data: { name: "second", arguments: "{}", callId: "c2", turn: 1, step: 2 } },
      { type: "tool/result", data: { message: { content: [] } } },
    ]));
    env.emit("lark/message/received", message({ eventId: "ev-tool-limit" }));

    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalled());
    expect(env.card.replace.mock.calls[0]![1]).toContain("…及另外 2 个工具");
  });

  it("EMPTY_RESPONSE → 失败卡（含用户提示，无 pending 卡残留）", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.submit.mockResolvedValue(stream("EMPTY_RESPONSE"));
    env.emit("lark/message/received", message({ text: "帮我" }));
    await vi.waitFor(() => expect(env.card.fail).toHaveBeenCalled());
    expect(env.card.fail.mock.calls[0]![1]).toContain("没有可展示的回复");
    expect(env.card.replace).not.toHaveBeenCalled();
  });

  it("流中断（非最终事件）→ 失败卡", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const broken: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }, envelope: { runId: "run-1", scope } };
        throw new Error("connection reset");
      },
    };
    env.runClient.submit.mockResolvedValue(broken);
    env.emit("lark/message/received", message({ text: "帮我" }));
    await vi.waitFor(() => expect(env.card.fail).toHaveBeenCalled());
    expect(env.card.fail.mock.calls[0]![1]).toContain("运行中断");
  });

  it("流提前正常结束但没有终态 → 失败卡", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const ended: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }, envelope: { runId: "run-1", scope } };
      },
    };
    env.runClient.submit.mockResolvedValue(ended);

    env.emit("lark/message/received", message({ eventId: "ev-stream-eof" }));
    await vi.waitFor(() => expect(env.card.fail).toHaveBeenCalled());
    expect(env.card.fail.mock.calls[0]![1]).toContain("STREAM_BROKEN");
    expect(env.card.fail.mock.calls[0]![1]).toContain("运行中断");
  });

  it("Worker 提交连接失败 → 网络失败卡", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.submit.mockRejectedValue(new RunClientError("CONNECT_FAILED", "worker unavailable"));

    env.emit("lark/message/received", message({ eventId: "ev-connect-failed" }));
    await vi.waitFor(() => expect(env.card.fail).toHaveBeenCalled());
    expect(env.card.fail.mock.calls[0]![1]).toContain("CONNECT_FAILED");
    expect(env.card.fail.mock.calls[0]![1]).toContain("worker 不可达");
  });

  it("重复终态只更新一次卡片", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const duplicateDone: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { envelope: { runId: "run-1", scope }, outcome: { code: "OK" } };
        yield { envelope: { runId: "run-1", scope }, outcome: { code: "RUNTIME_ERROR", message: "late" } };
      },
    };
    env.runClient.submit.mockResolvedValue(duplicateDone);

    env.emit("lark/message/received", message({ eventId: "ev-duplicate-done" }));
    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalledTimes(1));
    expect(env.card.fail).not.toHaveBeenCalled();
  });

  it.each(["generated-image", "generated-image.txt"])("Worker MIME 识别图片并交付（%s）", async (name) => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const bytes = Uint8Array.from([1, 2, 3]);
    env.runClient.readArtifact.mockResolvedValue({ bytes, mimeType: "image/png" });
    env.lark.uploadImage.mockResolvedValue("img_v2_generated");
    env.runClient.submit.mockResolvedValue(stream("OK", [{
      type: "lark/artifact/created",
      data: {
        scope,
        artifactId: makeArtifactId("a".repeat(64)),
        name,
        digest: "b".repeat(64),
        bytes: bytes.byteLength,
      },
    }]));

    env.emit("lark/message/received", message({ eventId: "ev-image" }));

    await vi.waitFor(() => expect(env.runClient.readArtifact).toHaveBeenCalled());
    expect(env.runClient.readArtifact).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      name,
      bytes: 3,
    }));
    await vi.waitFor(() => expect(env.lark.uploadImage).toHaveBeenCalledWith(bytes));
    expect(env.lark.sendMessage).toHaveBeenCalledWith("oc_1", { kind: "image", imageKey: "img_v2_generated" });
    expect(env.card.append.mock.calls.some((call) => String(call[1]).includes(name))).toBe(false);
  });

  it("非图片 artifact 继续作为 Markdown 交付行", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.readArtifact.mockRejectedValue(new RunClientError("HTTP_ERROR", "not an image", 404));
    env.runClient.submit.mockResolvedValue(stream("OK", [{
      type: "lark/artifact/created",
      data: {
        scope,
        artifactId: makeArtifactId("c".repeat(64)),
        name: "report.md",
        digest: "d".repeat(64),
        bytes: 42,
      },
    }]));

    env.emit("lark/message/received", message({ eventId: "ev-report" }));

    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalled());
    expect(env.runClient.readArtifact).toHaveBeenCalledWith(expect.objectContaining({ name: "report.md" }));
    expect(env.card.append.mock.calls.some((call) => String(call[1]).includes("report.md"))).toBe(true);
  });

  it("图片交付失败只显示提示，不把 OK run 改为失败", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    env.runClient.readArtifact.mockRejectedValue(new Error("artifact unavailable"));
    env.runClient.submit.mockResolvedValue(stream("OK", [{
      type: "lark/artifact/created",
      data: {
        scope,
        artifactId: makeArtifactId("e".repeat(64)),
        name: "generated-image.png",
        digest: "f".repeat(64),
        bytes: 3,
      },
    }]));

    env.emit("lark/message/received", message({ eventId: "ev-image-failure" }));

    await vi.waitFor(() => expect(env.card.replace).toHaveBeenCalled());
    expect(env.card.fail).not.toHaveBeenCalled();
    expect(env.card.append.mock.calls.some((call) => String(call[1]).includes("图片交付失败"))).toBe(true);
  });
});

describe("运行编排/审批", () => {
  it("审批出卡事件 → 发送问卷卡；回调 → resolveInteraction", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    env.runClient.submit.mockResolvedValue(stream("OK", [{
      type: "lark/approval/requested",
      data: { scope, interactionId, kind: "questionnaire", question: { id: "q1", question: "继续？", options: ["继续", "停止"] } },
    }]));
    env.emit("lark/message/received", message({ text: "帮我" }));
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalled());
    const calls = env.lark.sendMessage.mock.calls;
    expect(calls.some((call) => (call[1] as { kind: string }).kind === "markdown-card")).toBe(true);

    // 问卷回调：form-submit → worker 解答。
    env.emit("lark/card/action", {
      kind: "form-submit",
      submissionKind: "questionnaire.submit",
      messageId: makeMessageId("om_card"),
      chatId: makeChatId("oc_1"),
      userId: makeUserId("ou_1"),
      interactionId: makeInteractionId(interactionId),
      formValues: { q1: "继续" },
      answerMode: "selected",
    });
    await vi.waitFor(() => expect(env.runClient.resolveInteraction).toHaveBeenCalledWith(
      scope,
      interactionId,
      { selected: ["继续"] },
    ));

    env.runClient.resolveInteraction.mockClear();
    env.emit("lark/card/action", {
      kind: "form-submit",
      submissionKind: "questionnaire.submit",
      messageId: makeMessageId("om_card"),
      chatId: makeChatId("oc_1"),
      userId: makeUserId("ou_1"),
      interactionId: makeInteractionId(interactionId),
      formValues: { q1: "自定义回答" },
      answerMode: "custom",
    });
    await vi.waitFor(() => expect(env.runClient.resolveInteraction).toHaveBeenCalledWith(
      scope,
      interactionId,
      { selected: [], custom: "自定义回答" },
    ));
  });
});
