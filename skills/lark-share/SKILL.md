---
name: lark-share
description: 将当前工作区中的 HTML、React/Vue 等前端项目或任意语言 HTTP API 通过受控 HTTPS share URL 临时公开，并管理分享生命周期。
whenToUse: 用户要求预览网页、远程测试开发中的 Web 项目、公开临时 API、生成可访问演示链接或撤销已有分享时。
version: "1"
capabilities:
  filesystem:
    - scope-workspace
  network:
    - chat.rwr.ink
---

# Web/API 临时分享（MewClaw）

## 创建前

- 所有代码必须位于当前 Scope 工作区。先确认项目的启动命令和容器内监听端口；服务必须在前台持续运行。
- 静态 HTML 可用 `python -m http.server <port> --bind 127.0.0.1 --directory <目录>`。
- Vite/React 开发服务使用 `vite --host 127.0.0.1 --port <port>`，并优先把 base 配置为相对路径或分享前缀兼容模式。
- Python、Node、Go、Rust、Java、.NET 等 API 应监听容器内 `127.0.0.1` 或 `0.0.0.0`，不得依赖宿主端口或外部数据库密钥。

## 创建与验证

- 调用 `share_web`，只传启动命令、容器端口和必要的 TTL；不要传绝对工作区、用户 ID、宿主 URL 或凭证。
- 创建后用返回的 HTTPS URL 做最小 HTTP 验证。页面项目检查入口与静态资源；API 检查一个无副作用端点；需要 HMR 时再检查 WebSocket。
- 明确告诉用户过期时间。分享是公开 capability URL，持有链接者均可访问，不得分享 `.env`、凭证、私有数据或管理接口。

## 管理

- 用 `share_list` 查看当前用户的有效分享。
- 用户要求停止、链接泄露或任务完成时，调用 `share_revoke`。撤销是立即且不可恢复的，但不删除工作区文件。
- 分享容器默认断网、资源受限且到期回收；不要声称它是长期生产托管、固定域名、数据库或持久后台任务。
