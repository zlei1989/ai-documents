# 90 · Archify 图示引擎

> 状态：已接入，唯一图示引擎。普通 SVG 图片只读展示；不再有 `diagram_*` 工具、SVG 编辑器或自由 SVG 生成链路。
> 上游：[tt-a1i/archify](https://github.com/tt-a1i/archify) v3.1.0，MIT；调研见 [archify-integration](../research/archify-integration.md)。

## 90.1 目标与非目标

**目标**

- AI 用 Archify JSON IR 生成架构/流程/时序/数据流/状态/ERD/类/树/时间线/瀑布图。
- `MAIN.md` 用标准 Markdown 图片引用海报，不引入自定义围栏/iframe。
- 右键海报打开交互 viewer；结构编辑器改 IR、实时预览、校验、保存。
- 人改过之后，AI 下一轮基于源 JSON 继续改；revision 冲突可检测。
- 普通 SVG/图片作为只读附件展示，不再提供生成或编辑能力。

**非目标（v1）**

- Archify 图的像素拖拽/WYSIWYG。
- 文档内联交互 HTML；提交 viewer HTML。
- 所有 10 类型的完整可视化表单（5 种结构表，其余 JSON）。
- 普通 SVG 的编辑/生成；旧 SVG 编辑器已移除。
- brand marks、repository evidence、代码库溯源、自动更新。
- 运行时 Chromium/Playwright 依赖；在线安装 Archify。

## 90.2 文件布局

```text
<artifact>/
  MAIN.md
  assets/diagrams/
    x.archify.json      # 源 IR（提交；唯一真相）
    x.archify.svg       # 独立海报（提交；Markdown 引用）
  .aidocs/archify/
    diagrams/x.archify.html       # viewer 缓存（gitignore）
    diagrams/x.meta.json          # sourceRevision/htmlSha/posterSha/warnings
    preview/<hash>.html           # 实时预览缓存（gitignore，最多 12 份）
```

- 源命名：`<slug>.archify.json`；海报 = 源名把 `.archify.json` 换成 `.archify.svg`；同名自动 `-2`。
- `meta.output` 固定指向 `.aidocs/archify/<rel>.archify.html`（portable POSIX 相对路径）；服务端覆盖模型给的值。
- 交互 HTML 不提交；源 JSON 与海报提交。文档换机器仍显示海报，交互版可再生成。
- Markdown：`![标题](assets/diagrams/x.archify.svg)` 单独一行。
- 普通 `.svg` 仍可放在 `assets/`，只作为图片展示，不能通过 App 生成/编辑。

## 90.3 引擎与生成工具

全项目只有一组图示工具：

| 工具 | 参数 | 行为 |
|---|---|---|
| `archify_guidelines` | `type`, `full?` | 返回该类型紧凑规范：结构数组、必填字段、枚举、最小 skeleton、布局要点；`full` 附完整 schema |
| `archify_save` | `type`, `ir`(JSON string/object), `title?`, `path?`, `quality?`, `autoLayout?` | 清理离线字段 → 新图默认自动排版（architecture 摆位、workflow 补卡片尺寸）→ 注入 meta → validate + 布局体检 → render → 提取海报 → 原子写 JSON/SVG/HTML/meta → 返回 Markdown 引用、revision 与布局建议 |

- `tools` 闭集：`ARCHIFY_TOOL_NAMES` 同时加入 `extensionFactories` 与 `tools`；不存在 `diagram_guidelines`/`diagram_save`。
- 默认：`meta.locale=zh-CN`、`meta.visual_preset=classic`、`meta.animation=trace`、`meta.quality_profile=showcase`；quality 可切 standard。
- 更新已有图：`path` 指向 `.archify.json`；AI 角色不要求 `baseRevision`，编辑器保存要求。
- 校验失败：返回 diagnostics（code/subject/evidence/supportedFixes），不写正式文件。
- 成功后：AI 工具清 marker；编辑器保存记录 marker。

## 90.4 渲染与海报

- CLI：`node <vendor>/bin/archify.mjs validate|render ...`，`spawn` 参数数组、不经过 shell；timeout 45s；maxBuffer 64MB；`ARCHIFY_UPDATE_CHECK_DISABLED=1`。
- 渲染不跑 `finalize`/`deliver`（避免 Chromium browser-check）。
- 海报提取：
  1. 定位主 SVG（`aria-labelledby="archify-diagram-title"`）；
  2. 注入 HTML 全部 `<style>`；
  3. 固定 `data-theme=light`、width/height 来自 viewBox、去动画/reader 状态；
  4. `@xmldom/xmldom` 解析/序列化；移除 script/foreignObject/iframe/object/embed/animate/on*/外部 href；CSS 拒绝 `@import` 与外链；
  5. 限额 768KB；超限先去 `@font-face`；仍超限报错并保留 last-good；
  6. 写 `<slug>.archify.svg`。
- 海报是**只读快照**；卡片只在 viewer 里，海报保留主图/legend。

### 布局体检与自动排版

- `validate` 对 architecture/workflow 追加 `--layout-json`，拿到渲染器实际几何（节点/边/标签坐标）。
- 本地 lint（`packages/server/archify/src/layout.ts`）检查：折点数、<12px 贴边、边穿节点/边交叉、标签压节点、字号 <8/9px、同泳道顶部差、画布长宽比/宽度、卡片尺寸一致性；输出 `{score, summary, issues}`，issue 复用 `ArchifyDiagnostic`（severity=warning，code=`layout/*`）。
- 报告写入 `.aidocs/archify/**/*.meta.json` 的 `layout` 字段，保存/校验/预览响应带回；`archify_save` 的文本结果列出前 6 条建议，编辑器显示分数与面板。
- 自动排版只在**新图**默认开启（更新已有图保留坐标；`autoLayout:true` 可强制重排）。architecture 采用「主路径 L 形 + store 在 owner 正下方 + security 在上方 + 统一卡片」；有 boundaries/环/超过 24 个组件时跳过，缺坐标时退回网格兜底。workflow 只补 `width/height`（同 lane 高度一致、sublabel 至少 8px），并清掉旧 viewBox/绝对路由钉点。
- 普通 SVG 资源也走同一 poster 净化后展示（保留 class/style，禁脚本/事件/外链），但不提供编辑。

## 90.5 交互 viewer

- 缓存 HTML 由 `GET /api/docs/:group/:name/archify-view/[...path]` 提供；`[...path]` 为完整源路径（含 `assets/`）。
- 缓存 sidecar 记录 sourceRevision；不一致时重新 validate/render；失败保留 last-good。
- 响应头：

```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Cache-Control: no-cache
```

- 前端 iframe：`sandbox="allow-scripts"`（不加 same-origin），不授予顶层导航/popup。
- 生成后注入选择桥：点击 `[data-node-id]` → `parent.postMessage({source:'aidocs-archify',type:'select',id})`；父窗口 `{source:'aidocs',type:'focus',id}` → 节点 click。父窗口校验来源和 id 格式。

## 90.6 实时预览

编辑器改动结构/JSON/预设后，不等保存就更新右侧 viewer：

- 600ms 防抖；请求 `POST /api/docs/:g/:n/archify-preview` `{type, ir, quality}`；
- 服务端 `previewArchifyIr` 先 validate，再 render 到 `.aidocs/archify/preview/<sha256>.html`，注入选择桥，不写源/海报/marker；
- 返回 `{ok, diagnostics, warnings, layout, previewUrl}`；同一 IR 命中缓存直接复用（HTML + `.json` sidecar 保存布局报告）；
- 编辑器把 iframe 切到 `previewUrl`，header 显示「实时预览 / 预览更新中… / 校验未通过」；
- 非法 IR 保留上一次成功预览并展示 diagnostics；保存成功后再切回正式 viewer URL；
- 预览缓存最多保留 12 份（HTML + `.json` sidecar），自动清理最旧。

路由：`POST /api/docs/:g/:n/archify-preview`（创建）+ `GET /api/docs/:g/:n/archify-preview/[...path]`（读取，沙箱 CSP）。

## 90.7 API 与契约

契约（`packages/server/contracts`）：`ArchifyTypeSchema`、`ArchifyDiagnosticSchema`、`ArchifyLayoutReportSchema`、`ArchifyLayoutInputSchema`、`ArchifyLayoutResultSchema`、`ArchifySummarySchema`、`ArchifyDocumentSchema`、`ArchifySaveInputSchema`、`ArchifyValidateInputSchema`、`ArchifyPreviewInputSchema`、`ArchifyPreviewResultSchema`、`ArchifyAiInputSchema`、`ArchifyAiResultSchema`；`ToolNameSchema` 增加 `archify`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/docs/:g/:n/archify/[...path]` | 读源 IR、revision、海报/交互 URL |
| PUT | `.../archify/[...path]` | 保存 IR；validate/render/poster/cache；`baseRevision` 冲突 409 |
| POST | `/api/docs/:g/:n/archify-validate` | 只校验不写盘；`{type, ir, quality}` |
| POST | `/api/docs/:g/:n/archify-preview` | 实时预览渲染；不写正式文件 |
| POST | `/api/docs/:g/:n/archify-layout` | 排版：返回变换后的 IR（architecture 摆位 / workflow 补尺寸），不写盘 |
| POST | `/api/docs/:g/:n/archify-ai` | 直接调 pi 模型改/修 IR；`{mode:'edit'|'repair', type, ir, instruction?, diagnostics?}`；只返回草稿 + 诊断 |
| GET | `/api/docs/:g/:n/archify-preview/[...path]` | 预览 HTML（sandbox CSP） |
| GET | `/api/docs/:g/:n/archify-view/[...path]` | 正式 viewer HTML；按 revision 再生成 |

- `path` 使用完整 asset 路径，如 `assets/diagrams/x.archify.json`；服务端也接受省略 `assets/` 的相对路径。
- 资源路由 `GET /api/docs/:g/:n/assets/[...path]` 对 SVG 走 poster 净化；不提供 SVG 编辑 API。

## 90.8 结构编辑器

全屏 overlay，左侧结构/JSON，右侧实时交互预览。

- 类型化结构表：architecture（components/connections + pos/size）、workflow（nodes/edges + lane/col）、sequence（participants/messages + y）、dataflow（nodes/flows + stage/row）、lifecycle（states/transitions）。
- 「排版」按钮（architecture/workflow）调用 `archify-layout`；结果写回编辑器 IR，走实时预览，保存后才落盘。
- 其它类型（ERD/class/tree/timeline/waterfall）v1 用 JSON 编辑 + 实时预览；高级字段（boundaries/cards/phases/segments/activations/layout）在任何类型都原样保留。
- JSON 标签：「应用到预览」解析后写回 IR、立即请求预览；语法错误就地提示，不发请求。
- 一句话改图：JSON 文本下方输入框 → `POST archify-ai {mode:'edit', instruction}`。服务端**直接调 pi 的模型接口**（`ModelRuntime.complete`，不建 agent 会话），要求模型只返回 `{summary, ir}` 结构化 JSON；成功后写回 JSON 草稿并立即预览，不写盘。
- 校验自动修复：`校验` 失败时自动带 diagnostics 调 `archify-ai {mode:'repair', diagnostics}`。模型输出先过 Archify schema；仍有错就再修一次；修复结果写回草稿/诊断/预览，header 显示「AI 修复中… / AI 已修复」。仍失败则如实显示，不再递归。
- 节点 id 改名级联 from/to/parent/wraps/mainPath；删除节点清理关系与引用。
- 校验：`校验` 按钮只校验（失败后按上一条自动修复）；保存前服务端再校验。diagnostics 显示 code/message，表格行按 subject.path 标红。
- 保存：`PUT {ir, baseRevision, quality, force?}`；409 弹「重新加载/覆盖保存」；保存成功重置 revision/dirty/history，海报用 `?v=epoch` 刷新。
- 实时预览：600ms 防抖、后台渲染、失败保留 last-good；点击节点选中左侧行；选中行发 focus。
- 布局体检：header 显示分数/summary；左侧结构表下方用琥珀色面板列出 `layout/*` 建议（含 fix），不阻塞保存。
- 撤销/重做 40 步；Cmd/Ctrl+S、Esc 关闭确认、beforeunload。
- 不做像素拖拽；architecture 的 pos/size 用数字字段。

## 90.9 入口与回注

- `MarkdownImage` 识别 `.archify.svg`，`archify=true`；提示「右键复制图片 / 打印 / 打开交互图示 / 编辑 JSON」。
- `/workspace` 右键菜单：复制图片（PNG，SVG 自动栅格化）、打印（新窗口只放这张图，加载完调起系统打印）、加入对话上下文、打开交互图示、编辑 JSON、复制路径、复制 Markdown 引用；普通 SVG/图片只读，没有交互/结构入口，但仍可复制图片、打印、加入对话上下文或复制路径。
- `/docs` 只读：**点击 Archify 海报在新标签打开交互 viewer**（不带 `embed`，保留 Archify 自带工具栏/侧栏）；普通图片不可点，也没有右键菜单。创作页保存后递增 `imageEpoch`，海报重取。
- marker 复用 `.aidocs/diagram-edits.json`，记录 `.archify.json` 路径；下一条消息注入提醒；`archify_save` 成功后清除。
- 提示词要求：所有图示都用 Archify；普通 SVG 只读；改图先 read 源 JSON；不要 read/改海报 SVG；不要用 write 直接改源 JSON。

## 90.10 安全与限额

- 不增加 bash/MCP；CLI 子进程用参数数组，cwd/输出受限。
- 离线：移除 `brand`/`repository`/`sources`；不传 repo root；不跑 browser check；不联网。
- 海报/普通 SVG：≤768KB；script/foreignObject/事件/外链禁止；CSP `script-src 'none'`、`font-src data:`。
- viewer/预览：CSP sandbox + iframe sandbox；`connect-src 'none'`；模型只能写 IR，不能写 HTML。
- 路径：源/海报限定 `assets/`，缓存限定 `.aidocs/archify/`；拒绝 `..`、绝对路径、反斜杠、隐藏段、符号链接。
- revision：源 JSON sha256；编辑器冲突 409；AI 工具更新不要求 revision（提示词要求先 read）。
- vendor：固定 v3.1.0 + LICENSE/THIRD_PARTY_NOTICES；`AIDOCS_ARCHIFY_ROOT` 可覆盖；不自动更新。

## 90.11 测试与验收

自动化：

- `packages/server/archify/src/archify.test.ts`：10 种 skeleton 校验；保存/读取/续存/view/实时预览；非法 IR 不写；海报 light/style/无 script/<800KB；新图自动排版/更新保留坐标；原始坏布局被体检标出；8 节点示例自动排版 100 分。
- `packages/server/archify/src/layout.test.ts`：architecture L 形摆位、boundaries/环跳过；lint 折点/贴边/画布/卡片；workflow 宽度与同 lane 高度、字号/对齐诊断。
- `packages/server/api/src/archify.test.ts`：保存/读取/列表/validate/view/preview、revision 冲突/force、路径穿越、海报 CSS 保留。
- `packages/server/agents/src/archify.test.ts`：工具注册、skeleton、保存/更新（无需 baseRevision）、diagnostics；不再有 `diagram_*`。
- `packages/server/agents/src/archify-ai.test.ts`：结构化回复解析（裸 JSON/围栏/前后解释/缺 ir）、edit/repair prompt 内容与诊断瘦身。
- `apps/web/tests/archify-api.test.ts`：路由 GET/PUT/validate/preview/view、CSP、409、海报路由、非法路径。
- `apps/web/tests/archify-ai-api.test.ts`：`archify-ai` 入参（edit 缺 instruction、repair 缺 diagnostics）→ 400，不触达模型。
- `apps/web/tests/archify-model.test.ts`：改名级联、删除清理、新增节点/关系、诊断路径。
- 普通 SVG 资源只读净化测试（`packages/server/api/src/diagrams.test.ts`）。

手动验收：

1. AI 画三层网关架构图，海报落盘并在 MAIN.md 引用。
2. 创作页右键海报、只读页点击海报，都能打开 viewer；编辑结构改标签，**不保存**右侧预览即更新；保存后海报/viewer 同步刷新。
3. 点击 viewer 节点选中左侧行；校验按钮反馈通过/诊断；非法 IR 保留上一次预览。
4. JSON 下方输入「把 X 改成 Y」，JSON 与右侧预览更新；故意删掉必填字段后点「校验」，自动出现「AI 修复中…」并修复回草稿。
5. 手动保存后 AI 基于源 JSON 继续改，改动保留。
6. 编辑器打开时 AI 改同一图，保存 409，可重载/覆盖。
7. 普通 SVG 没有「编辑图示」入口；不能通过 API 保存 SVG。
