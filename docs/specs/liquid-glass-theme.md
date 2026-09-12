# 液态玻璃主题 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-liquid-glass` |
| 位置 | `packages/ui/liquid-glass` |
| 角色 | 官方 Theme Definition 的 Provider；官方 theme、slots 的 Consumer |
| 里程碑 | 液态玻璃主题首版 |
| 状态 | done（SVG壁纸与语义材质；生产运行态验收） |
| 关联 ADR | 蓝图 ADR-1 |
| 依赖能力 | `ctx.theme`、`ctx.slots`、Host `ctx.webServer` |
| 提供能力 | 主题 token 覆盖、主题设置页 |

## 1 目的与边界

通过官方主题 token 扩展整站明暗配色，以 rdev/liquid-glass-react 为插件自有控件提供折射材质。不修改官方 DSH、官方插件、私有 DOM 或样式选择器，不替换官方布局和会话组件。登录页是独立 Auth 应用，不在本次 DSH 客户端主题范围内；生产候选通过后经用户确认切换。

## 2 服务契约

复用官方 `ThemeRuntime.overrideTokens(source, tokens): () => void` 与 `getTheme(): ThemeSnapshot`，每个 token 必须同时提供 light/dark 值；不再创建主题状态服务。设置页通过 `settings.section` 加法注册。所有样式、token、slot 注册均归属 Cordis effect，卸载恢复下层配色并移除自有 DOM 与监听器。

## 3 配置契约

`Config`：`enabled: boolean = true`（插件可用性）、`defaultEnabled: boolean = true`（无个人记录时的默认选择）、`refraction: boolean = true`、`displacementScale: number = 32`（0–80）、`blurAmount: number = 0.12`（0–1）、`saturation: number = 130`（100–180）、`aberrationIntensity: number = 1`（0–3）、`identityTimeoutMs: number = 5000`（1000–30000 毫秒）。Host 加载时显式解析默认值并拒绝未知字段、非法类型、非有限值和越界值。通过自有 JSON script 元素传给 Client，Client 再校验。关闭插件不注入客户端配置，客户端不注册效果。配置只控制视觉，不包含密钥或账户数据。

## 4 事件契约

消费官方 `theme/change(snapshot: ThemeSnapshot)`（emit），读取配色变化更新自有预览；不发布新事件。监听器随组件或插件卸载释放。

## 5 模型可见面

无。主题不注册工具、不改变提示词、不读写会话，不产生模型可见输入。

## 6 行为契约

会话面包屑使用header内的nav；该导航从通用玻璃面板选择器中排除，透明、无阴影、无滤镜。标题按钮及面包屑点击/禁用行为不变，其他nav保持原主题。

横向tablist为透明无框容器，无圆角、阴影或滤镜，8px间隙；直接tab子项32px最小高度和14px水平内边距，aria-selected驱动2px底边选中态，不使用背景选中块。header/banner/toolbar不加玻璃框。不改点击/键盘处理器、ID或aria-controls。窄屏内部横向滚动，纵向aria-orientation=vertical不采用横向规则。

视觉统一修订：通用底面和插件预览统一中性灰白/石墨，不再使用绿色色阶；补齐官方实际消费的 sidebar-fill、input-major、menu、selector、sidebar-nav-item-active token。菜单容器18px、弹窗24px、菜单项10px圆角；菜单内边距8px，相邻语义项4px间距。不再给所有按钮追加玻璃阴影，浮层内部按钮和菜单项无重复阴影。参考 gracefullight/liquid-glass 的低着色分层思路，未引入额外依赖或复制其组件。保留状态色、圆形图标按钮及官方布局逻辑。

