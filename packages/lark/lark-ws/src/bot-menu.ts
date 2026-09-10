/**
 * application.bot.menu_v6 解析（lark-claw bot-menu-event.ts 语义保留）。
 *
 * 机器人菜单事件：eventId/userId/eventKey 三字段严格校验（非空、无
 * 首尾空白、≤128 字符），任一缺失即丢弃。
 */
import { parseUserId, type UserId } from "dsh-lark-contracts";

export interface LarkBotMenuEvent {
  eventId: string;
  userId: UserId;
  eventKey: string;
}

const MAX_IDENTIFIER_LENGTH = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function exactIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim()) return undefined;
  return value.length <= MAX_IDENTIFIER_LENGTH && !CONTROL_CHARS.test(value) ? value : undefined;
}

/** 解析机器人菜单事件原始载荷；字段不合法返回 undefined。 */
export function parseLarkBotMenuEvent(event: unknown): LarkBotMenuEvent | undefined {
  const source = typeof event === "object" && event !== null ? event as Record<string, unknown> : undefined;
  if (!source) return undefined;
  const operator = source.operator as { operator_id?: { open_id?: unknown } } | undefined;
  const eventId = exactIdentifier(source.event_id);
  const userId = parseUserId(operator?.operator_id?.open_id);
  const eventKey = exactIdentifier(source.event_key);
  if (!eventId || !userId.ok || !eventKey) return undefined;
  return { eventId, userId: userId.value, eventKey };
}
