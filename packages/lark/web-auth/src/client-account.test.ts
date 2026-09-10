import { describe, expect, it } from "vitest";

import { isDefaultModelInList, parseModelIds } from "./client-account.js";

describe("账户中心的模型列表输入", () => {
  it("支持换行或逗号分隔，并会去除空白和重复项", () => {
    expect(parseModelIds(" gpt-4o, deepseek-chat\n\n gpt-4o \n qwen-max,deepseek-chat "))
      .toEqual(["gpt-4o", "deepseek-chat", "qwen-max"]);
  });

  it("要求默认模型属于去重后的模型列表", () => {
    const modelIds = parseModelIds("gpt-4o\ndeepseek-chat");
    expect(isDefaultModelInList(modelIds, " deepseek-chat ")).toBe(true);
    expect(isDefaultModelInList(modelIds, "gpt-image-1")).toBe(false);
    expect(isDefaultModelInList(modelIds, " ")).toBe(false);
  });
});
