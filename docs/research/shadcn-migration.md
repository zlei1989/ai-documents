# Research · shadcn 组件映射与迁移方案（票 09）

触发：用户定调「UI 库彻底换成 shadcn」，取代原定 antd 6。本票把替换落到组件级，并给出技术栈结论。

## 1. 技术栈结论

| 层 | 选型 | 依据 |
|---|---|---|
| 组件来源 | **shadcn CLI（源码 copy-in）**，不用 npm 包直接引 | shadcn 不是运行时依赖，组件以源码进 `packages/client/ui/src/components/ui/`；与「源码直导 exports」的 monorepo 纪律天然契合 |
| 样式 | **Tailwind CSS v4** | shadcn 现状：Tailwind v4 下 `components.json` 的 `tailwind` 配置留空 |
| 无障碍原语 | **Base UI**（shadcn 自 2026-07 起的**默认库**） | 与 Radix 同一批人做的继任者；shadcn 为它重建了全部组件且**保持同一抽象**——`@/components/ui/*` 的 import 与 API 不变，只有底层实现不同。新项目用 `npx shadcn create` 选 Base UI 即可 |
| 图标 | **lucide-react** | shadcn 默认图标库 |
| 提示 | **sonner** | shadcn 官方 toast 方案 |
| 表格 | **shadcn Table + TanStack Table** | shadcn 无 data-table 组件，官方给的是「Table 组件 + 自建 data table」指南 |
| 表单 | **react-hook-form + shadcn Form + zod** | 与现有 zod 契约层同栈 |
| 暗色 | **next-themes** | shadcn 文档默认配套 |
| 流式 markdown | **`streamdown@2.7.0`**（Vercel，Apache-2.0，React 18/19 peer） | 专为 AI 流式输出设计、react-markdown 的 drop-in 替代；另有 `@streamdown/cjk`（中文排版）、`@streamdown/mermaid`（流程图！与「画流程图」方法论直接相关）、`@streamdown/math` 插件 |
| diff 渲染 | **保留 `react-diff-viewer-continued@4.4.0` + `diff@9`**，外壳用 shadcn 重写 | 该库不依赖 antd；参考仓库 `diff-view.tsx` 的外壳（Alert/Empty/Skeleton/吸顶）需按 shadcn 原语重写 |

monorepo 注意（shadcn 官方要求）：每个 workspace 都要有 `components.json`，且 `style` / `iconLibrary` / `baseColor` 保持一致；CLI 靠 alias 在 workspace 间路由文件。

## 2. 组件映射表（antd → shadcn）

| 原 antd 用途（参考仓库里的位置） | shadcn 方案 |
|---|---|
| `Table`（providers / mcp servers / skills 列表） | `Table` + TanStack Table（排序/过滤/分页自建） |
| `Modal`（provider 表单、MCP 表单） | `Dialog`（+ `react-hook-form`） |
| `Drawer`（agent-log 抽屉、skill 预览） | `Sheet`（右侧滑出，交互同构） |
| `message` / `notification` | `sonner` 的 `toast` |
| `Form` / `Input` / `Select` | `Form` + `Input` + `Select`/`Combobox`（`Command` + `Popover`） |
| `Tabs`（settings 四 Tab） | `Tabs` |
| `Tree`（skills 目录树、分组文档树） | **无官方组件**，自建受控树（`Collapsible` + 递归）；保持「左树右详情」形态 |
| `Tag` / `Badge` | `Badge` |
| `Tooltip` / `Popover` / `Dropdown` | 同名 shadcn 组件 |
| `Switch` / `Checkbox` / `Radio` | 同名 shadcn 组件 |
| `Card` / `Descriptions` | `Card` + `dl` 布局 |
| `Empty` / `Skeleton` / `Spin` | 自建 `EmptyState` + `Skeleton`（`Loader` 用 `lucide-react` 的 `Loader2` 旋转） |
| `Alert`（截断提示、错误提示） | `Alert` |
| 应用侧边栏 | `Sidebar` block |
| `@ant-design/x-markdown`（流式 markdown） | `streamdown`（+ `@streamdown/cjk`；流程图场景加 `@streamdown/mermaid`） |
| `@ant-design/icons` | `lucide-react` |
| antd 主题 / 暗色 | `next-themes` + CSS 变量 |
| 附件块 `attachment-block-view`（antd 壳） | shadcn 重写：`Card`/`Badge` + 文件图标 |

## 3. 对既有决议的修正

- **票 02 迁移表**里「settings 页组件（provider-table / provider-form-modal / mcp-server-* / skill-table / skill-detail-drawer）**搬**」→ 修正为：**行为与纪律照搬，UI 全部按 shadcn 重写**。要保住的不是组件代码，而是那些口径：密钥掩码单出口、`preview→import` 两步拉模型、树+详情抽屉、测试连接探针四态、SSE 具名事件等纯逻辑层。
- **票 05/06 原型**：原型一律用 shadcn + Tailwind 出，不再参照 antd 视觉。「文档主位 + 右侧聊天栏」的布局决策不变，但视觉语言从「后台控制台」转向「编辑/写作工具」——这正是换 shadcn 的收益点。
- 参考仓库里 `diff-view.tsx` 的外壳、`agent-log` 的组件外壳都不能直接搬（import 的是 antd），只有**行为规范与状态机**可搬。

## 4. 风险与注意

1. shadcn 组件是 copy-in 源码：升级靠 `npx shadcn diff` + 手工合并，需要把「组件目录视为自有代码」纳入规范。
2. TanStack Table 的自行组装成本 > antd Table 开箱即用；settings 页三张表是本项目表格的全部需求，可控。
3. `streamdown` 的 CJK 排版依赖 `@streamdown/cjk` 插件，接入时验证中文标点/换行表现。
4. Tailwind v4 与 Next 16 的 PostCSS 配置需按 shadcn 官方 Next 指南走，别沿用旧 v3 配置。
5. 视觉回归：换库后所有页面都要重新过一遍暗色/亮色两套。
6. Base UI 路线相对新（2026-07 才成为默认）：组件 API 与 Radix 同抽象，但边角行为（焦点管理、动画钩子 `data-*` 属性）有细微差异——遇到问题以 Base UI 文档为准，别照抄 Radix 时代的教程。

## 结论一句话

**Next 16 + Tailwind v4 + shadcn（Base UI）+ lucide + sonner + TanStack Table + react-hook-form + next-themes + streamdown**；antd 组件全部按映射表重写，参考仓库只保留行为纪律与纯逻辑层，UI 代码零搬。
