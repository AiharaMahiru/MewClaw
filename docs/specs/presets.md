# dsh-lark-presets SPEC（bot 模板目录化）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-presets`（Plugin，worker）+ `scripts/bot-new.mjs`（生成器）+ `presets/`（模板目录） |
| 位置 | `packages/lark/presets/`、`presets/` |
| 角色 | Plugin（模板装载/校验/运行面应用） |
| 里程碑 | M4 |
| 状态 | implementing |
| 关联 ADR | ADR-9（部署身份）/ ADR-7（供应链） |
| 依赖能力 | `ctx.skillTrust`（技能声明核对） |
| 提供能力 | `ctx.larkPresets` |

## 1 目的与边界

bot 模板目录化：**不改运行时源码即可新建机器人**——一个 preset 目录 = 一份部署模板（身份默认值/模型档位/工具面/技能清单/知识检索策略）。装载期校验（schema + 修订号 + 技能存在性）fail loud；运行期把模板应用到 agent（工具限制、知识策略）并记录模板修订与技能摘要到会话。

非目标：preset 的运行时热更新（重启生效——版本化修订以 git 为审计）；模型路由本身（agent-default-model 能力）；飞书面呈现（网关照常）。

## 2 契约

```ts
// presets/<name>/preset.json
interface Preset {
  /** 模板名（kebab-case，与目录名一致）。 */
  name: string
  /** 版本（语义化字符串）。 */
  version: string
  /** 修订号 = preset.json 内容的 SHA-256（bot:new/变更脚本维护；不符 = 装载拒绝）。 */
  revision: string
  /** 部署身份默认值（网关 Scope 引导的模板化来源；M4 先装载校验，M4 后半网关消费）。 */
  identity?: { tenantId?: string; botId?: string; deploymentId?: string }
  /** 模型档位（lark-run profile 语义）。 */
  profile?: "quick" | "standard" | "long"
  /** 工具面：deny 名单（worker 全局工具集内禁止；未知工具名 = 装载拒绝）。 */
  tools?: { deny?: string[] }
  /** 技能清单：必须存在于 skills/ 且 trust-manifest 有条目（否则装载拒绝——越权模板部署前失败）。 */
  skills?: string[]
  /** 知识检索策略：auto = 无摄入意图时预检检索（缺省）；off = 关闭。 */
  retrieval?: "auto" | "off"
  /** 人设（进入会话元数据；M4 后半接 system-prompt persona）。 */
  persona?: string
}

interface LarkPresets {
  /** 解析一个模板（存在且校验通过才返回；不存在返回 undefined——lark-run 回退默认）。 */
  resolve(name: string): Preset | undefined
  list(): Preset[]
}
```

## 3 配置契约

```ts
interface Config {
  /** 模板根目录（默认 presets）。 */
  presetsRoot: string
}
```

## 4 事件契约

发布（session 事件，contracts 声明并注册）：`lark/run/preset`
`{scope, preset: string, revision: string, version: string, skills: string[]}`——每次运行开头由 lark-run 写入（模型可见 ⟺ 已落盘：模板身份与技能摘要先于提示词）。

## 5 模型可见面

无直接工具面；模板的 deny/retrieval 影响模型可见工具集与预检行为（经 lark-run/agent 作用域应用）。

## 6 行为契约

- 装载：读 `presetsRoot/*/preset.json`；任一失败（JSON 非法/schema 非法/revision 与内容不符/skills 缺失或未在 trust-manifest/未知 deny 工具名）→ 该模板拒绝 + 告警，不阻止进程（默认模板必须存在——lark-run 配置的 presetId 在装载期校验存在，缺失 fail loud）；
- 运行：lark-run 在 agent setup 应用 `tools.deny`（agent 作用域 restrict）与 retrieval 策略；`lark/run/preset` 事件先落盘；
- 生成器：`node scripts/bot-new.mjs <name> [--template coding-assistant|knowledge-assistant]` → 从参考模板复制 + 改写 name + 计算 revision；已有同名模板拒绝（不覆盖）；
- 修订纪律：手工改 preset.json 后必须重算 revision（生成器 `--revision <name>` 子命令或手算）；不符即装载拒绝（fail closed）。

## 7 安全与信任

- 模板是供应链输入：revision 不符拒绝（篡改检测）；skills 引用必须与 trust-manifest 一致（越权模板部署前失败——ACL 语义：模板不能声明自己没有的技能）；
- deny 名单只做减法（模板不能授予新能力）；未知工具名拒绝（防拼写错误静默放行）；
- persona/模板内容不进密钥面。

## 8 测试契约

- `unit`：装载（合法/非法 JSON/未知键/revision 不符/未知技能/未知 deny 工具名/默认模板缺失 fail loud）；
- `unit`：resolve/list；生成器（创建/拒绝覆盖/revision 重算）；
- `unit`：lark-run 集成（deny 应用到 agent 作用域 restrict、`lark/run/preset` 事件先落盘、retrieval off 时不预检检索）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| 部署身份 env（BOT_ID/DEPLOYMENT_ID/技能目录） | 收敛为 preset 目录（identity 字段 M4 后半由网关消费） |
| `skills/*/agents/*.yaml`（各技能 agent 模板） | 参考模板 presets/coding-assistant、presets/knowledge-assistant 重写（DSH 能力缝工具面） |

行为变化：lark-claw 无独立 preset 机制（env + 技能目录隐式组合）→ 显式模板目录 + 修订号 + 装载校验；每次运行记录模板修订与技能摘要（M4 验收点）。

## 10 开放问题

1. preset identity 与网关 Scope 引导的接合点 → M4 后半（网关 bundle 消费 presets 的 identity 默认值）；本切片先装载校验与 worker 面应用；
2. persona → dsh system-prompt persona 的接线 → M4 后半（dsh-lark-base 的 persona 行目前固定 MewClaw）。
