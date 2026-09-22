# dsh-TUI 本机与云端工作区

TUI 与 Web、Windows Desktop、Feishu 属于同一个 MewClaw。产品与共享策略以 Web 为基线，运行时契约跟随 DSH 官方上游；统一能力归属与优化顺序见[统一架构](mewclaw-architecture.md)。

## 本机工作区（2026-09-23）

使用本轮 TUI 候选包，启动 `dsh-tui "D:\项目\我的工程"`，或在主界面执行
`/workspace open <本机目录>`。`/connect https://chat.rwr.ink` 登录后退出远程菜单，
在主界面 `/model` 选择「MewClaw 云端账号」，普通聊天即可使用本机文件工具。
账号模型使用 `/auth/desktop-inference`；Agent、文件工具和持久化在本机运行。
本机目录不发送给云端 `workspace/create`，不依赖旧 `/desktop-workspace` 桥接。

云端会话继续由 `/connect` 的远程菜单管理。下面的旧桥接章节只描述云端会话
借用本机工具的另一路能力，不是本机工作区的前置条件。候选安装、验证与
Windows 边界见 [本轮验收](client-local-workspaces.md)。

## 旧远程桥接适配

MewClaw 共享主线提供可供 TUI adapter 消费的远程客户端包：`dsh-lark-tui-remote`。
云端保存登录态、额度、模型目录、会话和工作区登记；TUI 只在本机执行被
授权的文件操作，因此换电脑时不需要把云端工作区文件复制到 TUI 的会话目录。

## 共享客户端开发

