import { describe, expect, it, vi } from "vitest";

import { createFeishuPairingClient } from "./pairing.js";
import type { PairingClientError } from "./pairing.js";

const endpoint = "http://127.0.0.1:3080/internal/pairing/start";

function client(response: unknown, status = 201) {
  return createFeishuPairingClient({
    endpoint,
    credentials: { resolve: vi.fn(async () => ({ value: "pairing-secret" })) },
    request: vi.fn(async () => new Response(JSON.stringify(response), { status })),
  })!;
}

describe("Feishu pairing client", () => {
  it("returns the server-provided binding status", async () => {
    await expect(client({
      url: "http://127.0.0.1:3080/auth/pair?token=opaque",
      binding: { status: "unbound" },
    }).issue("ou_user", "session-" + "a".repeat(64))).resolves.toEqual({
      url: "http://127.0.0.1:3080/auth/pair?token=opaque",
      binding: { status: "unbound" },
    });
  });

  it("rejects a response without a valid binding state", async () => {
    await expect(client({ url: "http://127.0.0.1:3080/auth/pair?token=opaque" }).issue("ou_user", "session-" + "a".repeat(64)))
      .rejects.toMatchObject({ code: "PAIRING_INVALID_RESPONSE" } satisfies Partial<PairingClientError>);
  });
});
