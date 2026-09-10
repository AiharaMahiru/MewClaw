# MewClaw Desktop 开发交接

更新时间：2026-09-10。适用分支：`desktop`。当前开发基线：`220e804`；桌面根 README：`7c8d99f`。本文是下一轮桌面开发的入口，不是发布验收证明。

## 1. 接手位置与约束

- 上游已通过 `upstream/dsh-desktop` Git 子模块关联。首次接手运行 `git submodule update --init --recursive`，确认 `git submodule status` 指向 `a1ddcda8e701a8490c619ce411ea8a3d6daa1453`。后续候选使用此检出，不依赖旧 `/tmp` 研究副本。升级必须同时评审子模块指针与准备脚本固定 revision，不能自动追踪远端 HEAD。

- 桌面工作树：`/opt/dsh/desktop-source`；Web 工作树：`/opt/dsh/source`。接手先检查 `git branch --show-current`、`git status --short` 和 `git worktree list`。
- `master` 管理 Web、共享插件与云端服务；`desktop` 管理桌面组合。共享改动从基于 `master` 的短期分支提交，再以 `master → desktop` 普通 Merge PR 同步，不反复 Squash，不整分支反向合并。
- Web 工作树已有四个 web-auth 文件及 `docs/specs/account-feishu-settings.md` 的未提交改动，不属于桌面任务，禁止混入提交或回退。
- 上次确认生产入口为 `/opt/dsh/current → /opt/dsh/releases/R3`。接手重新核验，不把本文当实时服务状态。本轮分支和文档工作未重启或切换生产。
- 先读 `AGENTS.md`、`docs/spec-standard.md`、`docs/reference/dsh-AGENTS.md`、[桌面 APP SPEC](docs/specs/desktop-app.md)、[本地工作区 SPEC](docs/specs/desktop-workspace.md)。先补完整契约，再实施未定义接口。
- 官方 DSH 及官方附属包不修改；自有行为走插件、配置及公开能力。社区桌面必要派生修改须在准备脚本中可复现并记录来源，不能宣称社区底座零改动。
- 本文只交接计划，不授权新的生产或破坏性操作。实施时遵循当时有效的用户授权；操作前说明精确范围、影响与回滚，需确认时等待确认。

## 2. 已完成与明确缺口

已验证的开发成果：

- 固定社区底座 `a1ddcda8e701a8490c619ce411ea8a3d6daa1453`，桌面 2.0.6、DSH 0.1.2-rc.1；独立 npm 候选构建及 Linux Electron 启动通过，社区定向测试 34 项通过。
- 自有 Cloud WebServer Provider 保留本地认证、Host/Origin 检查及云端 Cookie/CSRF 对；代理 HTTP/SSE/WS，不自动重放写请求，不把本地启动凭证发往云端。
- 专用普通账号在桌面和独立 Web 浏览器完成两轮真实模型续聊，双方显示相同结果。不是通过复制会话数据库实现同步。
- `LocalWorkspaceFiles` 复用官方 FileSystem，支持 list/read/write、条件更新、路径边界、体积限制与撤销。云端插件四个测试文件共 15 项通过；这不是桥接 E2E。

**未完成：原生目录授权、云端工具桥接、跨账号/断线全链路验收、Windows 安装包与实机测试。尚无可交付 APP。** 登录页 `#root` 修复已进代码，仍需真实窗口停留超过 30 秒复验。官方依赖逐包完整性与 Windows 原生依赖闭包也尚未验收。

关键文件：`apps/desktop/launcher.mjs`、`apps/desktop/plugins/cloud/src/{index,proxy,boot,files}.ts`、`scripts/prepare-desktop-candidate.mjs`。构建说明见 [桌面开发 README](apps/desktop/README.md)。

## 3. 下一步按顺序实施

### 第一步：补齐本地工作区契约（立即开始）

阅读社区原生目录选择、profile 和公开服务接口，核对当前官方 tools/FileSystem 扩展点，更新本地工作区 SPEC：

