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

const loader = (globalThis as typeof globalThis & {
  __ModuleLoader__?: ModuleLoader;
}).__ModuleLoader__;

/** 只占据会话首屏中央标识，不接触会话、模型或网络状态。 */
export function applyBrand(ctx: ClientContext, React: ReactApi): void {
  registerMark(ctx, React, "conversation.hero.brand.mark", "mewclaw-hero-mark");
  registerMark(ctx, React, "sidebar.brand.mark", "mewclaw-sidebar-mark");
  ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, () => React.createElement("span", {
    className: "mewclaw-sidebar-name",
  }, "MewClaw Harness") as ReactNode));
}

function registerMark(ctx: ClientContext, React: ReactApi, slot: "conversation.hero.brand.mark" | "sidebar.brand.mark", ownClass: string): void {
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, (props: MewClawBrandMarkProps) => renderMewClawBrandMark(React, {
    ...props,
    className: [props.className, ownClass].filter(Boolean).join(" "),
  }) as ReactNode));
}

loader?.load({
  id: "dsh-lark-atw-brand",
  factory: (require) => {
    const React = require("react") as ReactApi;
    return {
      apply: (ctx) => applyBrand(ctx, React),
      inject: ["slots"],
    };
  },
});
