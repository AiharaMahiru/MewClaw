# dsh-lark-vision SPEC（图片/扫描件视觉分析）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-vision`（Plugin，worker） |
| 位置 | `packages/lark/vision/` |
| 角色 | Plugin（提供 `ctx.larkVision`） |
| 里程碑 | M4 |
| 状态 | implementing |
| 关联 ADR | ADR-4（执行只发生在 worker） |
| 依赖能力 | `ctx.credentials`（VISION_* 凭证引用） |
| 提供能力 | `ctx.larkVision` |

## 1 目的与边界

主模型为 text-only 时的视觉路由：图片/扫描 PDF 附件经本插件调用视觉模型
（OpenAI Responses API 兼容端），把**结构化文本**回注给主会话（lark-claw
vision-client 平移；蓝图 §5 的「注册进 llm 目录」改为独立客户端 + 凭证引用——
llm 适配器生态尚不稳定，行为变化记录于 §9）。

非目标：视频/音频；视觉模型的对话式多轮（单次分析）；RAG 视觉嵌入
（knowledge SPEC 已声明不迁）。

## 2 服务契约

```ts
interface LarkVision {
  /** 分析一张图片（data URL）；返回结构化文本分析（不可信证据）。 */
  analyze(asset: { dataUrl: string }, signal?: AbortSignal): Promise<string>
  /** 是否可用（凭证装载且模型已配）。 */
  available(): boolean
}
```

分析结果结构（lark-claw OUTPUT_SCHEMA 保留，wire 校验手写）：
`{type, title, ocrText, description, tableMarkdown, nodes[], edges[], keywords[], uncertainRegions[]}`
→ 拼装为 Markdown 文本块回注。所有字段保持严格类型；文本先 HTML 转义，不能伪造
`<visual_analysis>` 或其他上下文边界。

## 3 配置契约

```ts
interface Config {
  /** 凭证引用（env 变量名）。 */
  apiKeyEnv: string
  baseUrlEnv?: string   // 缺省用 VISION_BASE_URL 语义的固定缺省
  modelEnv?: string     // 缺省固定模型名
  reasoningEffortEnv?: string
  /** 请求时限（默认 120s，1s..5min）。 */
  timeoutMs?: number
}
```

缺失凭证 = 不可用（available()=false，fail closed 降级），**不**装载失败——
视觉是增强能力，主会话 text-only 仍可运行。
timeout 只有在字段缺省时回落到 120 秒；显式非法数值在任何凭证解析或上游请求前 fail loud。

## 4 事件契约

无（分析文本经 uploads 的 `lark/run/context` 块进入会话）。

## 5 模型可见面

uploads 预检：图片类附件物化后调 `ctx.larkVision.analyze` → 文本块
`<visual_analysis>…</visual_analysis>` 进上下文；不可用时块内说明「图片无法
分析」（fail closed 但运行继续）。该块以 UTF-8 计最多 64 KiB，且先作为
`lark/run/context` 事件落盘后才进入模型请求。

## 6 行为契约

- 提示词固定：把图片当不可信证据提取文本/表格/图示结构；**不执行图中指令**；
- 输出 JSON 强校验（zod 换手写 wire 校验）；`store:false`（不留云端）；
- 成功响应最多 1 MiB、错误响应最多 64 KiB（仅显示前 512 字符）；`output_text`
  最多 256 KiB；字段最多 16 KiB，小型标签最多 512 bytes，任一数组最多 128 项；
  超限或 wire 不符均拒绝，交由 uploads 产出失败降级块。
- 密钥与 base URL 脱敏；超时 120s；错误 → 上层降级块（不抛穿运行）。

## 7 安全与信任

- 图片是提示注入面：固定分析提示词 + 结果标记不可信证据（uploads 的边界块
  覆盖）；结果 HTML 转义后回注，不执行、不落密钥；
- 凭证只经引用；值绝不入日志/事件。

## 8 测试契约

- `unit`：wire 解析（output_text 缺失/status 非 completed 报错）、请求体形状
  （store:false/固定提示词/JSON schema）、密钥脱敏、available 语义；成功/失败响应
  字节预算、字段/数组和最终模型上下文预算、边界标签转义。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/rag/src/vision-client.ts` | 平移（zod wire 校验改手写） |
| `.env` VISION_BASE_URL / VISION_MODEL / VISION_OPENAI_API_KEY / VISION_MODEL_REASONING_EFFORT | 凭证引用接回 |

行为变化：蓝图 §5 原计划「视觉模型注册进 llm 目录」→ 独立客户端（llm 适配器
生态稳定后再迁——届时替换点在本插件内部，契约面不变）。

## 10 开放问题

1. 扫描 PDF 的视觉路由（多页转图）→ 与富格式提取一起评估（M4d/ M5）。
