/**
 * dsh-lark 插件入口（SPEC lark.md）。
 *
 * 提供 ctx.lark 服务：装载期解析凭证引用（缺失 fail loud），
 * 之后凭据变更经 credentials/reference-updated 事件热重载（重建 SDK 客户端；
 * 新值不可解析时保留最后可用实例，与 dsh 生态语义一致）。
 *
 * 本文件同时是包的唯一出口：服务契约、卡片载荷、回调解析与错误类型
 * 都从这里导出（插件行名 `dsh-lark`，服务键 `ctx.lark`）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

import { createLarkApi, type LarkApi } from "./api.js";
import { resolveLarkConfig } from "./config.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 飞书 OpenAPI 唯一封装面（网关宿主面服务，不进模型上下文）。 */
    lark?: LarkApi;
  }
}

export const name = "lark";

export const inject = ["credentials"];

export interface Config {
  /** 应用 ID 凭证引用（env 变量名）；缺失 fail loud at load。 */
  appIdEnv: string;
  /** 应用密钥凭证引用；缺失 fail loud at load。 */
  appSecretEnv: string;
  /** 飞书域名（feishu.cn / larksuite.com）。 */
  baseURL?: string;
  /** 资源下载大小上限（字节，默认 50 MiB）。 */
  maxResourceBytes?: number;
}

export const Config: z<Config> = z.object({
  appIdEnv: z.string().required(),
  appSecretEnv: z.string().required(),
  baseURL: z.string(),
  maxResourceBytes: z.number(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const { maxResourceBytes } = resolveLarkConfig(config);
  /** 活跃守卫：dispose 后异步重建不再 provide（防 INACTIVE_EFFECT）。 */
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });

  /** 解析一个凭证引用；未配置时返回 undefined（fail loud 由调用方决定）。 */
  const resolveCredential = async (reference: string): Promise<string | undefined> => {
    const resolved = await ctx.credentials!.resolve(reference as CredentialRef);
    return resolved?.value;
  };

  /** 用当前凭证重建 SDK 客户端；凭证缺失时保留旧实例并告警。 */
  const rebuild = async (): Promise<void> => {
    if (!active) return;
    const [appId, appSecret] = await Promise.all([
      resolveCredential(config.appIdEnv),
      resolveCredential(config.appSecretEnv),
    ]);
    if (!appId || !appSecret) {
      // 装载期缺失 = 致命（fail loud）；运行期缺失（热重载路径）= 保留旧实例告警。
      throw new Error(
        `lark: 凭证引用未配置（${config.appIdEnv} / ${config.appSecretEnv}）——密钥值绝不写入配置，请检查 .env 与凭证提供方`,
      );
    }
    if (!active) return;
    ctx.provide("lark", createLarkApi({
      appId,
      appSecret,
      ...(config.baseURL ? { domain: config.baseURL } : {}),
      maxResourceBytes,
    }));
  };

  // 装载期等待凭证解析与服务提供，使失败归属当前 Cordis fiber。
  await rebuild();

  // 凭证热重载：只关心本插件引用的两个 ref；新值不可解析时保留最后可用实例。
  ctx.on("credentials/reference-updated", (reference: CredentialRef) => {
    if (reference !== config.appIdEnv && reference !== config.appSecretEnv) return;
    void rebuild().catch((error: unknown) => {
      ctx.logger.warn(`lark: 凭证热重载失败，保留旧实例：${String(error)}`);
    });
  });
}

// 包的公开类型面：其他包（lark-ws/gateway/card/approval）从这里导入。
export * from "./api.js";
export * from "./card-action.js";
export * from "./cards.js";
export * from "./errors.js";
export * from "./types.js";
