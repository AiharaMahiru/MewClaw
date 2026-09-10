# R3 远程设置与四模式

状态：实施中。用户授权修复、合并和生产发布。

自有 web-auth 客户端提供 settingsScope/settingsSchema 的公开结构契约，通过 remote.settings 获取服务端事实。不设置 ownsHost，不修改 Connection、官方对象或依赖文件。Auth Edge 在认证页面的客户端目录中排除官方 ui-settings 基础 Provider，保留官方消费者。普通用户保持只读；管理员写入使用命名空间 revision，失败刷新事实。订阅、排队写入在插件退出时释放。

新建模式菜单显示 lightweight、standard、liangshen、cordis 四个稳定 ID，并更新名称。lark-standard、ptc、minimal 保留解析与恢复能力。高效模式暂以 liangshen 为默认执行策略，旧 PTC/极简策略通过既有 preset 配置保持可用，不删除历史数据。

验收：远程 mirror 首读/失败恢复/并发写入/卸载回归，Auth Edge 权限回归，四模式目录与旧 ID 恢复检查，官方完整性和候选启动门禁。通过后切换生产，保留 R2。
