import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";

import { registerLarkShareCommand } from "./index.js";

describe("/lark-share Web command", () => {
  it("只使用 invocation 中的准确 agent id 签发 code", async () => {
    const register = vi.fn((definition: { handler: (input: unknown) => Promise<unknown>; name: string; recordInput: boolean }) => {
      void definition;
      return vi.fn();
    });
    const issueClaim = vi.fn(async () => ({ code: "A".repeat(24), expiresAt: "2026-08-18T00:10:00.000Z" }));

    registerLarkShareCommand({ commands: { register } } as never, { issueClaim } as never);
    const definition = register.mock.calls[0]![0]!;
    const sessionId = SessionId("web-session-command");
    const result = await definition.handler({ agent: { id: sessionId } });

    expect(issueClaim).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual(expect.objectContaining({ kind: "success", text: expect.stringContaining("A".repeat(24)) }));
    expect(definition.name).toBe("lark-share");
    expect(definition.recordInput).toBe(false);
  });
});
