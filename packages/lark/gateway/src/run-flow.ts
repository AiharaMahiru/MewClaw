import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { renderMarkdownCard, renderQuestionnaireCard } from "dsh-lark";
import { artifactLine, assistantText, collapseToolLines, toolLine, type LarkCardService } from "dsh-lark-card";
import type { LarkCommandsService } from "dsh-lark-commands";
import {
  makeRunId,
  parseScope,
  scopeKey,
  scopeEquals,
  type ChatId,
  type MessageId,
  type RunAttachment,
  type RunStreamDone,
  type RunStreamItem,
  type Scope,
} from "dsh-lark-contracts";
import { RunClientError, type LarkRunClient } from "dsh-lark-run-client";

import type { SessionGenerations } from "./generations.js";

type LarkService = NonNullable<Context["lark"]>;

interface RunFlowOptions {
  lark: LarkService;
  runClient: LarkRunClient;
  card: LarkCardService;
  commands: LarkCommandsService;
  generations: SessionGenerations;
  maxToolLines: number;
  failureCardTemplate: string;
  info(message: string): void;
}

export interface RunFlowInput {
  scope: Scope;
  chatId: ChatId;
  messageId: MessageId;
  prompt: string;
  attachments: RunAttachment[];
}

interface FlowState {
  cardId: MessageId;
  openTools: Array<{ name: string; at: number }>;
  toolLines: string[];
  assistantParts: string[];
  assistantChunkSteps: Set<string>;
  toolCount: number;
  toolTotalMs: number;
  done: boolean;
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  EMPTY_RESPONSE: "没有可展示的回复，请换个方式再试。",
  RUN_TIMEOUT: "运行超时，请重试或缩短任务。",
  QUEUE_FULL: "排队已满，请稍后再试。",
  CANCELLED: "已取消。",
  RUNTIME_ERROR: "执行出错，请重试。",
  STREAM_BROKEN: "运行中断，请重试。",
  STREAM_SCHEMA_ERROR: "事件流格式异常，请重试。",
  RESPONSE_SCHEMA_ERROR: "worker 响应格式异常，请重试。",
  HTTP_ERROR: "worker 返回错误，请稍后重试。",
  CONNECT_FAILED: "worker 不可达，请稍后重试。",
  CARD_SEND_FAILED: "状态卡发送失败，请稍后重试。",
};

type FlowPhase = "submit" | "stream";

function failureCode(error: unknown, phase: FlowPhase): string {
  if (error instanceof RunClientError) return error.code;
  return phase === "submit" ? "CONNECT_FAILED" : "STREAM_BROKEN";
}

export class RunFlow {
  constructor(private readonly options: RunFlowOptions) {}

  async execute(input: RunFlowInput): Promise<void> {
    const runId = makeRunId(randomUUID());
    const cardId = await this.#sendProcessing(input.chatId);
    if (!cardId) return;
    const state: FlowState = {
      cardId,
      openTools: [],
      toolLines: [],
      assistantParts: [],
      assistantChunkSteps: new Set(),
      toolCount: 0,
      toolTotalMs: 0,
      done: false,
    };
    let phase: FlowPhase = "submit";
    try {
      const stream = await this.options.runClient.submit({
        runId,
        scope: input.scope,
        messageId: input.messageId,
        prompt: input.prompt,
        profile: this.options.commands.getProfile(input.scope),
        sessionGeneration: this.options.generations.get(scopeKey(input.scope)),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      });
      phase = "stream";
      for await (const item of stream) await this.#handleItem(item, state, input);
      if (!state.done) await this.#fail(state, "STREAM_BROKEN");
    } catch (error) {
      if (!state.done) await this.#fail(state, failureCode(error, phase));
    }
  }

  async #sendProcessing(chatId: ChatId): Promise<MessageId | undefined> {
    try {
      return await this.options.card.sendProcessing(chatId);
    } catch {
      await this.options.lark.sendMessage(chatId, {
        kind: "markdown-card",
        card: renderMarkdownCard(this.#failureText("CARD_SEND_FAILED")),
      }).catch(() => undefined);
      return undefined;
    }
  }