当前 MewClaw TUI 使用 [AiharaMahiru/dsh-TUI](https://github.com/AiharaMahiru/dsh-TUI) 的源码构建。其 adapter 直接导入 `src/dsh-adapter/remote/index.ts`，该目录保存本仓库 `packages/lark/tui-remote/src` 的 11 个共享源码副本；截至 2026-09-23 字节一致，但尚无跨仓库同步门禁。`account-model.ts`、`account-inference.ts` 和 `local-files.ts` 是 TUI 专属扩展。下面的包依赖示例供共享客户端开发，不是当前 fork 的实际绑定方式。

上游 TUI（当前缓存验证提交 `8e1931e7bbd376dc8838d74f2fe24f052012542c`，版本
`0.10.2`）仍按上游方式安装；此命令不会安装 MewClaw fork 的新增能力：

```bash
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
dsh-tui version
```

远程适配包目前随本仓库构建，尚未发布到 npm。开发/验收机可从共享主线构建：

```bash
git clone --recurse-submodules --branch master https://github.com/AiharaMahiru/MewClaw.git dsh-web
cd dsh-web
pnpm install --frozen-lockfile
pnpm --filter dsh-lark-tui-remote build
```

后续可将 `packages/lark/tui-remote` 的构建产物作为 TUI 适配器依赖；迁移前先验证包导出、独立安装与官方 adapter 边界，再替代现有副本。构建产物不等于已经部署，也不要求把共享包发布到官方 npm 作用域。

## 最小挂载示例

下面的代码应放在 dsh-TUI 的 adapter 层，而不是 screens/UI 层。密码只在
登录调用栈中存在；客户端落盘的 `remote-session.json` 只含当前 origin 的
会话 Cookie，文件权限为 0600。

```ts
import WebSocket from 'ws'
import { DshTuiRemoteClient } from 'dsh-lark-tui-remote'

const endpoint = process.env.DSH_TUI_REMOTE_ENDPOINT
if (!endpoint) throw new Error('请设置 DSH_TUI_REMOTE_ENDPOINT')

const client = new DshTuiRemoteClient({
  endpoint,
  // 生产 endpoint 使用 HTTPS；HTTP 仅允许 loopback，不能把此开关带到公网。
  websocketFactory: (url, { headers }) => new WebSocket(url, { headers }),
})

const remote = client.createTuiAdapter()
const user = await client.restore() ?? await client.login(
  await tui.prompt('邮箱'),
  await tui.password('密码'),
)
const capabilities = await remote.capabilities()
const sessions = await remote.sessions.listSessions({ limit: 50 })
const models = await client.models()

// HostDescriptor.runtime.location = 'remote'
// HostDescriptor.runtime.remoteAttach = true
// 将 remote.workspace 挂到 dsh-TUI 的 Workspace Host Port。
```

`ws` 是 TUI 侧的 WebSocket 实现；适配器必须把 Cookie 和 Origin 交给
`websocketFactory` 的 `headers`，禁止把 session Cookie 拼到 URL 查询参数。

## 会话、模型和额度

- `client.login` 首先读取 `GET /` 获取 CSRF Cookie，再调用现有
  `POST /auth/login`；`GET /auth/me` 可用于启动时恢复。
- `client.models()` 读取现有 `GET /auth/models`，只返回脱敏的模型档案和共享模型。
  API Key 从不经过 TUI。
- 会话模型选择必须使用官方的 `{ provider, model, reasoningEffort? }` 结构：
  `client.selectModel(sessionId, { provider, model })`。只传一个旧式字符串时，
  客户端仅把第一个 `/` 前的片段当 provider；新接入应直接使用 `session/modelCatalog`
  返回的 provider/model，避免共享模型路由误判。
- `client.quota()` 读取用户范围的 `GET /api/billing/usage`。额度不足或计费
  代理不可用会转换成稳定错误码，不能用本地余额猜测放行。
- 模式目录和切换走官方 Remote：`agentPresets()`、`permissionPresets()`、
  `selectAgentPreset()`、`executeCommand()` 与 `selectMode()`。后两类模式通过
  `/permission <preset>`、`/plan [off]` 命令由 Worker 写入 durable session event；
  客户端不直接伪造 `sandbox/mode`、`approval/policy` 或 `permission/preset` 事件。
- `prompt()` 会生成官方 `requestId`，并发送 `{ sessionId, mode, content }`；不要再把
  旧版 `{ text }` 直接放在 request 顶层。`renameSession()`、`cancelSession()`、
  `selectModel()`、工作区 rename/delete 同样遵循官方嵌套 `request` 结构。
- `client.rpc()` 保留官方 `/api/<method>` 信封。`createSession` 和
  `createWorkspace` 始终使用 `payload.args.request`；不要改成顶层 `path`。

## 工作区本地化

```ts
const binding = await remote.workspace.bind(sessionId)
await remote.workspace.serve(sessionId, async (operation, signal) => {
  // 这里调用 TUI 自己的本机 FileSystem/Shell Host。
  return await localWorkspace.execute(operation, signal)
}, { autoRebind: true })
```

云端桥接动作只有 `status`、`bind`、`poll`、`result`、`unbind`、`sync`。
每次绑定使用新的 `generation`，云端 `revision` 用于乐观并发校验。轮询断线
时可以重新绑定；如果本机操作已经执行但 `result` 未确认，客户端会停止而不
重放该操作，避免重复写文件或运行 Shell。`sync` 的文件名必须是相对路径，
`..`、绝对路径和盘符路径会在 TUI 侧先拒绝，云端仍会再次执行归属校验。

## 安全边界与已知限制

- 默认只接受 HTTPS；Cookie 不进入日志、错误文本、URL 或 TUI 配置。默认文件
  存储不是系统钥匙串，桌面发行版可注入自己的 `CredentialStore`。
- 401 会清除本地会话并要求重新登录；403、CSRF、额度不足、资源归属和工作区
  revision 冲突都以稳定错误码返回。
- `/api/remote.mux` 流需要 TUI 提供带 Cookie 的 WebSocket 工厂。无 cursor 的
  流默认不自动重连，避免重复业务项；只有提供 `resumePayload` 时才建议开启
  `maxReconnects`。
- MewClaw fork 的 `/connect` 已接入云端会话、工作区和模式控制；普通聊天、转录与 `Shift+Tab` 仍由本机 Harness Channel 处理。共享远程 facade 不等于完整远程聊天界面。
- 云端 `workspace/create` 的 `path` 必须是服务端用户工作区根内的路径；本机目录
  不应直接上传。电脑本地根目录由 TUI Host 自己授权，再通过 `/desktop-workspace`
  的 bind/poll/result 桥接执行相对路径操作。
- 当前交付包含无密钥 HTTP/WS stub 契约测试，不等同于真实云端浏览器登录、
  模型调用或跨网络文件 E2E。真实验收仍需在明确授权后使用测试账户和测试额度。

## 回滚

停用账号推理前先结束或取消运行中的本地回合，再通过 `/connect` 退出登录或由维护者调整 TUI profile。保留已有会话日志和工作区；登录、退出与配置调整按对应宿主执行，不以删除用户数据代替停用。Git 分支同步不触发服务重启或生产切换。
