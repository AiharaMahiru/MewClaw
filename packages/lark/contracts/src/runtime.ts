/**
 * dsh-lark-contracts 运行时注册（副作用模块）。
 *
 * 进程启动早期（任何 import dsh-lark-contracts 的路径都会到达这里）：
 * 1. 把 lark/* 事件名注册进 KNOWN_SESSION_EVENT_TYPES——否则
 *    session-persistence 装载含 lark/* 的日志时按"未知必需事件"拒绝
 *    （M1 实证，见 docs/evidence/m1-session-eventmap-augment-target.md 姊妹篇）。
 */
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";

import { registerLarkEventTypes } from "./events.js";

registerLarkEventTypes(KNOWN_SESSION_EVENT_TYPES);
