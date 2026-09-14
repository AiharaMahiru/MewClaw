# dsh-lark-model-seat SPEC（composer 模型位：思考强度优先）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-model-seat`（Plugin，web bundle 宿主空壳 + client slot shadowing） |
| 位置 | `packages/lark/model-seat/` |
| 角色 | composer `conversation.input.model` 单一槽位的定制占位者（slot priority shadowing） |
| 里程碑 | 后迁移 UX 定制 |
| 状态 | implementing |
| 依赖能力 | 客户端 `ctx.slots`、`ctx.modelDirectories`、`ctx.sessions` |
| 提供能力 | 思考强度优先的模型触发器（滑条视图 + "更多"模型清单）、官方模型菜单 sticky 分组标题的安全网样式修正 |

## 1 目的与边界

官方 `dsh-client-ui-model-selection` 的 composer 触发器点击后直接展开按 provider
分组的模型清单。本插件把该槽位替换为"思考强度优先"交互：

- 点击触发器 → 弹出层默认展示**当前模型思考强度的横向分段滑条**（含"默认"档），
  上方有"更多"字样入口；
- 点击"更多" → 同一弹出层切换为 provider 分组模型清单（自绘，非 sticky 标题）；
- 选择档位/模型经共享 `ModelDirectory.select()` 提交，与 `/model` 命令同一状态源。

非目标与硬约束：不改官方包；不复制官方菜单组件；官方注册保留但通过
`priority: -1` shadowing 让本组件渲染（slot 语义：同 cell 低 priority 获胜）。
工作区徽标等其他槽位不受影响；`/model` slash 弹窗保持官方实现。

## 2 服务契约

```ts
// 宿主侧：空插件（官方 cordis-client-runner 同款范式——占位行让装载器发现 dsh.client）。
export const name = "dsh-lark-model-seat";
export function apply(ctx: Context): void;   // no-op

// 客户端 client.js（__ModuleLoader__ 工厂）：
//   inject: ["slots", "modelDirectories"]
//   apply(ctx):
//     ctx.inject(["slots", "modelDirectories"], scope =>
//       scope.slots.inject("conversation.input.model", () =>
//         scope.slots.register({ name, priority: -1, inject: sessionId => Face }, Seat)))
//   Face = { available, directory: SnapshotStore, load(), select(selection) }
//        —— 与官方 inject 工厂同一实现（subagent 会话 available=false）。
```

组件 props：runtime `{ sessionId, locked }` + Face。渲染规则：

- `locked || !available` → 触发器禁用态，不展开。
- `current === null`（尚无选择）→ 直接进模型清单视图。
- 档位列表 = 当前模型 `reasoning.efforts`；"默认"档提交省略 `reasoningEffort`。
- 切模型只提交 `{ provider, model }`（新模型回 provider 默认档位）。
- 无 `reasoning` 的模型显示"该模型不提供思考强度档位"提示而非空滑条。

## 3 配置契约

无配置。

## 4 事件契约

无（不新增事件；`select` 走官方 session `selectModel` RPC，会话侧投影不变）。

## 5 模型可见面

无（纯 UI；模型选择结果仍经官方投影进入会话，模型可见面无变化）。

## 6 行为契约

- 弹出层 `position: fixed`，锚定触发器上方；外部 pointerdown / Escape 关闭。
- 打开弹出层即调 `load()` 确保目录加载；目录 `status`/`error` 原样展示在清单视图。
- 档位/模型点击即提交并关闭；提交失败由共享 store 的 `error` 态呈现。
- 注入一次 `<style data-plugin-css="dsh-lark-model-seat">`：本组件样式 +
  `._7KE1Ra_groupTitle{position:static}` 安全网（官方菜单其它入口残留时不再出现
  吸顶黑底条；类名漂移时规则失配即失效，无副作用）。

## 7 测试契约

- 假 slots/modelDirectories 上下文：注册到 `conversation.input.model` 且
  `priority: -1`；inject 工厂产出 Face 四字段。
- 组件单测（假 React/createElement 收集器）：
  - 打开默认渲染 effort 视图：分段数 = efforts + "默认"档，激活档 =
    `current.reasoningEffort ?? reasoning.defaultEffort`；
  - "更多"切换到清单视图：分组标题 + 模型行，当前模型带选中标记；
  - 点击档位 → `select({provider, model, reasoningEffort})`；点击模型 →
    `select({provider, model})`；`locked`/`!available`/`current:null` 的退化分支。
- `pnpm build` 产出 `client.js`（esbuild 脚本清单含本包入口）。

## 8 发布契约

`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-model-selection` 等客户端
依赖；`packages/bundle/web/cordis.patch.yml` 挂载宿主插件；官方 model-selection
包保持原样（升级时核验 `conversation.input.model` 槽位与 shadowing 语义仍在）。

## 9 兼容性

- 移除/禁用本插件即回退官方模型选择器（官方注册未被修改，priority 0 恢复渲染）。
- 官方 rc 升级若变更槽位名/优先级语义，本组件注册会 fail loud（槽位未声明即抛错），
  属预期硬失败，升级门禁覆盖。

## 10 开放问题

- 档位名跟随官方 `ModelReasoningEffort.name`（英文档位名）；如需中文档位列，
  待官方 locale 或目录字段扩展后再接。
