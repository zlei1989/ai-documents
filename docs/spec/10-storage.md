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
│           ├── sessions/           # 会话史（进 git！回滚文档=回滚会话）
│           │   ├── <id>.jsonl      # pi 会话（模型上下文真相）
│           │   └── <id>.ui.jsonl   # UI 渲染块记录（见 30-streaming）
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
- git 调用一律 `execFileSync` + `-c core.quotepath=false -c core.autocrlf=false`（中文文件名不乱码、工作树字节与仓库一致）。

## 敏感文件

- 全局配置在应用配置目录（如 `~/.aidocs/config.json`），**不在 storageRoot 内**；API key 落盘 `chmod 0600`，下行一律掩码。
- storageRoot 只放用户内容，永不含 key。
