/**
 * markdown 卡片载荷模型与渲染（纯函数，无 I/O）。
 *
 * 渲染策略是纯数据变换：输入内容与动作，输出飞书 card schema 2.0 载荷。
 * 策略归 dsh-lark-card；本文件只提供载荷类型与渲染原语（lark-claw
 * markdown-card.ts 语义保留，注释中文化）。
 */
import { randomUUID } from "node:crypto";
/** 卡片命令按钮动作（命令词汇校验在 dsh-lark-commands 注册表，不在本层）。 */
export interface CardCommandAction {
  label: string;
  /** 服务端注册的动作引用；未提供时只用于非命令类的通用卡片预览。 */
  actionId?: string;
  command: string;
  style?: "default" | "primary" | "danger";
  /** 二次确认文案（点按后弹确认框）。 */
  confirm?: string;
  group?: string;
  layout?: "stack";
}
interface PlainText { tag: "plain_text"; content: string; }
interface MarkdownElement {
  tag: "markdown";
  content: string;
  text_align: "left";
  text_size: "normal";
}
interface ButtonElement {
  tag: "button";
  text: PlainText;
  type: "default" | "primary" | "danger";
  width: "default" | "fill";
  behaviors: [{ type: "callback"; value: { actionId: string } }];
  confirm?: {
    title: { tag: "plain_text"; content: string };
    text: { tag: "plain_text"; content: string };
  };
}
interface FormSubmitButton {
  tag: "button";
  text: PlainText;
  type: "default" | "primary" | "danger";
  width: "fill";
  name: string;
  form_action_type: "submit";
  confirm?: ButtonElement["confirm"];
}

interface FormElement {
  tag: "form";
  name: string;
  elements: [SelectElement | InputElement, FormSubmitButton];
  vertical_spacing: "8px";
}

interface ColumnElement {
  tag: "column";
  width: "auto";
  vertical_align: "top";
  elements: [ButtonElement];
}

interface ColumnSetElement {
  tag: "column_set";
  flex_mode: "bisect" | "trisect" | "flow";
  horizontal_spacing: "8px";
  horizontal_align: "left";
  columns: ColumnElement[];
}

type CardElement = MarkdownElement | ButtonElement | ColumnSetElement | FormElement | SelectElement | InputElement;

/** 飞书 card schema 2.0 markdown 卡片载荷。 */
export interface MarkdownCardPayload {
  schema: "2.0";
  config: { update_multi: true };
  body: {
    direction: "vertical";
    padding: string;
    elements: CardElement[];
  };
}

/** 把单个动作渲染为按钮（callback 只携带服务端 actionId）。 */
function renderAction(action: CardCommandAction, width: ButtonElement["width"] = "fill"): ButtonElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: action.label },
    type: action.style || "default",
    width,
    behaviors: [{
      type: "callback",
      value: { actionId: action.actionId ?? randomUUID() },
    }],
    ...(action.confirm ? {
      confirm: {
        title: { tag: "plain_text", content: "请确认" },
        text: { tag: "plain_text", content: action.confirm },
      },
    } : {}),
  };
}

function flexMode(count: number): ColumnSetElement["flex_mode"] {
  if (count === 2) return "bisect";
  if (count === 3) return "trisect";
  return "flow";
}

function renderActionColumns(actions: readonly CardCommandAction[]): ColumnSetElement {
  const mode = flexMode(actions.length);
  const buttonWidth = mode === "flow" ? "default" : "fill";
  return {
    tag: "column_set",
    flex_mode: mode,
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: actions.map((action) => ({
      tag: "column",
      width: "auto",
      vertical_align: "top",
      elements: [renderAction(action, buttonWidth)],
    })),
  };
}

function renderButtons(actions: readonly CardCommandAction[]): Array<ButtonElement | ColumnSetElement> {
  if (actions.length === 0) return [];
  if (actions.some((action) => action.layout === "stack")) return actions.map((action) => renderAction(action));
  if (actions.length === 1) return [renderAction(actions[0]!)];
  return [renderActionColumns(actions)];
}

/** 按 group 分组（未分组归入 default 组），保持声明顺序。 */
function groupActions(actions: readonly CardCommandAction[]): CardCommandAction[][] {
  const groups = new Map<string, CardCommandAction[]>();
  for (const action of actions) {
    const key = action.group || "default";
    const group = groups.get(key) || [];
    group.push(action);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderActionGroup(actions: readonly CardCommandAction[]): Array<ButtonElement | ColumnSetElement> {
  return renderButtons(actions);
}

/**
 * 渲染问卷交互卡（dsh-lark-approval 的呈现载荷）。
 *
 * 表单值约束：card-action 解析器只接受字符串 form_value（单值语义），
 * 因此 M1 问卷用单选 select（选项非空）或自由输入 input（无选项）；
 * 提交按钮名 `questionnaire_submit_<interactionId>_<answerMode>` 由解析器还原 kind、id 与答案模式。
 */
export interface QuestionnaireCardOptions {
  interactionId: string;
  questionId: string;
  question: string;
  /** 选项标签（空数组 = 自由文本回答）。 */
  options: string[];
}

interface SelectElement {
  tag: "select_static";
  name: string;
  placeholder: PlainText;
  required: true;
  options: Array<{ text: PlainText; value: string }>;
}

interface InputElement {
  tag: "input";
  name: string;
  label: PlainText;
  placeholder: PlainText;
  required: true;
}

export function renderQuestionnaireCard(options: QuestionnaireCardOptions): MarkdownCardPayload {
  const choice: SelectElement | InputElement = options.options.length > 0
    ? {
      tag: "select_static",
      name: options.questionId,
      placeholder: { tag: "plain_text", content: "请选择" },
      required: true,
      options: options.options.map((label) => ({ text: { tag: "plain_text", content: label }, value: label })),
    }
    : {
      tag: "input",
      name: options.questionId,
      label: { tag: "plain_text", content: "回答" },
      placeholder: { tag: "plain_text", content: "请输入你的回答" },
      required: true,
    };
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content: options.question, text_align: "left", text_size: "normal" },
        {
          tag: "form",
          name: `questionnaire_${options.questionId}`.replace(/[^a-z0-9_-]/g, "_"),
          elements: [choice, {
            tag: "button",
            text: { tag: "plain_text", content: "提交" },
            type: "primary",
            width: "fill",
            name: `questionnaire_submit_${options.interactionId}_${options.options.length > 0 ? "selected" : "custom"}`,
            form_action_type: "submit",
          }],
          vertical_spacing: "8px",
        },
      ],
    },
  };
}
/**
 * 渲染 markdown 卡片载荷：正文 markdown + 分组动作按钮/表单。
 * 纯函数；未提供 actionId 时仅为通用卡片生成 UUID。生产命令卡由 commands provider
 * 预先注册 actionId，卡片回调载荷始终只是服务端状态引用。
 */
export function renderMarkdownCard(content: string, actions: readonly CardCommandAction[] = []): MarkdownCardPayload {
  const elements: MarkdownCardPayload["body"]["elements"] = [
    {
      tag: "markdown",
      content,
      text_align: "left",
      text_size: "normal",
    },
  ];
  if (actions.length) {
    elements.push(...groupActions(actions).flatMap(renderActionGroup));
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}
