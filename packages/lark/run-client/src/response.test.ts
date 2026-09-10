/** Worker JSON 响应必须在解析前受实际字节预算保护。 */
import { describe, expect, it } from "vitest";

import { readJsonResponse } from "./response.js";

describe("readJsonResponse", () => {
  it("声明长度或流式实际长度超限时拒绝并取消读取", async () => {
    let declaredCancelled = false;
    const declared = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": "65" },
    });
    await expect(readJsonResponse(declared, 64)).rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
    expect(declaredCancelled).toBe(true);

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readJsonResponse(new Response(stream), 64)).rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
    expect(cancelled).toBe(true);
  });

  it("在预算内只返回合法 JSON", async () => {
    await expect(readJsonResponse(new Response('{"exists":false}'), 64)).resolves.toEqual({ exists: false });
    await expect(readJsonResponse(new Response("not-json"), 64)).rejects.toMatchObject({ code: "RESPONSE_SCHEMA_ERROR" });
  });
});
