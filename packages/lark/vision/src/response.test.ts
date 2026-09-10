/** 视觉上游响应在 JSON 解析前必须受字节预算保护。 */
import { describe, expect, it } from "vitest";

import { MAX_VISION_RESPONSE_BYTES, readVisionJson } from "./response.js";

describe("readVisionJson", () => {
  it("拒绝超过预算的声明长度和实际流字节", async () => {
    let declaredCancelled = false;
    const declared = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": String(MAX_VISION_RESPONSE_BYTES + 1) },
    });
    await expect(readVisionJson(declared)).rejects.toThrow("Vision API returned invalid response");
    expect(declaredCancelled).toBe(true);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_VISION_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(readVisionJson(new Response(stream))).rejects.toThrow("Vision API returned invalid response");

    await expect(readVisionJson(new Response("{}"))).resolves.toEqual({});
  });
});
