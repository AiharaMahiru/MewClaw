# dsh-lark bundles + apps SPEC（组合层与部署 bin）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-base`、`dsh-lark-worker`、`dsh-lark-gateway-bundle`（bundle 层）+ `apps/lark-gateway`、`apps/lark-worker` |
| 位置 | `packages/bundle/base`、`packages/bundle/worker`、`packages/bundle/gateway`、`apps/*` |
| 角色 | Bundle（cordis.patch.yml 层）+ App（启动 bin + 覆盖 cordis.yml） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；三个 bundle 与两个 app bin 已落地，组合校验测试 + 真模型 e2e 通过） |
| 关联 ADR | ADR-1, ADR-3, ADR-5 |
| 依赖能力 | `dsh-base`（框架 base 层）及全部组成包 |

## 1 目的与边界

把各插件按"平台强制层 → 部署层 → 会话层"组装成两个可部署进程。bundle 层是**声明式组合**，不含业务代码；apps 只做进程引导（启动、信号、健康、supervisor IPC 契约）。

非目标：任何能力实现；预设目录内容（M4 presets SPEC）。

## 2 服务契约

无（组合层）。

## 3 配置契约

bundle 层配置 = 所插入行的行级 config（各自归所有包）；apps 层：

```ts
interface AppConfig {  // 两个 app 各自的最小进程配置
  /** 日志级别。 */
  logLevel?: 'info' | 'warn' | 'error'
}
```

## 4 组合（M1 目标行集）

**平台强制层 `dsh-lark-base`**（在 dsh-base 之上插入，任何部署都带）：

- `dsh-lark-contracts` 依赖恒定在场（事件类型一致性）；
- 平台提示词政策段（persona/instructions 行，内容为平台安全与身份政策——ADR-5 的"不可覆盖层"）；
- 会话工作区根行（fs/sandbox policy 的 lark 默认）；
- M2 增：`dsh-skill-trust`、sandbox 策略行。

**worker 层**（`dsh-lark-worker`）：`dsh-lark-run` + `dsh-lark-cron` +（M3：`dsh-knowledge-postgres`、`dsh-memory-mem0`）+ profile 对应的 agent preset。执行隔离由 app overlay 显式选择：

lightweight 与 full 使用相同宿主 Provider 和 system-only preset roots，仅默认 preset 不同。Scope、认证、目录策略、审批和既有外部控制插件禁用配置保持不变；OCI 仍由容器 Provider 决定执行位置。

- `lightweight.overlay.yml`：保留历史 profile 入口，取消执行能力裁剪。默认 preset 为 lark-lightweight，公开 include 官方 standard，能力与 full 一致，且 includeUserRoot 为 false；不提供 OS 级沙箱。
- `full.overlay.yml`（可选）：保留宿主本机 subprocess、Shell、文件搜索、jobs、委派等官方执行组合，默认选择“飞书全功能模式”，并把 `lark-lightweight`、`lark-standard`、`liangshen`（全能优化模式）与官方 `standard`、`code`、`minimal`、`cordis` 加入 system-only roster；该 profile 不提供 OS 级 sandbox。
- `oci.overlay.yml`（可选）：以 `dsh-sandbox-oci` 替换本机 subprocess/sandbox；允许容器内 shell/编译，默认断网，并继续暴露同一七项 system-only roster；lightweight preset 的执行同样由容器 Provider 承载。

**网关层**（`dsh-lark-gateway-bundle`）：仅 `credentials`、`dsh-cdg-bridge`、`dsh-lark-run-client` 和 `dsh-lark-gateway/bot-fleet`。机器人由Auth账号配置驱动，在独立根装载lark/card/commands/gateway/ws；部署根不再启动默认机器人。**不含**任何工具行与 agent 栈行（硬边界）。

**apps**：

- `apps/lark-gateway`：从源码（tsx ESM 钩子）加载网关 cordis.yml；WS 连接状态作为健康信号（supervisor 判据）；IPC shutdown 契约（`shutdown` 消息 → 有序关停）。
- `apps/lark-worker`：加载 worker cordis.yml；只接受 supervisor/CLI 传入的显式 profile overlay；无主模型配置由 agent-default-model 行 fail loud。
- Windows supervisor：读取 `DSH_LARK_ISOLATION_PROFILE`（`lightweight | full | oci`，缺省 `full`），把对应 overlay 传给 worker；仅 OCI profile 启动并维护 Podman。`ADMIN_PORT` 与 `LARK_WORKER_PORT` 仅在未设置时取默认值；显式值必须是 `1..65535` 的规范十进制字符串，否则在创建子进程前失败。状态面公开 profile，不公开路径或密钥。

