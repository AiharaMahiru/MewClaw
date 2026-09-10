import { describe, expect, it } from "vitest";

import { parseStoredCommandResult } from "./command-journal.js";

const UUIDS = {
  event: "30000000-0000-4000-8000-000000000001",
  binding: "30000000-0000-4000-8000-000000000002",
  principal: "30000000-0000-4000-8000-000000000003",
  user: "30000000-0000-4000-8000-000000000004",
} as const;

function storedMutation(eventType: string, outcome: string): unknown {
  const resolution = {
    principalId: UUIDS.principal,
    canonicalUserId: UUIDS.user,
    bindingVersion: 1,
  };
  return {
    kind: "mutation",
    result: {
      ok: true,
      outcome,
      resolution,
      event: {
        eventId: UUIDS.event,
        eventType,
        outcome,
        namespace: { tenantId: "tenant", botId: "bot", deploymentId: "deployment" },
        bindingId: UUIDS.binding,
        ...resolution,
        subjectDigest: "0".repeat(64),
        occurredAt: "2026-08-24T00:00:00.000Z",
      },
    },
  };
}

describe("canonical-user command journal validation", () => {
  it.each([
    ["identity-bound", "unbound"],
    ["identity-unbound", "bound"],
  ])("拒绝损坏的 %s + %s 组合", (eventType, outcome) => {
    expect(() => parseStoredCommandResult(storedMutation(eventType, outcome)))
      .toThrow("canonical-user: PostgreSQL returned invalid command result");
  });

  it.each(["identity-bound", "identity-unbound"])("允许 %s + unchanged", (eventType) => {
    expect(parseStoredCommandResult(storedMutation(eventType, "unchanged")))
      .toMatchObject({ kind: "mutation", result: { ok: true, outcome: "unchanged" } });
  });
});
