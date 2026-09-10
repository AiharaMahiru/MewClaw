/**
 * 渲染纯函数测试（SPEC lark-card.md §8）：白名单、截断、模板。
 */
import { describe, expect, it } from "vitest";

import {
  artifactLine,
  assistantText,
  collapseToolLines,
  toolLine,
} from "./render.js";

describe("assistantText", () => {
  it("只取 text 块；reasoning 等白名单外块丢弃", () => {
    const event = {
      type: "assistant/message",
      seq: 0,
      time: 1,
      data: {
        message: {
          content: [
            { type: "reasoning", text: "隐藏推理" },
            { type: "text", text: "可见回答" },
            { type: "redacted", text: "脱敏块" },
          ],
        },
      },
    } as never;
    expect(assistantText(event)).toBe("可见回答");
  });

  it("非 assistant/message 事件返回空串", () => {
    expect(assistantText({ type: "turn/start", data: { turn: 1 } } as never)).toBe("");
  });
});

describe("行渲染与截断", () => {
  it("toolLine：有/无时长", () => {
    expect(toolLine("bash")).toBe("`bash`");
    expect(toolLine("bash", 2500)).toBe("`bash` · 2.5s");
  });

  it("artifactLine：文件名 + 字节数", () => {
    expect(artifactLine("report.md", 42)).toBe("📎 report.md（42 字节）");
  });

  it("collapseToolLines：超上限折叠为计数行", () => {
    const lines = ["l1", "l2", "l3", "l4", "l5"];
    expect(collapseToolLines(lines, 8)).toEqual(lines);
    expect(collapseToolLines(lines, 3)).toEqual(["l1", "l2", "…及另外 3 个工具"]);
  });
});
