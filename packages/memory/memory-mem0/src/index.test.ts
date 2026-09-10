/**
 * dsh-memory-mem0 测试（SPEC memory.md §8）：
 * 默认 no-op 降级、启用但凭证缺失 fail loud、memoryScopeIds 派生、
 * recall/remember 映射（mock 客户端）、失败降级。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";
import type { MemoryService } from "dsh-memory";

import { apply, createMem0Service, memoryScopeIds, type Mem0ClientPort } from "./index.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

function makeCtx(secrets: Record<string, string | undefined> = {}) {
  return {
    logger: { warn: vi.fn() },
    provide: vi.fn(),
    credentials: {
      resolve: vi.fn(async (ref: string) => {
        if (ref in secrets) return { value: secrets[ref] };
        return undefined;
      }),
    },
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dsh-memory-mem0", () => {
  it("不通过 process.env 改写宿主进程的 SDK 行为", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env\s*\[?[^\n=]*\]?\s*(?:\?\?=|=)/u);
    expect(source).not.toContain("MEM0_TELEMETRY");
  });
  it("显式关闭：no-op 降级（enabled()=false、空召回、写入 no-op）", async () => {
    let provided: MemoryService | undefined;
    const ctx = {
      logger: { warn: vi.fn() },
      provide: vi.fn((_name: string, value: MemoryService) => { provided = value; }),
      credentials: { resolve: vi.fn(async () => undefined) },
    };
    await apply(ctx as never, { enabled: false });
    expect(provided!.enabled()).toBe(false);
    expect(await provided!.recall(scope, "q")).toEqual([]);
    await expect(provided!.remember(scope, "u", "a")).resolves.toBeUndefined();
  });

  it("省略 enabled 默认启用：凭证缺失时 fail loud", async () => {
    const ctx = makeCtx({});
    await expect(apply(ctx, {})).rejects.toThrow(/凭证引用未配置/);
  });

  it("显式启用但凭证缺失 → fail loud", async () => {
    const ctx = makeCtx({});
    await expect(apply(ctx, { enabled: true })).rejects.toThrow(/凭证引用未配置/);
  });

  it("memoryScopeIds：部署哈希（conversation 不入键）", () => {
    const hash = (parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");
    const ids = memoryScopeIds(scope);
    expect(ids.agentId).toBe(hash(["t", "b", "d"]));
    expect(ids.userId).toBe(hash(["t", "b", "d", "ou_1"]));
    const other = memoryScopeIds({ ...scope, conversationId: makeConversationId("oc_2") });
    expect(other.agentId).toBe(ids.agentId); // 跨会话同键。
  });

  it("recall/remember：mock 客户端映射（截断/过滤/失败降级）", async () => {
    const search = vi.fn(async () => ({
      results: [{ memory: "  记忆片段  " }, { memory: "" }],
    }));
    const add = vi.fn(async () => undefined);
    const client = { search, add } as unknown as Mem0ClientPort;
    const service = createMem0Service(client, { warn: vi.fn() });
    const hits = await service.recall(scope, "query");
    expect(hits).toEqual([{ content: "记忆片段", rank: 0 }]);
    expect(search).toHaveBeenCalledWith("query", {
      filters: { user_id: memoryScopeIds(scope).userId, agent_id: memoryScopeIds(scope).agentId },
      topK: 8,
    });

    await service.remember(scope, "用户说了什么", "助手回答");
    expect(add).toHaveBeenCalledWith(
      [{ role: "user", content: "用户说了什么" }, { role: "assistant", content: "助手回答" }],
      expect.objectContaining({ infer: true, userId: memoryScopeIds(scope).userId }),
    );

    // 召回失败 → 空数组（降级）；写入失败 → 告警不抛。
    search.mockRejectedValueOnce(new Error("down"));
    expect(await service.recall(scope, "q")).toEqual([]);
    add.mockRejectedValueOnce(new Error("down"));
    const warn = vi.fn();
    const failing = createMem0Service(client, { warn });
    await expect(failing.remember(scope, "u", "a")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
