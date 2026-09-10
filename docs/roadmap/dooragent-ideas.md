# DoorAgent 优点的 DSH/Cordis 开发清单

本清单不属于生产迁移依赖。每项实施前必须单独建立 SPEC，并按 Definition / Provider / Consumer 设计为 DSH 插件能力缝。

迁移过程中发现的 BUG、性能问题和必要重构不进入本路线图拖延处理：影响迁移正确性或安全性的立即修复，其余有证据的问题记录独立 SPEC 和优先级。

| 优先级 | DoorAgent 思路 | DSH 现状 | DSH/Cordis 落点 | 验收重点 |
| --- | --- | --- | --- | --- |
| P1 | 原生文件树、编辑器、Git diff、预览 | 已安装 better-sidebar，但可见性和集成曾不稳定 | 复用现有插件并补官方 Web slot、权限和构建契约 | 文件/Git/预览在浅深色和多用户 Scope 下可用 |
| P1 | 统一运行健康和 operator gate | DSH 已有多服务 health，但缺统一生产视图 | `health` Definition + 各服务 Provider + Admin Consumer | 状态必须与真实流量门禁一致，禁止虚假 ready |
| P1 | 余额、充值、ledger、usage 数据分析 | DSH 已有美元 token 计费与 Admin 页面 | 扩展 billing 能力缝和只读分析 Consumer | 金额守恒、幂等、官网定价版本化 |
| P1 | 可取消、具背压的流式调用 | DSH 有 NDJSON run bridge，但生产取消/重连证据仍分散 | 扩展 run contract 与 transport Provider，不建立第二套会话协议 | ACK 前重验 Scope；取消、断流和重放不重复提交 |
| P1 | Artifact stage/commit/rollback | DSH 已有上传和运行产物事件，缺跨进程统一提交状态 | `artifact` Definition + Workspace Provider + Web/Lark Consumer | 内容摘要、owner Scope、原子提交、失败清理和可追溯下载 |
| P2 | Program：可保存、复用的工作程序 | DSH 有 skills、cron 和 presets，缺统一编排对象 | `program` Definition/Provider/Consumer | 程序版本、Scope、审批、工具能力声明可审计 |
| P2 | Evolution：Dream/Distill 生命周期 | DSH 有记忆反馈和异步 scheduler | 独立 `evolution` 插件消费 session/memory 事件 | 默认关闭、预算受控、结果可回滚且不可自改权限 |
| P2 | 进程身份与交付 gate | DSH Linux Runtime 已有 systemd/manifest，缺统一 PID identity 与 release completion 报告 | 扩展 Linux Runtime audit，不把宿主进程伪装成 Cordis service | PID+creation identity、版本摘要、健康与恢复点必须一致 |
| P2 | 知识选择与本轮引用分离 | DSH 有 scoped knowledge 与引用事件 | 扩展 knowledge Consumer 的 selection/reference contract | 持久选择不被单轮引用污染，ACL 在查询内完成 |
| P2 | Rich content 规范化渲染 | DSH Web/Lark 各有渲染面，复杂工具结果缺共享中间表示 | `rich-content` 纯类型 Definition + 平台 Consumer | 有界输入、降级文本、浅深色、无脚本注入 |
| P2 | 音频输入和输出 | 飞书音频链路有限 | `audio` Definition + 转写/合成 Provider + Lark/Web Consumer | 多用户额度、附件上限、模型可见事件完整 |
| P2 | Project profile | DSH 有 Agent preset 和工作区 | 新增 project policy，不替代 execution preset | profile 与六个 full/OCI preset 正交组合 |
| P3 | Public Chat/分享会话 | 当前以私有用户和飞书会话为主 | 独立 share capability，默认关闭 | 脱敏、只读、撤销、过期和 Scope 防泄漏 |
| P3 | Qdrant 运维体验 | DSH 主知识路径是 PostgreSQL/pgvector | 仅在有明确性能收益时作为可选 Provider | ACL 必须查询内过滤，不能先取后滤 |

## 明确不复用

- DoorAgent 的 root 全能力执行模型。
- DoorAgent SQLite 用户 schema 和仅特定邮箱域规则。
- Pi JSONL 作为 DSH 原生 session 协议。
- UI profile 取代 DSH Agent preset/OCI roster 的设计。
- 未批准却仍接收生产流量的 operator gate 行为。
- DoorAgent 的 Docker socket 授权、root 进程监督器与非 systemd 生命周期。

## 排序原则

- P1 只包含能直接降低生产数据丢失、重复提交、不可观测或用户核心工作流风险的能力。
- P2 在现有 DSH 能力缝上增量实现，必须先证明官方插件或既有 Provider 无法满足。
- P3 默认不进入主运行组合；共享与可选向量 Provider 必须通过跨 Scope 拒绝测试后才能启用。
- 路线图不是迁移验收的替代项。除迁移正确性或安全性修复外，以上能力均不得阻塞 DoorAgent 退役。
