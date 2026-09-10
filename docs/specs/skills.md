# skills SPEC（M4 技能落地）

| 元数据 | 值 |
| --- | --- |
| 包 | 无新包——`skills/` 目录（SKILL.md 技能）+ 两个独立命名的 `dsh-skill-filesystem` Provider（dsh-base 与 Worker 受审根）+ `dsh-skill-trust`（供应链预检，M2 已上线）+ 清单生成器 `scripts/trust-manifest.mjs` |
| 位置 | `skills/<name>/SKILL.md`、`skills/trust-manifest.json` |
| 角色 | 技能（模型面能力指引，经 dsh-tool-skill 发现） |
| 里程碑 | M4 |
| 状态 | implementing |
| 关联 ADR | ADR-7（技能供应链） |
| 依赖能力 | dsh 技能栈（dsh-skill + skill-filesystem + tool-skill，dsh-base 已挂）；Worker 组合插入独立的受审技能 Provider |

## 1 目的与边界

把 lark-claw 的受审技能和 DSH 工作流指引迁移为 DSH 技能：`SKILL.md`（YAML frontmatter：name/description + DSH 信任 metadata + Markdown 指引体），经 `dsh-skill-filesystem` 发现、`dsh-tool-skill` 注入模型面。

当前受审技能为 `lark-rag`、`lark-web`、`lark-cron`、`lark-office`、`lark-research`、`lark-automation`、`lark-coding`、`lark-share`、`lark-browser` 与 `cdg-bridge`。通用 Skill 只编排已挂载工具，绝不创建隐藏执行面。`lark-cli` 和原脚本式 `cdg-bridge` 不迁移；CDG 只保留重写后的纯指引 Skill，并调用 Scope 受限的 `cdg_file`。

非目标：技能脚本执行语义（DSH 技能是纯指引体，执行靠能力缝工具——与 lark-claw 的脚本型技能不同，属行为变化）；bot 模板（presets SPEC，M4 后半）。

## 2 契约

- 技能目录 `<skillsRoot>/<kebab-name>/SKILL.md`；frontmatter 必须有 `name`（与目录名一致）与 `description`；新技能把 `version/capabilities` 放在官方兼容的 `metadata.dsh` 中，旧技能的顶层声明继续兼容，但两种位置同时出现时拒绝加载；
- 指引体只引用工作区内真实存在的能力（工具名/命令名与实际注册一致——不写"以后可能用"的能力）；
- 供应链：每个技能目录必须在 `skills/trust-manifest.json` 有 `{version, digest, capabilities}` 条目；`scripts/trust-manifest.mjs` 按 skill-trust 的摘要算法（相对路径排序、SHA-256(path+NUL+content)）生成/更新清单；预检失败即拒绝加载（M2 已上线，本 SPEC 只是把清单从空表变成逐技能核入）。

## 3 配置契约

worker 组合层：

```yaml
- insert:
    - id: lark-reviewed-skill-filesystem
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: dsh-lark-reviewed
        includeDefaultRoots: false
        bundledSkillDir: skills
```

（Worker 明确插入第二个 provider 实例。独立 provider 名用于与 dsh-base 和 agent preset
自带的 `filesystem` 项目技能 provider 合并，禁止同名 shadow 导致受审技能消失；
`bundledSkillDir` 让发布内只读技能绕过用户工作区 fs provider，摘要信任仍由 `dsh-skill-trust` 强制。）

## 4 事件契约

无新事件（技能发现/注入是 dsh 能力缝内部行为）。

## 5 模型可见面

dsh-tool-skill 把技能清单注入 system prompt；模型经 skill 工具读取完整指引体。技能指引体是模型可见内容——只写确定性事实（工具用法/平台语义），不写密钥、路径、用户数据。

## 6 行为契约

