# 70 · 决策索引（ADR 清单）

每条决议的详情在对应票里（`wayfinder/tickets/`），票里又链到 `docs/research/`。本文件只做索引与「为什么」。

| ID | 决策 | 依据 | 详情 |
|---|---|---|---|
| ADR-01 | 纯本地 localhost，无鉴权 | 个人工具，v1 范围 | 地图定调 |
| ADR-02 | 命名：ArtifactType / Artifact / Group | 语义清晰 | GLOSSARY.md |
| ADR-03 | 类型 = 文件夹 + 清单（type.yaml/prompt.md/resources/） | 方法论可被 git 与拷贝 | 票 07 |
| ADR-04 | 一 Artifact 至少一个持久会话，**会话史随文档 git 化**（ADR-35 扩展为多会话） | 回滚文档=回滚会话 | 票 01/07 |
| ADR-05 | 会话 JSONL 用 pi 的 `SessionManager.create(cwd, customDir)` 落 `<artifact>/sessions/` | 实测可控 | 票 01/04 |
| ADR-06 | 系统提示词 = **追加**（保留 pi 默认） | 用户拍板 | 票 07 ⚠️ 见下 |
| ADR-07 | 资源 = 物化到 `.aidocs/type/` + 清单按需 read（≤4KB mustRead 全文直插） | token 成本 | 票 07 |
| ADR-08 | Skills/MCP = 类型白名单 + **全局停用优先** | 可预期 | 票 07 |
| ADR-09 | 类型改动下一轮生效（重建会话壳 + 同一会话文件续接） | pi 快照语义 | 票 07 |
| ADR-10 | 技能来源：`~/.agents/skills` + `<storageRoot>/skills` | agentskills 规范 | 票 07 |
| ADR-11 | 技术栈：Next16 + React19 + Tailwind v4 + **shadcn（Base UI）** | 用户拍板 | 票 09 |
| ADR-12 | 流式用 SSE（具名事件 + 全量回放 + 16ms 增量合并 + 心跳） | 参考仓库实战 | 票 02/03 |
| ADR-13 | git 操作 = `execFileSync` 薄封装，带两个 `-c` | 中文路径/字节一致 | 票 03 |
| ADR-14 | 回滚 = 路径限定 `checkout <sha> -- <dir>` + 立即提交；**禁 reset --hard** | 单仓多 Artifact | 票 03 |
| ADR-15 | 自动提交：`agent_settled` 后 2s（AI）/ 8s（人工），路径限定 | 可回溯且不卷入别人 | 票 03 |
| ADR-16 | 未初始化 git 时显式「一键 init」，不静默 | 不擅改用户目录 | 票 03 |
| ADR-17 | 包结构照抄 ai-result-evaluation，UI 层零搬运 | 结构纪律 | 票 02/09 |
| ADR-18 | pi 嵌入 = in-process SDK + globalThis 会话注册表 | 单进程本地 | 票 01/04 |
| ADR-19 | 创作页 = A 三栏（树 / 文档 / 聊天），手动收起 | 原型拍板 | 票 05 |
| ADR-20 | 三栏可拖 + 左树可隐藏 + localStorage + ⌘B/⌘J | 用户追加 | 票 05 补遗 |
| ADR-21 | 类型编辑器 = B 双栏（配置 / 编辑器），预览走 tab | 原型拍板 | 票 06 |
| ADR-22 | 类型编辑走独立路由页，会话不断 | 诉求 1 | 票 05 |
| ADR-23 | 文档默认预览，可切编辑 | 人改为次 | 票 05 |
| ADR-29 | Archify = 结构图引擎；IR 为源、SVG 海报为标准 Markdown 引用、交互 HTML 为应用内缓存 | 结构图质量/校验与 Markdown 可移植性兼得 | [90](90-archify.md) |
| ADR-30 | Archify 海报只读；编辑入口是语义化结构编辑器 + JSON + 实时预览 | 海报是渲染快照，IR 才是可编辑层 | [90](90-archify.md) |
| ADR-31 | vendor Archify v3.1.0，CLI 子进程、无 shell、离线、不跑 Chromium | 本地离线、版本确定；不新增 bash 工具 | [90](90-archify.md) |
| ADR-32 | 交互 HTML 走 `.aidocs` 缓存 + sandbox iframe + CSP | 保留 viewer 交互，不污染 Markdown、不提交大文件 | [90](90-archify.md) |
| ADR-33 | Archify 表单覆盖 5 种常见类型，其余 JSON；v1 不做像素拖拽 | 控制复杂度；高级字段不丢 | [90](90-archify.md) |
| ADR-34 | 移除自由 SVG 引擎（diagram_guidelines/diagram_save、SVG 编辑器、SVG 编辑 API 与设计文档）；普通 SVG 只读，Archify 唯一图示引擎 | 用户明确要求全面拥抱 Archify；减少双栈维护与误导入口 | [90](90-archify.md) |
| ADR-35 | 同一 Artifact 多会话：`.index.json` 记清单/activeId，每会话独立 pi + `<id>.ui.jsonl`；头部图标新建/切换；切走空闲会话释放运行时 | 创作中按主题拆上下文，避免一条长会话越聊越贵/越乱 | [30](30-streaming.md) |

## ⚠️ 需要注意的取舍

### ADR-06 追加 vs 替换（风险最高）

用户选择**追加**：保留 pi 默认系统提示词，把类型 prompt.md 追加其后。代价是模型同时看到「你是编码代理」与「你是写作助手」两套身份。

**缓解（实现必须做全）**：
1. 工具白名单收紧为 `read/write/edit/ls/grep`，**不给 bash**；
2. 类型 prompt.md 模板首句强制声明写作角色与产出物；
3. cwd 锁死在 Artifact 目录；
4. **首轮实测复核点**：若出现「读 package.json / 跑命令 / 探索仓库」式跑偏，把开关切到 `systemPromptOverride`（替换）——只需改装配函数一处。

### ADR-13 与 pnpm 12

pnpm 12 默认拒绝依赖构建脚本，新项目第一步要 `pnpm approve-builds --all`（写入 `pnpm-workspace.yaml` 的 `allowBuilds`），否则安装直接失败。

### ADR-14 的隐含前提

「单仓装所有 Artifact」意味着任何仓库级操作都是全局的——这是禁用 `reset --hard` 的根本原因，不是偏好。
