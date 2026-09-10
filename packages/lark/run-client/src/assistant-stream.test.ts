import { describe, expect, it } from "vitest";
import { makeRunId, parseScope, type RunRequest } from "dsh-lark-contracts";
import { parseLine } from "./validation.js";

const parsed = parseScope({ tenantId: "t", botId: "b", deploymentId: "d", userId: "u", conversationId: "c" });
if (!parsed.ok) throw new Error("invalid fixture");
const request = { runId: makeRunId("stream-test"), scope: parsed.value } as RunRequest;
const envelope = { runId: request.runId, scope: request.scope };
const assistant = { turn: 1, step: 2, text: "临时正文" };

describe("临时正文 wire", () => {
  it("保留独立正文行而不伪造持久化事件", () => {
    expect(parseLine(JSON.stringify({ envelope, assistant }), request, 4096)).toEqual({ envelope, assistant });
  });
  it.each([
    { assistant: { ...assistant, step: -1 } },
    { assistant: { ...assistant, text: {} } },
    { assistant, event: {} },
    { assistant, outcome: { code: "OK" } },
  ])("拒绝非法或混合载荷 %j", (value) => {
    expect(() => parseLine(JSON.stringify({ envelope, ...value }), request, 4096)).toThrow();
  });
  it("拒绝另一运行的正文", () => {
    expect(() => parseLine(JSON.stringify({ envelope: { ...envelope, runId: "other" }, assistant }), request, 4096)).toThrow();
  });
});
