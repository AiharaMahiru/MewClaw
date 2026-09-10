# dsh-sandbox-oci SPEC（OCI 沙箱 Provider）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-sandbox-oci` |
| 位置 | `packages/sandbox/oci` |
| 角色 | Provider（实现 DSH `sandbox` 能力；Podman rootless OCI） |
| 里程碑 | M2 |
| 状态 | implementing（M2 实施中；容器核心 + 接线 + 实机 Podman e2e（含断网断言）已通过） |
| 关联 ADR | ADR-6；[linux-production-runtime.md](linux-production-runtime.md) |
| 依赖能力 | `ctx.sandbox`（宿主能力）、`ctx.subprocess` |
| 提供能力 | 每 scope 一个非根 OCI 容器：读写根、降权、资源上限、单挂载、默认断网 |

## 1 目的与边界

worker 允许任意代码执行时的可选强隔离 profile：镜像由仓库 `infra/sandbox` 构建（Node/npm、uv/Python、.NET、Rust、Git、C/C++ 工具链），容器以非根运行，读根文件系统、删除能力、CPU/内存/PID/tmpfs 上限、仅挂载 scope 工作区、默认无网络。默认生产使用不提供任意代码执行的 lightweight profile；选择 OCI 时本包不提供不安全降级。

非目标：镜像内容治理（infra/sandbox）；策略判定（DSH `sandboxPolicy` 负责模式与根目录解析，本包只执行）；Windows ACL（DSH 既有 `sandbox-windows-acl`）。

## 2 服务契约

**M2 实证修正**：DSH `sandbox` 能力是**同世界进程禁锢**（`confine(argv, policy) → ConfinedArgv`，由调用方 spawn 包装后的 argv），不是容器供给 API；容器/微虚拟机执行在 DSH 架构里替换的是 **subprocess 能力缝**（`ctx.subprocess`，抽象 `SubprocessRuntime`——子类实现 `resolveExecutable`/`spawn`/`spawnTerminal`，子类作为插件行挂载即注册，与 dsh-subprocess-local 同模式；dsh-e2b POC 即"沙箱 + FS/subprocess 适配器"）。

因此本包双服务：

```ts
// 1) 容器执行（替换 ctx.subprocess 的本地实现）
class OciSubprocessRuntime extends SubprocessRuntime {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle   // podman exec（惰性 provision 容器）
  resolveExecutable(command, env?, signal?): Promise<string>
  // spawnTerminal 不支持（throw）
}
// 2) confine 透传（容器即边界；同世界包裹不再叠加）
class OciSandbox extends SandboxProvider {
  confine(argv, policy): ConfinedArgv  // { argv, enforcement: 'full', denialSignatures: [...] }
  // podman 不可用 → SandboxUnavailableError（fail closed）
}
```

M2 增量 1（已落地）：配置解析（latest 拒绝/网络默认 none/localInsecure 生产拒绝）与容器生命周期核心（安全参数、环境白名单、挂载校验、`rm --force --ignore` 清理不变量、配额注入点）。增量 2（已落地）：OciSubprocessRuntime（惰性 provision、podman exec 流管道、有界收集器 + spill、terminate SIGTERM→grace→SIGKILL、宿主打包 ripgrep 到容器路径的受限映射、spawnTerminal 明确拒绝）+ OciSandbox（confine 透传 full，podman 探活失败 SandboxUnavailableError）+ 双服务插件行（挂载前须禁用 dsh-base 的 subprocess/sandbox 行——见 `apps/lark-worker/oci.overlay.yml`，开发默认仍走 sandbox-local）。OCI 下需要持久 Bash 的 preset 使用独立的 pipe Consumer；它不宣称 PTY 能力，普通 Bash/文件搜索仍经 `ctx.subprocess.spawn()` 进入同一容器边界。容器 Bash 看到路径 `/workspace`，文件工具则必须使用官方 `dsh-tool-fs` 按会话 header 中的宿主 cwd 解析；禁止把容器绝对路径交给宿主文件工具。OCI overlay 为所有非完整提示 preset 注册独立系统段说明该差异；`minimal` 的完整 persona 重述同一规则。

## 3 配置契约

```ts
interface Config {
  /** 必填镜像名：固定非 latest 标签或 sha256 digest。 */
  image: string
  /** 必填工作区根：非空绝对路径。 */
  workspaceRoot: string
  /** Podman 可执行路径（默认 PATH 解析 'podman'）。 */
  podmanPath?: string
  /** 网络策略（默认 'none'；'bridge' 为显式开启）。 */
  network?: 'none' | 'bridge'
  /** 资源上限：CPU 为有限正数；其余为正安全整数。 */
  resources?: { cpus: number; memoryMiB: number; pids: number; tmpfsMiB: number }
  /** 每 quota 工作区上限：安全整数 1 byte..3 GiB，默认 3 GiB。 */
  storageLimitBytes?: number
  /** 本机开发逃逸开关；显式 true 在生产拒绝。 */
  localInsecure?: false
}
```

字段仅在 `undefined` 时使用默认。显式空路径、零值、负值、小数、`NaN`、无穷大或越界
quota 必须在插件装载期 fail loud，不能被 truthiness 静默替换。

