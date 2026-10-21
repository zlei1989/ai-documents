# 10 · 磁盘布局与版本化

## storageRoot（用户配置的存储根，本身是 git 仓库）

```
<storageRoot>/
├── types/
│   └── <typeName>/                 # 一个类型一个文件夹（名称即 id，允许中文）
│       ├── type.yaml               # 清单：name/description/model/skills/mcp/resources
│       ├── prompt.md               # 系统提示词（追加到 pi 默认提示词之后）
│       └── resources/              # 任意层级文件树（文件管理器管理）
├── docs/
│   └── <groupName>/
│       └── <artifactName>/         # 一个产物一个文件夹
│           ├── meta.yaml           # title/typeName/createdAt/updatedAt
│           ├── MAIN.md             # 唯一入口正文
│           ├── assets/             # 用户附件与 AI 生成的图示
│           │   └── diagrams/       # Archify 源/海报（x.archify.json/.svg）；普通 SVG 只读
│           ├── research/           # AI 深度查询产出的资料
│           ├── sessions/           # 会话史（回滚文档=回滚会话）
│           │   ├── .index.json     # 会话清单：id/title/createdAt/updatedAt + activeId（空会话也在）
│           │   ├── <id>.jsonl      # pi 会话（模型上下文真相，进 git）
│           │   └── <id>.ui.jsonl   # 该会话的 UI 渲染块（派生数据，gitignore；超 32MB 裁到最近 8MB）
│           │                       # 旧版单会话的共享 ui.jsonl 在首次读取时自动迁到 <activeId>.ui.jsonl
│           └── .aidocs/            # gitignore
│               ├── type/           # 类型资源物化副本（会话启动时同步）
│               ├── diagram-edits.json # 「图示被手动改过」提醒（不提交）
│               └── archify/        # Archify viewer/meta/preview 缓存（不提交，可再生成）
└── skills/                         # 可选：项目级技能（agentskills 规范）
```

**约定**
- 目录名即显示名（重命名 = 目录改名 + git mv）；不引入 UUID 作为主键，路径即可寻址。
- `types/<typeName>` 与 `docs/<group>/<artifact>` 内部一律 UTF-8、LF（git 侧 `core.autocrlf=false`）。
- `.aidocs/` 与常见噪音（`.DS_Store`、`node_modules`）进 storageRoot 的 `.gitignore` 模板。
- `sessions/.index.json` 是会话清单与当前会话（`activeId`）的唯一真相源：新建空会话在发第一条消息前没有 pi 文件，也靠它出现在列表里。首次打开旧文档时从 `sessions/*.jsonl` 盘点并补写索引。
- 会话 id 由应用生成（`s-<时间戳>-<随机>`）或沿用旧 pi 文件头里的 uuid；只允许 `[A-Za-z0-9._-]`，禁止把索引里的字符串直接拼进路径。
- Archify 图放 `assets/diagrams/<slug>.archify.json`（源）+ `<slug>.archify.svg`（海报，Markdown 引用），HTML viewer、实时预览落 `.aidocs/archify/`。普通 SVG/图片只读展示。`meta.updatedAt` 在保存后刷新，但编辑保存本身不立即 git commit（与 `saveMain` 一致，下一轮 AI 结束的自动提交会纳入）。

## type.yaml

```yaml
name: 技术方案
description: 教模型如何写一份技术方案
model: null            # null = 跟随全局默认；或 "provider/model"
skills:                # 白名单（全局里勾选）
  - mermaid-diagram
  - poem
mcp:
  - context7
resources:             # 文件树里的相对路径
  - path: 模板/方案模板.md
    mustRead: true     # ≤4KB 且 mustRead → 全文直插系统提示词
  - path: 参考资料/检索引擎笔记.md
    mustRead: false
```

## artifact meta.yaml

```yaml
title: 文档生成应用
type: 技术方案          # 指向 types/<name>；类型改名或删除时这里会失配（见风险）
createdAt: 2026-05-01T10:00:00Z
```

