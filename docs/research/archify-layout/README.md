# Archify 图示布局审计（2026-10-17）

对象：`/workspace/测试/Archify演示` 里的两张图（边缘网关参考架构、发布流程泳道图）。
目的：分清「插件定的」和「IR 定的」，量化当前缺陷，估算改进空间。

## 结论

- 视觉风格（卡片、配色、字体、图例、动画、路由算法）由 vendored Archify v3.1.0 决定。
- **architecture 的比例几乎全由 IR 里的 `pos`/`size` 决定**：router 不能移动节点，只能在给定坐标上绕线。
- **workflow 的比例由 v2 编译器决定**：`lane`/`col` 是输入，列距、卡片高度、垂直居中、自动宽度、路由都是引擎算的。
- 我们当前的封装没有布局重排、没有几何质检，也没有把上游的 authoring rules 交给模型；所以「比例/线条」缺陷主要是**作者几何 + 引擎默认值**，不是插件随机发挥。

## 量化对比

### 边缘网关参考架构（同一语义，只重排坐标 + 统一卡片）

| 指标 | 现状 | 重排后 |
|---|---|---|
| viewBox / 长宽比 | 1110×377（2.94:1） | 890×554（1.61:1） |
| 连线折点总数 | 9 | 0 |
| 最长边 | 514px（users→redis） | 100px |
| 总边长 | 1322px | 540px |
| 与节点净空 <12px | 2 处（均 3px） | 0 |
| 连线交叉 | 1 处（gw→users × orders→pg） | 0 |
| 卡片尺寸 | 140/150/160 × 66 | 150×66 |
| 列中心距 | 220/220/240/200 | 220/220/220 |
| 行中心距 | 60/60/100（相邻行有重叠带） | 120/120/120 |

坏点：
- `gw→users` 在 Order Service 下方 3px 处横穿，再折回 User Service 左侧；4 个折点。
- `users→redis` 在 PostgreSQL 下方 3px 处横穿，再从右侧折回 Redis；3 个折点。
- 这两条不是路由算法不会绕，而是节点摆位让「直线」不可能：Redis 在 Gateway 下方，却由右侧的 User Service 写入。

### 发布流程泳道图（只改 IR：显式宽度 + 补齐 tag）

| 指标 | 现状 | 只改 IR |
|---|---|---|
| 卡片宽度 | 92 / 136 | 120 / 140 |
| 卡片高度 | 52 / 68 混排 | 68 统一 |
| 同泳道顶部差 | 8px（两处） | 0 |
| 最小次级字号 | 7.0px | 8.0px |
| 折点总数 | 5 | 5（未改善） |

说明：宽度和文字是引擎按内容挤出来的；补齐 `tag` 让同泳道卡片同高，显式 `width` 让 sublabel 回到 8px。但回边/跨泳道路由仍由编译器决定，只能改引擎。

## 已落地（2026-10-17）

- `packages/server/archify/src/layout.ts`：`layoutArchitecture`（主路径 L 形 + store 在 owner 下方 + security 在上方 + 统一卡片）、`normalizeWorkflow`（补 width/height，同 lane 同高）、`gridPlaceArchitecture`（缺坐标/环/boundaries 兜底）、`lintLayout`（折点/贴边/交叉/标签/字号/对齐/画布）。
- `archify_save`：新图默认自动排版，更新已有图默认保留坐标；`autoLayout?: boolean` 可覆盖。保存/校验/预览都会跑布局体检，报告随响应返回。
- 编辑器：header 显示布局分数；结构表下方琥珀色面板列 `layout/*` 建议；「排版」按钮调用 `POST .../archify-layout`，只改草稿，保存后落盘。
- 测试：`layout.test.ts` + `archify.test.ts` 覆盖 8 节点示例自动排版 100 分、原始坏布局被标出、新图重排/更新保留、workflow 字号与对齐。
- 本轮“重排后”对照图是手工坐标；自动排版算法在同一 8 节点 IR 上复现了这组坐标（测试断言）。

## 为什么引擎会这样

- architecture 的 `layout.mode: "grid"` 只是「固定格点数学」，不是自动布局；不写 `size` 时组件默认 120×60。见 [grid.mjs](../../../packages/server/archify/vendor/archify/renderers/architecture/grid.mjs#L1)。
- architecture 路由的最小净空是 2px；它只保证不撞，不保证好看。见 [route-quality.mjs](../../../packages/server/archify/vendor/archify/renderers/shared/route-quality.mjs#L11)。
- workflow 的自动宽度只在「sublabel 连 6px 都放不下」时才扩宽；否则把字号压到 7px 来塞进 92px。见 [workflow-compiler.mjs](../../../packages/server/archify/vendor/archify/renderers/workflow/workflow-compiler.mjs#L166)。
- workflow 同泳道节点按容器**垂直居中**，所以 52px 和 68px 的卡片顶部/底部都不齐。见 [workflow-compiler.mjs](../../../packages/server/archify/vendor/archify/renderers/workflow/workflow-compiler.mjs#L1002)。
- 我们的 guidelines 只有一句「pos/size 建议显式给出」，没有上游的主路径/间距/画布规则。见 [guidelines.ts](../../../packages/server/archify/src/guidelines.ts#L31)。
- 校验只跑了 schema/validate，没有 `--layout-json` 几何报告；保存结果的 warnings 只放在 `details`，content 文本里没有。见 [run.ts](../../../packages/server/archify/src/run.ts#L91)、[archify.ts](../../../packages/server/agents/src/archify.ts#L153)。

## 改进分层

**S（已落地，见上）**

1. 在 `archify_save` 前加确定性 layout：architecture 按主路径分层，store 放 owner 正下方，fan-out 分侧，统一卡片尺寸；或强制 `layout:grid + row/col`。
2. 把上游 authoring rules 蒸馏进 guidelines：主路径阅读顺序、store 在 owner 下方、每侧 fan-out `32 + 14×(k−1)`、标签间隙 `6.5×units + 21`、画布 ≤1240、省略 `viewBox`、workflow 显式 `width` 避免 7px。
3. 加几何 lint：折点数、<12px 贴边、边穿节点、标签压节点、字号 <8、同泳道顶差、长宽比；作为 warnings 返回模型 + 编辑器显示。
4. 编辑器加「排版/规范化」。

**M（后续可选：改 vendor 或包 patch）**

- architecture：端口按主路径选边、净空提到 12–16px、标签避让、绕行通道。
- workflow：同泳道顶对齐、<8px 强制扩宽、跨泳道线走泳道间通道、标签不落标题带、统一拐角策略。
- vendor 是 MIT，但 `UPSTREAM.md` 要求不原地改；用 patch set/fork，升级时跑回归。

**L（后续可选：自研布局层）**

- 用 ELK/dagre 或自写分层只算坐标，继续让 Archify 渲染。彻底可控，但要自己编码泳道/阶段/主路径语义，维护成本最高。

## 复现

```bash
cd <artifact>
ARCHIFY_UPDATE_CHECK_DISABLED=1 node <repo>/packages/server/archify/vendor/archify/bin/archify.mjs \
  validate architecture assets/diagrams/边缘网关参考架构.archify.json --json --quality showcase --layout-json

ARCHIFY_UPDATE_CHECK_DISABLED=1 node <repo>/packages/server/archify/vendor/archify/bin/archify.mjs \
  validate workflow assets/diagrams/发布流程泳道图.archify.json --json --quality showcase --layout-json
```

本目录的 `arch-clean.archify.json` 与 `wf-clean.archify.json` 是可重渲染的对照版本。
