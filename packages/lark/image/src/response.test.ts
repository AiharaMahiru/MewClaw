/** 图片 API 响应在解析前必须受字节预算保护。 */
import { describe, expect, it } from "vitest";

import { readImageJson } from "./response.js";

describe("readImageJson", () => {
  it("拒绝超过预算的声明长度和实际流字节", async () => {
    let declaredCancelled = false;
    const declared = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), { headers: { "content-length": "65" } });
    await expect(readImageJson(declared, 64)).rejects.toThrow("Image API returned invalid response");
    expect(declaredCancelled).toBe(true);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
        controller.close();
      },
    });
    await expect(readImageJson(new Response(stream), 64)).rejects.toThrow("Image API returned invalid response");
  });

  it("只返回预算内的合法 JSON", async () => {
    await expect(readImageJson(new Response('{"data":[]}'), 64)).resolves.toEqual({ data: [] });
    await expect(readImageJson(new Response("not-json"), 64)).rejects.toThrow("Image API returned invalid response");
  });
});
