/**
 * ctx.lark 服务实现（SPEC lark.md §2/§6）。
 *
 * 官方 node-sdk 的 Client 负责令牌的获取/缓存/单飞刷新（生产验证过的
 * lark-claw 语义），本层只做：调用面封装、错误分类、资源上限与品牌化 ID。
 * 调用方已通过授权检查（allowlist 判断是 gateway 的职责，本服务不重复）。
 */
import { Readable } from "node:stream";

import { Client } from "@larksuiteoapi/node-sdk";
import {
  parseChatId,
  parseImageKey,
  parseMessageId,
  parseUserId,
  type ChatId,
  type ImageKey,
  type MessageId,
  type UserId,
} from "dsh-lark-contracts";

import { classifyError, LarkApiError } from "./errors.js";
import type { ChatMember, MessageContent, ResourceData, TenantAccessToken } from "./types.js";

export type LarkResourceType = "file" | "image";
/** 飞书消息图片接口的固定服务端上限。 */
const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024;

/** ctx.lark 服务契约（SPEC lark.md §2）。 */
export interface LarkApi {
  /** 获取有效访问令牌（SDK 内部缓存 + 单飞刷新；本方法用于诊断/展示）。 */
  getToken(): Promise<TenantAccessToken>;
  /** 发送消息（文本或卡片）；返回 message_id（以平台返回为准，勿自造）。 */
  sendMessage(chatId: ChatId, content: MessageContent): Promise<MessageId>;
  /** 按 open_id 发送并返回平台提供的真实 P2P chat_id。 */
  sendMessageToUser(userId: UserId, content: MessageContent): Promise<{ messageId: MessageId; chatId: ChatId }>;
  /** 上传消息图片；平台返回 image_key 必须经品牌化校验。 */
  uploadImage(bytes: Uint8Array): Promise<ImageKey>;
  /** 更新指定消息内容（卡片流转用）。 */
  updateMessage(messageId: MessageId, content: MessageContent): Promise<void>;
  /** 下载消息资源（文件/图片）；字节是不信输入，调用方须再摘要校验。 */
  downloadResource(messageId: MessageId, fileKey: string, type: LarkResourceType): Promise<ResourceData>;
  /** 群成员列表（member_id_type=open_id；受网关 allowlist 策略约束）。 */
  getChatMembers(chatId: ChatId): Promise<ChatMember[]>;
}

export interface LarkClientOptions {
  appId: string;
  appSecret: string;
  /** 飞书域名（feishu.cn / larksuite.com）；缺省走 SDK 默认。 */
  domain?: string;
  /** 资源下载大小上限（字节）；超限拒绝（LARK_RESOURCE_INVALID）。 */
  maxResourceBytes: number;
}

/** 平台消息内容 → SDK 请求体（content 一律 JSON 字符串）。 */
function toSdkMessage(content: MessageContent): { msg_type: string; content: string } {
  if (content.kind === "text") {
    return { msg_type: "text", content: JSON.stringify({ text: content.text }) };
  }
  if (content.kind === "markdown-card") {
    return { msg_type: "interactive", content: JSON.stringify(content.card) };
  }
  return { msg_type: "image", content: JSON.stringify({ image_key: content.imageKey }) };
}

export function createLarkApi(options: LarkClientOptions): LarkApi {
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    ...(options.domain ? { domain: options.domain } : {}),
  });

  return {
    async getToken() {
      try {
        const response = await client.auth.v3.tenantAccessToken.internal({
          data: { app_id: options.appId, app_secret: options.appSecret },
        });
        if (response.code !== 0 || !response.data?.tenant_access_token) {
          throw classifyError({ code: response.code }, "获取应用令牌");
        }
        return {
          token: response.data.tenant_access_token,
          expiresAtMs: Date.now() + (response.data.expire ?? 0) * 1000,
        };
      } catch (error) {
        throw classifyError(error, "获取应用令牌");
      }
    },

    async sendMessage(chatId, content) {
      try {
        const message = toSdkMessage(content);
        const response = await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, ...message },
        });
        if (response.code !== 0 || !response.data?.message_id) {
          throw classifyError({ code: response.code }, "发送消息");
        }
        const messageId = parseMessageId(response.data.message_id);
        if (!messageId.ok) {
          throw new LarkApiError("LARK_API_FAILED", "发送消息返回无效 message_id");
        }
        return messageId.value;
      } catch (error) {
        throw classifyError(error, "发送消息");
      }
    },

    async sendMessageToUser(userId, content) {
      try {
        const message = toSdkMessage(content);
        const response = await client.im.v1.message.create({
          params: { receive_id_type: "open_id" },
          data: { receive_id: userId, ...message },
        });
        if (response.code !== 0) {
          throw classifyError({ code: response.code }, "按用户发送消息");
        }
        const messageId = parseMessageId(response.data?.message_id);
        const chatId = parseChatId(response.data?.chat_id);
        if (!messageId.ok || !chatId.ok) {
          throw new LarkApiError("LARK_API_FAILED", "按用户发送消息返回无效 message_id/chat_id");
        }
        return { messageId: messageId.value, chatId: chatId.value };
      } catch (error) {
        throw classifyError(error, "按用户发送消息");
      }
    },

    async uploadImage(bytes) {
      const maxBytes = Math.min(options.maxResourceBytes, MAX_MESSAGE_IMAGE_BYTES);
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        throw new LarkApiError("LARK_RESOURCE_INVALID", "图片字节为空或超出大小上限");
      }
      try {
        const response = await client.im.v1.image.create({
          data: { image_type: "message", image: Buffer.from(bytes) },
        });
        const imageKey = parseImageKey(response?.image_key);
        if (!imageKey.ok) {
          throw new LarkApiError("LARK_API_FAILED", "上传图片返回无效 image_key");
        }
        return imageKey.value;
      } catch (error) {
        throw classifyError(error, "上传图片");
      }
    },

    async updateMessage(messageId, content) {
      try {
        const message = toSdkMessage(content);
        const response = await client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: message.content },
        });
        if (response.code !== 0) {
          throw classifyError({ code: response.code }, "更新消息");
        }
      } catch (error) {
        throw classifyError(error, "更新消息");
      }
    },

    async downloadResource(messageId, fileKey, type) {
      try {
        const response = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type },
        });
        // 第一道闸：响应头声明的 content-length（未知时跳过，靠第二道闸）。
        const declared = Number(response.headers?.["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxResourceBytes) {
          throw new LarkApiError(
            "LARK_RESOURCE_INVALID",
            `资源超出大小上限 ${options.maxResourceBytes} 字节`,
          );
        }
        return {
          // Readable.toWeb 已返回 node:stream/web 的 ReadableStream，直接透传。
          stream: Readable.toWeb(response.getReadableStream()),
          bytes: Number.isFinite(declared) ? declared : 0,
        };
      } catch (error) {
        throw classifyError(error, "下载资源");
      }
    },

    async getChatMembers(chatId) {
      try {
        const response = await client.im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: "open_id", page_size: 100 },
        });
        if (response.code !== 0 || !response.data?.items) {
          throw classifyError({ code: response.code }, "读取群成员");
        }
        const members: ChatMember[] = [];
        for (const item of response.data.items) {
          // SDK 类型允许 member_id 缺失；缺 member_id 的条目不可用，跳过。
          const openId = parseUserId(item.member_id);
          if (!openId.ok) continue;
          members.push({
            openId: openId.value,
            ...(item.name ? { name: item.name } : {}),
          });
        }
        return members;
      } catch (error) {
        throw classifyError(error, "读取群成员");
      }
    },
  };
}
