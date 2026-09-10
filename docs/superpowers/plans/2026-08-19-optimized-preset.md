# 全能优化模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将历史 Liangshen 两阶段 preset 纳入仓库 system root，改为“全能优化模式”，并让 full/OCI 用户看到六项可选模式。

**Architecture:** 保留 `liangshen` 内部 ID以兼容旧 session；复制 preset 运行文件到 `dsh-lark-web-bundle/agent-presets`，让 full/OCI 的 system roots 直接发现它。lightweight 继续使用独立 root，不引入执行能力。

**Tech Stack:** Cordis YAML composition、Node ESM preset helpers、Vitest、pnpm workspace。

---

### Task 1: 建立失败回归测试

**Files:**
- Modify: `tests/dsh-web-composition.test.ts`
- Test: `tests/dsh-web-composition.test.ts`

- [x] **Step 1: 更新 full roster 断言**
  将 full roster 测试改为要求仓库 `agent-presets/liangshen/agent.cordis.yml` 和 `preset.yml` 存在，并要求 metadata 包含“全能优化模式”、不包含“梁神模式”。

- [x] **Step 2: 更新 policy 断言**
  将 full overlay 的 `web-ui-liangshen` 断言改为：第三方行仍 disabled，但 system preset 文件存在；同时增加 roster 六项的明确快照断言。

- [x] **Step 3: 运行测试并确认 RED**
  运行 `pnpm exec vitest run --maxWorkers=1 tests/dsh-web-composition.test.ts`，预期因仓库缺少 `agent-presets/liangshen` 且 metadata 仍为旧内容而失败。

### Task 2: 迁移 preset 与用户文案

**Files:**
- Create: `packages/bundle/web/agent-presets/liangshen/agent.cordis.yml`
- Create: `packages/bundle/web/agent-presets/liangshen/custom-bash.mjs`
- Create: `packages/bundle/web/agent-presets/liangshen/tool-bootstrap.mjs`
- Create: `packages/bundle/web/agent-presets/liangshen/NOTICE`
- Create: `packages/bundle/web/agent-presets/liangshen/preset.yml`

- [x] **Step 1: 复制经过审阅的运行文件**
  从当前已安装的 `@linxin666/dsh-liangshen` 包复制上游 preset 文件，保留两阶段锚定、Windows Git Bash 回退、plan/compaction/delegation 组合，不改变工具能力。

- [x] **Step 2: 更新 metadata**
  只修改 `preset.yml` 的 `name` 与 `description`，保持 `order: 4` 和目录 ID `liangshen`。

- [x] **Step 3: 保持系统 root 供应链**
  确认 `packages/bundle/web/package.json` 的 `files` 已包含 `agent-presets`，full/OCI roots 无需扫描用户目录。

### Task 3: Green 验证与隔离回归

**Files:**
- Modify: `.codex-tasks/20260819-dsh-optimized-preset/TODO.csv`
- Modify: `.codex-tasks/20260819-dsh-optimized-preset/PROGRESS.md`
- Create: `docs/evidence/optimized-preset-20260819.md`

- [x] **Step 1: 运行 roster 回归**
  运行 `pnpm exec vitest run --maxWorkers=1 tests/dsh-web-composition.test.ts tests/composition.test.ts`，预期全部通过。

- [x] **Step 2: 运行工程门禁**
  依次运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm verify:dsh-brand`、`pnpm smoke` 和 `git diff --check`。

- [x] **Step 3: 检查 live roster**
  在 full/OCI profile 中确认六项可选；在 lightweight 中确认仍只有轻量模式；确认列表没有用户目录路径和重复 Liangshen 行。

- [x] **Step 4: 归档证据并收口**
  记录文件摘要、测试结果、live roster 和浏览器选择结果，更新 CSV/PROGRESS 为完成。
