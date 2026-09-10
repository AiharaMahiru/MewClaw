# dsh-lark-image SPEC（生图与图生图能力缝）

## 1 目的与边界

生图（text→image）与改图（image+prompt→image）能力，语义平移 lark-claw `skills/generate-image`（该技能不迁移为脚本技能，能力进插件——蓝图 §迁移边界）。图片**理解**（image→text）仍归 `dsh-lark-vision`，两包互补构成多模态面。

## 2 服务契约

```ts
interface LarkImageService {  // ctx.larkImage
  /**
   * 生成图片：无参考图走 /v1/images/generations（JSON），有参考图走
   * /v1/images/edits（multipart，OpenAI 兼容）。PNG 魔数校验后写工作区
   * 顶层 generated-<uuid>.png（R-06 产物收集自动产 📎 行）。
   * 参考图路径必须位于本次运行工作区内（realpath 包含校验，拒绝 symlink 逃逸）。
   */
  generate(input: {
    scope: Scope
    /** Web 共享会话的真实 cwd；飞书确定性会话省略并按 Scope 派生。 */
    workspace?: string
    prompt: string
    /** 工作区相对路径（数量由 maxReferences 控制，默认 8，硬上限 16）。 */
    references?: string[]
  }): Promise<{ path: string; bytes: number }>
}
```

## 3 配置契约

```ts
interface Config {
  /** 所有可写会话工作区的共同根；实际路径必须通过 realpath 包含校验。 */
  workspaceRoot: string
  /** OpenAI Image API base URL；默认 https://api.openai.com。 */
  baseUrl?: string
  /** OpenAI API Key 凭证引用；默认 OPENAI_API_KEY。 */
  apiKeyEnv?: string
  /** GPT Image 模型名；默认 gpt-image-2。 */
  model?: string
  /** 参考图单张字节上限（默认 10 MiB，1 byte..50 MiB）。 */
  maxReferenceBytes?: number
  /** 单次最多参考图数量（默认 8，允许值 1..16）。 */
  maxReferences?: number
}
```

生产通过 GPT 文本模型同源的 OpenAI 兼容入口 `https://cpa.rwr.ink/v1` 调用 Image API，固定使用
`gpt-image-2` 与 `OPENAI_API_KEY`。视觉理解继续独立使用 `VISION_*`，不得把视觉 provider 的
key、base URL 或聊天模型误用于生图。密钥纪律：错误信息中的完整 key、上游部分掩码 key、
Bearer token 与 base URL 一律替换为 `[REDACTED]`。

## 4 行为契约

- 路由：references 空 → generations；非空 → edits（参考图逐一读入，MIME 按扩展名 png/jpg/webp）。
- 工作区解析：Web 会话传入 session header 的真实 `cwd`；未提供 cwd 的飞书确定性会话
  使用 `workspaceRoot + scopeKey(scope)`。两条路径都必须位于配置根内，并在创建后再次通过
  `realpath` 包含校验；不得从 cwd 反推 Scope。
- 输出恒为 PNG（`output_format: "png"`）；响应 b64 解码后校验 PNG 魔数，非 PNG 拒绝。
- 成功响应先以流式 UTF-8 读取；声明长度和实际字节均限制为“30 MiB PNG 的 base64 长度 + 1 KiB JSON 包装”，解码后的 PNG 不得超过 30 MiB（与 R-06 单交付物上限一致）。错误响应体最多读取 64 KiB，写入错误的信息最多 512 字符。
- 单次生成上限：prompt ≤ 4000 字符、references ≤ `maxReferences`；缺省 8，硬上限 16。
- `maxReferenceBytes` 必须是 1 byte..50 MiB 的安全整数，`maxReferences` 必须是 1..16 的安全整数；配置非法时插件装载直接 fail loud。只有字段缺省采用默认，显式零值不回落为默认预算。
- 改图提示会按输入顺序注入 `图1`..`图N` 与工作区相对文件名，并明确“图1优先作为构图主图”。
  模型应先向用户复述角色映射（例如“图1人物、图2风格？”），再在提示词中使用“图N”引用。
- 上传参考图与 `generated-*.png` 均可在同一 Scope 的后续轮次复用；长期保留的人物/风格图即 canonical reference，
  不复制到外部目录，不跨 Scope 读取。
- 失败 fail loud（工具面向模型返回错误文本）；不做部分成功。
- HTTP 429/5xx 标记为可重试的上游临时错误，可使用相同提示词稍后重试；不将其归咎于提示词，也不自动重复可能收费的请求。

## 5 Consumer（dsh-tool-image）

`generate_image` 工具：参数 `prompt`（必填）、`reference_paths`（可选数组，最多 8，受 Provider 配置限制）。执行经 `ctx.larkScopeIndex` 从 `exec.agent` 解析 Scope，并把 session header 的 cwd 作为 Web 工作区传给 Provider；无 cwd 时由 Provider 使用飞书 Scope fallback。成功渲染产物路径 + 字节数。工具描述与系统提示段声明：主图放第一、用“图1/图2”编号引用、先确认角色映射、参考图与生成物可作为 canonical reference 跨轮复用，且文件必须位于本次会话工作区。

## 6 安全与信任

- 参考图路径包含校验在工作区内（realpath 后必须以工作区为前缀；拒绝 symlink 指向外部；Windows 与 POSIX 分隔符统一后比较）。
- 生成物是模型产物不是用户数据；写入工作区即受 R-06 收集与 30 MiB 上限约束。
- 密钥只经凭证引用；不落日志/事件/卡片。

## 7 测试契约

`unit`：路由选择（有/无参考图）、声明/实际响应预算、PNG 魔数与 30 MiB 解码上限、参考图越界路径拒绝（含 Windows 合法路径）、multipart 与 JSON 请求体形态（mock fetch）、脱敏、默认/自定义/非法 `maxReferences`；工具层：Scope 解析、Web cwd 透传、飞书 Scope fallback、配置根越界拒绝、输出渲染与编号化提示。

## 8 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/generate-image/src/generate-image.ts` | 平移（路由/魔数/脱敏/edits multipart） |
| `config.ts` | 平移为凭证引用 Config（IMAGE_* env 改引用名） |
| `validation.ts` | 平移（工作区包含 + symlink 拒绝 + 上限） |
| `prompt.ts` buildEditPrompt | 平移（参考图命名注入提示） |
| 输出 `artifacts/` 子目录 | 改为工作区顶层单文件（每图独立 📎 产物行，UX 更明确） |

## 9 行为变化

脚本技能（stdin JSON CLI）→ 插件能力缝 + 模型工具；输出目录结构调整（见 §8）；MIMO/XIAOMI 语音系键不消费（语音收发需飞书音频消息面，当前入口无音频载荷——留待立项）。
