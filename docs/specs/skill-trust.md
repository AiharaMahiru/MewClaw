# dsh-skill-trust SPEC（技能供应链预检）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-skill-trust` |
| 位置 | `packages/skill/skill-trust` |
| 角色 | Plugin（技能信任清单预检；fail closed） |
| 里程碑 | M2 |
| 状态 | implementing（M2 实施中；预检核心 + lark-run 挂点已落地） |
| 关联 ADR | ADR-11 |
| 依赖能力 | `ctx.skill`（技能注册表面）、`ctx.fs` |
| 提供能力 | 预检钩子 + 清单校验 + 能力声明核对 |

## 1 目的与边界

受审技能目录（`skills/*`）在会话资源加载前做供应链预检：目录 SHA-256 摘要、版本、能力声明（文件读写范围、网络目的地、密钥引用、子进程要求）与 `skills/trust-manifest.json` 逐项核对；新技能从官方兼容的 `metadata.dsh` 读取版本和能力，旧版顶层声明继续兼容；不匹配、双重声明、缺失、通配、逃逸或符号链接一律拒绝加载。

非目标：技能的内容审查（人工，产物是 manifest）；技能发现机制（DSH skill-filesystem 承担）；运行时能力执行（sandbox/sandboxPolicy 承担）。

## 2 服务契约

```ts
interface SkillTrust {
  /** 全量预检：返回通过/拒绝清单；拒绝 = 会话创建失败（fail closed）。 */
  preflight(): Promise<TrustReport>
}
```

钩子位置：会话创建前（lark-run 的 session 创建路径挂 preflight）；M0 spike 确认 DSH skill 生命周期中最小侵入的挂点。

## 3 配置契约

```ts
interface Config {
  /** manifest 路径（默认 <repo>/skills/trust-manifest.json）。 */
  manifestPath?: string
  /** 受检技能根（默认 <repo>/skills）。 */
  skillsRoot?: string
  /** 摘要算法固定 SHA-256（不可配，安全不变量）。 */
}
```

## 4 事件契约

发布：`skill-trust/result`（ignorable；仅技能名 + 通过/拒绝 + 拒绝原因码——不含摘要冲突详情）。
消费：无。

## 5 模型可见面

无。

## 6 行为契约

不变量：

- 缺失条目、摘要不符、版本不符、能力声明不符 = 拒绝（无"警告放行"档位）；
- 顶层 `version/capabilities` 与 `metadata.dsh` 不得并存，避免解析来源歧义；
- 通配路径、路径逃逸、符号链接 = 拒绝；
- preflight 失败 → 会话创建失败（`SESSION_CREATE_FAILED`，contracts 错误码）；清理路径照常执行（继承 lark-claw 教训：预检失败时沙箱清理仍要成功）。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 技能目录被改 | 预检拒绝，会话创建失败 | 复核后重算摘要并更新 manifest |
| manifest 缺失 | fail loud（启动或首次预检） | 生成 manifest |
| 摘要计算失败（IO） | 视为不通过 | 环境修复 |

## 7 安全与信任

- manifest 本身受版本控制，与技能目录同 PR 评审变更；
- 拒绝原因不泄露目录内容细节（防定向探测）。

## 8 测试契约

- `unit`：缺失/摘要不符/通配/逃逸/符号链接全部拒绝；通过用例；
- `unit`：官方 `metadata.dsh` 声明通过；顶层和嵌套双声明拒绝；
- `unit`：preflight 失败时清理路径执行断言；
- `security`：篡改任一字节 → 拒绝。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `packages/pi-runtime` 的 skill trust/preflight 逻辑 | 重写（DSH skill 生命周期挂点） |
| `skills/trust-manifest.json` | 平移（重算各技能摘要后更新） |
| Pi 的 `PI_SKILL_TRUST_MANIFEST` / `PI_SKILL_PATHS` 配置 | 删除（Config 化） |

## 10 开放问题

1. ~~DSH skill 生命周期中 preflight 的最小侵入挂点~~ **已解决（M2）**：挂点在 **lark-run 会话创建前**（executeRun 在 `agents.create/resume` 之前调用 `ctx.skillTrust.preflight()`，失败抛 `SESSION_CREATE_FAILED`；此时尚未创建任何资源，清理路径天然无残留）。worker bundle 挂载 `dsh-skill-trust` 行；lark-run 经可选服务注入（`ctx.skillTrust` 存在才预检）。
