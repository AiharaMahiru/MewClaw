/**
 * 桥接客户端事件（SPEC lark-run-client.md §4）与 ctx 服务键。
 *
 * 流错误事件只携带 runId + 错误码（不携带事件内容）。
 */
import type { LarkRunClient } from "./client.js";
import type { RunId } from "dsh-lark-contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** worker 运行 API 的网关侧唯一客户端。 */
    larkRunClient?: LarkRunClient;
  }
  interface Events {
    /**
     * 运行流错误（断流/schema 失败；仅 runId + 错误码）。
     * @param payload - runId 与错误码
     * @mode sync
     */
    "lark/run/stream/error"(payload: { runId: RunId; code: string }): void;
  }
}
