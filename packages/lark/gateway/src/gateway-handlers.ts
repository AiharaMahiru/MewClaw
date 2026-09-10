import type { Context } from "@deepseek-ai/cordis";
import { renderMarkdownCard, type CardActionPayload, type CardCommandAction } from "dsh-lark";
import type { GatewayCommandResult, LarkCommandsService, ParsedGatewayCommand } from "dsh-lark-commands";
import {
  makeConversationId,
  scopeKey,
  type ChatId,
  type MessageId,
  type RunAttachment,
  type Scope,
  type UserId,
} from "dsh-lark-contracts";
import type { LarkRunClient } from "dsh-lark-run-client";
import type { InboundMessage, LarkBotMenuEvent } from "dsh-lark-ws";

import type { GatewayAttachments } from "./attachments.js";
import type { GatewaySecurity } from "./config.js";
import type { Dedupe } from "./dedupe.js";
import type { SessionGenerations } from "./generations.js";
import type { RunFlow } from "./run-flow.js";

type LarkService = NonNullable<Context["lark"]>;
const BOT_MENU_PENDING_TEXT = "正在处理...";

interface BotMenuTarget {
  chatId: ChatId;
  messageId?: MessageId;
}

interface GatewayHandlerOptions {
  lark: LarkService;
  runClient: LarkRunClient;
  commands: LarkCommandsService;
  security: GatewaySecurity;
  unauthorizedCardText?: string;
  dedupe: Dedupe;
  generations: SessionGenerations;
  attachments: GatewayAttachments;
  runFlow: RunFlow;
  info(message: string): void;
  warn(message: string): void;
}

export class GatewayHandlers {
  readonly #p2pChats = new Map<UserId, ChatId>();

  constructor(private readonly options: GatewayHandlerOptions) {}

  message(message: InboundMessage): void {
    this.options.info(`lark-gateway: message received delivery=${message.delivery}`);
    void this.#handleMessage(message).catch(() => this.options.warn("lark-gateway: 消息处理失败（已尽力收尾）"));
  }

  cardAction(action: CardActionPayload): void {
    void this.#handleCardAction(action).catch(() => this.options.warn("lark-gateway: 卡片回调处理失败"));
  }

  botMenu(menu: LarkBotMenuEvent): void {
    void this.#handleBotMenu(menu).catch(() => this.options.warn("lark-gateway: 机器人菜单处理失败"));
  }

  async #handleMessage(message: InboundMessage): Promise<void> {
    if (!this.#authorized(message.userId, message.chatId)) {
      if (this.options.unauthorizedCardText) {
        await this.#sendCard(message.chatId, this.options.unauthorizedCardText);
      }
      return;
    }
    if (!this.options.dedupe.check(message.eventId)) return;
    if (message.chatType === "p2p") this.#p2pChats.set(message.userId, message.chatId);
    const scope = this.#scope(message.userId, message.chatId);
    if (!await this.#saveResources(scope, message)) return;
    const command = this.options.commands.parse(message.text);
    if (command) return this.#handleCommand(scope, message, command);
    if (message.delivery === "resource_only") {
      await this.#sendCard(message.chatId, "已收到附件。请发送文字说明你想如何处理它。");
      return;
    }
    await this.options.runFlow.execute({
      scope,
      chatId: message.chatId,
      messageId: message.messageId,
      prompt: message.text,
      attachments: await this.options.attachments.claim(scope),
    });
  }

