# DSH Lark 附件格式处理修复转交

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
