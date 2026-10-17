# Research · 参考仓库资产迁移清单（票 02）

调研对象：`/Users/zhanglei1120/Github/ai-result-evaluation`（下称 aieval）。判定标准：**搬** = 原样改包名进来；**改** = 结构沿用、领域语义重写；**砍** = 不进入新项目。

## 骨架层（已定，照抄纪律）

- **改**：`pnpm-workspace` + 根 `tsconfig.base.json` + 全链 `tsc --noEmit` + 包 `"exports": "./src/index.ts"` 源码直导 + ESLint 单向依赖。结构：`apps/web` + `packages/server/{contracts,core,agents,api}` + `packages/client/{base,ui}`。其中 `agents` 包名从「三家厂商适配」语义变成「pi 会话适配」。

## server/contracts
- **改**：zod 契约模式照搬（判别联合 + `safeParse`），实体全部换成 Provider / StorageSettings / McpServer / SkillRef / ArtifactType / Group / Artifact / ChatEvent / ChatMessage。

## server/core
| 模块 | 判定 | 理由 |
|---|---|---|
| `config-store.ts`（原子写、BOM、chmod 0600） | **搬** | 全局 settings 落盘即它 |
| `paths.ts` | **改** | 改成 aidocs 的目录口径（configDir、storageRoot、types/、docs/） |
| `event-log.ts`（seq 单调 JSONL、读容错写严校验） | **改** | 裁剪为每 Artifact 一份 `session/events.jsonl`；四条口径（本模块发号、appendFileSync、读容错、写严校验）全部保留 |
| `message-log.ts` | **改** | 同上，裁为 `session/messages.jsonl` |
| `skill-store.ts`（扫第一层、frontmatter 校验、不合格条目带 reason 入列） | **搬** | 全局 Skills 页直接可用 |
| `skill-materialize.ts` | **改** | 物化目标从 per-row configHome 改为「按 type.yaml 勾选清单渲染给 pi 的 skillsOverride」 |
| `mcp-probe.ts` | **搬** | MCP 设置页「测试连接」直接可用 |
| `git-exec.ts`（execFileSync、防注入、-c 口径、timeout） | **搬** | **这是票 03 的重要先例**：参考仓库已用成败证明 spawn git CLI 路线可用且纪律成熟 |
| `git.ts` / `git-diff-*` | **改** | mirror/clone/checkout 链砍掉，留「非 ASCII 路径不乱码」等 -c 参数纪律与 diff 收集思路 |
| `mirror*.ts`、`workspace*.ts`、`case-*.ts`、`attachment-store.ts` | **砍** | 评测领域专属 |

## server/api
| 模块 | 判定 | 理由 |
|---|---|---|
| `run-stream.ts`（具名事件、`id: <seq>`=Last-Event-ID、回放后接增量、终态关流、15s 心跳、先读盘后开流防丢窗） | **搬+裁** | 双通道（events/judges）裁成单条聊天事件流；文件头口径注释原文保留——这四条纪律每条漏了都是「界面上某条流不刷新」 |
| `messages-stream.ts`（无 seq 全量回放、mergeKey 覆盖累积、**增量帧 16ms 窗口合并防 O(n²)**、终态不关流） | **搬+裁** | 单条消息流直接是「打开文档看历史会话」的通道；delta 合并纪律原样保留 |
| `providers.ts`（toView 掩码单出口、preview→import 两步拉模型、协议 baseUrl 规范化） | **改** | 保留纪律；底层从「起智能体」改为「写 pi 的 models.json/auth.json」（见票 01） |
| `settings.ts` / `mcp.ts` / `skills.ts` | **搬+改** | CRUD 结构直接沿用 |
| `cases*.ts` / `runs.ts` / `judge*.ts` / `ask-user*.ts` / `inject-*.ts` / `follow-up.ts` | **砍** | 评测/人机问答领域专属（ask-user 暂不进入 v1） |

## packages/client/base（数据访问层）
- **改**：`http.ts`（SWR hooks 原语）照搬；`row-stream.ts`（具名事件逐个 addEventListener——onmessage 只收默认事件的坑）与 `row-messages.ts（mergeKey 覆盖 + rAF 合并 setState）裁成单聊天流 hooks；cases/runs/judge/ask-user 系列全砍。

## packages/client/ui
| 模块 | 判定 | 理由 |
|---|---|---|
| `composite/agent-log/` 中的 `block-renderer-registry` + `render-blocks` + `build-model` | **搬+裁** | 块分派机制保留；块只留 text/thinking/tool/**attachment**（attachment-block-view 现成！） |
| `text-block-view`（x-markdown 流式）/ `thinking-block-view` | **搬** | 直接用 |
| `tool-group-panel` / `tool-item-detail` | **改** | 收敛为单工具调用块（文件名+diff 摘要），去掉多行并行编排色彩 |
| `virtual-turn-list` / `agent-log-layering` / `agent-log-size-sweep` / `subagent-bar` / `task-panel-card` / `unrecognized-block-view` / `agent-environment-drawer` / `row-summary-line` / `agent-log-facts-bar` / `inject-*` / `follow-up-*` / `ask-user-card` / `raw-output-panel` | **砍** | 多轮虚拟滚动/排队注入/问答卡片等评测场景专属 |
| `composer-input.tsx` | **改** | 聊天栏输入框基底，加附件 chips 注入 |
| `settings` 页相关组件（provider-table / provider-form-modal / mcp-server-* / skill-table / skill-detail-drawer） | **搬** | 设置页四个 Tab 形态直接复刻 |

## 砍单汇总（不进新项目）
evaluator 全包、agents 三家适配（claude/codex/dsh）、git 镜像链（mirror*/case-git）、cases/runs 领域层、ask-user/inject/follow-up 人机队列、runs 审计 UI 大部分。

## 对票 03 的输入
`core/git-exec.ts` 已是「Node 服务端 spawn git CLI」路线的内部先例（execFileSync + 超时 + -c 口径），票 03 选型若走 CLI 路线可直接搬此模块。
