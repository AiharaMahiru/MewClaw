/**
 * 摄入意图解析测试（lark-claw attachment-prompt-preparer.test 案例平移）。
 */
import { describe, expect, it } from "vitest";

import { parseKnowledgeIngestionIntent } from "./intent.js";

describe("parseKnowledgeIngestionIntent", () => {
  it.each([
    ["请把这个文件添加到知识库", "user_private"],
    ["将附件保存进我自己的知识库", "user_private"],
    ["把这个文件添加到公共知识库", "bot_shared"],
    ["添加到知识库，但不要放进公共知识库", "user_private"],
    ["添加到公共知识库，但不要共享", "user_private"],
    ["添加到我的知识库，后来还是放进公共知识库", "bot_shared"],
    ["不要添加到公共知识库，而是添加到我自己的知识库", "user_private"],
  ] as const)("routes explicit ingestion '%s' to %s", (message, visibility) => {
    expect(parseKnowledgeIngestionIntent(message)).toEqual({ visibility });
  });

  it("ignores knowledge discussion without an ingestion command", () => {
    expect(parseKnowledgeIngestionIntent("公共知识库里有哪些文件？")).toBeUndefined();
    expect(parseKnowledgeIngestionIntent("帮我总结一下这个文件")).toBeUndefined();
  });

  it.each([
    "不要把这个文件添加到知识库",
    "无需将附件保存进知识库",
  ])("does not persist a negated ingestion command '%s'", (message) => {
    expect(parseKnowledgeIngestionIntent(message)).toBeUndefined();
  });

  it("english: add to knowledge base → private；shared target → bot_shared", () => {
    expect(parseKnowledgeIngestionIntent("please add this file to my knowledge base"))
      .toEqual({ visibility: "user_private" });
    expect(parseKnowledgeIngestionIntent("store this into the shared knowledge base"))
      .toEqual({ visibility: "bot_shared" });
  });
});
