# 40 · 核心交互流

## 4.1 创作闭环（北极星）

```
进入文档
  └─ 有会话？ ── 是 → SessionManager.open(最近的 sessions/*.jsonl)
               └ 否 → 新建会话（装配见 20-architecture）
  ↓
聊天栏输入 → POST messages → pi session.prompt()
  ↓
SSE 流式：status=running → 文本/思考/工具块 → agent_settled → status=done
  ↓
UI：徽标「已完成 · 可收起」（不自动收起）
  ↓
git 自动提交（debounce 2s，路径限定）
  ↓
文档预览刷新（fs watch → 重新读 MAIN.md）
```

**手动收起**：点标题栏 `›` 或 `⌘J`，聊天栏收成 46px 窄条（显示「创作会话 · 已完成」竖排文字），点开恢复。宽度与显隐状态持久化。

**消息流里能看到的块**：用户文本、assistant 文本（streamdown 流式）、thinking（折起）、工具卡（read/edit/ls/grep，`+N −M`）、附件 chips、选区块、**生图结果格子**（`images` 块：多图拼格子、点击放大、右键加入上下文）、错误块。

## 4.2 附件与选区上下文

- **拖入 / 粘贴**：写进 `<artifact>/assets/`，同时在消息里生成 `attachment` 块（文件名 + 大小 + `relPath`）。
- **@ 提及**（v1 可选）：插入 `research/`、`assets/` 下文件的相对路径引用。
- **右键加入选区**：正文预览或「编辑原文」里选中区域 → 右键「加入对话上下文」→ 暂存为上下文缓存（可多处累积、单个移除或清空）→ 随下一条消息发送，发送成功后立即清空，不重复注入。正文不重复落盘；消息流只留 `source` / `chars` / `preview` 元信息。
- **右键加入图片**：预览里右键任意图片 →「加入对话上下文」→ 把该图的 Markdown 引用当一处上下文（与选区同一缓存、同样发送后清空），不必先选中文字。
- **生图结果加入上下文**：消息流里的生图结果右键 →「加入对话上下文」→ 该图的 Markdown 引用进入同一缓存；点击缩略图可放大查看，刷新后结果仍在。
- **AI 调研产物**：模型用 write 工具写进 `research/`（类型提示词里约定），随文档 git。

## 4.3 类型快捷往返（诉求 1）

```
文档页 / 创作页 ──[「类型编辑 ↗」]──▶ /types/<typeName>?doc=<group>/<name>
                                         │ 编辑 prompt / 勾选 skills / 管理 resources
                                         │ 保存
   原文档创作页 ◀──[「回到文档」直达 link]──┘
```

**必须满足**
- 「类型编辑」入口带 `?doc`（创作页顶栏按钮；`/docs` 只在右键菜单，右栏顶栏不设）；「回到文档」用 `doc` 直接生成创作页地址，**不依赖 `router.back()`**（新标签页/刷新/直达时没有历史）。
- 会话在后台**不断**（会话注册表按 artifactDir 持有）；返回后消息流原样、草稿不丢、滚动位保留。
- 类型编辑页有「未保存离开」提醒。
- 文档引用的类型目录已被删除时，`/types/<typeName>?doc=...` 不 404：落地页给出「回到文档」与「创建同名类型」。
- 保存后若存在进行中会话：顶部徽标「影响 N 个进行中会话 · 下一轮生效」；下一轮 `prompt()` 前重建会话壳（同一会话文件续接），见 20-architecture。

## 4.3.1 澄清选择（按需）

```
模糊需求 ──▶ 模型调用 request_clarification（1–3 题，每题 2–4 个短选项）
                 │ 状态 waiting，聊天里出现「需要澄清」卡
                 │ 用户点选项 / 其他… / 跳过，或 10 分钟超时
                 ▼
        POST /api/docs/<group>/<name>/clarifications
                 │ 工具拿到答案，同一轮继续
                 ▼
              改写 MAIN.md
```

