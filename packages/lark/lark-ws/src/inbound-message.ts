/**
 * im.message.receive_v1 结构解析（lark-claw inbound-message.ts 语义保留，
 * 品牌化 ID + 中文注释）。
 *
 * 不信任输入：JSON 解析失败、字段缺失一律返回 undefined（丢弃），
 * 绝不抛异常、绝不假设 schema。
 */
import { parseChatId, parseMessageId, parseUserId, type ChatId, type MessageId, type UserId } from "dsh-lark-contracts";

import type { InboundDelivery, InboundMessage, InboundResource } from "./events.js";

/** 平台原始事件（只声明用到的字段，其余忽略）。 */
export interface LarkMessageEvent {
  event_id?: string;
  sender?: { sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id?: string;
    chat_type?: string;
    message_type: string;
    content: string;
  };
}

interface ParsedContent {
  delivery: InboundDelivery;
  text: string;
  resources: InboundResource[];
}

function parseObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** 非空且 trim 后的字符串。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 非空但保留原样的字符串（富文本节点用，不做 trim）。 */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 去重键不信任平台 event_id；非法或缺失时使用已校验的 messageId。 */
function dedupeKey(eventId: unknown, messageId: MessageId): string {
  const parsed = parseMessageId(eventId);
  return parsed.ok ? parsed.value : messageId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

/** post 消息正文可能包在各语言层（zh_cn/en_us/...）或直接是 content 数组。 */
function postBody(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Array.isArray(parsed.content)) return parsed;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const candidate = asRecord(parsed[locale]);
    if (candidate && Array.isArray(candidate.content)) return candidate;
  }
  return Object.values(parsed)
    .map(asRecord)
    .find((candidate) => candidate && Array.isArray(candidate.content));
}

interface PostParseState {
  hasText: boolean;
  imageIndexes: Map<string, number>;
  resources: InboundResource[];
}

/** post 图片节点：去重注册资源，正文替换为占位符。 */
function postImage(key: string, state: PostParseState): string {
  let index = state.imageIndexes.get(key);
  if (!index) {
    index = state.resources.length + 1;
    state.imageIndexes.set(key, index);
    state.resources.push({ type: "image", key, fileName: `post-image-${index}` });
  }
  return ` [图片 ${index}]`;
}

/** post 单节点 → 文本片段（img/a/at/text；其余忽略）。 */
function postNodeText(value: unknown, state: PostParseState): string {
  const node = asRecord(value);
  const tag = nonEmpty(node?.tag);
  if (!node || !tag) return "";
  if (tag === "img") {
    const key = nonEmpty(node.image_key);
    return key ? postImage(key, state) : "";
  }
  const text = tag === "at"
    ? nonEmpty(node.user_name) || nonEmpty(node.user_id)
    : nonBlank(node.text) || (tag === "a" ? nonEmpty(node.href) : undefined);
  if (!text || !["text", "a", "at"].includes(tag)) return "";
  state.hasText = true;
  return tag === "at" ? `@${text}` : text;
}

function parsePost(parsed: Record<string, unknown>): ParsedContent | undefined {
  const body = postBody(parsed);
  if (!body) return undefined;
  const state: PostParseState = { hasText: false, imageIndexes: new Map(), resources: [] };
  const title = nonEmpty(body.title);
  if (title) state.hasText = true;
  const rows = (body.content as unknown[])
    .filter(Array.isArray)
    .map((row) => (row as unknown[]).map((node) => postNodeText(node, state)).join("")
      .replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const text = [title, ...rows].filter(Boolean).join("\n");
  if (!text || (!state.hasText && state.resources.length === 0)) return undefined;
  return {
    delivery: state.hasText ? "prompt" : "resource_only",
    text,
    resources: state.resources,
  };
}

/** 按消息类型解析 content（text/file/image/post；其余类型丢弃）。 */
function parseContent(type: string, content: string): ParsedContent | undefined {
  const parsed = parseObject(content);
  if (!parsed) return undefined;
  if (type === "text") {
    const text = nonEmpty(parsed.text);
    return text ? { delivery: "prompt", text, resources: [] } : undefined;
  }
  if (type === "file") {
    const key = nonEmpty(parsed.file_key);
    const fileName = nonEmpty(parsed.file_name);
    return key && fileName
      ? { delivery: "resource_only", text: `请处理附件：${fileName}`, resources: [{ type, key, fileName }] }
      : undefined;
  }
  if (type === "image") {
    const key = nonEmpty(parsed.image_key);
    return key
      ? { delivery: "resource_only", text: "请处理这张图片。", resources: [{ type, key, fileName: "image" }] }
      : undefined;
  }
  if (type === "post") return parsePost(parsed);
  return undefined;
}

/**
 * 解析 im.message.receive_v1 原始事件；任一关键字段缺失即返回 undefined。
 * 品牌化 ID 在结构校验通过后构造。
 */
export function parseLarkInboundMessage(event: unknown): InboundMessage | undefined {
  const source = asRecord(event);
  if (!source) return undefined;
  const raw = source as unknown as LarkMessageEvent;
  const userId = parseUserId(raw.sender?.sender_id?.open_id);
  const chatId = parseChatId(raw.message?.chat_id);
  const messageId = parseMessageId(raw.message?.message_id);
  const chatType = nonEmpty(raw.message?.chat_type);
  const content = parseContent(raw.message?.message_type ?? "", raw.message?.content ?? "");
  if (!userId.ok || !chatId.ok || !messageId.ok || !content) {
    return undefined;
  }
  return {
    eventId: dedupeKey(raw.event_id, messageId.value),
    messageId: messageId.value,
    userId: userId.value,
    chatId: chatId.value,
    ...(chatType ? { chatType } : {}),
    ...content,
  };
}

export type { ChatId, MessageId, UserId };
