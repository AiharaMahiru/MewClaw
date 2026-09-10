/**
 * 卡片回调解析（card.action.trigger 原始事件 → 类型化载荷）。
 *
 * 安全规则（AGENTS.md 硬边界）：卡片回调载荷只是服务端状态引用，永不是
 * 授权证据；所有字段都是不信任输入，逐字段校验后使用。
 *
 * 与 lark-claw 的行为差异（SPEC lark.md §9）：命令卡只传回服务端注册的 actionId。
 * 本层只做严格结构校验与品牌化，命令语义、Scope 比对和一次性消费归 commands provider。
 */
import {
  LarkError,
  parseChatId,
  parseInteractionId,
  parseMessageId,
  parseUserId,
  type ChatId,
  type InteractionId,
  type MessageId,
  type ParseResult,
  type UserId,
} from "dsh-lark-contracts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const INTERACTION_ID = new RegExp(`^${UUID}$`, "i");
const MAX_FORM_VALUES = 64;
const MAX_FORM_VALUE_LENGTH = 4_000;
const FORM_FIELD = /^[a-z][a-z0-9_-]{0,63}$/;
const QUESTIONNAIRE_SUBMIT_NAME = new RegExp(`^questionnaire_submit_(${UUID})(?:_(selected|custom))?$`, "i");

/** card.action.trigger 原始事件（只声明用到的字段，其余忽略）。 */
export interface CardActionTriggerEvent {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  operator?: { open_id?: string };
  action?: { value?: unknown; name?: unknown; form_value?: unknown };
}

/** 命令按钮回调（只含服务端 actionId，绝不含自由命令文本）。 */
export interface CardCommandPayload {
  kind: "command";
  messageId: MessageId;
  chatId: ChatId;
  userId: UserId;
  actionId: InteractionId;
}

/** 已注册 provider 的问卷表单提交。 */
export type CardFormAnswerMode = "selected" | "custom";

export interface CardFormSubmissionPayload {
  kind: "form-submit";
  submissionKind: "questionnaire.submit";
  messageId: MessageId;
  chatId: ChatId;
  userId: UserId;
  interactionId: InteractionId;
  answerMode: CardFormAnswerMode;
  formValues: Readonly<Record<string, string>>;
}

export type CardActionPayload = CardCommandPayload | CardFormSubmissionPayload;

function invalid(message: string): ParseResult<never> {
  return { ok: false, error: new LarkError("INVALID_REQUEST", "caller-bug", message) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 表单值：键名与值长双重校验，拒绝超大表单。 */
function formValues(value: unknown): Readonly<Record<string, string>> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const entries = Object.entries(source);
  if (entries.length > MAX_FORM_VALUES) return undefined;
  const values: Record<string, string> = {};
  for (const [name, input] of entries) {
    if (!FORM_FIELD.test(name) || typeof input !== "string" || input.length > MAX_FORM_VALUE_LENGTH) {
      return undefined;
    }
    values[name] = input;
  }
  return values;
}

/** 按钮回调值：只接受单个 UUID actionId，拒绝任意命令或附加字段。 */
function commandActionReference(value: unknown): string | undefined {
  const source = record(value);
  if (!source || Object.keys(source).length !== 1) return undefined;
  const actionId = source.actionId;
  return typeof actionId === "string" && INTERACTION_ID.test(actionId) ? actionId : undefined;
}

function formSubmission(
  value: unknown,
  name: unknown,
  formValue: unknown,
): { interactionId: string; answerMode: CardFormAnswerMode; formValues: Readonly<Record<string, string>> } | undefined {
  const source = record(value);
  let interactionId: string | undefined;
  let namedAnswerMode: CardFormAnswerMode | undefined;
  const namedSubmission = typeof name === "string" ? QUESTIONNAIRE_SUBMIT_NAME.exec(name) : undefined;
  if (source && source.kind === "questionnaire.submit"
    && typeof source.interactionId === "string"
    && INTERACTION_ID.test(source.interactionId)) {
    interactionId = source.interactionId;
  } else if (namedSubmission) {
    interactionId = namedSubmission[1];
  }
  if (namedSubmission?.[2]) {
    namedAnswerMode = namedSubmission[2].toLowerCase() as CardFormAnswerMode;
  }
  if (!interactionId) return undefined;
  const valueAnswerMode = source?.answerMode;
  const answerMode = valueAnswerMode === undefined
    ? namedAnswerMode ?? "selected"
    : valueAnswerMode === "selected" || valueAnswerMode === "custom" ? valueAnswerMode : undefined;
  if (!answerMode) return undefined;
  const parsedValues = formValues(formValue);
  if (!parsedValues) return undefined;
  return { interactionId, answerMode, formValues: parsedValues };
}

function parseActionInteractionId(value: string): InteractionId | undefined {
  const parsed = parseInteractionId(value);
  return parsed.ok ? parsed.value : undefined;
}

interface CardActionBase {
  messageId: MessageId;
  chatId: ChatId;
  userId: UserId;
}

function parseBase(trigger: CardActionTriggerEvent): CardActionBase | undefined {
  const messageId = trigger.context?.open_message_id || trigger.open_message_id;
  const chatId = trigger.context?.open_chat_id || trigger.open_chat_id;
  const userId = trigger.operator?.open_id;
  const parsedMessageId = parseMessageId(messageId);
  const parsedChatId = parseChatId(chatId);
  const parsedUserId = parseUserId(userId);
  if (!parsedMessageId.ok || !parsedChatId.ok || !parsedUserId.ok) return undefined;
  return { messageId: parsedMessageId.value, chatId: parsedChatId.value, userId: parsedUserId.value };
}

function parseFormAction(
  base: CardActionBase,
  action: NonNullable<CardActionTriggerEvent["action"]>,
): ParseResult<CardActionPayload> {
  const submission = formSubmission(action.value, action.name, action.form_value);
  if (!submission) return invalid("invalid card action: bad form submission");
  const interactionId = parseActionInteractionId(submission.interactionId);
  if (!interactionId) return invalid("invalid card action: bad interaction id");
  return {
    ok: true,
    value: {
      kind: "form-submit",
      ...base,
      submissionKind: "questionnaire.submit",
      interactionId,
      answerMode: submission.answerMode,
      formValues: submission.formValues,
    },
  };
}

function parseCommandAction(base: CardActionBase, value: unknown): ParseResult<CardActionPayload> {
  const actionReference = commandActionReference(value);
  if (!actionReference) return invalid("invalid card action: bad action reference");
  const actionId = parseActionInteractionId(actionReference);
  if (!actionId) return invalid("invalid card action: bad action id");
  return {
    ok: true,
    value: {
      kind: "command",
      ...base,
      actionId,
    },
  };
}

/**
 * 解析 card.action.trigger 原始事件。
 * messageId/chatId/userId 任一缺失即拒绝；命令按钮与问卷表单分别走独立校验。
 * 未有 Consumer 的表单类型在此拒绝，品牌化 ID 只在解析成功后构造。
 */
export function parseCardAction(event: unknown): ParseResult<CardActionPayload> {
  const source = record(event);
  if (!source) return invalid("invalid card action: expected object");
  const trigger = source as unknown as CardActionTriggerEvent;
  const base = parseBase(trigger);
  if (!base) return invalid("invalid card action: missing message/chat/user id");
  const action = trigger.action;
  if (action?.form_value !== undefined) return parseFormAction(base, action);
  return parseCommandAction(base, action?.value);
}
