# 历史会话副本迁移工具 SPEC

| 元数据 | 值 |
| --- | --- |
| 位置 | scripts/session-upgrade/ |
| 角色 | 离线 App / Consumer；复用官方格式 Definition、JSONL Provider |
| 状态 | implementing |
| 依赖能力 | 官方 released v0 codec、sessionFormatCatalog、Session、JsonlSessionPersistence |

## 1 目的与边界

仅迁移用户批准的三份历史会话副本，保留旧代字节和事件语义。不是生产自动迁移插件，不挂入 Agent，不修改官方包，不删除会话，不直接访问生产路径。生产转换和发布需另行确认。

## 2 服务契约

`migrateRows(rows: unknown[]): MigrationResult` 将未损坏、未继承父日志的 v0 物理行转为当前 v3 logical artifact，返回 artifact 和只含计数的转换报告。官方 codec 解包并校验密集序号。错误抛出，不输出数据正文。

自有扩展只支持 lark/message/in、lark/run/preset、lark/memory/recalled，且必须无 surfaceOp/sourceEventSeqs、完整 Scope 且数据满足当前精确字段契约。其他未知事件拒绝。将扩展暂存到独立集合，官方事件压紧序号并重映射所有已知引用；引用扩展序号拒绝。每组扩展只能锚定在紧随的 agent/inbox/spliced 之前，锚点 type/time/data 必须唯一且官方转换后不变。官方转换完成后原顺序放回扩展，并重映射 v3 引用；不使用伪造官方事件作为占位符。

descriptor v2 仅允许新版 snapshotSubagentDescriptor 可无损接受的字段；除 version 2→3 外不得丢失或改写任何字段。其他旧版本拒绝。新版完整 Session 与官方 v3 artifact 验证均通过才返回。

## 3 配置契约

CLI 显式输入 sourceRoot、outputRoot、planPath；都要求绝对路径。计划 version=1，entries 为1至3项 relativePath/sourceSha256；无密钥。源路径必须位于源根内，拒绝 symlink、父路径、绝对计划路径、重复会话；输出必须不存在且不在源树内。源与输出均不得位于 /var/lib/dsh、/opt/dsh/current、/opt/dsh/releases 或其真实路径下。根目录0700、计划/报告0600；源文件必须匹配固定摘要后才处理，完成后复核源摘要。

默认 limits：maxSourceBytes=33554432、maxDecodedBytes=67108864、maxEvents=200000；在函数参数显式解析，超限拒绝，不作静默截断。初版只支持完整 .jsonl.zstd 或 .jsonl，输出使用官方 zstd Provider。

## 4 事件契约

不注册新会话事件。允许三种已存在的 lark 事件完整保留；序号改变但其数据和时间不变。官方事件按官方转换语义迁移，包括 stream 嵌入和 system head；所有 sourceEventSeqs、surfaceOp、command source、compaction范围、title引用必须随新序号重映射，缺失引用拒绝。输入继承前缀非零拒绝，避免跨父子会话坐标猜测。

## 5 模型可见面

无工具注册或新模型输入。迁移后抽取去掉序号的模型可见事件，与插入扩展之前的官方转换结果严格一致；扩展不得改变模型 surface。正文不进入控制台或Git报告。

## 6 行为契约

先转换并验证全部计划输入，后创建全新输出根；任一失败输出不得称为可发布。官方 Provider create/append/flush/close 写入 sessions/ 下的v3，然后重新创建 Provider 并打开完整比较。原文件字节保留在 originals/ 下，以计划序号命名，不复制锁文件。输入源、保留原件与计划摘要一致；输出manifest包括源与目标文件摘要、计数、工具版本与源根引用，不含消息。物理读取使用 Node 公共 zstd API 的 info/bytesWritten 逐帧解码并累计明文上限；损坏尾帧、非法UTF-8及不完整JSONL尾行拒绝，不把首帧解码成功当作完整文件成功。

## 7 安全与信任

输入是跨文件边界的不可信 JSON。拒绝未支持payload字段及引用，不恢复自动执行、不启动模型、不占生产写句柄。新版读取通过不等于真实模型续聊或子代理冷恢复通过。任何生产操作需要单独确认。

## 8 测试契约

无密钥测试覆盖：三种扩展原位及全文保留、锚点歧义拒绝、引用扩展拒绝、source/surface/title序号回映射、descriptor无损转换及额外字段拒绝、未知事件拒绝、文件摘要/越界/symlink/覆盖拒绝、JSONL写后读取及源字节不变。对三份真实副本执行同一门禁，输出仅摘要与数量。

## 9 迁移映射

官方v0解码与0→1→2→3转换复用，不复制修改官方实现。新增自有扩展暂存/回插及序号映射；descriptor仅做经新schema验证的版本标识转换。原始文件永久保留于输出旧代与独立输入副本，后续不擅自清理。

## 10 开放问题

生产侧批量转换、v3写入后无损回滚及真正子代理冷恢复仍须后续方案和确认；本工具只验收副本。副本证据见 [会话升级验收](../evidence/dsh-015-session-upgrade.md)。依赖仅新增已安装官方格式包的显式开发依赖与 Node 标准库，无额外压缩实现或运行服务。