  async #handleItem(
    item: RunStreamItem | RunStreamDone,
    state: FlowState,
    input: RunFlowInput,
  ): Promise<void> {
    if (state.done) return;
    if ("outcome" in item) return this.#finish(item, state);
    await this.#handleEvent(item.event as SessionEvent, state, input);
  }

  async #finish(item: RunStreamDone, state: FlowState): Promise<void> {
    if (state.done) return;
    const code = item.outcome.code;
    this.options.info(`lark-gateway: run ${item.envelope.runId} outcome=${code}`);
    if (code !== "OK") return this.#fail(state, code);
    state.done = true;
    const stats = `${state.toolCount} 个工具 · ${(state.toolTotalMs / 1000).toFixed(1)}s`;
    const sections = [
      state.assistantParts.join(""),
      state.toolLines.length > 0 ? collapseToolLines(state.toolLines, this.options.maxToolLines).join("\n") : "",
      `---\n${stats}`,
    ].filter(Boolean);
    await this.options.card.replace(state.cardId, sections.join("\n\n"));
  }

  async #fail(state: FlowState, code: string): Promise<void> {
    if (state.done) return;
    state.done = true;
    await this.options.card.fail(state.cardId, this.#failureText(code));
  }

  async #handleEvent(event: SessionEvent, state: FlowState, input: RunFlowInput): Promise<void> {
    if (event.type === "assistant/chunk") return this.#assistantChunk(event, state);
    if (event.type === "assistant/message") return this.#assistant(event, state);
    if (event.type === "tool/call") {
      state.openTools.push({ name: event.data.name, at: Date.now() });
      return;
    }
    if (event.type === "tool/result") return this.#toolResult(state);
    if (event.type === "lark/artifact/created") return this.#artifact(event, state, input);
    if (event.type === "lark/approval/requested") await this.#approval(event, input);
  }

  async #artifact(event: SessionEvent, state: FlowState, input: RunFlowInput): Promise<void> {
    if (event.type !== "lark/artifact/created") return;
    const artifactScope = parseScope(event.data.scope);
    if (!artifactScope.ok || !scopeEquals(artifactScope.value, input.scope)) {
      return this.#artifactFailure(event.data.name, state);
    }

    let image: Awaited<ReturnType<LarkRunClient["readArtifact"]>>;
    try {
      image = await this.options.runClient.readArtifact(event.data);
    } catch (error) {
      if (error instanceof RunClientError && error.status === 404) {
        return this.#artifactLine(event.data.name, event.data.bytes, state);
      }
      this.#artifactFailure(event.data.name, state);
      return;
    }

    try {
      const imageKey = await this.options.lark.uploadImage(image.bytes);
      await this.options.lark.sendMessage(input.chatId, { kind: "image", imageKey });
    } catch {
      this.#artifactFailure(event.data.name, state);
    }
  }

  #artifactLine(name: string, bytes: number, state: FlowState): void {
    const line = artifactLine(name, bytes);
    state.assistantParts.push(line);
    this.options.card.append(state.cardId, line);
  }

  #artifactFailure(name: string, state: FlowState): void {
    const line = `图片交付失败：${name}`;
    state.assistantParts.push(line);
    this.options.card.append(state.cardId, line);
  }

  #assistant(event: SessionEvent, state: FlowState): void {
    if (event.type !== "assistant/message") return;
    const text = assistantText(event);
    if (text.length === 0) return;
    if (state.assistantChunkSteps.has(`${event.data.turn}:${event.data.step}`)) return;
    state.assistantParts.push(text);
    this.options.card.append(state.cardId, text);
  }

  #assistantChunk(event: SessionEvent, state: FlowState): void {
    if (event.type !== "assistant/chunk" || event.data.chunk.type !== "text-delta") return;
    if (event.data.chunk.text.trim().length === 0) return;
    state.assistantChunkSteps.add(`${event.data.turn}:${event.data.step}`);
    state.assistantParts.push(event.data.chunk.text);
    this.options.card.append(state.cardId, event.data.chunk.text);
  }

  #toolResult(state: FlowState): void {
    const open = state.openTools.shift();
    if (!open) return;
    const durationMs = Date.now() - open.at;
    state.toolCount += 1;
    state.toolTotalMs += durationMs;
    state.toolLines.push(toolLine(open.name, durationMs));
    this.options.card.append(state.cardId, collapseToolLines(state.toolLines, this.options.maxToolLines).join("\n"));
  }

  async #approval(event: SessionEvent, input: RunFlowInput): Promise<void> {
    if (event.type !== "lark/approval/requested") return;
    const { interactionId, question } = event.data;
    await this.options.lark.sendMessage(input.chatId, {
      kind: "markdown-card",
      card: renderQuestionnaireCard({
        interactionId,
        questionId: question.id,
        question: question.question,
        options: question.options,
      }),
    });
  }

  #failureText(code: string): string {
    return this.options.failureCardTemplate
      .replaceAll("{{code}}", code)
      .replaceAll("{{hint}}", FAILURE_TEXT[code] ?? "请重试。");
  }
}
