# dsh-cdg-bridge SPEC（CDG 加密附件桥接）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-cdg-bridge`（内部 Plugin）+ `dsh-tool-cdg`（模型面 Consumer） |
| 位置 | `packages/lark/cdg-bridge/`、`packages/lark/tool-cdg/`、`skills/cdg-bridge/` |
| 角色 | 内部附件桥接 Plugin（提供 `ctx.cdgBridge`）+ 受控模型工具 Consumer（提供 `cdg_file`） |
| 里程碑 | M3 |
| 状态 | implementing |
| 关联 ADR | ADR-4（网关保存时 inspect；worker 物化时 decrypt） |
| 依赖能力 | 外部可执行文件 `cdgbridge`（按平台分发，M5 进入受控目录） |
| 提供能力 | 内部 `ctx.cdgBridge`；Scope 受限的 `cdg_file` |

## 1 目的与边界

企业加密（CDG）附件的探测与解密桥接（lark-claw cdg-file-bridge 平移）：`inspect`（是否加密，网关保存时打 encryption 标记）+ `decrypt`（解密到指定路径，worker 物化时使用）。同时为明确的用户 CDG 文件请求提供受控 `cdg_file` 工具；工具只能在当前 Scope 工作区内执行，不能把它当作通用 CLI、MCP 或宿主命令入口。

非目标：CDG 格式本身（外部二进制）；跨平台分发实现（M5，按平台放入受控运行时目录）；MCP 服务端挂载（`doctor` 只能检查宿主已配置的项目状态，不把 MCP 暴露给模型）；任意宿主命令执行。

## 2 服务契约

```ts
interface CdgBridge {  // ctx.cdgBridge
  /** 探测文件是否 CDG 加密；未配置、调用失败或输出不可判定均拒绝。 */
  inspect(path: string): Promise<boolean>
  /** 解密到目标路径；桥接未配置 → 抛错（加密附件无法处理）。 */
  decrypt(source: string, destination: string): Promise<void>
}
```

## 3 配置契约

```ts
interface Config {
  /** cdgbridge 可执行文件绝对路径；缺省 = 桥接关闭（inspect/decrypt 均抛错）。 */
  command?: string
  /** 单次调用超时（默认 30s，1s..5min）。 */
  timeoutMs?: number
}
```

可执行文件约束：绝对路径（相对路径拒绝，防搜索路径注入）；存在性装载期校验（配置了但不存在 → fail loud）。
`command` 缺省表示显式关闭桥接；显式空白 command、零/负数/小数/不安全或超范围
timeout 均在装载期拒绝，绝不降级为无超时子进程。

## 4 事件契约

无（进程内同步能力；调用失败以异常传播给调用方语义）。

## 5 模型可见面

Worker 注册单个 `cdg_file` 工具，并通过受信 `skills/cdg-bridge/SKILL.md`
指导模型在用户提出 CDG、绿盾、亿赛通或 Esafenet 文件请求时直接调用。工具动作是
`inspect`、`read`、`decrypt_file`、`write`、`write_text`、`patch`、
`replace_text`、`grep`、`replace`、`encrypt_dir`、`decrypt_dir`、`doctor`、
`list`、`write_plaintext`、`append_text` 和 `embed_images`。
工具参数不包含用户、Scope、工作区根、密钥路径、CLI 路径或任意命令。

## 6 行为契约

