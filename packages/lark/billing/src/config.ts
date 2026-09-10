import z from "@deepseek-ai/schemastery";

import { assertSafeNonNegativeInteger, usdToMicroCredits, type BillingNamespace, type DefaultModelPrice, type ModelPrice } from "./types.js";
import { validatePrice } from "./pricing.js";

export const DEFAULT_MONTHLY_LIMIT_MICRO_CREDITS = 10_000_000;
export const DEFAULT_MODEL_PRICE: DefaultModelPrice = {
  inputMicroCreditsPerMillion: 220_000,
  outputMicroCreditsPerMillion: 660_000,
  cacheReadMicroCreditsPerMillion: 7_000,
  cacheWriteMicroCreditsPerMillion: 0,
  reasoningMicroCreditsPerMillion: 0,
};

const OFFICIAL_PRICING_UPDATED_AT = "2026-08-23T00:00:00.000Z";

/** OpenAI 官方标准档（每百万 token，美元）；输出价格已包含 reasoning token。 */
function openAiPrice(model: string, inputUsd: number, cacheReadUsd: number, cacheWriteUsd: number, outputUsd: number): ModelPrice {
  return {
    provider: "openai",
    model,
    inputMicroCreditsPerMillion: usdToMicroCredits(inputUsd),
    outputMicroCreditsPerMillion: usdToMicroCredits(outputUsd),
    cacheReadMicroCreditsPerMillion: usdToMicroCredits(cacheReadUsd),
    cacheWriteMicroCreditsPerMillion: usdToMicroCredits(cacheWriteUsd),
    reasoningMicroCreditsPerMillion: 0,
    updatedAt: OFFICIAL_PRICING_UPDATED_AT,
  };
}

