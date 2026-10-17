# Archify 调研：把结构图引擎接进 ai-documents

> 调研日期：2026-10-17
> 上游：[tt-a1i/archify](https://github.com/tt-a1i/archify) v3.1.0（MIT，Node ≥18）
> 相关规范：[90-archify.md](../spec/90-archify.md)

## 结论

**旧自由 SVG 编辑器已移除**。把 Archify 当作唯一图示引擎：

- Archify JSON IR 是唯一真相，落 `assets/diagrams/<slug>.archify.json`；
- 独立 SVG 海报落 `assets/diagrams/<slug>.archify.svg`，MAIN.md 用标准 Markdown 图片引用；
- 交互 viewer HTML 落 `.aidocs/archify/` 缓存，由 App 全屏沙箱 iframe 打开；
- 编辑入口是**语义化结构编辑器**（结构表 / JSON + 实时预览），不是拖 SVG；
- 普通 SVG/图片只读展示；不再有自由 SVG 生成/编辑器。

这样同时拿到 Archify 的布局/校验/视觉质量、Markdown 的可移植性，以及适合 AI 与人的可编辑 IR。

## Archify 是什么

- Agent Skill + 零依赖 Node CLI，不是前端组件库或 WYSIWYG 编辑器。
- 模型编写类型化 JSON IR，renderer 做 schema 校验、布局、路由、标签避让，输出**自包含 HTML**（内联 SVG + viewer 脚本/CSS/字体）。
- 10 种类型：architecture、workflow、sequence、dataflow、lifecycle、erd、class、tree、timeline、waterfall。
- 设计系统：light/dark、classic/signal-flow/blueprint/editorial 预设、5 种 viewer locale、legend、cards、语义图标、边界/泳道/阶段、focus/route/lens 交互。
- 官方明确：WYSIWYG editing 不在当前范围；编辑靠改 IR 再渲染。
- 质量核心是 validate/布局门禁：schema、几何、路由、标签间距、container border 等；失败返回带 `code/subject/evidence/supportedFixes` 的 diagnostics。
- 参考规模：HTML ~820KB（字体/viewer JS 占比高），内联 SVG ~30KB；skill 去掉 examples 约 4MB，可离线 vendor。

## 技术验证（实际跑过）

1. 对线上 Archify sequence 示例，取 `.diagram-container svg` + 页面全部 `<style>`，设置 `data-theme="light"`、移除动画，序列化得到 **352,666 字节** 的独立 SVG；作为 `<img>` 加载成功，固有尺寸 1080×580，低于现有 SVG 上限。
2. 把同一 Archify HTML 放进 `sandbox="allow-scripts"` 的 iframe，viewer 正常渲染（字体、主题、布局、交互），说明交互版可以安全嵌入。
3. 在 ai-documents 内用 vendored CLI 生成 architecture 图，海报 324KB、viewer HTML ~799KB；`<img>` 正常显示，右键菜单、结构编辑器保存、预览刷新、点击节点选中行全部跑通。
4. 10 种类型的骨架都能通过 Archify schema 校验（`@aidocs/archify` 测试覆盖）。

## 为什么旧 SVG 编辑器不能承载 Archify

Archify SVG 依赖：

- 100+ CSS class 与主题变量；
- HTML viewer 里的 `<style>`（字体、viewer、SVG 内联卡片样式）；
- `defs/pattern/marker`、主题/预设属性。

现有编辑器/净化器是“表现属性白名单”：

- 会剥掉 `class/style/pattern`，图直接坏；
- 检查器读不到 fill/stroke（都在 CSS class 里）；
- strict 保存拒绝 `style/class`；
- 即使 flatten CSS，也会丢主题/预设/交互/校验；
- 重新渲染会覆盖手工 SVG 修改，形成两套真相。

因此 Archify 海报是**只读快照**；编辑必须回到 IR。

## 接入设计

```text
assets/diagrams/x.archify.json   # 源 IR（提交）
assets/diagrams/x.archify.svg    # 海报（提交，Markdown 引用）
.aidocs/archify/...x.archify.html # viewer 缓存（gitignore）
.aidocs/archify/...x.meta.json    # sourceRevision / 生成时间 / warnings
```

- 生成：`archify_guidelines` 取类型规范 → `archify_save` 校验 IR、渲染 HTML、提取 SVG、原子写。
- 海报提取：主 SVG + 页面全部 `<style>`；固定 light、去动画；移除脚本/foreignObject/外链；限额 768KB；字体 CSS 超限时先裁字体。
- 交互：CSP `sandbox allow-scripts` + iframe `sandbox="allow-scripts"`；`connect-src 'none'`；点击节点用 postMessage 回编辑器。
- 编辑：结构表覆盖 architecture/workflow/sequence/dataflow/lifecycle；其余类型 v1 用 JSON；高级字段原样保留。
- 冲突：源 JSON sha256 revision；编辑器 PUT 带 `baseRevision`；409 可重新加载/覆盖。
- 回注：`.aidocs/diagram-edits.json` 记录源 JSON；AI 改图先 read 源 JSON；工具成功后清 marker。
- 安全：CLI 用 `spawn` 参数数组、无 shell；离线 env；移除 brand/repository/sources；不跑 Chromium。

## 被否决的方案

| 方案 | 原因 |
|---|---|
| Archify SVG 进旧 SVG 编辑器 | CSS/class/defs 破坏；flatten 丢语义；再渲染覆盖手工修改 |
| 文档内联 Archify iframe | 自定义 Markdown、可移植性差、性能/安全负担 |
| Archify 只做提示词/guidelines | 拿不到 schema 校验与布局引擎，提升有限 |
| 仅用旧 SVG 引擎（已移除） | 结构图质量不足，且双栈维护成本高 |
| 首个版本做像素拖拽 | Archify 的布局是确定性输出；拖拽需独立映射层，v1 用语义字段 |

## 风险与后续

- 海报丢失 cards（cards 在 SVG 外）；交互版保留，文档中说明。
- 海报在窄文档宽度下文字可能偏小；交互版是详细阅读入口。
- 820KB HTML 缓存不提交；换机器后可再生成。
- 当前 Archify 无 WYSIWYG；结构化编辑器覆盖常见类型，ERD/class/tree/timeline/waterfall 暂用 JSON。
- 未来可加 architecture pos/size 拖动、PNG/share card、品牌 marks、代码库 evidence。

## 参考

- [Archify README](https://github.com/tt-a1i/archify/blob/main/README.md)
- [Archify SKILL.md](https://github.com/tt-a1i/archify/blob/main/archify/SKILL.md)
- [Schemas README](https://github.com/tt-a1i/archify/blob/main/archify/schemas/README.md)
- [Authoring cookbook](https://github.com/tt-a1i/archify/blob/main/docs/authoring-cookbook.md)
- [Viewer export](https://github.com/tt-a1i/archify/blob/main/viewer/export.js)
