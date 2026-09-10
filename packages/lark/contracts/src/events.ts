/**
 * SessionEventMap 声明合并（ADR-2 / ADR-4）：飞书专属 session 事件的唯一 home。
 *
 * 事件经 dsh-session 的 session.append() 落盘，任何依赖本包的构建都会
 * 随 @deepseek-ai/dsh-session 的类型一起获得这些成员。payload 全部是
 * 无损 JSON（dsh-session 运行时校验 isJsonValue），scoped 键一律来自
 * 事件自身的 scope 字段，payload 内不得重复携带。
 *
 * 增强目标必须是 `@deepseek-ai/dsh-session/types`（SessionEventMap 的
 * home 模块），而不是根包名：dsh 生态（dsh-agent 等）一律增强 /types
 * 子路径，两个身份并发增强会导致合并丢失（M1 实证，见 docs/evidence）。
 *
 * 安全规则：payload 禁止出现密钥、凭证引用之外的环境值、隐藏推理内容、
 * 原始工具输出全文（引用 digest 替代）。
 *
 * ignorable 说明（M1 实证）：dsh-session 0.1.0-rc.6 的 session.append()
 * 不暴露 ignorable 标记，lark/* 事件一律为必需事件。本仓库全部组件都
 * 依赖本包（类型自洽）；未知第三方读取含 lark/* 的日志时拒绝重建属预期。
 */
import type { ArtifactId, InteractionId, MessageId } from "./ids.js";
import type { Scope } from "./scope.js";

/** lark/* 事件名全集（写入 KNOWN_SESSION_EVENT_TYPES 注册用）。 */
export const LARK_SESSION_EVENT_TYPES = [
  "lark/message/in",
  "lark/artifact/created",
  "lark/knowledge/citations",
  "lark/approval/requested",
  "lark/approval/resolved",
  "lark/run/context",
  "lark/run/preset",
  "lark/memory/recalled",
] as const;

/** 知识检索引用（M3 起由 dsh-tool-knowledge 写入）。 */
export interface KnowledgeCitation {
  /** 来源文档标识（库内 id 或 digest）。 */
  source: string;
  /** 引用片段（节选文本，非全文）。 */
  snippet: string;
  /** 命中分数（0..1，展示用）。 */
  score: number;
}

/** 审批类型（M1 仅 questionnaire；后续可扩展）。 */
export type ApprovalKind = "questionnaire";

/** 审批结局。 */
export type ApprovalOutcome = "answered" | "expired" | "aborted";

/** 随审批事件携带的问题呈现数据（网关据此渲染交互卡）。 */
export interface ApprovalQuestion {
  /** 问题 id（回显在答案中）。 */
  id: string;
  /** 问题文本。 */
  question: string;
  /** 选项标签（空数组 = 自由文本回答）。 */
  options: string[];
}

/**
 * 事件契约版本哨兵（运行时值导出）。
 *
 * 让 events 模块在运行时与类型面都成为显式可导入模块：SessionEventMap
 * 声明合并经 `import "dsh-lark-contracts/events"` 直达（不依赖 export* 链）。
 */
export const LARK_SESSION_EVENT_MAP_VERSION = 4;

/**
 * 把 lark/* 事件名注册进 dsh-session 的已知类型集。
 *
 * dsh-session 的 session.append() 不暴露 ignorable 标记（M1 实证），因此
 * 插件自定义事件要能通过 session-persistence 的 assertEventsSupported
 * （"unknown to this harness and not marked ignorable" 拒绝），唯一官方
 * 扩展机制是导入时把类型名加入导出的 KNOWN_SESSION_EVENT_TYPES Set——
 * 持久化层与运行共享同一 Set 实例。
 */
export function registerLarkEventTypes(known: ReadonlySet<string>): void {
  // d.ts 声明为 ReadonlySet，运行时是可变 Set——注册即官方扩展机制。
  const mutable = known as Set<string>;
  for (const type of LARK_SESSION_EVENT_TYPES) mutable.add(type);
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    /**
     * 一条经授权的用户消息进入会话。
     * 写入方：dsh-lark-run（在提交提示词给模型之前写入——模型可见 ⟺ 已落盘）。
     * @param scope - 消息归属的完整 Scope（scoped 键来源）。
     * @param messageId - 飞书消息 ID（幂等与渲染引用）。
     * @param text - 用户消息原文。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/message/in": {
      scope: Scope;
      messageId: MessageId;
      text: string;
    };
    /**
     * 会话产出用户可交付文件（工件）。
     * 写入方：dsh-lark-uploads；交付物可由 digest 重建。
     * @param scope - 工件归属的完整 Scope。
     * @param artifactId - 工件品牌化 ID。
     * @param name - 展示文件名。
     * @param digest - 内容摘要（SHA-256）。
     * @param bytes - 字节数。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/artifact/created": {
      scope: Scope;
      artifactId: ArtifactId;
      name: string;
      digest: string;
      bytes: number;
    };
    /**
     * 知识检索引用随回答展示（M3 起写入）。
     * @param scope - 检索发起方的完整 Scope（ACL 归属）。
     * @param citations - 本次回答引用的知识条目列表。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/knowledge/citations": {
      scope: Scope;
      citations: KnowledgeCitation[];
    };
    /**
     * 运行预检组装的模型可见上下文块（附件/摄入/检索候选/边界警示，
     * M3 起 dsh-lark-uploads 写入；先落盘再进入提示词）。
     * @param scope - 本次运行的完整 Scope。
     * @param blocks - 有界上下文块原文（模型可见内容与落盘一一对应）。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/run/context": {
      scope: Scope;
      blocks: string[];
    };
    /**
     * 本次运行的 bot 模板身份与技能摘要（M4 起 dsh-lark-run 写入；
     * 模型可见 ⟺ 已落盘——模板修订与技能清单先于提示词）。
     * @param scope - 本次运行的完整 Scope。
     * @param preset - 模板 slug（presets/<slug>）。
     * @param revision - 模板内容修订号。
     * @param version - 模板版本号。
     * @param skills - 本次装载的受信技能名列表。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/run/preset": {
      scope: Scope;
      preset: string;
      revision: string;
      version: string;
      skills: string[];
    };
    /**
     * 记忆召回（M4 起 dsh-lark-run 写入；只记条数——记忆文本随提示词
     * 进 user/message，内容不在此重复）。
     * @param scope - 记忆用户键对应的完整 Scope。
     * @param count - 召回条数。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/memory/recalled": {
      scope: Scope;
      count: number;
    };
    /**
     * 交互问卷已发出（dsh-lark-approval 写入，随运行事件流到达网关渲染）。
     * 携带问题呈现数据；网关据此发交互卡。
     * @param scope - 问卷归属的完整 Scope。
     * @param interactionId - 交互品牌化 ID（回调幂等键）。
     * @param kind - 问卷种类。
     * @param question - 问题呈现数据（题干/选项）。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/approval/requested": {
      scope: Scope;
      interactionId: InteractionId;
      kind: ApprovalKind;
      question: ApprovalQuestion;
    };
    /**
     * 交互问卷已得到答复或过期（dsh-lark-approval 写入）。
     * @param scope - 问卷归属的完整 Scope。
     * @param interactionId - 交互品牌化 ID。
     * @param outcome - 结局（答复值或过期）。
     * @mode emit（经 session/event 通道观察；append 本身同步落盘）
     */
    "lark/approval/resolved": {
      scope: Scope;
      interactionId: InteractionId;
      outcome: ApprovalOutcome;
    };
  }
}
