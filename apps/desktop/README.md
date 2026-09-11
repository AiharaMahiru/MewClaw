# MewClaw 桌面开发

当前发行候选版本为 `1.0.0`。左侧栏品牌下方提供云端/本地会话切换，本地 Harness、会话与文件工具在电脑运行；打开本地目录不依赖云端工作区桥接。切换有序重启 APP，两边历史分别保留。实际验收见 [验证记录](../../docs/evidence/desktop-local-harness-20260911.md)。

桌面和 Web 官方依赖统一为 `0.1.5-rc.1`。本地复用 Web 品牌插件及 main/rightbar 布局契约；冻结官方版本闭包以避免 npm 自动混入 rc.2。新增 Markdown/编辑器依赖为社区 Consumer 构建和测试使用，不通过修改官方包规避缺失依赖。

本地模式继续使用云端账号模型，当前仅支持账号私有默认模型，并需部署本轮 Auth Edge 推理接口；未部署时本地目录仍可打开，但模型推理不可用。原生目录选择只授权文件读写，本地模式禁止 Shell 和同步。退出、切换或重新登录后需重新选择目录。旧云端桥接说明见 [工作区配套说明](workspace-deployment.md)，本轮新契约及 Web 修改见 [HANDOFF](../../HANDOFF.md)。

## 分支与同步

- `master`：Web、共享插件与云端服务。
- `desktop`：从 `master` 派生的桌面集成及发行分支。
- Web 更新通过 `master → desktop` PR 同步，使用普通 merge commit，保留共同历史；不要对长期同步 PR squash 或反复 cherry-pick。
- 共享修复在基于 `master` 的短期分支提交，再同步至 `desktop`；不要整条桌面分支反向合并回 Web。
- 桌面专属代码位于 `apps/desktop/`，准备脚本为 `scripts/prepare-desktop-candidate.mjs`。云端桥接服务应独立进入 `master`，默认配置不得改变现有 Web 行为。
- Web 与桌面独立发版，桌面标签使用 `desktop-vX.Y.Z`；合并不代表允许自动上线。

本机 Web 工作目录为 `/opt/dsh/source`，桌面为 `/opt/dsh/desktop-source`。二者共享 Git 历史，但工作树和暂存区独立。候选、运行数据和凭证不提交。

## 底座与构建

复用 anywhere-labs/dsh-desktop，固定提交和社区消费方派生修改由准备脚本记录。官方 DSH 包不打补丁；不继承社区根补丁配置。

上游源码由 `upstream/dsh-desktop` Git 子模块关联，固定在 `a1ddcda8e701a8490c619ce411ea8a3d6daa1453`。克隆时使用 `--recurse-submodules`，或在已有仓库初始化如下。子模块保持原样，派生变换仅发生在新候选中。示例绝对路径需替换为本机路径，Windows 使用绝对盘符路径。

```sh
git submodule update --init --recursive
node scripts/prepare-desktop-candidate.mjs /absolute/MewClaw/upstream/dsh-desktop /absolute/new-candidate
cd /absolute/new-candidate
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node /absolute/MewClaw/apps/desktop/verify-workspace.mjs /absolute/new-candidate
```

需要 Node 24。安装生命周期默认关闭，Electron 下载及平台原生依赖必须另行审核处理；上述命令不是安装包构建流程。

准备脚本复制版本化的 `candidate.package-lock.json`，使用 `npm ci` 固定依赖；上游版本或依赖变更时，必须在隔离候选重新生成、审阅并更新此锁文件，不手工修改校验摘要。

## Windows 开发包

在独立候选目录执行（Node 24 / Windows x64）：

```sh
node node_modules/electron/install.js
node node_modules/electron-builder/cli.js --config electron-builder.cjs --win --x64 --publish never
node /absolute/MewClaw/apps/desktop/verify-package.mjs /absolute/new-candidate
```

本机本轮使用既有 `MewClaw-desktop-candidate`，为避开用户正在运行的旧 APP，构建命令追加 `--config.directories.output=release/desktop.6`，验包追加 `--release-dir=release/desktop.6`。无需另建候选目录。UI 冒烟入口：`node apps/desktop/local-ui-smoke.mjs <候选绝对路径> advanced --switch`，使用临时用户数据，不登录或请求真实模型。

Electron 安装器会校验固定版本的下载摘要；官方连接不可用时可对该命令设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。输出目录为候选下的 `release/`，包括当前用户安装程序 `*-Setup.exe`、便携启动器 `*-Portable.exe`、完整 ZIP，以及 `win-unpacked/MewClaw.exe`。`win-unpacked` 中的 EXE 必须与整个目录一起保留。

验证脚本检查 MewClaw 启动入口、官方运行时打包前后字节一致性、真实 Electron 的 DSH/pnpm/原生依赖和无头 CLI，最后打印产物 SHA-256。全部采用无凭证临时 DSH_HOME，不执行真实云端会话。开发包不包含代码签名。

上游升级须单独 PR：评审新提交，同步调整准备脚本的固定 revision，重跑兼容与完整性门禁，最后提交子模块指针。不要用 `git submodule update --remote` 自动追踪最新版本；GitHub 源码 ZIP 不含子模块内容。

同步 PR 门禁：构建、桌面插件测试、官方依赖完整性、登录与会话同步、本地工作区授权和断线测试。Windows 产物构建与 Windows 实机验收分别报告；门禁尚未全部完成，不得发布为正式 APP。