M1 实施记录（与草案的差异）：

1. **网关组合不挂 dsh-base**：dsh-base 行集含完整 agent/工具栈，网关若挂载即违反"网关无工具行"硬边界。网关 bundle 自含 `credentials` 和账号宿主行；平台强制层（hmr 禁用、平台 persona）只作用于 worker 部署。
2. **worker 开发端口 8788**：lark-claw 的 pi-worker 仍占用 8787（迁移期并存，原系统保持不动）；M5 交接时回归 8787 决策。
3. app bin 的组合装载 = 读自身 package.json 的 `dsh.profile.bundles` → 逐层 `loadOverlayPatches` → `boot()`（与 dsh CLI profile 语义一致，分发时可直接被 `dsh --profile` 装载）。

## 5 事件契约

无新增（组合层不产生事件）。

## 6 行为契约

- 网关组合缺失任何工具行；worker 组合缺失 lark 客户端行——由**组合校验测试**锁死（防误改回耦合）；
- 每层可独立加载（bundle 测试逐一挂载冒烟）；
- 两进程缺省单机部署（loopback 桥接）；跨主机部署必须配置 tokenEnv（与 lark-claw 语义一致）。
- 未知隔离 profile 启动失败；worker 绝不在没有 profile overlay 的情况下由 supervisor 启动。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 行缺失依赖（inject 服务无提供者） | 加载失败（fail loud） | 修正组合 |
| 无主模型配置 | worker 启动失败（fail loud） | 配置模型行 |
| 配置 schema 非法 | 加载失败并指名字段 | 修正配置 |
| 隔离 profile 非法 | supervisor 启动失败 | 设为 `lightweight`、`full` 或 `oci` |
| 健康端口显式为空、非规范或超出范围 | supervisor 在创建子进程前失败 | 设为 `1..65535` 的规范十进制值，或取消设置以使用默认值 |
| 执行工具被目录或审批策略拒绝 | 明确拒绝，不更换执行 Provider 绕过 | 按对应授权流程处理 |
| agent preset 声明的宿主依赖未激活 | 会话创建失败并列出 waiting 行 | 选择与 profile 匹配的 preset，不做静默降级 |

## 7 安全与信任

- 平台强制层不可被部署层覆盖（行 id 保留，preset 无法插入同名覆盖——由组合校验测试断言）；
- 本地开发：`.env`（自 lark-claw 复制、git-ignored、已授权）经 credentials 能力的项目 `.env` 回退读取；apps 不直接 `require('dotenv')` 读值。
- Linux 生产通过继承的 `DSH_PROJECT_ENV_DIR=/var/lib/dsh` 指定项目环境层；
  `loadLayeredEnv()` 仍负责解析与冻结来源，使 `.credentials.yaml` 的受管值优先于
  `/var/lib/dsh/.env` 默认值。Worker、Gateway、Admin 不得继承整份密钥环境文件，
  否则 `env` 层会压过 Models 页面写入的 `file` 层。

## 8 测试契约

- `unit`（组合校验）：网关组合无工具行 / worker 组合无 lark 行断言；
- `unit`：每 bundle 层独立加载冒烟；
- `security`：lightweight 保留完整执行能力与 permission 服务；OCI overlay 替换本机 subprocess/sandbox；账号与工作区拒绝测试不削弱；
- `integration`：lightweight preset 可挂载并创建会话；工作区选择与 `commands/list` 可用，工具目录与官方 standard 一致且受实际 Provider 约束；
- `unit`：supervisor profile → worker 参数与 Podman 生命周期选择；
- `unit`：Linux unit 只让 Auth 继承控制面密钥文件，四个 App 均固定生产项目环境目录；
- `e2e`：双进程本机部署端到端（M1 验收烟雾）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/main.ts` | 删除（→ cordis.yml + bin 引导） |
| `apps/pi-worker/src/main.ts` | 删除（→ cordis.yml + bin 引导） |
| `packages/service-runtime` | 平移 `infra/windows`（supervisor 子进程清单换新 bins） |
| `.env` | 复制为本地开发密钥源（git-ignored，已授权） |
| `.env.example` | 删除（变量名清单进入各包 Config） |

## 10 开放问题

1. 每次 DSH 升级都要对照官方 `standard` 复核 `lark-lightweight` 引用的官方 standard 及宿主依赖；
2. apps bin 的 source-launch 约定（tsx ESM 钩子）与 dsh CLI 启动器的差异验证（M0 spike）。