## git 版本化

- storageRoot 未初始化时：设置页与首次进入给**显式按钮**「初始化版本历史」→ `git init -b main` + 首次提交；**绝不静默 init**。
- 自动提交：
  - AI 每轮结束（pi `agent_settled`）后 **debounce 2s**；人工保存后 **debounce 8s**；
  - 路径限定：`git add -A -- <artifactDir>`，`git diff --cached --quiet -- <artifactDir>` 无变更不提交；
  - message 前缀：`ai: <artifact> · <本轮摘要>` / `human: <artifact> · 手动编辑`，附 trailer `Artifact: docs/<group>/<artifact>`。
- 回滚（详见 40-flows）：`git checkout <sha> -- <artifactDir>` → 立即 `git commit -m "rollback: <artifact> → <sha>"`。
- 远端同步（设置页手动触发，绝不自动推拉）：
  - 拉取 = `git fetch --prune <remote>` → 无落后则直接返回；落后则 `git merge --no-edit <remote>/<branch>`（合并，不 rebase）。
  - 推送前**按文件夹生成提交**：`git status --porcelain -uall` 拿到全部变更（含未跟踪、重命名新旧路径），按 `docs/<group>/<artifact>` / `types/<name>` / `skills/<name>` / 根目录分组；每组 `git add -A -- <分组路径>` 后提交，message 为 `human: <标签> · 推送前提交`，一次推送生成 N 个可读提交。派生数据（`.aidocs/`、`node_modules/`、`sessions/*.ui.jsonl`、`*.tmp-*`、`.DS_Store`）不进这些提交；任一组的提交失败就中止推送并保留已提交部分。
  - 推送 = `git push -u <remote> HEAD:<branch>`；远端领先时拒绝并提示先拉取，绝不 force push。结果里带 `commits[]`（分组路径 / 标签 / short sha / 文件数），设置页逐条展示。
  - 工作区有 **tracked 未提交改动** 时拒绝拉取（避免把半成品卷进合并）；未跟踪文件不阻止，冲突交给 git 自己判定。
  - 拉取出冲突：保留 `MERGE_HEAD` 现场，自动启动 **pi 冲突修复**（见下）；修复完成后只 `git add -A -- <冲突文件>` 并 `git commit --no-edit` 完成合并。
  - 合并/rebase 进行中，自动提交直接跳过（`gitOperationInProgress`），防止把冲突半成品抢跑成合并提交。
- pi 冲突修复（`agents/repair-session.ts` + `api/git-repair.ts`）：
  - 独立最小会话：cwd = storageRoot，工具仅 `read/write/edit/ls/grep`，不加载类型提示词、skills、MCP、Archify、research、seedream、AGENTS.md。
  - 提示词要求先 read 冲突文件、理解两侧意图、删掉全部 `<<<<<<< / ======= / >>>>>>>` 标记、只改列出的文件；二进制冲突不猜。
  - 收尾：仍有标记则追加一轮（最多 2 次）；无标记后 stage 冲突文件并完成合并提交；失败/超时（10 分钟）/用户中止都保留现场，设置页可重试或「放弃合并」（`git merge --abort`）。
  - 修复事件通过 SSE（`/api/storage/repair?stream=1`）实时展示 tool / text / log / status；连接断开按 `Last-Event-ID` 续传，页面刷新后点「重新修复」会接上仍在跑的同一任务。
- git 调用一律 `execFileSync` / `execFile` + `-c core.quotepath=false -c core.autocrlf=false`（中文文件名不乱码、工作树字节与仓库一致）；网络操作带 `GIT_TERMINAL_PROMPT=0` 等环境变量，避免在无 TTY 的服务进程里卡住等账号密码。

## 敏感文件

- 全局配置在应用配置目录（如 `~/.aidocs/config.json`），**不在 storageRoot 内**；API key 落盘 `chmod 0600`，下行一律掩码。
- storageRoot 只放用户内容，永不含 key。