export const OFFICIAL_OPENAI_PRICES: readonly ModelPrice[] = [
  openAiPrice("gpt-5.6-sol", 4, 0.4, 5, 20),
  openAiPrice("gpt-5.6-terra", 2, 0.2, 2.5, 12),
  openAiPrice("gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2),
  openAiPrice("gpt-5.5", 5, 0.5, 0, 30),
  openAiPrice("gpt-5.5-pro", 30, 0, 0, 180),
  openAiPrice("gpt-5.4", 2.5, 0.25, 0, 15),
  openAiPrice("gpt-5.4-mini", 0.75, 0.075, 0, 4.5),
  openAiPrice("gpt-5.4-nano", 0.2, 0.02, 0, 1.25),
  openAiPrice("gpt-5.4-pro", 30, 0, 0, 180),
  openAiPrice("gpt-5.2", 1.75, 0.175, 0, 14),
  openAiPrice("gpt-5.2-pro", 21, 0, 0, 168),
  openAiPrice("gpt-5.1", 1.25, 0.125, 0, 10),
  openAiPrice("gpt-5", 1.25, 0.125, 0, 10),
  openAiPrice("gpt-5-mini", 0.25, 0.025, 0, 2),
  openAiPrice("gpt-5-nano", 0.05, 0.005, 0, 0.4),
  openAiPrice("gpt-5-pro", 15, 0, 0, 120),
  openAiPrice("gpt-4.1", 2, 0.5, 0, 8),
  openAiPrice("gpt-4.1-mini", 0.4, 0.1, 0, 1.6),
  openAiPrice("gpt-4.1-nano", 0.1, 0.025, 0, 0.4),
  openAiPrice("gpt-4o", 2.5, 1.25, 0, 10),
  openAiPrice("gpt-4o-2024-05-13", 5, 0, 0, 15),
  openAiPrice("gpt-4o-mini", 0.15, 0.075, 0, 0.6),
  openAiPrice("gpt-4-turbo-2024-04-09", 10, 0, 0, 30),
  openAiPrice("gpt-4-0613", 30, 0, 0, 60),
  openAiPrice("gpt-3.5-turbo", 0.5, 0, 0, 1.5),
  openAiPrice("gpt-3.5-turbo-0125", 0.5, 0, 0, 1.5),
  openAiPrice("gpt-3.5-turbo-1106", 1, 0, 0, 2),
  openAiPrice("gpt-3.5-turbo-instruct", 1.5, 0, 0, 2),
];

/** DeepSeek 官方 Models & Pricing（按 2026-08-23 页面 off-peak 价，美元/百万 token）。 */
export const OFFICIAL_DEEPSEEK_PRICES: readonly ModelPrice[] = [
  {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    ...DEFAULT_MODEL_PRICE,
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  {
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    inputMicroCreditsPerMillion: 660_000,
    outputMicroCreditsPerMillion: 1_980_000,
    cacheReadMicroCreditsPerMillion: 22_000,
    cacheWriteMicroCreditsPerMillion: 0,
    reasoningMicroCreditsPerMillion: 0,
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  {
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    ...DEFAULT_MODEL_PRICE,
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
];

/** 所有内置官方价格；管理员仍可通过价格 API 覆盖单个模型。 */
export const OFFICIAL_MODEL_PRICES: readonly ModelPrice[] = [
  ...OFFICIAL_DEEPSEEK_PRICES,
  ...OFFICIAL_OPENAI_PRICES,
];

export interface BillingConfig {
  databaseUrlEnv: string;
  /** Worker/Admin 共用的计费账本域；不改变运行本身的 Scope。 */
  namespace?: {
    tenantId: string;
    botId: string;
    deploymentId: string;
  };
  /** 用户可见配置：自然月美元额度。 */
  defaultMonthlyLimitUsd?: number;
  /** 旧版内部单位配置，仅用于平滑迁移。 */
  defaultMonthlyLimitMicroCredits?: number;
  defaultPrice?: DefaultModelPrice;
}

export interface ResolvedBillingConfig {
  databaseUrlEnv: string;
  namespace?: BillingNamespace;
  defaultMonthlyLimitMicroCredits: number;
  defaultPrice: DefaultModelPrice;
  defaultPrices: readonly ModelPrice[];
}

export const Config: z<BillingConfig> = z.object({
  databaseUrlEnv: z.string().required(),
  namespace: z.object({
    tenantId: z.string().required(),
    botId: z.string().required(),
    deploymentId: z.string().required(),
  }),
  defaultMonthlyLimitUsd: z.number(),
  defaultMonthlyLimitMicroCredits: z.number(),
  defaultPrice: z.object({
    inputMicroCreditsPerMillion: z.number(),
    outputMicroCreditsPerMillion: z.number(),
    cacheReadMicroCreditsPerMillion: z.number(),
    cacheWriteMicroCreditsPerMillion: z.number(),
    reasoningMicroCreditsPerMillion: z.number(),
  }),
});

export function resolveBillingConfig(config: BillingConfig): ResolvedBillingConfig {
  const defaultMonthlyLimitMicroCredits = config.defaultMonthlyLimitUsd !== undefined
    ? usdToMicroCredits(config.defaultMonthlyLimitUsd, "default monthly USD limit")
    : assertSafeNonNegativeInteger(config.defaultMonthlyLimitMicroCredits ?? DEFAULT_MONTHLY_LIMIT_MICRO_CREDITS, "default monthly limit");
  return {
    databaseUrlEnv: config.databaseUrlEnv,
    ...(config.namespace ? { namespace: {
      tenantId: config.namespace.tenantId as BillingNamespace["tenantId"],
      botId: config.namespace.botId as BillingNamespace["botId"],
      deploymentId: config.namespace.deploymentId as BillingNamespace["deploymentId"],
    } } : {}),
    defaultMonthlyLimitMicroCredits,
    defaultPrice: validatePrice(config.defaultPrice ?? DEFAULT_MODEL_PRICE),
    defaultPrices: OFFICIAL_MODEL_PRICES,
  };
}
