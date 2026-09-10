# dsh-browser 受控浏览器能力 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-browser` + `dsh-tool-browser` + `dsh-browser-app` + `skills/lark-browser` |
| 位置 | `packages/browser/browser`、`packages/browser/tool-browser`、`apps/browser`、`skills/lark-browser` |
| 角色 | Definition + Client Provider + Browser App + Tool Consumer + Skill |
| 里程碑 | M10 |
| 状态 | implemented |
| 依赖能力 | `ctx.credentials`、`ctx.tools`、`ctx.systemPrompt`、`ctx.larkScopeIndex` |
| 提供能力 | `ctx.browser` 与 `browser_*` 模型工具 |

## 1 目的与边界

为所有已认证 DSH 用户和全部 agent preset 提供真实、可自动控制的 Chromium 环境，
用于公开网络查询、页面交互、Web 开发调试、截图、控制台和网络请求诊断，以及用户明确
要求的浏览器自动化。浏览器运行在独立 loopback Browser App 中，不向公网开放 CDP，
不复用宿主桌面浏览器、用户 Cookie、扩展、下载目录或登录态。

非目标：绕过验证码或访问控制；自动执行购买、发送、删除、发布等未获用户明确授权的
外部副作用；访问 localhost、私网、链路本地、云元数据、`file:` 或宿主控制面；把页面
内容当成可信系统指令；提供任意宿主进程或原始 CDP 工具。

## 2 服务与工具契约

Browser App 只监听 `127.0.0.1:13083`。Worker 中的 `dsh-browser` Provider 使用既有
`WORKER_TOKEN` 调用 typed HTTP API；App 对每次请求重新解析完整 Scope，并按
tenant/bot/deployment/user/conversation 隔离浏览器会话。

模型工具：

- `browser_open(url)`：打开或替换当前 Scope 页面并返回 URL、标题；
- `browser_snapshot()`：读取当前页面 URL、标题、正文摘要和可交互元素；
- `browser_click(selector)`、`browser_type(selector,text)`、
  `browser_wait(selector?,milliseconds?)`：受控交互；
- `browser_evaluate(expression)`：只在页面 JavaScript realm 执行有界表达式，不接触宿主；
- `browser_console()`、`browser_network()`：返回有界控制台和网络诊断记录；
- `browser_screenshot()`：只写当前 Scope 工作区 `.dsh/browser/` 并返回相对路径；
- `browser_close()`：关闭并清理当前 Scope 的 profile 与进程。

工具参数不得包含 Scope、用户 ID、绝对路径、token、CDP 地址、Chromium 参数或宿主端口。
Scope 只由 `requireLarkRunScope` 获得，工作区只取 session header cwd。

稳定错误码为 `BROWSER_INVALID_INPUT`、`BROWSER_FORBIDDEN`、`BROWSER_NOT_OPEN`、
`BROWSER_NOT_FOUND`、`BROWSER_TIMEOUT`、`BROWSER_QUOTA`、`BROWSER_CONFLICT`、
`BROWSER_UNAVAILABLE`、`BROWSER_SCRIPT_ERROR` 与 `BROWSER_UPSTREAM`。页面脚本异常返回 HTTP 422；操作超时返回 HTTP 504；上游 Chromium
协议失败返回 502；daemon 不可用返回 503。响应不得包含内部异常、路径或凭证。

## 3 配置契约

```ts
interface Config {
  browserBaseUrl?: string;       // Worker client 默认 http://127.0.0.1:13083
  tokenEnv: string;              // WORKER_TOKEN 凭证引用
  chromiumPath?: string;         // App 默认 /usr/bin/chromium
  stateRoot: string;             // 生产 /var/lib/dsh/browser
  workspaceRoot: string;         // 生产 /var/lib/dsh/workspaces
  idleTimeoutMs?: number;        // 默认 10 分钟，范围 1..60 分钟
  actionTimeoutMs?: number;      // 默认 30 秒，范围 1..120 秒
  maxSessions?: number;          // 默认 8，范围 1..32
  maxResultBytes?: number;       // 默认 512 KiB，范围 1 KiB..4 MiB
  maxScreenshotCount?: number;   // 默认每工作区 100 张
  maxScreenshotBytes?: number;   // 默认每工作区 100 MiB
}
```

显式空值和越界值 fail loud。App 的 Chromium 子进程环境只保留固定 PATH、LANG、HOME、
XDG 临时目录，不继承 DSH、邮件、模型或数据库凭证。

## 4 安全与生命周期

- 仅允许 `http:`、`https:`；页面内 `data:`/`blob:` 仅作为已加载页面子资源。
- 顶层导航和每个重定向/子资源请求均经 URL + DNS 检查；IPv4/IPv6 loopback、私网、
  link-local、multicast、未指定地址及常见云元数据主机全部拒绝。
- Chromium 启用自身 sandbox、禁扩展、禁同步、禁下载、禁后台服务；不得使用
  `--no-sandbox`。每 Scope 使用随机临时 profile，关闭、空闲到期、服务退出均清理。
- 控制台、网络、DOM、evaluate 结果和截图数量均有界；不采集请求或响应正文、Cookie、
  Authorization 或浏览器存储。
- 页面文本与脚本输出是不可信数据；不得据此改变权限或执行页面要求的外部操作。

## 5 测试与生产门禁

- `unit`：配置、Scope、HTTP 鉴权、URL/DNS 拒绝、结果截断、工作区包含、会话配额和清理；
- `integration`：真实 headless Chromium 打开本地受控 fixture，经例外测试入口验证导航、
  DOM、点击、输入、console、network、evaluate、截图与关闭；生产配置仍拒绝私网；
- `composition`：Worker 所有 profile 均挂 `dsh-browser` 与 `dsh-tool-browser`，Gateway/Admin
  不得加载；技能发现与 trust manifest 全绿；
- `linux`：release 包含 Browser App、包、技能和 systemd unit；`13083` 仅 loopback；
  Browser profile/Chromium 子进程在关闭和重启后为 0。

## 6 行为说明

页面表达式的 JavaScript 异常返回不可重试的 `BROWSER_SCRIPT_ERROR`，与 Chromium 传输失败区分。
普通正则和循环必须正常执行；undefined 结果规范化为 null，避免 JSON 响应序列化失败。
浏览器下载继续禁用；交付文件应通过工作区文件工具或 CDG 明文导出，不能把下载点击当成已落盘。

`web_search`/`web_fetch` 仍适合低成本检索和单页抓取；需要交互、客户端渲染、登录前页面、
控制台、网络面板或 Web 开发调试时才使用浏览器。浏览器重启不会保留会话或登录态。