- 定义完整 Scope 下的会话—设备—目录授权绑定、请求 ID、超时、取消、撤销、错误分类与持久化责任。
- 明确 Definition / Provider / Consumer，以及注册和卸载的 disposer；禁止读取社区私有 desktopRuntime 或 monkey-patch 实例。
- 云端认证端提供可信账号与会话归属，不能信任客户端 userId；管理员身份也不能自动取得别人的电脑目录权限。
- 首版仅 list/read/write，无 Shell、目录同步或离线副作用重放。传输可先评估窄 HTTP 轮询，不预先建设通用设备平台；选型和取舍写入 SPEC。
- 定义本地绑定期间的云端执行型工具拒绝策略。断线或绑定恢复失败必须明确拒绝，不回退服务器目录。

完成标准：wire、生命周期、授权来源、失败恢复和无密钥拒绝用例均可照契约实现；未定义接口不得先写实现。

### 第二步：打通一条最小纵向链路

1. 在桌面提供明确区分“云端工作区”和“本机目录”的入口，原生授权后创建 `LocalWorkspaceFiles`。重点核验社区 Windows directory-picker bridge，禁止把 `C:\\...` 传给云端 `workspace.create`。
2. 云端桥接与工具作为共享自有插件，在基于 `master` 的独立工作树开发，不能在带飞书脏工作的目录直接切分支；默认配置不改变现有 Web 行为。
3. 按认证 Scope 和会话归属绑定请求；云端网关只认证/转发，工具生命周期由 Worker 管理，实际文件操作在授权电脑执行。
4. 模型只接收正常工具结果，并落入官方 session log；不可隐藏注入文件正文。工具参数不能指定其他用户或设备。
5. 使用官方工具 guard 等公开接口阻止本地绑定会话误调用服务器执行工具；写入保持 createIfAbsent/replaceIfVersion，无条件覆盖不进入首版。

完成标准：桌面授权临时目录，同一云端会话真实读取、创建并条件更新该目录文件，Web 能看到相同工具结果；无本地授权时无法操作电脑文件。

### 第三步：隔离、生命周期和真实窗口回归

- 无密钥测试：跨账号/跨 Scope 拒绝、伪造设备身份、绝对路径与父路径、根外 symlink、旧版本写、超限、撤销后请求拒绝。
- 请求重复、客户端断线、云端重启和响应丢失：结果不明必须显式呈现，不自动重放写入；取消不能被宣称为已经回滚完成的磁盘写入。
- 插件卸载关闭请求和轮询、释放监听器；重连不累加监听器、不接管其他会话。
- 登录页停留超过 30 秒，登录/退出/重新登录、双端续聊、SSE/WS 断线恢复；不能关闭看门狗来掩盖启动错误。

完成标准：定向测试通过并保存无凭证日志及必要截图，明确区分单测、Linux Electron E2E 和 Windows 实机证据。

### 第四步：Windows x64 打包

- 使用 MewClaw 应用标识、独立数据目录及自身发行配置；不沿用社区自动更新地址。
- 冻结候选锁文件，核对 UPSTREAM.json 列全 settingsNamespace 与 profile Provider 选择变更，并验证官方包完整性。
- 重新取得目标平台原生依赖，不能把 Linux Electron/sharp 复制后当 Windows 产物；检查社区 ASAR 流程对官方补丁的依赖，必要时验证无 ASAR 方案。
- 生成安装包或 portable、SHA-256、来源与版本记录；签名状态如实注明。Linux root 测试的 `--no-sandbox` 不进入正式发行配置。

完成标准：产物实际存在，Windows 安装/启动/登录/本地文件全链路通过；缺少实机或签名时明确列出缺口，不能以打包成功代替实机成功。

### 第五步：必要后端发布与交付

候选门禁通过后才安排必要云端桥接插件上线。先核验真实生产入口、服务基线和数据兼容性，说明变更服务、配置及回滚方案，保留 R3 和运行数据。不能仅回滚代码而忽略新绑定数据的兼容性。

完成标准：生产健康与账号隔离通过，下载地址可用、摘要相符；交付说明包括版本、支持系统、签名状态、安装/卸载和授权撤销方式。Web 未相关功能不得受影响。

## 4. 当前可复跑的检查

以下候选路径仅是本机历史位置，接手先检查存在性及源码是否一致；旧候选通过不能替代新提交验证。