- 清单生成器是唯一更新入口（手工改 digest 会预检失败——fail closed 正是目的）；
- 技能变更流程：改 SKILL.md → 跑官方 Skill 校验器 → 跑生成器 → 提交（清单与内容同 commit，版本化修订由 git 承担）；
- 每次运行记录技能摘要：会话预检报告（skill-trust 的 TrustReport）在 lark-run 的会话元数据/日志中体现（M4 后半与 preset 修订一起落会话事件）。

## 7 安全与信任

- 技能是供应链输入（AGENTS.md 硬边界）：目录摘要 + 版本 + 能力声明预检失败即拒绝加载；通配/符号链接/路径逃逸拒绝（skill-trust 已实现）；
- 技能指引体不得诱导绕过沙箱或 ACL；不得含提示注入面（对用户消息只做语义指引，不回显）。

## 8 测试契约

- `unit`：生成器与 skill-trust 摘要算法一致（用生成器产物跑 preflightSkills 全绿）；改动任一技能文件后 preflight 拒绝；manifest 缺条目拒绝；
- `unit`：SKILL.md frontmatter 可被 skill-filesystem 解析（name/description 有效）。
- `integration`：管理员与普通用户的 `skill.list` 都能看到十个受审技能，真实会话调用
  `skill("lark-coding")` 成功；不得用同名 Provider shadow dsh-base 或 preset 项目技能根。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/rag/SKILL.md` | 改写为 `skills/lark-rag/SKILL.md`（工具面从 rag CLI 改为 knowledge_search + 附件摄入意图语义） |
| `skills/web/SKILL.md` | 改写为 `skills/lark-web/SKILL.md`（web_search/web_fetch） |
| `skills/cron/SKILL.md` | 改写为 `skills/lark-cron/SKILL.md`（自然语言创建走 cron 工具，确定性管理走 `/cron`） |
| DSH 办公协作 | `skills/lark-office/SKILL.md`（可选 `mail_recent` / `mail_read` / `mail_send`；草稿不发送，发送前需用户确认） |
| DSH 证据研究 | `skills/lark-research/SKILL.md`（`knowledge_search` 与 Firecrawl web 工具；区分内部与外部不可信证据并保留来源） |
| DSH 定时自动化 | `skills/lark-automation/SKILL.md`（仅用户明确要求时使用 `cron_schedule`；任务文本只引用已存在的工具） |
| DSH 编码协作 | `skills/lark-coding/SKILL.md`（Scope 工作区内 `read` / `write` / `edit`；默认 lightweight 不宣称 shell 或测试执行） |
| DSH Web/API 分享 | `skills/lark-share/SKILL.md`（当前 Scope 工作区经 `share_web` 创建临时 HTTPS 分享，并用 `share_list` / `share_revoke` 管理） |
| DSH 受控浏览器 | `skills/lark-browser/SKILL.md`（公开网页交互、Web 调试、Console/Network/截图与明确授权的自动化） |
| CDG 文件能力 | `skills/cdg-bridge/SKILL.md`（纯指引）+ `dsh-tool-cdg`（Scope 工作区受控工具） |
| `skills/lark-cli` / 原脚本式 `skills/cdg-bridge` | 不迁移；不得进入默认技能发现根或 preset |
| 技能脚本（rag cli / web cli 等） | 不迁移（能力进能力缝；DSH 技能无脚本执行面——行为变化） |
| `skills/trust-manifest.json`（M2 空清单） | 逐技能核入条目 |

行为变化：lark-claw 脚本型技能（技能 = 可执行脚本）→ DSH 指引型技能（技能 = 模型指引 + 能力缝工具执行）；供应链预检机制保留并加强（digest 核对从部署期校验改为每会话预检）。

工作流约束：办公邮件仅在 mail 工具已挂载时可用，研究以来源引用为交付，自动化只创建明确、可终止的会话重入任务；编码 Skill 在默认 profile 只提供安全的文本审阅与修改，不把未暴露的 shell、进程或代码执行能力写进模型指引。

## 10 开放问题

1. 会话级技能摘要事件（审计"每次运行记录技能摘要"的载体）→ 与 presets 一起收口。