## 4 事件契约

发布：`sandbox/provisioned` / `sandbox/disposed`（仅容器 id 与耗时，供清理审计）。
消费：无。

## 5 模型可见面

无直接工具（OCI profile 中普通工具经 DSH bash/fs Consumer 使用 sandbox 能力；`minimal`/`liangshen` 的持久 Bash 使用独立的 pipe Consumer；lightweight profile 不加载本包）。

## 6 行为契约

不变量（继承 lark-claw OCI 约束）：

- 每个 provision 的容器必须有显式清理路径：`podman rm --force --ignore <generated-name>`，**不经 shell**，`finally` 中执行；
- 命令以 `bash -c` 执行（登录 shell 会替换镜像 PATH，禁用）；
- DSH 打包的 `@vscode/ripgrep` 只能按包布局映射到镜像内 `/usr/bin/rg`；其他宿主绝对路径不得映射，避免把宿主文件系统路径带入容器；
- 本 Provider 的 `spawnTerminal` 继续 fail closed。OCI preset 不把 pipe 适配器伪装成 PTY；需要持久状态的 Bash Consumer 通过普通管道启动一个 Agent 所有的 Bash 进程，并在 Agent dispose 或超时时终止它；
- Windows 9P 挂载不支持 Unix 模式位：`DOTNET_CLI_HOME` 与 `NUGET_PACKAGES` 置于 bounded `/tmp` tmpfs，`UseAppHost=false`；
- provision 与命令执行的环境分离：前者只注入固定运行时与缓存变量；后者只透传 `NO_COLOR`、`TERM`、`PAGER`、`GIT_PAGER`。宿主路径、`DSH_*` 与任何密钥变量均不得进入容器；
- 失败路径不得残留容器（前后镜像-容器集合对比测试锁死）。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| Podman API 不可用 | provision fail loud（计数日志） | Windows supervisor 或 Linux systemd 在 Worker 前验证 rootless Podman |
| 镜像缺失 | fail loud（提示构建命令） | `pnpm sandbox:build` |
| 资源超限（OOM/PID） | 运行失败 + 明确错误码 | 任务重试或降档 |
| 清理失败 | 重试 + 审计日志；绝不静默 | 手动清理脚本 |
| 本地逃逸配置出现在生产 | 启动拒绝（fail closed） | 修正配置 |

## 7 安全与信任

- 容器 ID/名称是自生成随机值；工作区挂载路径规范化、防逃逸；
- 网络默认关闭是安全不变量，开启是显式配置动作；
- 日志不记挂载路径与命令参数内容（仅命令名）。
- Linux 生产由受限 `systemd` unit 以专用 `dsh` 用户运行 Worker；Podman 必须在同一用户上下文
  报告 rootless，镜像以 digest 固定。探活、用户 namespace 或镜像校验失败时不得降级到宿主
  `full` 执行。`ProtectHome=true` 会遮罩 `/run/user`，因此生产 unit 必须把宿主
  `/run/user/995` 精确 bind 到 `/var/lib/dsh/rootless-runtime`，并在该 alias 下完成
  `podman info` 与实际命令验证；具体部署门禁见
  [linux-production-runtime.md](linux-production-runtime.md)。

## 8 测试契约

- `unit`：配置校验（生产拒绝逃逸开关）、路径规范化；
- `e2e`（真实 Podman）：.NET 构建/运行于绑定挂载工作区；清理前留活后台进程 → 验证 `rm --force --ignore`；失败路径零残留（前后镜像-容器集合对比）；
- `security`：网络/降权/只读根/挂载范围，以及命令级环境变量拒绝透传断言。

## 9 迁移映射

OCI roster 必须设置 `includeShippedRoot: false` 并在显式 roots 最后保留官方目录。
新版内置目录默认优先于自定义 roots，否则同名 minimal 会错误加载 PTY 实现而非 OCI 管道实现。
必须验证实际 roster.resolve 的文件路径，不能仅测试 YAML 中列出了 OCI 目录。

| lark-claw 来源 | 处置 |
| --- | --- |
| `packages/sandbox/src/oci-sandbox-provider.ts` | 复用（容器生命周期核心） |
| `packages/sandbox/src/sandbox-config.ts` / `user-workspace-quota.ts` | 复用（配置/配额语义） |
| `packages/sandbox-mcp`（镜像与烟雾脚本） | 平移 `infra/sandbox`；MCP 适配器删除 |
| `apps/pi-worker/src/sandbox-runtime.ts` | 删除（DSH sandbox 能力取代） |

## 10 开放问题

1. ~~DSH sandbox 能力 provider 的精确接口与 sandboxPolicy 解析约定~~ **已解决（M2 实证）**：见 §2 修正——confine 透传 + subprocess 容器 provider 双服务；sandboxPolicy 由 dsh `sandbox-policy` 行解析（mode/workspaceRoot），本包只消费 policy.workspaceRoot 做挂载校验。
2. 多容器并行上限与每用户配额在能力层还是本包配置层（阻塞 M2）：倾向本包配置层（resources + 每 quota 存储上限），能力层不引入配额概念。
