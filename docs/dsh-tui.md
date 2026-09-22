# dsh-TUI 远程工作区

本分支 `feat/dsh-tui-remote-workspace` 为当前 dsh Web 增加了一个可供
`ccch1mneyyy/dsh-TUI` 挂载的远程客户端包：`dsh-lark-tui-remote`。
云端保存登录态、额度、模型目录、会话和工作区登记；TUI 只在本机执行被
授权的文件操作，因此换电脑时不需要把云端工作区文件复制到 TUI 的会话目录。

## 安装

上游 TUI（当前缓存验证提交 `8e1931e7bbd376dc8838d74f2fe24f052012542c`，版本
`0.10.2`）仍按上游方式安装：

```bash
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
dsh-tui version
```

远程适配包目前随本仓库构建，尚未发布到 npm。开发/验收机可从本分支构建：

```bash
git clone https://github.com/AiharaMahiru/MewClaw.git dsh-web
cd dsh-web
git fetch origin feat/dsh-tui-remote-workspace
git switch --detach origin/feat/dsh-tui-remote-workspace
pnpm install --frozen-lockfile
pnpm --filter dsh-lark-tui-remote build
```

将 `packages/lark/tui-remote` 的构建产物作为 TUI 适配器依赖（或在
`dsh-TUI` 的 adapter 分支中以 workspace/link 方式接入）。生产发布前应由
发布者另行生成 npm 包并签名；本分支不改变线上 `/opt/dsh/current`。

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
- `client.quota()` 读取用户范围的 `GET /api/billing/usage`。额度不足或计费
  代理不可用会转换成稳定错误码，不能用本地余额猜测放行。
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
- 当前交付包含无密钥 HTTP/WS stub 契约测试，不等同于真实云端浏览器登录、
  模型调用或跨网络文件 E2E。真实验收仍需在明确授权后使用测试账户和测试额度。

## 回滚

本次改动只在 `feat/dsh-tui-remote-workspace`，没有重启服务、切换 release、
修改生产凭证或迁移用户会话。停用方式是从 TUI profile 移除该 adapter，并删除
本机 `remote-session.json`；云端现有 Web 登录和工作区数据不受影响。
