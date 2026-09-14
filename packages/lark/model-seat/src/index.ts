/** composer 模型位定制的宿主占位插件：浏览器端经包 `dsh.client` 声明由 ModuleLoader 装载。 */
import type { Context } from "@deepseek-ai/cordis";

export const name = "dsh-lark-model-seat";

/** 宿主侧无行为；全部逻辑在 client.js（见 docs/specs/model-seat.md §2）。 */
export function apply(_ctx: Context): void {}