```sh
cd /opt/dsh/desktop-source
git diff --check
node --check apps/desktop/launcher.mjs
node --check scripts/prepare-desktop-candidate.mjs
cd /opt/dsh/desktop-candidates/20260910-clean-base
export PATH=/opt/dsh/runtime/node/bin:$PATH
npm run build --workspace dsh-lark-desktop-cloud
npx vitest run mewclaw-cloud/src
npx vitest run tests/window-options.spec.ts tests/profile-service.spec.ts tests/notifications.spec.ts
```

若重建候选，按桌面 README 使用不存在的新目标目录，不覆盖或直接删除旧候选。新增步骤须补对应可执行验收命令，不能将“待实现”门禁标为完成。

## 5. 本机证据与测试善后

- 长程记录：`/opt/dsh/desktop-source/.codex-tasks/20260910-mewclaw-desktop/`，阶段 1、2 完成，阶段 3 进行中；CSV 为里程碑状态源。PROGRESS 旧段落有历史描述，按最新记录和实际代码核验。
- 双端 E2E 证据原件：`/opt/dsh/source/docs/evidence/desktop-cloud-20260910.md`；截图在任务 raw 目录。证据目录默认不入 Git，远端使用者不得假设这些本机文件随仓库存在。
- 测试账号的 ID 与随机凭证保存在本机 `/tmp/mewclaw-electron-test.chrXdE/test-account.json`（应为 0600）。只在授权测试需要时受控使用，不打印、不提交、不写入文档；不得读项目 `.env`。
- 上次交接时测试账号仍启用，状态需复核。验收结束或不再测试时，核对确为本次专用普通账号，通过公开认证存储接口禁用并撤销会话，保留测试记录；不要操作管理员或他人账号。
- CDP 测试端口曾使用 19337/19338，测试进程有自动超时。不要假设旧 PID/session 仍有效，不得广泛 kill。停进程前核对其命令、用户数据目录和归属。

---

## 历史附件修复交接（2026-08-14）

以下完整保留供追溯，不是桌面任务的行动指令；其中路径、生产状态、操作授权和任务记录限制均只适用于当时工作，不能覆盖上方桌面计划。

### DSH Lark 附件格式处理修复转交

更新时间：2026-08-14

> 文档状态：这是附件内容驱动管线的历史转交记录。初始现场状态和“未完成改动”章节保留用于追溯；当前实现与验证状态以仓库代码、`docs/evidence/` 和最新收口命令为准。

## 目标

后续由 Pi 在 `D:\AI\dsh` 继续开发。用户要求附件处理不能依赖文件扩展名硬编码，图片以及 `docx`、`xlsx`、`csv`、`py`、`rs`、无扩展名文件和其他格式都应优先按真实内容识别。

目标不是声称可以语义解析世界上所有二进制格式，而是建立统一的内容驱动管线：

1. 格式识别不依赖文件名或扩展名。
2. 任意可安全解码的文本都可读取，包括未知扩展名和无扩展名源码。
3. PDF、DOCX、XLSX 等富格式按真实 MIME 分派到已有解析器。
4. 图片按真实内容解码，必要时转换为视觉模型稳定支持的格式。
5. 已识别但暂无解析器的二进制文件应明确报告类型和限制，不得误称“加密”“损坏”或“不可读”。
6. CDG/Esafenet 文件必须先走现有 CdgBridge 检查和受控明文物化，再识别明文内容。

## 已确认根因

用户在飞书发送图片后，模型回复无法读取，并错误推测文件被加密。

真实链路如下：

1. `packages/lark/lark-ws/src/inbound-message.ts` 将独立图片命名为 `image`，富文本图片命名为 `post-image-<n>`，均无扩展名。
2. `packages/lark/gateway/src/attachments.ts` 当前把附件 MIME 固定为 `application/octet-stream`。
3. Worker 将附件物化为工作区 `uploads/<id>/image`。
4. `packages/lark/uploads/src/index.ts` 原实现仅在路径扩展名属于图片白名单，或声明 MIME 以 `image/` 开头时进入视觉分析。
5. 因路径无扩展名且 MIME 为 `application/octet-stream`，视觉路由直接跳过。
6. 主模型 `deepseek-v4-pro` 是文本输入模型，原生 `read_image` 因模型不支持图片输入而拒绝；正确架构应由 `dsh-lark-vision` 先把图片转为结构化文本。

