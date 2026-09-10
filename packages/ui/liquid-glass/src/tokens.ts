/** 官方语义 token 覆盖；不更改主题偏好、字体大小与状态色。 */
import type { ThemeTokenOverrides } from "@deepseek-ai/dsh-client-ui-theme/client";

/** 雾白与石墨色底面，浮层保留高不透明度以保证长文本可读。 */
export const OPAQUE_TOKENS: ThemeTokenOverrides = {
  "--dsw-specific-sidebar-fill": { light: "#f2f2f4", dark: "#232327" },
  "--dsw-specific-input-major": { light: "#fafafc", dark: "#303035" },
  "--dsw-specific-menu": { light: "#fafafc", dark: "#303035" },
  "--dsw-specific-selector": { light: "#e9e9ee", dark: "#393940" },
  "--dsw-specific-sidebar-nav-item-active": { light: "#dddde5", dark: "#41414b" },
  "--dsw-alias-bg-base": { light: "#f2f2f4", dark: "#19191d" },
  "--dsw-alias-bg-layer-1": { light: "#fafafc", dark: "#232327" },
  "--dsw-alias-bg-layer-2": { light: "rgb(255 255 255 / 96%)", dark: "rgb(35 35 40 / 98%)" },
  "--dsw-alias-bg-layer-3": { light: "#ffffff", dark: "#303035" },
  "--dsw-alias-bg-module-platform": { light: "#e9e9ee", dark: "#25252b" },
  "--dsw-alias-border-l1": { light: "#ceced6", dark: "#494951" },
  "--dsw-alias-border-l2": { light: "#dddde3", dark: "#393940" },
  "--dsw-alias-interactive-bg-hover": { light: "rgb(50 50 65 / 8%)", dark: "rgb(220 220 235 / 10%)" },
  "--dsw-alias-interactive-bg-active": { light: "rgb(50 50 65 / 14%)", dark: "rgb(220 220 235 / 17%)" },
};

/** 背景透出静态壁纸；浮层保留足够不透明度，不透明降级复用原配色。 */
export const GLASS_TOKENS: ThemeTokenOverrides = {
  ...OPAQUE_TOKENS,
  "--dsw-specific-sidebar-fill": { light: "rgb(250 250 252 / 48%)", dark: "rgb(28 28 35 / 50%)" },
  "--dsw-specific-input-major": { light: "rgb(250 250 252 / 76%)", dark: "rgb(36 36 44 / 78%)" },
  "--dsw-specific-menu": { light: "rgb(250 250 252 / 86%)", dark: "rgb(36 36 44 / 88%)" },
  "--dsw-specific-selector": { light: "rgb(255 255 255 / 28%)", dark: "rgb(255 255 255 / 9%)" },
  "--dsw-alias-bg-base": { light: "rgb(242 242 244 / 28%)", dark: "rgb(25 25 29 / 28%)" },
  "--dsw-alias-bg-layer-1": { light: "rgb(250 250 252 / 68%)", dark: "rgb(35 35 39 / 78%)" },
  "--dsw-alias-bg-layer-2": { light: "rgb(255 255 255 / 94%)", dark: "rgb(35 35 40 / 96%)" },
  "--dsw-alias-bg-module-platform": { light: "rgb(233 233 238 / 76%)", dark: "rgb(37 37 43 / 84%)" },
};
