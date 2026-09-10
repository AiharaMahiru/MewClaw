# 全能优化模式设计

## 状态

- 用户已确认：2026-08-19
- 任务形态：`single-full`

## 目标

将历史用户目录中的 Liangshen 两阶段 preset 纳入仓库的 system agent roster，展示为“全能优化模式”，使 full/OCI profile 的所有用户可选择六个模式：`lark-standard`、`standard`、`code`、`minimal`、`cordis` 和 `liangshen`。

## 设计决策

1. 保留内部 preset ID `liangshen`，只修改 `preset.yml` 的展示名与描述，保证已有持久化 session header 能继续恢复。
2. 将 `agent.cordis.yml`、`custom-bash.mjs`、`tool-bootstrap.mjs` 与 `NOTICE` 复制到 `packages/bundle/web/agent-presets/liangshen/`，由仓库 system root 分发；不再依赖用户目录扫描或启动同步。
3. full/OCI 继续 `includeUserRoot: false`，只扫描仓库 system roots；`lightweight` 仍只暴露 `lark-lightweight`，不把本机 Shell、PTY、jobs、subagent 和 workflow 能力带入轻量隔离 profile。
4. 保留第三方 `web-ui-liangshen` 插件行的 disabled policy；仓库 preset 已经提供选择能力，不额外启用会写用户目录的同步插件，避免重复挂载和供应链旁路。
5. 用户可见描述强调“压缩上下文、复用工具调用、减少冗余输出”，只表达优化目标，不宣称未经本仓库 benchmark 验证的固定分数。

## 用户文案

```yaml
name: 全能优化模式
description: 面向中大型工程任务的高效代理模式，优先压缩上下文、复用工具调用、减少冗余输出，在完整本机执行能力下兼顾更低 token 消耗与更稳定的 benchmark 表现。
order: 4
```

## 验收

- full/OCI 的可见 roster 包含六个 preset，用户目录 preset 不会污染列表。
- `liangshen` 旧 session ID 可按原 ID 恢复，新展示名为“全能优化模式”。
- lightweight roster、权限和执行隔离保持现状。
- roster 快照、metadata、文件供应链完整性测试先失败后通过；相关 typecheck、lint、build、brand、smoke 和 live roster 验证通过。
