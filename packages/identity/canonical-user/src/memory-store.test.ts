import { describe, expect, it } from "vitest";

import { makeBotId, makeDeploymentId, makeTenantId } from "dsh-lark-contracts";

import {
  MemoryCanonicalUserStore,
  type CanonicalUserId,
  type IdentityNamespace,
  type MemoryMutationCheckpoint,
} from "./index.js";

const USER_1 = "00000000-0000-4000-8000-000000000001" as CanonicalUserId;
const USER_2 = "00000000-0000-4000-8000-000000000002" as CanonicalUserId;
const OPEN_ID = "ou_sensitive_subject";
const NOW = "2026-08-24T00:00:00.000Z";
const PAST = "2026-08-23T00:00:00.000Z";

function namespace(tenant = "tenant-a"): IdentityNamespace {
  return {
    tenantId: makeTenantId(tenant),
    botId: makeBotId("bot-a"),
    deploymentId: makeDeploymentId("deployment-a"),
  };
}

function eventId(suffix: number): string {
  return `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

describe("MemoryCanonicalUserStore", () => {
  it("并发解析未知飞书身份只创建一个 provisional principal", async () => {
    const store = new MemoryCanonicalUserStore();
    const results = await Promise.all(Array.from({ length: 16 }, () => store.resolveForUsage({
      namespace: namespace(),
      source: { kind: "feishu", openId: OPEN_ID },
    })));

    expect(new Set(results.map((item) => item.principalId))).toHaveLength(1);
    expect(results.every((item) => item.canonicalUserId === null && item.bindingVersion === 1)).toBe(true);
    expect(store.snapshot()).toMatchObject({
      principals: [{ kind: "feishu-provisional", canonicalUserId: null }],
      bindings: [{ version: 1, canonicalUserId: null, validTo: null }],
    });
    expect(store.snapshot().outbox).toHaveLength(1);
  });

  it("Web principal 稳定，members 严格按 namespace 隔离", async () => {
    const store = new MemoryCanonicalUserStore();
    const first = await store.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_1 } });
    const again = await store.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_1 } });
    await store.resolveForUsage({ namespace: namespace("tenant-b"), source: { kind: "web", userId: USER_1 } });

    expect(again).toEqual(first);
    expect(await store.members({ namespace: namespace(), canonicalUserId: USER_1 })).toEqual([first.principalId]);
  });

  it("解绑 rotate principal，重绑不会转移旧历史", async () => {
    const store = new MemoryCanonicalUserStore();
    const provisional = await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const web1 = await store.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_1 } });
    const web2 = await store.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_2 } });

    const bound = await store.bind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(1), expectedVersion: 1 });
    expect(bound).toMatchObject({ ok: true, outcome: "bound", resolution: { principalId: provisional.principalId, canonicalUserId: USER_1, bindingVersion: 2 } });

    const unbound = await store.unbind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(2), expectedVersion: 2 });
    expect(unbound).toMatchObject({ ok: true, outcome: "unbound", resolution: { canonicalUserId: null, bindingVersion: 3 } });
    if (!unbound.ok) throw new Error("expected unbind success");
    expect(unbound.resolution.principalId).not.toBe(provisional.principalId);

    const rebound = await store.bind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_2, eventId: eventId(3), expectedVersion: 3 });
    expect(rebound).toMatchObject({ ok: true, outcome: "bound", resolution: { principalId: unbound.resolution.principalId, canonicalUserId: USER_2, bindingVersion: 4 } });
    expect(await store.members({ namespace: namespace(), canonicalUserId: USER_1 })).toEqual(expect.arrayContaining([web1.principalId, provisional.principalId]));
    expect(await store.members({ namespace: namespace(), canonicalUserId: USER_2 })).toEqual(expect.arrayContaining([web2.principalId, unbound.resolution.principalId]));
  });

  it("expectedVersion 不匹配时 fail closed 且不改状态", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const before = store.snapshot();
    const result = await store.bind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(4), expectedVersion: 9 });

    expect(result).toEqual({ ok: false, code: "EXPECTED_VERSION_MISMATCH", currentVersion: 1 });
    expect(store.snapshot()).toEqual(before);
  });
});

describe("Memory canonical-user failure and privacy", () => {
  it("Writer 非法边界输入返回 INVALID_INPUT 且不写状态", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const before = store.snapshot();
    const result = await store.bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: "NOT-A-UUID", expectedVersion: 1,
    });
    expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(store.snapshot()).toEqual(before);
  });

  it("eventId 同命令重放幂等，不同命令返回冲突", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const command = { namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(5), expectedVersion: 1 };
    const first = await store.bind(command);
    const replay = await store.bind(command);
    const conflict = await store.bind({ ...command, canonicalUserId: USER_2 });

    expect(replay).toEqual(first);
    expect(conflict).toEqual({ ok: false, code: "EVENT_ID_CONFLICT" });
    expect(store.snapshot().bindings).toHaveLength(2);
    expect(store.snapshot().outbox).toHaveLength(2);
  });

  it.each<MemoryMutationCheckpoint>(["after-principal", "after-binding", "after-outbox", "after-command"])(
    "%s 故障会共同回滚 principal、interval 与 outbox",
    async (checkpoint) => {
      const store = new MemoryCanonicalUserStore({ checkpoint: (current) => {
        if (current === checkpoint) throw new Error(`fault:${checkpoint}`);
      } });

      await expect(store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } })).rejects.toThrow(`fault:${checkpoint}`);
      expect(store.snapshot()).toEqual({ principals: [], bindings: [], outbox: [] });
    },
  );

  it("outbox 只保存 subject digest，不泄露 raw open_id", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const serialized = JSON.stringify(store.snapshot().outbox);
    expect(serialized).not.toContain(OPEN_ID);
    expect(store.snapshot().outbox[0]?.subjectDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Web resolve 拒绝仅适用于飞书命令的事件字段", async () => {
    const store = new MemoryCanonicalUserStore({ now: () => new Date(NOW) });
    const input = {
      namespace: namespace(), source: { kind: "web", userId: USER_1 },
      eventId: eventId(29), occurredAt: NOW,
    } as never;

    await expect(store.resolveForUsage(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store.snapshot()).toEqual({ principals: [], bindings: [], outbox: [] });
  });

  it("Writer 畸形结构返回 INVALID_INPUT 而不泄漏原生 TypeError", async () => {
    const store = new MemoryCanonicalUserStore();
    const result = await store.bind({
      namespace: null, openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(30),
    } as never);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(store.snapshot()).toEqual({ principals: [], bindings: [], outbox: [] });
  });
});

describe("Memory canonical-user command journal", () => {
  it("首次接触带 expectedVersion 时拒绝绑定并稳定重放", async () => {
    const store = new MemoryCanonicalUserStore();
    const command = {
      namespace: namespace(), openId: "ou_missing_versioned", canonicalUserId: USER_1,
      eventId: eventId(19), expectedVersion: 1,
    };
    expect(await store.bind(command)).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    expect(await store.bind(command)).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    expect(store.snapshot()).toEqual({ principals: [], bindings: [], outbox: [] });
  });

  it("首次接触可直接 bind，missing unbind 的原失败会稳定重放", async () => {
    const store = new MemoryCanonicalUserStore();
    const missing = {
      namespace: namespace(), openId: "ou_missing", canonicalUserId: USER_1, eventId: eventId(20),
    };
    expect(await store.unbind(missing)).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_missing" } });
    expect(await store.unbind(missing)).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    expect(await store.bind({ ...missing, canonicalUserId: USER_2 })).toEqual({ ok: false, code: "EVENT_ID_CONFLICT" });

    const direct = await store.bind({
      namespace: namespace(), openId: "ou_first_contact", canonicalUserId: USER_1, eventId: eventId(21),
    });
    expect(direct).toMatchObject({ ok: true, outcome: "bound", resolution: { canonicalUserId: USER_1, bindingVersion: 1 } });
  });

  it("existing ensure 的 eventId 在 rotate 后仍重放原 principal", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.bind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(22) });
    const ensured = await store.resolveForUsage({
      namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID }, eventId: eventId(23),
    });
    await store.unbind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(24), expectedVersion: 1,
    });
    expect(await store.resolveForUsage({
      namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID }, eventId: eventId(23),
    })).toEqual(ensured);
  });
});

describe("Memory canonical-user ordering and isolation", () => {
  it("拒绝未来时间戳，后续服务端时间命令仍可成功", async () => {
    const store = new MemoryCanonicalUserStore({ now: () => new Date(NOW) });
    const future = await store.bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(31), occurredAt: "9999-01-01T00:00:00.000Z",
    });
    const followup = await store.bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(32), occurredAt: PAST,
    });

    expect(future).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(followup).toMatchObject({ ok: true, outcome: "bound" });
    expect(store.snapshot().bindings[0]?.validFrom).toBe(PAST);
  });

  it("倒序时间返回 INVALID_INPUT 且不改变 interval", async () => {
    const store = new MemoryCanonicalUserStore();
    await store.bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(25), occurredAt: "2026-02-01T00:00:00.000Z",
    });
    const before = store.snapshot();
    const command = {
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(26), expectedVersion: 1, occurredAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await store.unbind(command)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(await store.unbind(command)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(store.snapshot()).toEqual(before);
  });

  it("同 subject 跨 namespace 隔离，并发 bind/unbind 保持唯一 active", async () => {
    const store = new MemoryCanonicalUserStore();
    const tenantA = await store.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const tenantB = await store.resolveForUsage({ namespace: namespace("tenant-b"), source: { kind: "feishu", openId: OPEN_ID } });
    expect(tenantA.principalId).not.toBe(tenantB.principalId);
    const [bound, unbound] = await Promise.all([
      store.bind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(27), expectedVersion: 1 }),
      store.unbind({ namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(28), expectedVersion: 2 }),
    ]);
    expect(bound.ok).toBe(true);
    expect(unbound.ok).toBe(true);
    expect(store.snapshot().bindings.filter((item) => item.namespace.tenantId === namespace().tenantId && item.validTo === null)).toHaveLength(1);
  });
});
