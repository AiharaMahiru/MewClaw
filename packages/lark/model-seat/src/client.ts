/**
 * dsh-lark-model-seat 浏览器入口：以 priority:-1 遮蔽官方
 * conversation.input.model 占据，复用同一 ModelDirectory store/select
 * （SPEC docs/specs/model-seat.md）。不修改官方包、不建第二份状态。
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";

import {
  createSeatComponent,
  ensureSeatStyle,
  type SeatDomApi,
  type SeatReactApi,
  type SeatSelection,
} from "./seat.js";

type ModuleLoader = {
  load(input: {
    id: string;
    factory: (require: (specifier: string) => unknown) => {
      apply: (ctx: ClientContext) => void;
      inject: string[];
    };
  }): void;
};

const loader = (globalThis as typeof globalThis & { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__;

/** 注册 composer 模型位占据：与官方同一注入面，priority -1 赢得 single 槽位。 */
export function applyModelSeat(ctx: ClientContext, React: SeatReactApi, dom: SeatDomApi): void {
  ensureSeatStyle(globalThis.document);
  ctx.slots.inject("conversation.input.model", () =>
    ctx.slots.register(
      {
        name: "conversation.input.model",
        priority: -1,
        inject: (sessionId) => {
          const directory = ctx.modelDirectories.directoryFor(sessionId);
          const available = ctx.sessions.subagentAddress(sessionId) === undefined;
          return {
            available,
            directory: directory.store,
            load: () => {
              if (available) void directory.load().catch(() => {});
            },
            select: (selection: SeatSelection) =>
              available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
          };
        },
      },
      createSeatComponent(React, dom),
    ));
}

loader?.load({
  id: "dsh-lark-model-seat",
  factory: (require) => {
    const React = require("react") as SeatReactApi;
    const dom = require("react-dom") as SeatDomApi;
    return {
      apply: (ctx) => applyModelSeat(ctx, React, dom),
      // remote.session：directoryFor 内部经本模块 ambient scope 读
      // ctx.remote.session，缺声明会被 inject 代理拒绝。
      inject: ["slots", "modelDirectories", "sessions", "remote.session"],
    };
  },
});
