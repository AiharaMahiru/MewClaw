/**
 * 入口事件契约（SPEC lark-ws.md §2/§4）。
 *
 * 进程级类型化事件，声明合并进 cordis Events。所有 payload 都是不可信输入：
 * 本包只做结构解析，不做授权判断（gateway 职责）。
 */
import type { CardActionPayload } from "dsh-lark";
import type { ChatId, MessageId, UserId } from "dsh-lark-contracts";

import type { LarkBotMenuEvent } from "./bot-menu.js";

/** 入站消息资源（文件/图片）。 */
export interface InboundResource {
  type: "file" | "image";
  key: string;
  fileName: string;
}

/** 投递分类：prompt = 可作提示词正文；resource_only = 纯资源（挂起等文本）。 */
export type InboundDelivery = "prompt" | "resource_only";

/** 一条经结构解析的入站消息；不含任何授权结论。 */
export interface InboundMessage {
  /** 平台事件 id（去重用；缺失时回退 messageId）。 */
  eventId: string;
  messageId: MessageId;
  userId: UserId;
  chatId: ChatId;
  chatType?: string;
  delivery: InboundDelivery;
  text: string;
  resources: InboundResource[];
}

declare module "@deepseek-ai/cordis" {
  interface Events {
    /**
     * 收到一条 im.message.receive_v1 消息（已做结构解析，未做授权/去重）。
     * content 仍是不信任载荷（gateway 解析前不假设 schema）。
     * @param payload - 入站消息
     * @mode sync
     */
    "lark/message/received"(payload: InboundMessage): void;
    /**
     * 收到消息撤回事件。
     * @param payload - 被撤回消息的 id
     * @mode sync
     */
    "lark/message/recalled"(payload: { messageId: MessageId }): void;
    /**
     * 卡片按钮/表单回调（结构已解析；回调载荷只是服务端状态引用，不是授权证据）。
     * @param payload - 卡片动作
     * @mode sync
     */
    "lark/card/action"(payload: CardActionPayload): void;
    /**
     * 机器人菜单事件。
     * @param payload - 菜单事件
     * @mode sync
     */
    "lark/bot/menu"(payload: LarkBotMenuEvent): void;
    /**
     * 连接健康状态（supervisor 的存活判据）。
     * @param payload - 当前状态
     * @mode sync
     */
    "lark/connection"(payload: { state: "connected" | "reconnecting" | "failed" }): void;
  }
}