真实失败样本：

```text
D:\AI\dsh\.workspaces\c221a1963f38bef5d502ece218cb8a3c88b5381d7293fa27410f270cba37095d\uploads\683fa0ed-f3a7-4800-8e42-bd6779e071a3\image
size: 162754 bytes
extension: empty
header: RIFF .... WEBP VP8
actual type: image/webp
```

该文件是有效 WebP，不是 CDG 加密文件，也没有损坏。

## 当前运行状态（历史转交时记录）

本节记录 2026-08-14 的现场状态，不代表当前分支或线上服务的实时状态。

最后复核时：

```text
task: MewClaw
state: Running
isolation profile: lightweight
PostgreSQL: running
Worker: running, healthy
Gateway: running, callback connected
Admin: running, healthy
Podman: not required
```

当时源码改动尚未构建和部署，服务也未因本任务重启，因此线上仍是旧行为。后续实现已落地到当前分支；运行态是否已部署以 `pnpm service:status` 和最新证据为准。

检查状态：

```powershell
cd D:\AI\dsh
pnpm service:status
```

不要转去检查 `D:\AI\lark-claw`；本次真实运行实例和目标仓库均是 `D:\AI\dsh`。

## 初始转交范围（历史记录）

初始转交时只改动或新增依赖于以下现有文件；仓库其余大量修改均在当时已存在，禁止回退：

```text
packages/lark/uploads/package.json
packages/lark/uploads/src/extract.ts
packages/lark/uploads/src/index.ts
packages/lark/uploads/src/index.test.ts
pnpm-lock.yaml
```

初始转交时具体状态：

- `package.json` 已加入 `file-type@22.0.1` 和 `sharp@0.35.3`。
- `pnpm-lock.yaml` 已加入这两个依赖对应条目；该文件原本已有其他未提交修改，不要整体覆盖或回退。
- `extract.ts` 目前包含一个只识别 PNG/JPEG/GIF/WebP/BMP 的手写文件头实现。
- `index.ts` 已临时接入该手写图片识别。
- `index.test.ts` 已加入“无扩展名 WebP + application/octet-stream”的回归案例。

手写签名方案已被用户明确否定，不能在其上继续追加格式；当前实现已替换为统一的内容检测和处理架构。

查看当前差异：

```powershell
git status --short
git diff -- packages/lark/uploads/package.json packages/lark/uploads/src/extract.ts packages/lark/uploads/src/index.ts packages/lark/uploads/src/index.test.ts pnpm-lock.yaml
```

## 初始推荐实现（当前实现已落地）

### 1. 统一内容检测

新增一个小型内容分类模块，使用 `file-type` 的 `fileTypeFromFile()` 检测二进制 MIME 和建议扩展名。不要再维护图片或 Office 魔数表。

`file-type` 对普通文本通常返回 `undefined`，这不是错误。此时再进入现有安全文本解码：

- UTF-8
- 带 BOM 的 UTF-16LE/UTF-16BE
- GB18030 回退
- NUL、控制字符比例和大小上限拒绝

因此 `.csv`、`.py`、`.rs`、自定义后缀和无扩展名文本都应按内容读取。

### 2. MIME 驱动解析器

把现有 `extractFile()` 从“扩展名白名单”改为“检测结果 + 内容解码”分派：

```text
application/pdf
  -> unpdf

application/vnd.openxmlformats-officedocument.wordprocessingml.document
  -> mammoth

application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  -> read-excel-file

未检测为二进制
  -> 通用文本解码

其他已识别二进制
  -> 明确的 UNSUPPORTED_MIME/暂无解析器结果
```

扩展名可以用于展示或文本 MIME 细化，但不得决定文件能否读取。

### 3. 图片统一解码

对检测 MIME 为 `image/*` 的文件使用 Sharp 解码，并设置像素、输入字节和输出字节上限。建议将视觉请求输入统一为 PNG，或仅在视觉供应商不支持源格式时转 PNG。

