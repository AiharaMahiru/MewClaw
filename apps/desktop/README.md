# MewClaw 桌面开发

当前为开发基线，不是可交付 APP。本地文件 Consumer 已有测试，原生目录授权、云端工具桥接、Windows 打包仍待完成。

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

```sh
node scripts/prepare-desktop-candidate.mjs /absolute/upstream /absolute/new-candidate
cd /absolute/new-candidate
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm run build --workspace dsh-lark-desktop-cloud
npx vitest run mewclaw-cloud/src
```

需要 Node 24。安装生命周期默认关闭，Electron 下载及平台原生依赖必须另行审核处理；上述命令不是安装包构建流程。

同步 PR 门禁：构建、桌面插件测试、官方依赖完整性、登录与会话同步、本地工作区授权和断线测试。Windows 产物构建与 Windows 实机验收分别报告；门禁尚未全部完成，不得发布为正式 APP。
