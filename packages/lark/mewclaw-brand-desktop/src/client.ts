import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";

import { applyBrand, type BrandReactApi } from "dsh-lark-mewclaw-brand/client-impl";

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

loader?.load({
  id: "dsh-lark-mewclaw-brand-desktop",
  factory: (require) => {
    const React = require("react") as BrandReactApi;
    return {
      apply: (ctx) => applyBrand(ctx, React),
      inject: ["slots"],
    };
  },
});