全局通过公开 `--dsw-alias-*` token 和原生 HTML/ARIA 语义选择器统一材质；不引用官方哈希 class、不探测私有 DOM、不把官方组件重新挂载进玻璃容器。自有 document 属性限定样式的启用和明暗状态，随开关和卸载移除。双色 SVG 背景以自有源码生成 data URI，不含脚本、远端链接或字体；body 背景承载壁纸，消费背景 token 的区域使用半透明底面。按钮、表单、原生导航、dialog/menu/listbox/toolbar/tablist 使用语义样式，保持原本尺寸、定位、焦点管理与状态颜色；长文本、图片、代码不施加滤镜。无公共材质接口且无语义标记的官方容器只接受 token 配色，不宣称所有官方元素都有真实折射。官方 light/dark/system 和字号偏好继续由官方服务管理，不写第二份官方配色偏好。控制面板「液态玻璃」提供始终可访问的 switch，移出可卸载的玻璃预览以保持键盘焦点；只控制主题覆盖层，不改官方主题选择。

减少透明、强制颜色或不支持 backdrop-filter 时使用不透明 token，隐藏背景、禁用语义表面滤镜。减少动态时移除自有过渡。主题页最多一个 SVG 折射实例，其余表面仅 CSS 磨砂与高光，不对所有元素建立 SVG 滤镜或指针监听。背景为静态双色抽象流线，中央低对比，响应式 cover。

个人开关通过同源只读 `/auth/me` 确认当前账号后，以版本化账号键保存在本浏览器 localStorage，刷新和同账号标签页同步；不修改其他账号、不写部署级 settings，不承诺跨设备同步。未登录、身份读取失败或存储被禁用时只使用本页内存并显示不能持久化的说明，不能误报保存成功。储存值只允许 `on` / `off`，坏值回到部署默认并显示提示；清除存储回到默认。身份请求随插件卸载中止，迟到结果不得重新挂载 token。生产部署先按当前运行 release 构建主题增量候选，不夹带未上线的桌面功能或改变会话格式。

折射只在支持 backdrop-filter、未请求减少动态/透明、非强制颜色时挂载；其他环境使用可读的磨砂或纯色表面。Safari/Firefox 的 SVG 位移是上游已知部分支持，不保证像 Chromium 一样折射。禁用 shader 模式和弹性位移，避免长列表和每条消息的 GPU/指针监听开销。主题页面最多一个折射实例；不使用远端图像、字体或运行时 CDN。

加载配置缺失 → 本插件保持未启用；JSON/配置非法 → 明确抛错；不支持滤镜/减少动态/高对比偏好 → 可见文字说明当前降级。插件内部 UI 渲染错误不应改变会话网络链路。

## 7 安全与信任

只信任校验后的插件配置。JSON 嵌入转义 `<` 防止脚本结束标签注入。不请求设置管理 API，不新增网络端点、不绕过 Auth Edge，不访问本机目录、凭证或消息内容。

## 8 测试契约

unit：配置默认值/非法输入拒绝、Host transform 注册/释放、token 双色与注册/释放。snapshot：真实构建的浏览器入口与官方 theme/slots 的无密钥装配页面，检查明暗主题、减少动态、卸载恢复、可操作按钮和截图。build/typecheck/lint 与官方完整性为交付门禁；隔离浏览器不等于生产真实账号验收。

新增依赖 `liquid-glass-react@1.1.1`（MIT），官方 token API 不提供折射组件，因此只复用该库的视觉实现；React 使用 DSH ModuleLoader 的同一实例，禁止打包第二份 React。GitHub master 声明 React >=18，npm 同版本却声明 >=19；本项目固定 React/ReactDOM 18.3.1，经真实浏览器回归后只为 `liquid-glass-react@1.1.1` 设置这两个 peer 的窄范围 allowedVersions，不全局放宽检查、不修改任何官方包。依赖仅客户端物化，关闭 refraction 时不挂载折射组件。产物大小实测记录在验收证据中。

## 9 迁移映射

无旧实现删除。新包、可选 overlay、构建入口与文档为增量改动，默认 Web 组合不变。撤销 overlay 即恢复现有外观。桌面通过 Web 共享包接入约定，不自动升级桌面 DSH 或修改社区子模块。

## 10 开放问题

无阻塞项。生产启用与桌面旧版官方主题 API 的实机兼容验收不包含在源码完成声明中。

本地验收记录：`docs/evidence/liquid-glass-theme/verification.md`；可重放快照和浏览器脚本随源码维护。证据目录依仓库规则不入 Git。