- `write_text` 是显式加密，不代表工作区自动加密全部文本。普通交付使用 `write_plaintext` 或普通文件工具。
- `read` 先 inspect，明确为明文时直接进行有界读取；支持 `encoding=utf8/base64`，不再将 PNG 或解密副本误交给仅支持 CDG 的 CLI read。
- 单文件 `grep` 支持明文，通过受控临时CDG副本复用CLI搜索引擎；原文件不变。目录grep仍只搜索CDG，普通混合目录使用常规grep/Bash。
- `append_text` 对单文件追加文本，保留明文/密文状态，大小有界并校验原摘要；`patch` 仍只做等长覆盖。
- 单文件写入/解密支持 `overwrite` 作为 `no_clobber` 的反向别名；显式冲突拒绝。
- `list` 返回工作区相对条目，避免模型猜测宿主目录；`doctor` 的有效 JSON 非健康报告不再当成进程不可用。
- `embed_images(path, output_path)` 将明文或CDG HTML中带引号的本地 `img src` 图片内嵌为Data URL，交付不同路径的UTF-8明文副本；原照片和HTML保留，8MiB上限，真实图片不替换为插画。CSS/JS、srcset和远程资源不打包并明确报告限制。

- `inspect <path>`：执行 `inspect` 子命令，stdout 必须是 JSON `{isEncrypted: boolean}`；未配置、调用失败或解析失败均 fail closed，拒绝附件并记录不含路径的告警；
- `decrypt <source> --out <destination> --strict-output`：`read` 子命令，成功 = 目标文件存在；失败抛错（错误信息不含密钥/路径细节）；
- 子进程执行：`windowsHide`、超时 kill、stdout 有界收集；桥接未配置时的错误文案明确指向配置项。
- `cdg_file` 每次执行都要求有效的 `larkScopeIndex` 运行信封，并只从
  `exec.agent.session.header.cwd` 取得工作区；输入和输出同时做词法包含与
  `realpath`/父目录校验，拒绝绝对越界、`..` 和符号链接逃逸；
- 单文件解密默认 `--no-clobber --strict-output`，且源和目标必须不同；工具没有删除动作；
- 目录加解密和批量替换默认 `--dry-run`，文件数、替换数、读取量、输出量和执行时间有上限；
- `write_text`、`patch` 的临时明文使用 `0600` 临时目录，调用结束后强制清理；
  CLI 以参数数组执行，不经过 shell，返回信息只展示工作区相对路径并脱敏宿主运行时路径。

## 7 安全与信任

- 桥接二进制是供应链输入（M5 镜像审计项）：路径仅来自配置（受控目录），不来自消息/模型；
- 解密只作用于 .uploads 内、已通过 scope 归属 + 摘要校验的附件；目标路径由调用方（uploads 物化）做工作区包含校验；
- inspect 的结果只决定 encryption 标记，不作为任何授权依据。
- 模型工具不挂载原始 `cdgbridge-mcp`，不开放 `register`、`unregister`、
  `run`、`run_background` 或 `--key-file`；普通用户不能借 CDG 能力读取其他用户工作区。

## 8 测试契约

- `unit`：未配置时 inspect/decrypt 均拒绝；命令注入防护（参数数组化）；stdout JSON 解析失败 → 拒绝 + 告警；超时；成功解密路径；windowsHide 与 kill 参数（mock spawn）。
- `unit/integration`：`cdg_file` 拒绝缺失 Scope、路径越界和符号链接逃逸；
  `write_text → inspect → decrypt_file` 实机链路成功，原加密文件仍存在；技能信任、
  Worker/Gateway 组合、Linux full/OCI 启动门禁均通过。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/rag/src/cdg-file-bridge.ts` | 平移为插件（子命令/超时/JSON 解析保留；默认命令路径改为显式配置） |
| 原脚本式 `skills/cdg-bridge/` | 不迁移脚本和任意命令面；重写为受信纯指引 Skill，调用受控 `cdg_file` |
| `cdgbridge` / `cdgbridge-mcp` 二进制 | Linux 生产放入版本化受控运行时目录；模型只调用包装工具，不直接挂载 MCP |

行为变化：lark-claw 默认命令硬编码相对路径（dist 相对 skills/cdg-bridge）→ 显式绝对路径配置；探测不可用或不可判定时拒绝，绝不降级为明文。

## 10 开放问题

1. 后续平台升级仍需把 `cdgbridge` 与 `cdgbridge-mcp` 的版本、摘要和归档保留纳入 supervisor/runtime manifest；不得改为从 PATH 搜索。
