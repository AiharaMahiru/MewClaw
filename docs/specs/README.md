# SPEC 索引

每个包 / 能力缝 / 部署组合的契约文档。格式与质量门槛见 [../spec-standard.md](../spec-standard.md)；状态机语义以该文件为准。

| SPEC | 包 | 角色 | 里程碑 | 状态 |
| --- | --- | --- | --- | --- |
| [desktop-app.md](desktop-app.md) | 桌面发行组合 | App / Bundle | Desktop 1 | implementing |
| [desktop-workspace.md](desktop-workspace.md) | 桌面本地工作区 | Definition / Provider / Consumer | Desktop 1 | implementing |
| [contracts.md](contracts.md) | `dsh-lark-contracts` | Contracts | M1 | implemented |
| [lark.md](lark.md) | `dsh-lark` | Definition + Provider | M1 | implemented |
| [lark-ws.md](lark-ws.md) | `dsh-lark-ws` | Plugin（长连接入口） | M1 | implemented |
| [lark-gateway.md](lark-gateway.md) | `dsh-lark-gateway` | Plugin（宿主面核心） | M1 | implemented |
| [lark-card.md](lark-card.md) | `dsh-lark-card` | Plugin（渲染） | M1 | implemented |
| [lark-approval.md](lark-approval.md) | `dsh-lark-approval` | Provider（userQuestions） | M1 | implemented |
| [lark-commands.md](lark-commands.md) | `dsh-lark-commands` | Plugin（命令注册表） | M1 | implemented |
| [lark-run.md](lark-run.md) | `dsh-lark-run` | Plugin（执行面核心） | M1 | implemented |
| [lark-run-client.md](lark-run-client.md) | `dsh-lark-run-client` | Consumer（桥接客户端） | M1 | implemented |
| [session-directory.md](session-directory.md) | `dsh-lark-session-directory` | Definition + Provider（跨表面会话授权目录） | M6 | implemented |
| [bundles.md](bundles.md) | `dsh-lark-base` / worker / gateway bundle + apps | Bundle + App | M1 | implemented |
| [knowledge.md](knowledge.md) | `dsh-knowledge`(+postgres+tool) | 能力缝 | M3 | implemented |
| [uploads.md](uploads.md) | `dsh-lark-uploads`（+gateway 附件落盘） | Plugin（运行前预检） | M3 | implemented |
| [cdg-bridge.md](cdg-bridge.md) | `dsh-cdg-bridge` | Plugin（加密附件桥接） | M3 | implemented |
| [web-firecrawl.md](web-firecrawl.md) | `dsh-web-firecrawl` | Provider（web） | M4 | implemented |
| [skills.md](skills.md) | skills/*（lark-rag/lark-web）+ trust-manifest 核入 | 技能 | M4 | implemented |
| [presets.md](presets.md) | `dsh-lark-presets` + presets/ + bot:new | Plugin + 模板 | M4 | implemented |
| [cron.md](cron.md) | `dsh-lark-cron`(+tool) | 能力缝 | M2 | implemented |
| [sandbox-oci.md](sandbox-oci.md) | `dsh-sandbox-oci` | Provider（subprocess 容器 + confine 透传） | M2 | implemented |
| [memory.md](memory.md) | `dsh-memory`(+mem0) | 能力缝（默认启用，可显式关闭） | M4 | implemented |
| [webui.md](webui.md) | `@deepseek-ai/dsh-web-app` + `dsh-lark-web-bundle`；管理面为 `dsh-lark-admin` + admin-web | 官方 dsh Web 聊天面 + 独立管理控制面 | M6 | implemented |
| [auth.md](auth.md) | `dsh-lark-auth` + `dsh-lark-auth-edge` + `apps/auth` | 多用户认证、邮箱/飞书身份、代理授权边界 | M7 | implemented |
| [billing.md](billing.md) | `dsh-lark-billing` | 模型计费、额度与用量分析能力缝 | M7 | implemented |
| [preview.md](preview.md) | `dsh-preview` + `dsh-tool-preview` + `skills/lark-share` | 公共 Web/API 分享能力缝 | M9 | implemented |
| [browser.md](browser.md) | `dsh-browser` + `dsh-tool-browser` + `skills/lark-browser` | 受控 Chromium 浏览器能力缝 | M10 | implemented |
| [canonical-user.md](canonical-user.md) | `dsh-canonical-user` | Definition + PostgreSQL/Memory Provider | M8 | implemented |
| [dooragent-migration.md](dooragent-migration.md) | `dsh-dooragent-migration` | Definition + Provider + Consumer + Plugin（一次性生产迁移） | M8 | implemented |
| [dooragent-associated-data.md](dooragent-associated-data.md) | `dsh-dooragent-migration` | 关联数据迁移阶段契约 | M8 | accepted |
| [linux-production-runtime.md](linux-production-runtime.md) | `dsh-linux-production-runtime` + 既有 DSH Apps | Debian 生产部署组合 + External PostgreSQL Provider + App Lifecycle | M8 | implemented |
| [image.md](image.md) | `dsh-lark-image` + `dsh-tool-image` | Definition + Provider + Consumer | M4 | implemented |
| [mail.md](mail.md) | `dsh-mail` + `dsh-mail-imap` + `dsh-tool-mail` | Definition + Provider + Consumer | M4 | implemented |
| [vision.md](vision.md) | `dsh-lark-vision` | Plugin（视觉路由） | M4 | implemented |
| [skill-trust.md](skill-trust.md) | `dsh-skill-trust` | Plugin（供应链预检） | M2 | implemented |
| — | `dsh-lark-members` | Tool Consumer | — | 不迁移；需要时重新立 SPEC |

## 维护规则

状态以对应包、组合测试和 evidence 为准；实现行为变化必须同一变更更新 SPEC。历史里程碑证据保留原始结论，不反向改写。

## M0 确认点索引

各 SPEC 的开放问题是唯一 home，此处只做定位（已解决项标注结论出处）：

1. `ctx.agents` 动态会话 API 与 session 事件流读取面 → **已解决**：[lark-run.md §10-1](lark-run.md)，证据 docs/evidence/m0-dsh-api-surface.md
2. userInteraction provider 接口 → **已解决**：[lark-approval.md §10-1](lark-approval.md)（`userQuestions.registerProvider` 面确认；拓扑拆分记录于 §9）
3. scope→sessionId 持久映射载体 → **已解决**（确定性派生）：[lark-run.md §10-2](lark-run.md)、[lark-commands.md §10-1](lark-commands.md)
4. 嵌入能力载体 → [knowledge.md §10-1](knowledge.md)
5. sandbox 能力 provider 接口 → [sandbox-oci.md §10-1](sandbox-oci.md)
6. 技能生命周期预检挂点 → [skill-trust.md §10-1](skill-trust.md)
