# MewClaw 液态玻璃主题

自有 Cordis 插件，复用官方 `ctx.theme.overrideTokens()` 和 `settings.section`。整站使用雾白/石墨色语义配色；设置中的「液态玻璃」页使用 [liquid-glass-react](https://github.com/rdev/liquid-glass-react) 1.1.1 呈现折射预览和主题开关。不是对全部聊天组件添加滤镜，也不修改官方 UI 或私有选择器。

双色静态 SVG 壁纸随官方明暗偏好切换，源码位于 `src/wallpaper.ts`，直接内嵌为 data URI，无需图片 API 或资源鉴权例外。半透明语义 token 让底面透出背景；原生导航、菜单、弹窗与工具栏按 HTML/ARIA 语义使用磨砂高光，按钮和表单保留原本尺寸及状态色。没有公开材质接口的官方容器只接收配色，不承诺逐个元素真实折射。关闭开关时移除整站材质；减少透明、高对比和无滤镜支持时使用不透明底面并隐藏壁纸。

## 启用与回滚

中性玻璃修订：去除绿色底面，侧栏和输入框补齐官方 specific token；菜单18px、弹窗24px、选项10px圆角，菜单8px内边距与选项4px间距。玻璃高光集中在容器，不再为每个按钮堆叠阴影。参考 gracefullight/liquid-glass 的低着色分层设计，保持当前依赖不变。

先在源码执行 `pnpm install --frozen-lockfile && pnpm build`。开发 Web 可追加 `config/liquid-glass.patch.yml`；Linux 生产 overlay 已登记主题，不要同时重复追加。文件路径按加载器基准目录解析，不使用会被错误拼接的绝对 `--patch` 路径。默认开发 Web bundle 不启用，生产切换仍需确认和候选验收。

打开控制面板（设置）→「液态玻璃」，使用独立开关即时开启或恢复原主题。开关通过同源 `/auth/me` 识别账号，保存于当前浏览器的账号独立存储键；刷新保留、同账号标签页同步，不影响其他账号、不跨设备同步。存储或身份不可用时明确显示仅本页有效。官方「通用」继续拥有 light/dark/system 与字号，不写第二份官方配色偏好。

`defaultEnabled` 控制没有个人偏好时是否开启；`enabled:false` 则禁用整个主题插件入口。调整部署配置后重新加载 Host 组合并刷新页面；移除生产 overlay 中的主题行即可回退。Client fiber 卸载会移除自己的 token、样式、设置页和订阅，恢复下层主题，而不重置官方偏好或删除个人开关记录。

配置字段、默认值和范围见 [SPEC](../../../docs/specs/liquid-glass-theme.md)。关闭 `refraction` 保留配色与静态预览。减少动态、减少透明、高对比或不支持 backdrop-filter 的环境不挂载折射实例；Safari/Firefox 位移折射仅部分支持，不能承诺与 Chromium 相同。没有使用 shader、持续弹性跟随、外部字体、远端图像或 CDN。

## 构建与验证

横向标签栏采用透明无框布局，不使用圆角背景；补齐按钮内边距，以细底线表示选中。标题工具区不添加玻璃框。窄屏在标签栏内部滚动，不挤压正文，官方点击、键盘和ARIA关联保留。

```sh
pnpm build
pnpm typecheck
pnpm exec eslint packages/ui/liquid-glass/src
pnpm exec vitest run packages/ui/liquid-glass tests/composition.test.ts
node scripts/verify-liquid-glass.mjs
node scripts/verify-theme-candidate.mjs <候选绝对路径>
pnpm verify:dsh-brand
pnpm verify:official-integrity
```

浏览器验证需要本机 Chromium，默认 `/usr/bin/chromium`，可通过 `CHROMIUM_PATH` 指定。脚本只启动临时 localhost 页面和独立浏览器 profile，结束时关闭其进程；不读取 `.env` 或联系生产。截图与文案输出到 `docs/evidence/liquid-glass-theme/`，临时 profile 留在输出报告指定位置，不清理已有用户文件。

示例使用真实 Cordis、官方 ThemeRuntime、SlotRegistry 与 React；Host settings 和身份响应为测试实现，会话是空选中适配器。官方通用设置页不在示例中装配，其未使用的图标/store 引用设置为调用即失败的桩。`GLASS_RELEASE_ROOT` 可指定候选目录以验证实际发行的客户端产物。本示例可证明本插件的装配、刷新、账号区分、交互和释放，不等于完整生产账户、聊天或 Windows 实机验收。

客户端通过官方 ModuleLoader 共享 React，不打包第二份 hooks runtime。上游库 MIT 许可证见 `THIRD_PARTY_LICENSES.txt`。官方依赖完整性保持零补丁。

版本兼容例外：GitHub master 的 1.1.1 元数据支持 React >=18，而 npm 发布包的 peer 写为 >=19。此项目固定 React/ReactDOM 18.3.1，已通过真实浏览器调用与生命周期测试；根 pnpm 配置只为该库的这两个 peer 声明精确兼容范围，不更改 DSH 的 React、不全局关闭 peer 检查。后续升级库或 React 必须重新验收。

## 桌面接入交接

主题共享源码应由 Web 分支合入 `desktop`，不要反向合并桌面整分支。桌面目前固定另一版 DSH：接入前必须核对其 `ThemeRuntime.overrideTokens` 双色覆盖、`settings.section` 与 ModuleLoader 接口，随后在独立候选中构建和实机测试。不要为此改社区子模块或私自升级桌面 DSH。此次 Web 主题开发没有修改桌面依赖、生成桌面安装包或切换生产。
