import { describe, expect, it } from "vitest";

import {
  appendCutoverDelta,
  openCutoverEpoch,
  sealCutoverEpoch,
  transitionRuntimePhase,
} from "./cutover.js";

const SHA = "a".repeat(64);

describe("runtime cutover state", () => {
  it("accepts the forward production phase sequence", () => {
    expect(transitionRuntimePhase("staged", "verified", { deltaCount: 0, reconciled: false })).toBe("verified");
    expect(transitionRuntimePhase("verified", "source-frozen", { deltaCount: 0, reconciled: false })).toBe("source-frozen");
    expect(transitionRuntimePhase("source-frozen", "promoted", { deltaCount: 0, reconciled: false })).toBe("promoted");
    expect(transitionRuntimePhase("promoted", "accepted", { deltaCount: 2, reconciled: false })).toBe("accepted");
  });

  it("allows automatic rollback only when no delta exists", () => {
    expect(transitionRuntimePhase("promoted", "rolled-back", { deltaCount: 0, reconciled: false })).toBe("rolled-back");
    expect(() => transitionRuntimePhase("promoted", "rolled-back", { deltaCount: 1, reconciled: false })).toThrow(/rollback-pending/);
    expect(transitionRuntimePhase("promoted", "rollback-pending", { deltaCount: 1, reconciled: false })).toBe("rollback-pending");
    expect(() => transitionRuntimePhase("rollback-pending", "rolled-back", { deltaCount: 1, reconciled: false })).toThrow(/reconciliation/);
    expect(transitionRuntimePhase("rollback-pending", "rolled-back", { deltaCount: 1, reconciled: true })).toBe("rolled-back");
  });

  it("enforces contiguous sequence and idempotent operation identifiers", () => {
    const epoch = openCutoverEpoch({
      epochId: "7cb35f47-77b2-4f45-8e9f-311efbcd62fd",
      migrationRunId: "4746c26a-5a04-44de-b52e-b38d20354f65",
      openedAt: "2026-08-24T03:50:00.000Z",
      sourceManifestSha256: SHA,
      targetManifestSha256: SHA,
    });
    const entry = {
      afterDigest: SHA,
      durableReference: "auth:01K34M6TWV6PG23CFV0Q4D8D8Q",
      epochId: epoch.epochId,
      kind: "create" as const,
      occurredAt: "2026-08-24T03:51:00.000Z",
      operationId: "4cfb07ab-11f8-42dd-8388-067b28291bc0",
      reversible: true,
      sequence: 1,
      surface: "auth" as const,
      targetDigest: SHA,
    };

    const journal = appendCutoverDelta({ entries: [], epoch }, entry);
    expect(journal.epoch.nextSequence).toBe(2);
    expect(journal.entries).toEqual([entry]);
    expect(() => appendCutoverDelta(journal, { ...entry, sequence: 2 })).toThrow(/operationId/);
    expect(() => appendCutoverDelta(journal, { ...entry, operationId: crypto.randomUUID(), sequence: 3 })).toThrow(/sequence/);
    expect(() =>
      appendCutoverDelta(
        journal,
        { ...entry, operationId: crypto.randomUUID(), sequence: 2, surface: "admin" } as never,
      ),
    ).toThrow(/surface/);
    expect(() =>
      appendCutoverDelta(
        journal,
        { ...entry, operationId: crypto.randomUUID(), reversible: "yes", sequence: 2 } as never,
      ),
    ).toThrow(/reversible/);
  });

  it("rejects writes after an epoch is sealed", () => {
    const epoch = sealCutoverEpoch(
      openCutoverEpoch({
        epochId: crypto.randomUUID(),
        migrationRunId: crypto.randomUUID(),
        openedAt: "2026-08-24T03:50:00.000Z",
        sourceManifestSha256: SHA,
        targetManifestSha256: SHA,
      }),
      "2026-08-24T04:00:00.000Z",
    );

    expect(() =>
      appendCutoverDelta(
        { entries: [], epoch },
        {
          afterDigest: SHA,
          durableReference: "manifest:closed",
          epochId: epoch.epochId,
          kind: "update",
          occurredAt: "2026-08-24T04:01:00.000Z",
          operationId: crypto.randomUUID(),
          reversible: true,
          sequence: 1,
          surface: "workspace",
          targetDigest: SHA,
        },
      ),
    ).toThrow(/sealed/);
  });
});
