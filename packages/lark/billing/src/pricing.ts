import type { TokenUsage } from "@deepseek-ai/dsh-llm";

import {
  assertSafeNonNegativeInteger,
  TOKENS_PER_MILLION,
  type DefaultModelPrice,
  type ModelPrice,
} from "./types.js";

export interface UsageCost {
  inputMicroCredits: number;
  outputMicroCredits: number;
  cacheReadMicroCredits: number;
  cacheWriteMicroCredits: number;
  reasoningMicroCredits: number;
  totalMicroCredits: number;
}

export function validatePrice(price: DefaultModelPrice): DefaultModelPrice {
  return {
    inputMicroCreditsPerMillion: assertSafeNonNegativeInteger(price.inputMicroCreditsPerMillion, "input price"),
    outputMicroCreditsPerMillion: assertSafeNonNegativeInteger(price.outputMicroCreditsPerMillion, "output price"),
    cacheReadMicroCreditsPerMillion: assertSafeNonNegativeInteger(price.cacheReadMicroCreditsPerMillion, "cache read price"),
    cacheWriteMicroCreditsPerMillion: assertSafeNonNegativeInteger(price.cacheWriteMicroCreditsPerMillion, "cache write price"),
    reasoningMicroCreditsPerMillion: assertSafeNonNegativeInteger(price.reasoningMicroCreditsPerMillion, "reasoning price"),
  };
}

export function validateUsage(usage: TokenUsage): Required<TokenUsage> {
  const inputTokens = assertSafeNonNegativeInteger(usage.inputTokens, "input tokens");
  const outputTokens = assertSafeNonNegativeInteger(usage.outputTokens, "output tokens");
  const cacheReadTokens = assertSafeNonNegativeInteger(usage.cacheReadTokens ?? 0, "cache read tokens");
  const cacheWriteTokens = assertSafeNonNegativeInteger(usage.cacheWriteTokens ?? 0, "cache write tokens");
  const totalTokens = assertSafeNonNegativeInteger(
    usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    "total tokens",
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: assertSafeNonNegativeInteger(usage.reasoningTokens ?? 0, "reasoning tokens"),
  };
}

function charge(tokens: number, rate: number): number {
  const result = Math.ceil(tokens * rate / TOKENS_PER_MILLION);
  return assertSafeNonNegativeInteger(result, "calculated charge");
}

export function calculateCost(usage: TokenUsage, price: DefaultModelPrice): UsageCost {
  const normalizedUsage = validateUsage(usage);
  const normalizedPrice = validatePrice(price);
  const inputMicroCredits = charge(normalizedUsage.inputTokens, normalizedPrice.inputMicroCreditsPerMillion);
  const outputMicroCredits = charge(normalizedUsage.outputTokens, normalizedPrice.outputMicroCreditsPerMillion);
  const cacheReadMicroCredits = charge(normalizedUsage.cacheReadTokens, normalizedPrice.cacheReadMicroCreditsPerMillion);
  const cacheWriteMicroCredits = charge(normalizedUsage.cacheWriteTokens, normalizedPrice.cacheWriteMicroCreditsPerMillion);
  // DeepSeek 的 completion_tokens 已包含 reasoning_tokens；推理字段只用于分析，不能再次计费。
  const reasoningMicroCredits = 0;
  const totalMicroCredits = assertSafeNonNegativeInteger(inputMicroCredits + outputMicroCredits + cacheReadMicroCredits + cacheWriteMicroCredits, "total charge");
  return { inputMicroCredits, outputMicroCredits, cacheReadMicroCredits, cacheWriteMicroCredits, reasoningMicroCredits, totalMicroCredits };
}

export function withPriceIdentity(provider: string, model: string, price: DefaultModelPrice, updatedAt = new Date().toISOString()): ModelPrice {
  return { provider, model, ...validatePrice(price), updatedAt };
}
