# 00 · 总览

> 交付物：`docs/spec/` 全套。由 wayfinder 地图 01–09 号决议装配而成，逐条可追溯到 `wayfinder/tickets/`。
> 目标读者：负责实现本应用的 agent / 工程师。

## 一句话

一个**纯本地**的 markdown 创作应用：把「一类文档怎么写」沉淀成可复用的 **ArtifactType**（提示词 + 技能 + MCP + 资源），在**文档工作区**里边聊边写，产物落成 `MAIN.md` + 附件目录，全程 git 版本化。

## 北极星闭环（v1 完成线）

```
配置 ArtifactType（方法论）
        │
        ▼
选类型 → 开聊 → AI 用文件工具直接改 MAIN.md → 消息流展示 → 手动收起 → 文档可见
        │                                   ▲
        └── 一键跳到类型编辑改方法论 ─────────┘（会话不断，下一轮生效）
```

只要这条环路顺畅，v1 就成立。

## 目标（v1）

| # | 目标 |
|---|---|
| G1 | 类型管理：创建/复制/删除 **ArtifactType**，编辑提示词、勾选全局技能与 MCP、管理资源文件树 |
| G2 | 文档管理：**Group → Artifact** 两级；Artifact = 一个目录，入口 `MAIN.md` |
| G3 | 创作对话：多会话（头部列表新建/切换，上下文隔离）、流式消息、工具调用可视化、附件与选区上下文注入、手动收起 |
| G4 | 类型快捷往返：创作 ↔ 类型编辑，独立路由，会话不断 |
| G5 | 版本化：storageRoot 是 git 仓库，自动 commit + 历史/diff/回滚 UI + 手动拉取/推送（冲突交给 pi） |
| G6 | 设置：模型供应商、存储目录、全局 MCP、全局 Skills |
| G7 | 模型选择三层：全局默认 / 类型锁定 / 会话临时切换 |
| G8 | 图示：AI 用 Archify JSON IR 生成结构图，MAIN.md 用标准 Markdown 引用 SVG 海报；右键打开交互 viewer / 结构编辑器，实时预览，保存回源 IR |
| G9 | 生图：一个 `seedream_image_generation` 工具覆盖文生图/图生图/融合/图层拆分/交互编辑/组图/流式/联网搜索；参考图先上传方舟 Files API（1 天过期），生成图落 `assets/images` 并在消息流拼格子、放大、右键复制图片或加入上下文 |

## 非目标（v1 明确不做）

- 多用户、鉴权、远端部署（纯本地 localhost 个人工具）
- git 分支管理 UI（只有历史 + diff + 回滚；分支走命令行）
- 移动端适配（桌面浏览器）
- 多人实时协作、评论、审批流
- 类型导出/分享打包（后续；目录本身已可拷贝）
- 大附件 LFS 策略（v1 只给提示，不做自动 LFS）
- 普通 SVG/栅格图片编辑；Archify 的像素拖拽/WYSIWYG（v1 用语义化结构编辑）

## 术语

见 [../GLOSSARY.md](../GLOSSARY.md)。核心四个：

- **ArtifactType（类型）**：方法论包 = `prompt.md` + `type.yaml`（勾选 skills/mcp/model）+ `resources/`
- **Artifact（产物）**：一篇文档 = 目录 + `MAIN.md` + `assets/` + `research/` + `sessions/`
- **Group（分组）**：Artifact 的一级归类
- **消息流**：创作过程中的块状事件流（文本 / 思考 / 工具 / 附件），完成后手动收起

## 技术栈（一屏速览）

| 层 | 选型 |
|---|---|
| 应用 | Next.js 16（App Router）+ React 19 + TypeScript 5.9 |
| UI | **shadcn/ui（Base UI 原语）** + Tailwind v4 + lucide-react + sonner |
| 表格/表单 | TanStack Table、react-hook-form + zod |
| Markdown | react-markdown + remark-gfm（CommonMark + GFM 表格/删除线/任务列表/脚注/自动链接；图片仍只渲染 assets/ 本地资源，外链不发请求） |
| 数据 | SWR + fetch；SSE（非 WebSocket） |
| 内核 | **pi** `@earendil-works/pi-coding-agent@1.3+`（in-process SDK），Node **≥ 22.19** |
| 存储 | 文件系统 + git，无数据库 |
| 图示 | Archify 唯一图示引擎：vendor CLI + JSON IR + SVG 海报 + sandbox viewer + 结构编辑器 + 实时预览；普通 SVG 只读 |
| 测试 | vitest 4（jsdom / node 两档） |

## 交付物索引

| 文档 | 内容 |
|---|---|
| [10-storage.md](10-storage.md) | 磁盘布局、git 版本化、会话落盘 |
| [20-architecture.md](20-architecture.md) | 包结构、依赖方向、pi 嵌入装配、会话生命周期 |
| [30-streaming.md](30-streaming.md) | SSE 协议、事件持久化、消息块模型 |
| [40-flows.md](40-flows.md) | 创作闭环、类型往返、Git 操作流、附件注入 |
| [50-settings.md](50-settings.md) | 五个设置页（含类型管理）+ 模型三层 |
| [60-ui.md](60-ui.md) | 布局（可拖三栏）、编辑器、类型编辑器、文件管理器 |
| [70-adr.md](70-adr.md) | 决策索引（ADR 清单，回链票） |
| [80-handoff.md](80-handoff.md) | 实现顺序、里程碑、风险与验证点 |
| [90-archify.md](90-archify.md) | Archify 图示：IR 源 / SVG 海报 / 交互 viewer / 结构编辑器 / 实时预览 / 安全 |
| [95-seedream.md](95-seedream.md) | 生图：Seedream 单工具、Files API 参考图上传、资产落盘、消息流图片结果 |
