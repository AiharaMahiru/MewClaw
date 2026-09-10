/**
 * MemoryPendingStore 测试（SPEC lark-approval.md §8）：
 * 幂等解答（CAS）、每 scope 上限、TTL 过期、显式过期。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import { MemoryPendingStore, StoreFullError } from "./store.js";

function scope(userId: string, conversationId: string): Scope {
  return {
    tenantId: makeTenantId("t"),
    botId: makeBotId("b"),
    deploymentId: makeDeploymentId("d"),
    userId: makeUserId(userId),
    conversationId: makeConversationId(conversationId),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryPendingStore", () => {
  it("创建 → 解答幂等（CAS：重复解答返回 undefined）", () => {
    const store = new MemoryPendingStore({ ttlMs: 60_000, maxPendingPerScope: 5 });
    const record = store.create(scope("ou_1", "oc_1"), "q1");
    expect(record.state).toBe("pending");
    expect(store.resolve(record.id)?.state).toBe("answered");
    expect(store.resolve(record.id)).toBeUndefined();
  });

  it("终态记录只保留到原始 TTL，随后释放内存", () => {
    vi.useFakeTimers();
    const store = new MemoryPendingStore({ ttlMs: 1_000, maxPendingPerScope: 5 });
    const record = store.create(scope("ou_1", "oc_1"), "q1");

    expect(store.resolve(record.id)?.state).toBe("answered");
    expect(store.find(record.id)?.state).toBe("answered");
    vi.advanceTimersByTime(1_100);
    expect(store.find(record.id)).toBeUndefined();
  });

  it("每 scope 未决上限：超出抛 StoreFullError；不同 scope 独立计数", () => {
    const store = new MemoryPendingStore({ ttlMs: 60_000, maxPendingPerScope: 2 });
    store.create(scope("ou_1", "oc_1"), "q1");
    store.create(scope("ou_1", "oc_1"), "q2");
    expect(() => store.create(scope("ou_1", "oc_1"), "q3")).toThrowError(StoreFullError);
    // 不同 conversation 不受影响。
    expect(() => store.create(scope("ou_1", "oc_2"), "q1")).not.toThrow();
  });

  it("相同用户和会话在不同 deployment 的待办配额独立", () => {
    const store = new MemoryPendingStore({ ttlMs: 60_000, maxPendingPerScope: 1 });
    const first = scope("ou_1", "oc_1");
    const otherDeployment = { ...first, deploymentId: makeDeploymentId("other") };

    store.create(first, "q1");
    expect(() => store.create(otherDeployment, "q1")).not.toThrow();
  });

  it("TTL 到期：状态 expired 且触发 onExpire 回调", () => {
    vi.useFakeTimers();
    const store = new MemoryPendingStore({ ttlMs: 1000, maxPendingPerScope: 5 });
    const onExpired = vi.fn();
    const record = store.create(scope("ou_1", "oc_1"), "q1");
    store.onExpire(record.id, onExpired);
    vi.advanceTimersByTime(1100);
    expect(record.state).toBe("expired");
    expect(onExpired).toHaveBeenCalledTimes(1);
    // 解答已被 CAS 拒绝。
    expect(store.resolve(record.id)).toBeUndefined();
  });

  it("显式过期：abort 路径；已解答后过期无效", () => {
    const store = new MemoryPendingStore({ ttlMs: 60_000, maxPendingPerScope: 5 });
    const record = store.create(scope("ou_1", "oc_1"), "q1");
    expect(store.expire(record.id, "aborted")?.state).toBe("aborted");
    expect(store.expire(record.id, "aborted")).toBeUndefined();

    const second = store.create(scope("ou_1", "oc_1"), "q2");
    store.resolve(second.id);
    expect(store.expire(second.id, "aborted")).toBeUndefined();
  });
});
