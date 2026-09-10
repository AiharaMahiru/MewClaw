# 网络安全提示词审计 SPEC

状态：实施中，用户已确认复用 DSH 配置并禁止攻防、恶意攻击和破解。

## 1 目标

在浏览器提示词转发到 DSH Worker 前，由 DeepSeek V4 Flash 判断网络安全风险。
触发限制时不转发原请求，并在网页显示中文弹窗。

## 2 能力划分

- Definition：审计输入、允许／拒绝／不可用结果及配置契约。
- Provider：认证边缘服务内调用独立审计模型，严格校验结构化结果。
- Consumer：认证代理强制执行结果；现有 web-auth 插件展示拒绝弹窗。

已检查官方插件目录及现有认证代理，未找到满足指定模型和转发前拒绝要求的现成能力。
实现复用认证代理扩展点，不修改 DSH 框架源码，不增加模型 SDK 依赖。

## 3 发送边界

授权成功后、requestUpstream 前执行审计，覆盖 session.prompt、队列消息编辑、子代理提示词、
goal.create/edit 的 objective 和 commands.execute 的完整命令行（含 /goal）。
这些发送端点的非 POST/JSON 请求在转发前拒绝，不能通过 Content-Type 绕开检查。
同时识别官方 args.request 和既有直接 args 载荷，不改变通过审计的原始内容。
WebSocket remote.mux 只允许 stream descriptor，官方网关拒绝通过该载体调用 unary 提示词方法。
飞书 Gateway 不经过 Auth Edge，是否纳入限制范围需单独确定。

## 4 审计契约

Auth 使用独立 Cordis Context 挂载官方设置、凭证和 DeepSeek Provider，复用同一 DSH_HOME。
默认使用 deepseek-official 路由和 deepseek-v4.1-flash 逻辑模型，连接来自 llm-deepseek 设置段，
不跟随 agent-default-model，不向 Worker 发送审计输入，不导出或复制凭证。
审计上下文只保留启动快照的 project-env/user-env 回退层，避免 Auth 控制面继承的旧密钥
遮蔽 Models 中保存的受管凭证；不修改主进程环境。部署应与 Worker 共用 DSH_HOME。
禁止明确的黑客入侵、口令或软件破解、恶意软件、窃密、钓鱼、绕过认证操作；授权或教学声明不豁免这些操作。
允许爬虫、公开数据采集、PLC 编程、正常网络维护与防守分析；没有明确禁止操作时允许，不因关键词拒绝。
审计输入作为不可信数据处理，不允许提示词覆盖审计系统指令。
仅接受经过运行时校验的明确允许结果；拒绝、超时和异常均不转发本次请求。
审计失败与风险拒绝使用不同错误码和固定中文文案，不向浏览器返回上游响应、密钥或内部错误。
图片是用户明确指定的不审计附件：官方 `type: "image"` 块不进入安全审计；图片-only 请求跳过文本审计，图片+文字请求只审计文字块，原始图片仍按上游协议转发。
未知多模态块、工具块或非法结构仍失败关闭，不能借此把未识别内容伪装成图片绕过边界。
独立审计调用不挂载 Agent 会话、工具或 Worker，不写入 DSH 会话上下文或 Auth 内容日志。

启用配置：AUTH_PROMPT_AUDIT_ENABLED，缺省 true，显式 false 仅用于隔离环境。
AUTH_PROMPT_AUDIT_TIMEOUT_MS 缺省 15000，范围 100–60000。
AUTH_PROMPT_AUDIT_MAX_CONCURRENT 缺省 4，范围 1–32；并发满立即失败关闭，不排无限队列。
启动器必须传入原始分层环境快照；生产启用却没有模型工厂时启动失败。
boot-check 不初始化模型，不解析审计凭证，不产生外部调用。

## 5 网页行为

使用 web-auth 的 ctx.effect 注册响应观察器与原生 dialog，卸载时清理。
仅检查同源目标请求的专用审计错误，读取 Response.clone()，保留原响应语义。
弹窗说明本次提示词未发送，允许关闭后修改内容；模型错误提示稍后重试。
展示文本不使用模型生成 HTML。

## 6 验收

无密钥模拟模型验证允许、拒绝、超时、异常结构及提示词注入场景。
代理集成测试验证拒绝时 Worker 接收请求数为零，允许时载荷保持一致。
覆盖主提示词、队列编辑、子代理、目标创建/编辑和命令入口；网页验证弹窗关闭、重复触发与插件卸载。
针对性单元测试最大超时 60 秒，执行类型检查、lint 和客户端构建。
模拟验证不等同于真实模型准确率或生产上线验证。

## 7 模型路由与故障回归

自有DeepSeek路由插件复用官方Adapter，通过配置把唯一可见逻辑模型 deepseek-v4.1-flash
映射为CommandCode端点要求的 deepseek/deepseek-v4.1-flash。Gemini Web2API不再注册为模型Provider；Gemini搜索MCP是独立工具能力，继续保留。
审计与普通请求共用此映射；仅审计调用显式 reasoningEffort=off，对应 thinking.type=disabled。
不通过全局 thinking=disabled 限制普通会话。必须用本地 HTTP 捕获实际 model/thinking 字段，不能只检查字符串或进程状态。
响应只能为完整 decision JSON（兼容完整代码围栏）。多个判定、嵌套对象、异常结束、截断都不能放行。
审计故障记录结束类型与稳定错误码，禁止记录输入、密钥、原始输出或供应商错误正文。

## 9 行为变化

启用后提示词发送增加一次模型审计延迟；审计不可用时阻止本次发送。
生产配置与服务切换须在候选完成验证后明确确认，并保留原发布版本用于回滚。
