import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

import { apply as applyMewClawBrand } from "dsh-lark-mewclaw-brand";

export const name = "dsh-lark-mewclaw-brand-desktop";
export const inject = ["webServer"];

/** 桌面端恒为大视口：关闭 ≤768px 移动适配样式，其余与 Web 品牌一致。 */
export function apply(ctx: Context): void {
  applyMewClawBrand(ctx, { mobile: false });
}
