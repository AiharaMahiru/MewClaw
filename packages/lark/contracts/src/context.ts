/**
 * 进程上下文键与跨包进程事件（声明合并）。
 *
 * `larkScopeIndex`：宿主级（worker）一次性注册的 sessionId → 运行 Scope
 * 映射表。dsh-lark-run 在 agent setup 闭包里写入、dispose 时清理；
 * worker 侧宿主插件（如 lark-approval）经 request.agent.id 查表。
 * （M2 实证：不能在每个 agent 作用域 provide 同名服务——并发 agent 会在
 * 同一 scope 触发服务重名冲突，故改用宿主级单例索引。）
 *
 * `lark/interaction/resolved`：网关送达的交互问卷答案（经 lark-run 的
 * /v1/interaction/resolve 控制端点进入 worker 进程）；消费方
 * dsh-lark-approval 按 interactionId 与完整 Scope 幂等解答。
 *
 * 注意：必须先副作用导入目标模块（dsh 生态惯例——如 dsh-user-questions），
 * 否则 declare module 会退化为环境模块声明，破坏 Context 的模块身份。
 */
import "@deepseek-ai/cordis";

import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";

import type { InteractionId, RunId } from "./ids.js";
import type { RunRequest } from "./run.js";
import type { Scope } from "./scope.js";

/** 会话 → Scope 索引（worker 宿主级单例）。 */
export interface LarkScopeIndex {
  /** 按 sessionId 查运行 Scope；未知会话返回 undefined。 */
  get(sessionId: SessionId): Scope | undefined;
  /** 绑定 Auth Edge 已认证的 Web 会话 Scope；实现必须严格校验 wire 输入。 */
  bindWeb(input: unknown): void;
  /** 读取某条 Web prompt 的无密钥私有模型引用。 */
  webModelRouteFor(sessionId: SessionId, rpcId: string): WebModelRouteRef | undefined;
  /** 读取当前串行 Web prompt 的引用及 rpcId，供私有 Adapter 兑换一次性能力。 */
  webModelRouteForCurrentSelection(sessionId: SessionId): (WebModelRouteRef & { rpcId: string }) | undefined;
  /** 供 ApiProxy 在 prompt 组装前选择固定的 private provider。 */
  webModelSelectionFor(sessionId: SessionId): { provider: "web-private"; model: string } | undefined;
}

/** Auth Edge 下发的无密钥私有模型引用；API Key 永不进入此进程级索引。 */
export interface WebModelRouteRef {
  profileId: string;
  revision: number;
  model: string;
  /** Auth Edge 为单条 prompt 签发的一次性 Worker 路由能力。 */
  capability: string;
}

/**
 * 从 Worker 运行信封解析模型工具 Scope。
 *
 * 工具调用没有信封时必须拒绝；Scope 不能从模型参数、cwd 或默认租户
 * 推导。集中在这里也避免不同 Consumer 对缺失上下文给出不一致的错误。
 */
export function requireLarkRunScope(
  ctx: Pick<Context, "larkScopeIndex">,
  exec: { agent?: { id: SessionId } },
  toolName: string,
): Scope {
  if (!exec.agent) throw new Error(`${toolName} requires an agent context`);
  const scope = ctx.larkScopeIndex?.get(exec.agent.id);
  if (!scope) throw new Error(`${toolName} requires a lark run scope (当前运行无 Scope 信封)`);
  return scope;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 会话 → Scope 索引（仅 worker 宿主面存在）。 */
    larkScopeIndex?: LarkScopeIndex;
  }
  interface Events {
    /**
     * 交互问卷答案送达（worker 进程内广播；网关经控制端点进入）。
     * @param payload - 回调 Scope、interactionId 与答案
     * @mode sync
     */
    "lark/interaction/resolved"(payload: {
      scope: Scope;
      interactionId: InteractionId;
      answer: { selected: string[]; custom?: string };
    }): void;
    /**
     * 进程内运行提交（M4 cron）：dsh-lark-cron 发出合成 RunRequest，
     * dsh-lark-run 接住并走与聊天运行相同的 per-scope 串行队列。
     * @param payload - 完整运行请求（runId 由提交方生成）
     * @mode sync
     */
    "lark/run/submit"(payload: RunRequest): void;
    /**
     * 进程内运行事件镜像（M4 cron）：dsh-lark-run 在桥接 NDJSON 之外
     * 镜像每个 session 事件（cron 输出捕获等进程内消费者）。
     * @param payload - runId 与事件
     * @mode sync
     */
    "lark/run/stream"(payload: { runId: RunId; event: SessionEvent }): void;
    /**
     * 一次运行的生命周期变化（执行面观测，日志/审计用；cron 结局回写依赖）。
     * 仅 runId + 固定 phase/outcome + 时长；绝不携带 scope、提示词、路径。
     * @param payload - runId + 阶段 + 结局
     * @mode sync
     */
    "lark/run/lifecycle"(payload: {
      runId: RunId;
      phase: "started" | "ended";
      outcome?: "ok" | "cancelled" | "timed-out" | "empty" | "failed" | "queued-full";
      code?: string;
      durationMs?: number;
    }): void;
  }
}
