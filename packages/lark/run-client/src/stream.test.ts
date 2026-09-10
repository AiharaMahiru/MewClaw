/** NDJSON 读取器边界：无换行帧、终态与 UTF-8 字节预算。 */
import { describe, expect, it } from "vitest";

import { makeMessageId, makeRunId, parseScope, type RunRequest } from "dsh-lark-contracts";

import { streamFromResponse } from "./stream.js";

const scope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!scope.ok) throw new Error("unreachable");

const request: RunRequest = {
  runId: makeRunId("run-1"),
  scope: scope.value,
  messageId: makeMessageId("om_1"),
  prompt: "你好",
};

function responseFromChunks(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function eventLine(): string {
  return JSON.stringify({
    event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    envelope: { runId: request.runId, scope: request.scope },
  });
}

function outcomeLine(): string {
  return JSON.stringify({ envelope: { runId: request.runId, scope: request.scope }, outcome: { code: "OK" } });
}

const options = { heartbeatToleranceMs: 1_000, maxEventBytes: 64 * 1024 };

describe("streamFromResponse", () => {
  it("无换行的超大 UTF-8 帧在缓冲前拒绝", async () => {
    const stream = streamFromResponse(responseFromChunks(["测".repeat(30)]), request, { ...options, maxEventBytes: 64 });
    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_SCHEMA_ERROR" });
  });

  it("缺少终态行的 EOF 视为中断", async () => {
    const stream = streamFromResponse(responseFromChunks([`${eventLine()}\n`]), request, options);
    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_BROKEN" });
  });

  it("EOF 前无换行的合法终态仍可消费", async () => {
    const stream = streamFromResponse(responseFromChunks([outcomeLine()]), request, options);
    await expect(collect(stream)).resolves.toEqual([expect.objectContaining({ outcome: { code: "OK" } })]);
  });

  it("非法 UTF-8 不能伪造终态错误码", async () => {
    const text = outcomeLine();
    const malformed = new TextEncoder().encode(text);
    const codeStart = text.indexOf("OK");
    malformed[codeStart] = 0xff;

    const stream = streamFromResponse(new Response(malformed), request, options);
    await expect(collect(stream)).rejects.toMatchObject({ code: "STREAM_SCHEMA_ERROR" });
  });
});
