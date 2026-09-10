/**
 * 卡片载荷渲染与回调解析测试（SPEC lark.md §8）。
 */
import { describe, expect, it } from "vitest";

import { parseCardAction } from "./card-action.js";
import { renderMarkdownCard, renderQuestionnaireCard } from "./cards.js";

describe("renderMarkdownCard", () => {
  it("纯文本卡片：单个 markdown 元素", () => {
    const card = renderMarkdownCard("正文 **加粗**");
    expect(card.schema).toBe("2.0");
    expect(card.config.update_multi).toBe(true);
    expect(card.body.elements).toEqual([{
      tag: "markdown",
      content: "正文 **加粗**",
      text_align: "left",
      text_size: "normal",
    }]);
  });

  it("单个动作渲染为 fill 按钮，回调值只含服务端 actionId", () => {
    const actionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    const card = renderMarkdownCard("正文", [{ label: "继续", command: "/resume", actionId }]);
    const button = card.body.elements[1] as { tag: "button"; behaviors: Array<{ value: Record<string, string> }> };
    expect(button.tag).toBe("button");
    expect(button.behaviors[0]!.value).toEqual({ actionId });
  });

  it("两个动作进 column_set（bisect）；四个动作 flow 模式", () => {
    const two = renderMarkdownCard("x", [{ label: "a", command: "/a" }, { label: "b", command: "/b" }]);
    const set = two.body.elements[1] as { tag: "column_set"; flex_mode: string };
    expect(set.flex_mode).toBe("bisect");

    const four = renderMarkdownCard("x", [
      { label: "a", command: "/a" }, { label: "b", command: "/b" },
      { label: "c", command: "/c" }, { label: "d", command: "/d" },
    ]);
    const flow = four.body.elements[1] as { tag: "column_set"; flex_mode: string };
    expect(flow.flex_mode).toBe("flow");
  });

  it("问卷卡按控件类型编码 selected/custom 模式", () => {
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    const selected = renderQuestionnaireCard({
      interactionId,
      questionId: "q1",
      question: "选择",
      options: ["继续"],
    });
    const selectedForm = selected.body.elements[1] as { elements: Array<{ name?: string }> };
    expect(selectedForm.elements[1]!.name).toBe(`questionnaire_submit_${interactionId}_selected`);

    const custom = renderQuestionnaireCard({
      interactionId,
      questionId: "q1",
      question: "补充",
      options: [],
    });
    const customForm = custom.body.elements[1] as { elements: Array<{ name?: string }> };
    expect(customForm.elements[1]!.name).toBe(`questionnaire_submit_${interactionId}_custom`);
  });

});

describe("parseCardAction", () => {
  const base = {
    open_message_id: "om_1",
    open_chat_id: "oc_1",
    operator: { open_id: "ou_1" },
  };
  const uuid = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";

  it("按钮回调：只解析 actionId，不接受命令文本", () => {
    const result = parseCardAction({ ...base, action: { value: { actionId: uuid } } });
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "command", messageId: "om_1", chatId: "oc_1", userId: "ou_1", actionId: uuid },
    });
  });

  it("拒绝含自由 command 的 callback value", () => {
    expect(parseCardAction({ ...base, action: { value: { command: "/clear", interactionId: uuid } } }).ok).toBe(false);
  });

  it("缺失 message/chat/user id 拒绝", () => {
    expect(parseCardAction({ action: { value: { actionId: uuid } } }).ok).toBe(false);
    expect(parseCardAction({ open_message_id: "om_1", operator: { open_id: "ou_1" }, action: {} }).ok).toBe(false);
  });

  it("控制字符或超长平台 ID 拒绝", () => {
    for (const event of [
      { ...base, open_message_id: "om_\n1" },
      { ...base, open_chat_id: "c".repeat(257) },
      { ...base, operator: { open_id: "ou_\n1" } },
    ]) {
      expect(parseCardAction({ ...event, action: { value: { actionId: uuid } } }).ok).toBe(false);
    }
  });

  it("非法 actionId（非 UUID）拒绝", () => {
    const result = parseCardAction({ ...base, action: { value: { actionId: "not-uuid" } } });
    expect(result.ok).toBe(false);
  });

  it("含额外 command 字段的 callback value 拒绝", () => {
    const result = parseCardAction({ ...base, action: { value: { actionId: uuid, command: "/" + "a".repeat(300) } } });
    expect(result.ok).toBe(false);
  });

  it("问卷表单提交：kind 从 value 或按钮名恢复", () => {
    const viaValue = parseCardAction({
      ...base,
      action: { value: { kind: "questionnaire.submit", interactionId: uuid }, form_value: { answer: "可以" } },
    });
    expect(viaValue).toMatchObject({ ok: true, value: { kind: "form-submit", submissionKind: "questionnaire.submit", formValues: { answer: "可以" } } });

    const viaCustom = parseCardAction({
      ...base,
      action: { value: { kind: "questionnaire.submit", interactionId: uuid, answerMode: "custom" }, form_value: { answer: "补充" } },
    });
    expect(viaCustom).toMatchObject({ ok: true, value: { answerMode: "custom", formValues: { answer: "补充" } } });

    const viaName = parseCardAction({
      ...base,
      action: { name: `questionnaire_submit_${uuid}`, form_value: { answer: "ok" } },
    });
    expect(viaName).toMatchObject({ ok: true, value: { kind: "form-submit", submissionKind: "questionnaire.submit" } });
  });

  it("拒绝未知问卷答案模式", () => {
    expect(parseCardAction({
      ...base,
      action: { value: { kind: "questionnaire.submit", interactionId: uuid, answerMode: "other" }, form_value: { answer: "x" } },
    }).ok).toBe(false);
  });

  it("无 Consumer 的 handoff 与 session-delete 表单回调拒绝", () => {
    expect(parseCardAction({
      ...base,
      action: { value: { kind: "handoff.submit", interactionId: uuid }, form_value: { answer: "继续" } },
    }).ok).toBe(false);
    expect(parseCardAction({
      ...base,
      action: { name: `handoff_submit_${uuid}`, form_value: { answer: "继续" } },
    }).ok).toBe(false);
    expect(parseCardAction({
      ...base,
      action: { name: `session_delete_submit_${uuid}`, form_value: { session_ids: ["s1"] } },
    }).ok).toBe(false);
  });

  it("非对象输入拒绝", () => {
    for (const value of [null, undefined, "x", 42, []]) {
      expect(parseCardAction(value).ok).toBe(false);
    }
  });
});
