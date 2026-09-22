# MewClaw 桌面开发

当前发行候选版本为 `1.0.0`。侧栏底部使用 MEWCLAW 云端/本地分段控件；选择“本地”后，通过原有“选择工作区 → 添加工作区”浏览本机目录。没有单独的“打开本地目录”按钮。切换仅刷新当前页面，不重启 Electron，云端和本地历史分别保留。本轮结果见 [桌面与 Web 一致性验收](../../docs/client-local-workspaces.md)；TUI 交付仍见 [本机工作区验收](../../docs/dsh-tui.md)。

桌面与 Web 官方依赖统一为 `0.1.6-alpha.2`、Cordis `4.0.2`，Electron `44.0.0`。本地使用同源品牌、玻璃主题、模型位及思考强度滑条、账号中心、模式和第三方组件；候选准备复用 Web bundle 与 full overlay 的有效 UI 策略。模式菜单采用 Web 的筛选及名称，实际工具与会话继续由官方 preset 提供。首屏与插件实时更新使用同一组合，避免 HMR 撤销桌面插件。

本地 Harness、工作区工具及会话日志在电脑运行，模型通过当前云端账号使用服务端推理接口，不复制供应商 API Key。本机文件、Shell、Skills、计划和子代理等遵循同一 preset 和审批流程；工作目录不是沙箱。模型推理需要有效登录与网络。本机工作区选择和历史浏览不依赖云端工作区桥接。旧桥接说明见 [工作区配套说明](workspace-deployment.md)。

## 分支与同步

- `master`：Web、共享插件与云端服务。
- `desktop`：从 `master` 派生的桌面集成及发行分支。
- Web 更新通过 `master → desktop` PR 同步，使用普通 merge commit，保留共同历史；不要对长期同步 PR squash 或反复 cherry-pick。
- 共享修复在基于 `master` 的短期分支提交，再同步至 `desktop`；不要整条桌面分支反向合并回 Web。
- 桌面专属代码位于 `apps/desktop/`，准备脚本为 `scripts/prepare-desktop-candidate.mjs`。云端桥接服务应独立进入 `master`，默认配置不得改变现有 Web 行为。
- Web 与桌面独立发版，桌面标签使用 `desktop-vX.Y.Z`；合并不代表允许自动上线。

本机 Web 工作目录为 `/opt/dsh/source`，桌面为 `/opt/dsh/desktop-source`。二者共享 Git 历史，但工作树和暂存区独立。候选、运行数据和凭证不提交。

## 底座与构建

复用 anywhere-labs/dsh-desktop，固定提交和社区消费方派生修改由准备脚本记录。官方 DSH 包不打补丁；仅复用本仓库 Web 已评审的第三方补丁，由 `apply-web-patches.mjs` 检查版本并幂等应用。

上游源码由 `upstream/dsh-desktop` Git 子模块关联，固定在 `5510cb1203838f2d55f9bbd52cdcfaae1cad5eac`。克隆时使用 `--recurse-submodules`，或在已有仓库初始化如下。子模块保持原样，派生变换仅发生在新候选中。示例绝对路径需替换为本机路径，Windows 使用绝对盘符路径。

```sh
git submodule update --init --recursive
node scripts/prepare-desktop-candidate.mjs /absolute/MewClaw/upstream/dsh-desktop /absolute/new-candidate
cd /absolute/new-candidate
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node /absolute/MewClaw/apps/desktop/verify-workspace.mjs /absolute/new-candidate
```

需要 Node 24，并先安装源码仓库的冻结依赖（准备脚本会构建同源浏览器 client）。安装生命周期默认关闭，Electron 下载及平台原生依赖必须另行审核处理；上述命令不是安装包构建流程。

准备脚本复制版本化的 `candidate.package-lock.json`，使用 `npm ci` 固定依赖；上游版本或依赖变更时，必须在隔离候选重新生成、审阅并更新此锁文件，不手工修改校验摘要。

## Windows 开发包

Windows 构建示例目录为 `D:\AI\dsh\MewClaw-desktop-candidate`，在该目录执行（Node 24 / Windows x64）：

```sh
node node_modules/electron/install.js
node node_modules/electron-builder/cli.js --config electron-builder.cjs --win --x64 --publish never
node /absolute/MewClaw/apps/desktop/verify-package.mjs D:/AI/dsh/MewClaw-desktop-candidate
```

Release 输出目录由版本自动计算为 `release/MewClaw-1.0.0-win-x64`，不再使用 `desktop.6` 等临时目录名；验包脚本会按候选 `package.json` 自动定位该目录。UI 冒烟入口：`node apps/desktop/local-ui-smoke.mjs D:/AI/dsh/MewClaw-desktop-candidate advanced --directory --switch`，默认使用临时用户数据与无密钥模型目录，不请求真实模型；附加 `--live-login <0600账号JSON文件>` 使用专用账号验证真实登录表单、Web 插件/模式清单及按钮双向切换，结束时登出。

Electron 安装器会校验固定版本的下载摘要；官方连接不可用时可对该命令设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。输出目录为候选下按版本命名的 `release/MewClaw-1.0.0-win-x64/`，包括当前用户安装程序、便携启动器、完整 ZIP，以及 `win-unpacked/MewClaw.exe`。`win-unpacked` 中的 EXE 必须与整个目录一起保留。

验证脚本检查 MewClaw 启动入口、官方运行时打包前后字节一致性、真实 Electron 的 DSH/pnpm/原生依赖和无头 CLI，最后打印产物 SHA-256。全部采用无凭证临时 DSH_HOME，不执行真实云端会话。开发包不包含代码签名。使用 `asar:false` 物理目录打包，避免官方 BigInt stat 与 Electron ASAR 虚拟目录不兼容。Linux 上可加 `--static-only` 核验物理应用目录、官方文件与 ZIP 一致性，该模式明确不执行 Windows 运行时。

模型驱动文件组合回放：`node apps/desktop/verify-local-session.mjs <候选目录> <独立证据目录>`。可显式附加 `--live <0600账号JSON文件>` 验证真实模型；凭证只保留内存并在结束后登出。

界面冒烟可附加 `--exercise-presets`，依次切换四种可见模式并等待挂载稳定，拒绝仅更新菜单后又回退的失败。历史模式通过官方 Include 的 Provider 子类按包导出定位 standard preset，开发 workspace 链接和发行目录共用同一入口。

上游升级须单独 PR：评审新提交，同步调整准备脚本的固定 revision，重跑兼容与完整性门禁，最后提交子模块指针。不要用 `git submodule update --remote` 自动追踪最新版本；GitHub 源码 ZIP 不含子模块内容。

同步 PR 门禁：构建、桌面插件测试、官方依赖完整性、登录与会话同步、本地工作区选择、双向切换和断线测试。Windows 产物构建与 Windows 实机验收分别报告；门禁尚未全部完成，不得发布为正式 APP。
