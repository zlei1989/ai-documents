# 80 · 交接清单：实现顺序、里程碑与验证点

## 前置（M0 之前，半天）

1. Node ≥ 22.19（本机 v24.19 ✅）；pnpm 12。
2. 新建 monorepo → **先** `pnpm approve-builds --all`（否则 `ERR_PNPM_IGNORED_BUILDS` 卡死装包）。
3. `next.config`：`serverExternalPackages: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', …]`。
4. 烟测脚本（照 `.smoke/smoke.mjs` 的思路）：自注册 provider → `createAgentSession` → prompt → 看 `agent_settled`。**跑通再往下**。

## 里程碑

| # | 里程碑 | 内容 | 验收 |
|---|---|---|---|
| M1 | 骨架 + 契约 | monorepo、shadcn init、contracts 的 zod 模型（Provider/Type/Artifact/ChatEvent） | `tsc --noEmit` 全绿，空页面可跑 |
| M2 | 设置页 | providers CRUD + 拉模型两步 + 掩码；storage 选择 + git 初始化；mcp 表格 + 探针；skills 双来源 + 启停 | 能配好一个真实供应商并发起一次纯 LLM 调用 |
| M3 | 存储与类型 | types/ docs/ 目录读写、type.yaml/meta.yaml 解析、原子写、路径穿越防护 | 建类型/建文档落盘正确，git 提交出现 |
| M4 | pi 会话 + SSE | 会话注册表（文档 + 会话 id）、装配、`subscribe` 投影、`sessions/<id>.ui.jsonl`、SSE 一条流、消息块渲染、附件与选区注入 | 打开文档能对话，模型改 `MAIN.md`，消息流可见工具块 |
| M5 | 类型往返 | 独立路由 `/types/[name]`、注入预览 tab、文件树管理器、保存后「下一轮生效」重建 | 创作中跳去改类型再回来，会话不断，下一轮生效 |
| M6 | Git UI | 历史时间线、diff、回滚（脏树守卫） | 能回滚一篇文档且会话史同步回滚 |
| M7 | 打磨 | 三栏拖拽/持久化/快捷键、暗色、错误态、empty 态 | 原型里定过的行为逐条对得上 |
| M8 | Archify 图示 | vendor CLI + IR 工具 + 海报提取 + sandbox viewer + 结构编辑器 + 实时预览 + revision/marker | AI 生成结构图；右键交互/编辑；不保存也能实时预览；保存同步海报；冲突可处理 |

依赖关系：M1 → M2 → M3 → M4 →（M5、M6 可并行）→ M7。

## 首次跑通检查表（M4）

- [ ] `agent_start → turn_start → message_start/… → message_update → turn_end → agent_end → agent_settled` 事件序与票 04 一致
- [ ] 会话文件落在 `<artifact>/sessions/`，重启后 `SessionManager.open` 能续接
- [ ] 系统提示词里能看到类型 prompt.md（追加）且**没有**未勾选的 skills 段
- [ ] 工具调用只出现白名单里的（无 bash）
- [ ] 一次编辑触发 git commit，message 前缀 `ai:`
- [ ] 配好远端后能拉取/推送；推送前按文件夹生成提交（文档 artifact / 类型 / 技能 / 根目录），拉取冲突时 pi 修复、自动提交合并，且合并期间自动提交不抢跑
- [ ] 收起→展开消息流后历史完整；刷新后仍在

## 已知风险与对策

| 风险 | 对策 |
|---|---|
| 追加提示词导致模型「编码代理」跑偏 | 见 ADR-06 的四条缓解 + 首轮实测复核 |
| `createMcpExtension()` 参数签名与文档不符 | M2 装包后读 d.ts，必要时改为「生成 mcp.json + agentDir 指向」 |
| pi 会话文件与 ui.jsonl 不一致 | ui.jsonl 每帧写快照；启动时以 pi 会话为准，ui 缺失则从消息重放（降级） |
| 大文档/大附件卡顿 | v1 不虚拟化；diff 侧已有限流（256KB 预算），文档正文不做截断 |
| pnpm 12 构建脚本策略 | M0 先 `approve-builds` |
| 中文路径 | 所有 git 调用带 `core.quotepath=false`；目录名不做 transliterate |
| Archify IR 不合规 | validate diagnostics 回填；实时预览保留 last-good；保存不写正式文件 |
| 手动改图后 AI 沿用旧版本 | `.aidocs/diagram-edits.json` 提醒 + prompt「改前先 read」；验收失败则升级为 marker 全文注入 |
| 实时预览拖慢编辑 | 600ms 防抖 + sha256 缓存 + 最多 12 份预览；渲染中保留 last-good |
| Archify 海报 CSS/class 被净化破坏 | 所有 SVG 统一走 poster 净化（保留 class/style，禁脚本/外链） |
| 交互 viewer 沙箱限制功能 | `sandbox=allow-scripts` + CSP；Phase 0 已实测；失败则回退海报/新标签打开 |

## 交付物清单

- `docs/spec/`（本目录，11 篇）
- `GLOSSARY.md`（术语）
- `wayfinder/MAP.md` + 9 张票（决策来源，可追溯）
- 原型：分支 `prototype/05-chat-canvas`、`prototype/06-type-editor`（只读参考，不合并）
- 烟测脚本：`.smoke/smoke.mjs`、`.smoke/prompt-inject.mjs`（本地未提交，可复制思路）
- 图示规格：[90-archify.md](90-archify.md)

## 开工建议

从 **M1 + M2** 开始，先让「配置供应商 → 发起一次调用」这条最窄的路跑通；不要先做 UI。pi 的装配（M4）是整个项目最容易翻车的地方，建议先用烟测脚本把装配写成可执行的最小版本，再套进 API 路由。