**交互约束**
- 是否使用澄清由模型/类型提示词决定；不使用时不出现卡片。
- 澄清卡按 `groupId` 整组提交；选择结果进 `ui.jsonl`，刷新/重连后卡片与已选答案回放。
- 等待期间会话状态 `waiting`，主输入框禁用并提示「请先在上方完成澄清选择」。
- 用户可以点「其他…」自由输入，或「跳过，按默认写」；跳过项记为「未指定（按最合理判断）」。
- 超时 10 分钟自动标 `expired`，模型按默认继续，并在文末列「待确认」。
- 提交已失效/已回答的 `groupId` 返回 409，卡片提示重新发起。

## 4.4 Git 操作流

**历史**：点顶栏 `⎇ N 个版本` → 抽屉：commit 时间线（sha / 时间 / 来源 ai|human / 摘要 / 变更文件数）。

**diff**：选两个 commit（默认 `HEAD~1 → HEAD`）→ 逐文件「文件名 + diff 正文」；正文要**两侧完整文本**（先 `reconstructSides` 还原），二进制只显示元信息与「查看该版本」。

**回滚**（一键）：
1. 检查工作树：`git status --porcelain -- <artifactDir>`；
2. 脏 → 弹「先提交当前改动再回滚」（默认）或取消；绝不静默丢弃；
3. `git checkout <sha> -- <artifactDir>`（整篇：MAIN.md + assets + research + sessions 一起回到该版本）；
4. 立即 `git commit -m "rollback: <artifact> → <sha>"`（回滚本身可再撤销）；
5. 目标早于首次提交 → 显示「没有更早版本」。

**禁止**：`reset --hard`（单仓装所有 Artifact，会抹掉别的文档的未提交改动）；`revert`（历史成对出现，个人文档时间线不可读）。

## 4.5 新建与删除

- 新建 Artifact：选 Group（或新建 Group）→ 选类型 → 建目录 + `meta.yaml` + 空 `MAIN.md`（可带类型级模板）→ 首次 git commit。
- 新建类型：从空白或复制现有类型（整目录拷贝）。
- 删除：直接删掉文档目录（不再转存到回收站）；git 里留一次删除提交，内容可从历史恢复。类型删除仍软删到 `.trash/types/`。
- 重命名：目录改名 + `git mv`；`meta.yaml` 里的 `type` 保持原引用（类型改名需批量提示）。

## 4.6 状态与并发

- 一个 Artifact 同时只有一个进行中的轮次；运行中再发消息必须选 `steer`（插入当前轮之后）或 `followUp`（本轮完成后）。
- 多个 Artifact 可并行开会话，但同一 storageRoot 的 git 写入串行（进程内单写队列）。
- 进程退出：会话注册表清空，未落盘的 UI 块以最后快照为准（每帧快照即写）。

## 4.7 Archify 图示闭环

```
用户：画一张三层网关架构图
  → archify_guidelines（type kit/schema 摘要）
  → archify_save（validate → render HTML → 提取 SVG 海报 → 原子写 .archify.json/.svg）
  → AI 在 MAIN.md 单独一行引用 .archify.svg
  → 预览 <img>：GET /assets/...（poster 净化 + CSP + ETag）
右键海报 → 打开交互图示 / 编辑结构
  → 全屏 overlay：结构表/JSON + sandbox iframe viewer
  → 改字段 600ms 防抖 → POST /archify-preview → 右侧 viewer 实时更新（不写源）
  → 点击 viewer 节点选中表格行
  → PUT {ir, baseRevision, quality} → validate/render/poster/cache
  → 海报 ?v=epoch 刷新；iframe ?v=revision 刷新
下一条消息
  → marker（源 .archify.json）→ prompt 提醒先 read 源 JSON
  → AI 基于源 IR 最小修改，archify_save 更新同一海报引用
```

**约束**
- 源 `.archify.json` 是唯一真相；海报只读，不要再 read 海报（省 token）。
- 普通 SVG/图片只读展示；不再有自由 SVG 工具或编辑器。
- 实时预览失败时保留上一次成功预览，并展示 diagnostics；保存才写源/海报。
- 交互 viewer 只从 `.aidocs` 缓存读取，sandbox `allow-scripts`，不授予 same-origin。
- 保存冲突 409；AI 工具更新不要求 baseRevision，但提示词要求先 read。
- 结构编辑器 v1 覆盖 architecture/workflow/sequence/dataflow/lifecycle；其余类型 JSON + 预览。
