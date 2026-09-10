/**
 * 服务契约数据类型（SPEC lark.md §2）。
 *
 * 跨边界 ID 一律用 dsh-lark-contracts 的品牌化类型；
 * 本文件只定义 ctx.lark 服务面的载荷类型。
 */
import type { ReadableStream } from "node:stream/web";

import type { ChatId, ImageKey, MessageId, UserId } from "dsh-lark-contracts";

import type { MarkdownCardPayload } from "./cards.js";

/** 应用访问令牌（getToken 返回值；SDK 内部另有一份缓存，本值仅用于展示/诊断）。 */
export interface TenantAccessToken {
  token: string;
  /** 过期时间（Unix 毫秒）。 */
  expiresAtMs: number;
}

/** 可发送的消息内容（文本、markdown 卡片与飞书图片）。 */
export type MessageContent =
  | { kind: "text"; text: string }
  | { kind: "markdown-card"; card: MarkdownCardPayload }
  | { kind: "image"; imageKey: ImageKey };

/** 群成员（最小字段；扩展经 SDK 原始类型，不新增字段家）。 */
export interface ChatMember {
  openId: UserId;
  name?: string;
}

/** 下载资源：字节流 + 已知总字节数（未知时为 0；大小上限见 Config.maxResourceBytes）。 */
export interface ResourceData {
  stream: ReadableStream<Uint8Array>;
  bytes: number;
}

export type { ChatId, MessageId };
