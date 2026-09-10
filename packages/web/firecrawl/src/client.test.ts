/** Firecrawl 传输层必须在 JSON 解析前限制响应体，避免异常上游放大内存。 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFirecrawlClient } from "./client.js";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const options = {
  apiUrl: "https://api.example",
  apiKeys: ["fc-test-secret"],
  timeoutMs: 1_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFirecrawlClient", () => {
  it("在 JSON 解析前拒绝声明或实际超过 1 MiB 的响应", async () => {
    const client = createFirecrawlClient(options);
    let declaredCancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": String(RESPONSE_LIMIT_BYTES + 1) },
    })));
    await expect(client.post("/v1/search", {})).rejects.toThrow("Firecrawl returned invalid JSON");
    expect(declaredCancelled).toBe(true);

    const oversizedJson = new TextEncoder().encode(`{"success":true}${" ".repeat(RESPONSE_LIMIT_BYTES)}`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedJson);
        controller.close();
      },
    }))));
    await expect(client.post("/v1/search", {})).rejects.toThrow("Firecrawl returned invalid JSON");
  });

  it("在预算内保留合法 JSON 响应", async () => {
    const client = createFirecrawlClient(options);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"success":true}')));
    await expect(client.post("/v1/search", {})).resolves.toEqual({ success: true });
  });
});
