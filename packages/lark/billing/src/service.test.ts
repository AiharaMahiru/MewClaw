import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_PRICE, OFFICIAL_DEEPSEEK_PRICES, OFFICIAL_MODEL_PRICES } from "./config.js";
import { MemoryBillingStore } from "./memory-store.js";
import { DefaultBillingService, BillingQuotaExceededError } from "./service.js";
import { withPriceIdentity } from "./pricing.js";
import type { Scope } from "dsh-lark-contracts";

const scope = (userId: string, conversationId = "chat-1"): Scope => ({
  tenantId: "tenant-1" as Scope["tenantId"],
  botId: "bot-1" as Scope["botId"],
  deploymentId: "deployment-1" as Scope["deploymentId"],
  userId: userId as Scope["userId"],
  conversationId: conversationId as Scope["conversationId"],
});

function create(limit = 10_000_000) {
  const store = new MemoryBillingStore(limit);
  const service = new DefaultBillingService(store, limit, DEFAULT_MODEL_PRICE, OFFICIAL_DEEPSEEK_PRICES);
  return { store, service };
}

describe("DefaultBillingService", () => {
  it("默认提供官网 DeepSeek 模型价格目录", async () => {
    const { service } = create();
    await expect(service.listPrices()).resolves.toEqual(OFFICIAL_DEEPSEEK_PRICES);
  });

  it("默认目录包含 OpenAI GPT 标准价格并按 provider/model 命中", async () => {
    const store = new MemoryBillingStore(10_000_000);
    const service = new DefaultBillingService(store, 10_000_000, DEFAULT_MODEL_PRICE, OFFICIAL_MODEL_PRICES);
    const prices = await service.listPrices();
    expect(prices).toHaveLength(OFFICIAL_MODEL_PRICES.length);
    expect(prices.find((price) => price.provider === "openai" && price.model === "gpt-5.6-luna")).toMatchObject({
      inputMicroCreditsPerMillion: 200_000,
      cacheReadMicroCreditsPerMillion: 20_000,
      cacheWriteMicroCreditsPerMillion: 250_000,
      outputMicroCreditsPerMillion: 1_200_000,
    });
    const charge = await service.recordUsage({
      scope: scope("user-a"), runId: "openai-run", turn: 0, step: 0,
      provider: "openai", model: "gpt-5.6-luna",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    });
    expect(charge.totalMicroCredits).toBe(800_000);
  });

  it("按真实 usage 结算并对重复事件幂等", async () => {
    const { service } = create();
    const input = {
      scope: scope("user-a"), runId: "run-1", turn: 0, step: 0,
      provider: "deepseek", model: "deepseek-chat",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      recordedAt: new Date("2026-08-22T01:00:00Z"),
    };
    const first = await service.recordUsage(input);
    const second = await service.recordUsage(input);
    expect(first.totalMicroCredits).toBe(550_000);
    expect(second.id).toBe(first.id);
    expect((await service.quota(input.scope, input.recordedAt)).usedMicroCredits).toBe(550_000);
  });

  it("按官网 USD 价格结算，reasoning token 不重复计费", async () => {
    const { service } = create();
    const charge = await service.recordUsage({
      scope: scope("user-a"), runId: "run-reasoning", turn: 0, step: 0,
      provider: "deepseek-official", model: "deepseek-v4-flash",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 250_000 },
    });
    expect(charge.inputMicroCredits).toBe(220_000);
    expect(charge.outputMicroCredits).toBe(330_000);
    expect(charge.reasoningMicroCredits).toBe(0);
    expect(charge.totalMicroCredits).toBe(550_000);
  });

  it("隔离不同用户和会话，并在额度耗尽时拒绝新运行", async () => {
    const { service } = create(1);
    // 固定在本次运行的自然月，避免测试跨月后把历史账单正确排除却误判为失败。
    const currentPeriod = new Date();
    const recordedAt = new Date(Date.UTC(currentPeriod.getUTCFullYear(), currentPeriod.getUTCMonth(), 15, 1));
    await service.setPrice({ ...withPriceIdentity("p", "m", {
      inputMicroCreditsPerMillion: 1,
      outputMicroCreditsPerMillion: 0,
      cacheReadMicroCreditsPerMillion: 0,
      cacheWriteMicroCreditsPerMillion: 0,
      reasoningMicroCreditsPerMillion: 0,
    }) });
    await service.recordUsage({
      scope: scope("user-a", "chat-a"), runId: "run-a", turn: 0, step: 0,
      provider: "p", model: "m", usage: { inputTokens: 1_000_000, outputTokens: 0 },
      recordedAt,
    });
    await expect(service.assertCanStart(scope("user-a", "chat-b"))).rejects.toBeInstanceOf(BillingQuotaExceededError);
    await expect(service.assertCanStart(scope("user-b", "chat-a"))).resolves.toBeUndefined();
  });

  it("按用户和模型聚合分析", async () => {
    const { service } = create();
    await service.recordUsage({
      scope: scope("user-a"), runId: "run-1", turn: 0, step: 0,
      provider: "deepseek", model: "deepseek-chat", usage: { inputTokens: 2, outputTokens: 0 },
      recordedAt: new Date("2026-08-22T01:00:00Z"),
    });
    await service.recordUsage({
      scope: scope("user-b"), runId: "run-2", turn: 0, step: 0,
      provider: "deepseek", model: "deepseek-chat", usage: { inputTokens: 3, outputTokens: 0 },
      recordedAt: new Date("2026-08-22T01:00:00Z"),
    });
    const result = await service.aggregate({ scope: scope("admin"), provider: "deepseek" });
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.inputTokens)).toEqual([2, 3]);
  });

  it("把 Web 与 Admin 原始 Scope 投影到同一计费 namespace", async () => {
    const store = new MemoryBillingStore(10_000_000);
    const namespace = {
      tenantId: "lark" as Scope["tenantId"],
      botId: "default" as Scope["botId"],
      deploymentId: "default" as Scope["deploymentId"],
    };
    const service = new DefaultBillingService(store, 10_000_000, DEFAULT_MODEL_PRICE, [], namespace);
    const webScope = scope("user-web");
    await service.recordUsage({
      scope: webScope, runId: "web:session", turn: 0, step: 0,
      provider: "openai", model: "gpt-5.6-luna", usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect((await service.quota(webScope)).scope).toEqual({ ...namespace, userId: webScope.userId });
    const adminScope = { ...webScope, ...namespace, userId: "admin" as Scope["userId"] };
    const rows = await service.aggregate({ scope: adminScope, userId: webScope.userId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...namespace, userId: webScope.userId, calls: 1 });
  });
});
