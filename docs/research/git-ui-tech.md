# Research · Git UI 技术选型（票 03）

场景：单用户 Mac、本地 Next.js 应用；storageRoot（所有 types/ + docs/ 同一个仓库）是 git 仓库；AI 频繁自动 commit（markdown + 图片）；UI 要 commit 历史时间线 + diff + 一键回滚，不做分支管理。

## 1. Node 侧 git 操作选型 → **spawn git CLI（`execFileSync`）**

| 方案 | 判断 |
|---|---|
| `isomorphic-git` | 纯 JS 无二进制依赖，但大仓库慢、部分 porcelain 语义缺失（index 细节、pathspec 的边角），且要自己维护 fs 适配。本场景**不换来任何东西**。 |
| `simple-git` | 本质就是 spawn git CLI 的封装——依赖二进制这一点与自建相同，只多了 API 糖和一层黑盒。 |
| 自建 `execFileSync` 薄封装 | ✅ **选它**。参考仓库 `packages/server/core/src/git-exec.ts` 已用此路线跑生产：`execFileSync`（非 shell，无注入面）、stdin 断开、`maxBuffer` 调大、墙钟超时、失败折成中文 `ServiceError` 且保留 git 英文原文进 `context`。 |

必带两个 `-c`（放在子命令前）：
- `-c core.quotepath=false`：否则中文文件名的 diff 全是 `"\346\226\207..."` 乱码——个人文档工具里这就是主路径。
- `-c core.autocrlf=false`：工作树字节必须与仓库一致，否则「AI 改了文件 / UI 显示的 diff / 回滚的内容」三者互相打架。

配套口径：`git rev-parse --is-inside-work-tree` 判仓库、`git rev-parse --show-toplevel` 定根、所有「读取类」调用统一过 `executeOrFail`（中文原因在前、`fatal:` 原文进 context）。

## 2. 回滚语义 → **`git checkout <commit> -- <path>`（路径限定），绝不用 `reset --hard`**

真 git 实测（v1→v2 后回滚到 v1）：

```
$ git checkout HEAD~1 -- MAIN.md
$ git status --short
M  MAIN.md          # 回滚结果进暂存区（index），工作树同步
```

- **为什么不是 `reset --hard`**：storageRoot 是**一个仓库装所有 Artifact**。`reset --hard` 是仓库级操作，会连同其它文档未提交的改动一起抹掉。路径限定的 checkout 把爆炸半径压到「这一个 Artifact」。
- **为什么不是 `revert`**：revert 造反向 commit，历史里出现成对的「改了/改回来」，个人文档时间线会读不下去；而且需要先确定要 revert 哪个 commit 区间，UI 上反而更难解释。
- **组合动作**（「回滚文档 = 回滚会话」）：`git checkout <sha> -- <artifactDir>`（MAIN.md + assets/ + research/ + 会话史一起回到该版本）→ 立即 `git commit -m "rollback: <artifact> → <sha>"`，让回滚本身成为一次可再撤销的提交。
- **工作树脏时**：先判 `git status --porcelain -- <artifactDir>`；若非空，UI 提供「先提交当前改动再回滚」（默认），不做静默丢弃。仓库里别的 Artifact 有脏改动不影响本操作（路径限定）。
- 回滚目标若是**首次提交之前**（文档还没被 commit 过），UI 显示「没有更早版本」而不是报错。

## 3. diff 渲染 → 沿用参考仓库组合

- `react-diff-viewer-continued@4.4.0` + `diff@9.0.0`（参考仓库 `packages/client/ui/src/composite/diff-view.tsx` 已在用）。
- 它要的是**两侧完整正文**而非 diff 文本 → 先 `reconstructSides` 还原（参考仓库 `diff-patch.ts` 的思路直接搬）。
- 取数纪律：ui 包不调接口，`renderFileBody(path)` 由调用方传入（每文件一个组件实例、进视口才渲染）。
- 二进制（图片等）：只显示文件名 + 大小 + 「二进制文件无法 diff」，并提供「查看该版本文件」（走 blob 预览）。
- 大文件：服务端按 256 KB 预算截断并在 UI 明示「已截断」。markdown 场景几乎碰不到，但图片文件夹会。

## 4. 自动 commit 策略

- **时机**：AI 每轮结束（pi `agent_settled`）后 debounce ~2s 提交一次；人工编辑器保存后 debounce 8s 提交。同一窗口内的多次保存合并成一个 commit。
- **空提交防护**：`git add -A -- <artifactDir>` 后 `git diff --cached --quiet -- <artifactDir>`，无变更不提交。
- **区分来源**：commit message 前缀 `ai: <artifactName> · <本轮摘要>` vs `human: <artifactName> · 手动编辑`；另加 trailer `Artifact: docs/<group>/<artifact>` 便于按文档过滤历史（`git log --grep`）。
- **路径限定**：所有 add/commit 都带 pathspec，避免把另一个正在被 AI 改的 Artifact 的中间态卷进来。
- 时间线取数：`git log --format=%H%x09%an%x09%at%x09%s -- <artifactDir>` 分页（`--max-count` + skip）；diff 取 `git diff <sha>^ <sha> -- <artifactDir>` 或 `git show --format= --numstat`。

## 5. 存储目录不是 git 仓库时 → **提示 + 一键 init，绝不静默**

- 配置 storageRoot 时探测 `.git`；没有则在设置页与首次进入时给一个明确按钮「初始化版本历史」→ `git init -b main` + 首次 `git add -A && git commit -m "init: storage root"`。
- 理由：v1 的 Git UI 是卖点之一，「没有 git 就整块功能消失」是坏体验；但静默 init 会在用户不明所以时改动他的目录，必须显式确认。
- 若用户选择不初始化：Git 相关入口显示「未启用版本历史」+ 再次提供初始化按钮，其余功能不受影响。

---

## 结论一句话

**自建 `execFileSync` 薄封装 + 两个 `-c` + 路径限定 checkout 回滚 + react-diff-viewer-continued**；参考仓库的 `git-exec.ts` / `diff-view.tsx` / `diff-patch.ts` 就是这套方案的现成实现，搬过来改领域语义即可。