真实样本已验证 Sharp 可自动识别和解码：

```text
format: webp
dimensions: 1920 x 1088
PNG output: 2940072 bytes
```

注意 PNG 可能比源图大很多，必须保留输出大小上限。像素上限可与 DSH attachment 默认策略的 40,000,000 像素对齐。

### 4. 普通附件的模型可见内容

当前非知识库摄入场景主要只注入 `<authorized_attachments>` 路径，模型仍需自行调用工具。应评估在 `dsh-lark-uploads.prepare()` 中复用一次检测/提取结果：

- 图片注入 `<visual_analysis>`。
- 可提取文本或富格式注入有边界、可截断、带来源的附件内容块。
- 明确摄入知识库时复用同一提取结果，避免二次解析。
- 未知二进制注入明确类型和“暂无解析器”说明，防止模型自行猜测。

所有模型可见块必须先写入 `lark/run/context`，保持“模型可见等于已落盘”。

### 5. 保持的安全边界

- 不读取、打印、复制或修改 `.env`。
- 不绕过 CdgBridge inspect/decrypt。
- 不削弱 Scope 归属、路径包含、SHA-256 和大小复核。
- 不在 Gateway 执行工作区工具。
- 不把文件名、扩展名或上游 MIME 当作可信内容证明。
- 不自动发送真实飞书或模型 smoke 消息；真实消息由用户手动发送。
- 不回退或覆盖其他未提交修改。
- 不创建 `.codex-tasks`、TODO、验收或过程记录文件；本 `HANDOFF.md` 是用户明确要求的唯一转交文件。

## 已执行验证

初版有限修复曾执行以下验证并通过：

```powershell
pnpm exec vitest run packages/lark/uploads/src/index.test.ts packages/lark/uploads/src/extract-rich.test.ts
# 2 files passed, 7 tests passed

pnpm exec tsc -p packages/lark/uploads/tsconfig.json --noEmit
# exit 0

pnpm exec eslint packages/lark/uploads/src/extract.ts packages/lark/uploads/src/index.ts packages/lark/uploads/src/index.test.ts
# exit 0
```

真实样本通过当前临时代码识别为：

```json
{"mimeType":"image/webp","extension":".webp"}
```

这些结果只证明初版 WebP 修复；这是初始转交时的结论。当前分支已包含 `file-type`/`sharp` 驱动的统一检测与图片解码实现，是否部署到生产仍需按当前环境单独复核。

## 收口验证门禁

至少覆盖以下回归：

1. 无扩展名 WebP 被识别并进入视觉分析。
2. PNG/JPEG/GIF/AVIF/TIFF 等以实际 Sharp 支持能力为准，不需新增业务魔数。
3. 无扩展名或错误扩展名的 UTF-8、UTF-16、GB18030 文本可读取。
4. `.csv`、`.py`、`.rs` 不依赖白名单即可提取。
5. DOCX/XLSX/PDF 在扩展名缺失或错误时仍按真实内容分派。
6. 扩展名伪装的二进制不会被当成文本。
7. 未支持二进制给出确定类型和明确限制，不出现“可能加密”的猜测。
8. CDG 文件先解密，再按明文真实内容识别。
9. 图片解码炸弹、超大输入和超大转码输出被有界拒绝。
10. `lark/run/context` 仍先于模型提示词落盘。

建议定向命令：

```powershell
pnpm exec vitest run packages/lark/uploads/src/extract.test.ts packages/lark/uploads/src/extract-rich.test.ts packages/lark/uploads/src/index.test.ts packages/lark/uploads/src/materialize.test.ts
pnpm exec tsc -p packages/lark/uploads/tsconfig.json --noEmit
pnpm exec eslint packages/lark/uploads/src
pnpm exec tsc -b packages/lark/uploads apps/lark-worker
```

如需把当前实现部署到运行态，完成构建产物更新后再执行：

```powershell
pnpm service:restart
pnpm service:status
```

状态应显示 PostgreSQL 运行、Worker/Admin healthy、Gateway callback connected、profile 仍符合用户选择。最后由用户在飞书发送真实图片和多类文件进行验收。
