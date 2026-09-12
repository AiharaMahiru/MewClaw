# 液态玻璃主题：官方扩展点与复验入口

新行为由 `dsh-lark-liquid-glass` 独立插件提供。全局配色只使用官方 `ThemeRuntime.overrideTokens`，双色成对，不调用 `setTheme` 写用户偏好；自有设置页使用 `settings.section` 的 list entry。没有包装官方 root/sidebar/conversation，也没有选择官方私有 class。

`liquid-glass-react@1.1.1` 仅负责自有 React 容器，关闭 shader/弹性与鼠标跟踪；React/jsx-runtime 通过 DSH ModuleLoader 共享。上游包的 ESM/CJS 声明不一致，仅在适配器使用窄类型断言，构建后的浏览器组件实际调用由验收覆盖。组件的位移层在亮色下会溢出圆角，使用自有传入 style 的 clipPath 裁切；切换玻璃/静态结构后恢复按钮焦点。

Host 使用公开 tapIndex 传递已校验的非敏感配置；无配置/disabled 不产生客户端贡献。所有注册及监听器使用 Cordis effect 或 React effect。恢复原主题、fiber 卸载与多次重新加载均验证下层 token 和官方偏好保留。默认组合不启用，生产与桌面另行验收。

供应链元数据差异：GitHub master 声明 React >=18，npm 1.1.1 声明 >=19。未升级官方 React；新增包的开发依赖固定 18.3.1，并用只作用于 `liquid-glass-react@1.1.1` 的 `pnpm.peerDependencyRules.allowedVersions` 记录经过浏览器验证的 React/ReactDOM 18.3.1 兼容范围。这不是全局跳过 peer 检查，也不是对官方依赖打补丁。

复验：`pnpm build`、`pnpm typecheck`、`pnpm exec vitest run packages/ui/liquid-glass tests/composition.test.ts`、`node scripts/verify-liquid-glass.mjs`、品牌与官方完整性门禁。浏览器用真实官方 ThemeRuntime 和 SlotRegistry；内存 Host settings、空会话适配器与未装配的官方通用设置行不代表生产 E2E。无密钥文案基线在 `packages/ui/liquid-glass/tests/appearance.snapshot.txt`，本地截图/证据按仓库规则保持 ignored。