  async #handleCommand(
    scope: Scope,
    message: InboundMessage,
    command: ParsedGatewayCommand,
  ): Promise<void> {
    const result = await this.options.commands.handle({
      scope,
      chatId: message.chatId,
      command,
      sessionGeneration: this.options.generations.get(scopeKey(scope)),
    });
    const fallback: GatewayCommandResult = {
      markdown: `未知命令 \`/${command.name}\`。输入 \`/help\` 查看可用命令。`,
    };
    await this.#sendCommandResult(message.chatId, result ?? fallback);
  }

  async #handleBotMenu(menu: LarkBotMenuEvent): Promise<void> {
    if (!this.#authorizedUser(menu.userId)) return;
    const command = this.options.commands.resolveBotMenu(menu.eventKey);
    if (!command || !this.options.dedupe.check(menu.eventId)) return;
    const target = await this.#resolveBotMenuTarget(menu.userId);
    if (!target) return;
    const scope = this.#scope(menu.userId, target.chatId);
    const result = await this.options.commands.handle({
      scope,
      chatId: target.chatId,
      command,
      sessionGeneration: this.options.generations.get(scopeKey(scope)),
    });
    const resolved = result ?? { markdown: `未知命令 \`/${command.name}\`。输入 \`/help\` 查看可用命令。` };
    if (target.messageId) {
      await this.options.lark.updateMessage(target.messageId, {
        kind: "markdown-card",
        card: renderMarkdownCard(resolved.markdown, resolved.actions),
      });
      return;
    }
    await this.#sendCommandResult(target.chatId, resolved);
  }

  async #resolveBotMenuTarget(userId: UserId): Promise<BotMenuTarget | undefined> {
    const known = this.#p2pChats.get(userId);
    if (known && this.#authorized(userId, known)) return { chatId: known };
    if (this.options.security.allowedChatIds.length > 0) return undefined;
    const target = await this.options.lark.sendMessageToUser(userId, {
      kind: "markdown-card",
      card: renderMarkdownCard(BOT_MENU_PENDING_TEXT),
    });
    if (!this.#authorized(userId, target.chatId)) return undefined;
    this.#p2pChats.set(userId, target.chatId);
    return target;
  }

  async #saveResources(scope: Scope, message: InboundMessage): Promise<boolean> {
    if (message.resources.length === 0) return true;
    const saved: RunAttachment[] = [];
    let phase: "download" | "save" = "download";
    try {
      for (const resource of message.resources) {
        phase = "download";
        const data = await this.options.lark.downloadResource(
          message.messageId,
          resource.key,
          resource.type,
        );
        phase = "save";
        saved.push(await this.options.attachments.save(scope, {
          key: resource.key,
          fileName: resource.fileName,
        }, data.stream));
      }
    } catch {
      await this.options.attachments.discard(scope, saved);
      this.options.warn(`lark-gateway: 附件处理失败 phase=${phase}`);
      await this.#sendCard(message.chatId, "附件下载失败，请重新发送。");
      return false;
    }
    await this.options.attachments.stage(scope, saved);
    return true;
  }

  async #handleCardAction(action: CardActionPayload): Promise<void> {
    if (!this.#authorized(action.userId, action.chatId)) return;
    const scope = this.#scope(action.userId, action.chatId);
    if (action.kind === "command") return this.#commandAction(scope, action);
    if (action.kind !== "form-submit" || action.submissionKind !== "questionnaire.submit") return;
    const values = Object.values(action.formValues);
    if (values.length === 0) {
      this.options.warn("lark-gateway: 问卷回调无表单值");
      return;
    }
    if (action.answerMode === "custom") {
      if (values.length !== 1) {
        this.options.warn("lark-gateway: 自定义问卷回调必须只有一个表单值");
        return;
      }
      await this.options.runClient.resolveInteraction(
        scope,
        action.interactionId,
        { selected: [], custom: values[0]! },
      );
      return;
    }
    await this.options.runClient.resolveInteraction(
      scope,
      action.interactionId,
      { selected: values },
    );
  }

  async #commandAction(scope: Scope, action: Extract<CardActionPayload, { kind: "command" }>): Promise<void> {
    const result = await this.options.commands.handleCardAction({
      scope,
      chatId: action.chatId,
      actionId: action.actionId,
      sessionGeneration: this.options.generations.get(scopeKey(scope)),
    });
    await this.#sendCommandResult(action.chatId, result);
  }

  #authorized(userId: UserId, chatId: ChatId): boolean {
    const { allowedChatIds } = this.options.security;
    if (!this.#authorizedUser(userId)) return false;
    return allowedChatIds.length === 0 || allowedChatIds.includes(chatId);
  }

  #authorizedUser(userId: UserId): boolean {
    return this.options.security.authorizedOpenIds.includes(userId);
  }

  #scope(userId: UserId, chatId: ChatId): Scope {
    return {
      ...this.options.security.identity,
      userId,
      conversationId: makeConversationId(chatId),
    };
  }

  #sendCommandResult(chatId: ChatId, result: GatewayCommandResult): Promise<MessageId> {
    return this.#sendCard(chatId, result.markdown, result.actions);
  }

  #sendCard(chatId: ChatId, markdown: string, actions: readonly CardCommandAction[] = []): Promise<MessageId> {
    return this.options.lark.sendMessage(chatId, { kind: "markdown-card", card: renderMarkdownCard(markdown, actions) });
  }
}
