/**
 * dsh-lark-contracts：跨包共享稳定类型；入口仅执行 lark 事件类型注册。
 *
 * SPEC：docs/specs/contracts.md。任何包不得自行再定义本包导出的类型。
 */
import "./runtime.js";
import "./desktop-events.js";

export * from "./attachments.js";
export * from "./context.js";
export * from "./cron.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./ids.js";
export * from "./run.js";
export * from "./scope.js";
