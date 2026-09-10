import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { ReactNode } from "react";

import {
  renderMewClawBrandMark,
  type MewClawBrandMarkProps,
  type ReactApi,
} from "./mark.js";

type ModuleLoader = {
  load(input: {
    id: string;
    factory: (require: (specifier: string) => unknown) => {
      apply: (ctx: ClientContext) => void;
      inject: string[];
    };
  }): void;
};

type BrandReactApi = ReactApi & {
  useState<T>(initializer: () => T): [T, (value: T) => void];
};

const HERO_COPY = ["该做点什么呢~ Mew", "灵感正伸着懒腰", "把难题交给猫爪", "今天也要聪明一点"] as const;

const loader = (globalThis as typeof globalThis & {
  __ModuleLoader__?: ModuleLoader;
}).__ModuleLoader__;

/** 只占据会话首屏中央标识，不接触会话、模型或网络状态。 */
export function applyBrand(ctx: ClientContext, React: BrandReactApi): void {
  ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, () => {
    // Hero 只在空白新会话挂载；本次挂载固定一条文案，避免阅读时持续跳动。
    const [copy] = React.useState(() => HERO_COPY[Math.floor(Math.random() * HERO_COPY.length)] ?? HERO_COPY[0]);
    return React.createElement("span", { className: "mewclaw-hero-brand" },
      renderMewClawBrandMark(React, { size: 46, className: "mewclaw-hero-mark" }),
      React.createElement("span", { className: "mewclaw-hero-copy" }, copy),
    ) as ReactNode;
  }));
  registerMark(ctx, React, "sidebar.brand.mark", "mewclaw-sidebar-mark", 24);
  ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, () => React.createElement("span", {
    className: "mewclaw-sidebar-name",
  }, "MewClaw Harness") as ReactNode));
}

function registerMark(ctx: ClientContext, React: ReactApi, slot: "sidebar.brand.mark", ownClass: string, fixedSize?: number): void {
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, (props: MewClawBrandMarkProps) => renderMewClawBrandMark(React, {
    ...props,
    size: fixedSize ?? props.size,
    className: [props.className, ownClass].filter(Boolean).join(" "),
  }) as ReactNode));
}

loader?.load({
  id: "dsh-lark-atw-brand",
  factory: (require) => {
    const React = require("react") as BrandReactApi;
    return {
      apply: (ctx) => applyBrand(ctx, React),
      inject: ["slots"],
    };
  },
});
