import { describe, expect, it } from "vitest";

import { resolveBotMenuCommand } from "./bot-menu.js";

describe("resolveBotMenuCommand", () => {
  it("把当前与旧版菜单键映射为现有 slash command", () => {
    expect(resolveBotMenuCommand("help")).toEqual({ name: "help", args: "" });
    expect(resolveBotMenuCommand("session")).toEqual({ name: "session", args: "" });
    expect(resolveBotMenuCommand("new")).toEqual({ name: "clear", args: "" });
    expect(resolveBotMenuCommand("cron")).toEqual({ name: "cron", args: "" });
    expect(resolveBotMenuCommand("preset")).toEqual({ name: "runtime", args: "" });
    expect(resolveBotMenuCommand("clear")).toEqual({ name: "clear", args: "" });
    expect(resolveBotMenuCommand("runtime")).toEqual({ name: "runtime", args: "" });
    expect(resolveBotMenuCommand("todo")).toEqual({ name: "todo", args: "" });
    expect(resolveBotMenuCommand("handoff")).toEqual({ name: "handoff", args: "" });
  });

  it("未知、带空白或自由参数的 eventKey fail closed", () => {
    for (const eventKey of ["unknown", " help", "help ", "/help", "runtime long", ""]) {
      expect(resolveBotMenuCommand(eventKey)).toBeUndefined();
    }
  });
});
