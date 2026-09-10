import { describe, expect, it } from "vitest";

import { WorkerResponseError, readWorkerJson } from "./worker-response.js";

const OVERSIZED_WORKER_RESPONSE_BYTES = 256 * 1024 + 1;

describe("readWorkerJson", () => {
  it("cancels a declared oversized response before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readWorkerJson(new Response(body, {
      headers: { "content-length": String(OVERSIZED_WORKER_RESPONSE_BYTES) },
    }))).rejects.toBeInstanceOf(WorkerResponseError);
    expect(cancelled).toBe(true);
  });

  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const malformed = new Uint8Array([0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);

    await expect(readWorkerJson(new Response(malformed))).rejects.toBeInstanceOf(WorkerResponseError);
  });
});
