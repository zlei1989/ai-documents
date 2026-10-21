# 20 · 架构与 pi 嵌入

## 包结构（pnpm monorepo，源码直导 exports，零构建）

```
apps/web/                    Next 16 App Router：页面壳 + API 路由（只做 zod 校验 → 调 api → 错误映射）
packages/server/
  contracts/                 zod 契约（唯一真相源，前后端共享）
  core/                      零框架依赖：config-store / paths / event-log / git / skill-store / mcp-command / mcp-probe
  archify/                   Archify vendor CLI 适配：validate/render/海报提取/IR 存储
  agents/                    pi 适配层：会话注册表、运行时装配、事件投影
  api/                       一个功能一个文件的服务函数
packages/client/
  base/                      SWR hooks + EventSource 订阅 + http 原语
  ui/                        shadcn 组件（components/ui/ 与 composite/），纯展示、不调接口
```

**依赖方向（ESLint 强制单向）**：
`apps/web → packages/client/{base,ui} → packages/server/{contracts,api} → agents/core/archify → contracts`

## 为什么照抄这个骨架

来自 ai-result-evaluation 的实战纪律（票 02）：源码直导零构建、契约单点、页面薄接线、ui 不调接口。参考仓库的 `core/git-exec.ts`、`config-store`、`skill-store`、`mcp-probe`、SSE 两条流的实现可直接裁剪复用。

## pi 装配（`packages/server/agents`）

### 进程模型

- **in-process SDK**（非子进程）：Next route handlers 跑 Node runtime，直接在服务进程里创建 `AgentSession`。
- **会话注册表**挂在 `globalThis`（`Map<artifactDir + sessionId, AgentSession>`，运行时/澄清 hub 同键隔离），避免 dev 热重载丢会话；进程重启后从 `sessions/*.jsonl` 重建（`SessionManager.open`）。同一文档可以同时有多个会话，各自一份模型上下文与渲染日志。
- **会话清单**由 `sessions/.index.json` 维护（`packages/server/agents/src/sessions.ts`）：首次打开旧文档时盘点已有 pi 文件、迁移旧版 `ui.jsonl`；空文档自动建默认会话。切走空闲会话时释放运行时，`running`/`waiting` 保留。
- `next.config` 把 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 等列入 `serverExternalPackages`（避免被打包；经验判断，实测确认）。

### 每个 Artifact 的装配顺序（照参考仓库适配器）

```
1. 读全局配置 + 该 Artifact 的 type.yaml
2. ModelRuntime.create({ credentials: InMemoryCredentialStore, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
3. runtime.registerProvider(providerId, { name, baseUrl, api: openai→openai-responses / anthropic→anthropic-messages, models: [model] })   ← provider 必须早于 createAgentSession
4. await runtime.setRuntimeApiKey(providerId, key)                                       ← key 只进内存
5. 物化类型资源到 <artifact>/.aidocs/type/（gitignore），生成资源清单
6. 构造 DefaultResourceLoader({ cwd: artifactDir, agentDir: 应用配置目录, appendSystemPromptOverride, skillsOverride, extensionFactories: [createMcpExtension(), createArchifyExtension(), createResearchExtension()（默认注入；配置不可用时省略）, createSeedreamExtension()（启用且配置完整时才给）] })
   await loader.reload()
7. createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel, settingsManager: SettingsManager.inMemory({retry:{enabled:false}}), resourceLoader, sessionManager: sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(artifactDir, <artifact>/sessions, { id: sessionId }), tools: [read/write/edit/ls/grep, archify_guidelines/archify_save, research_*（默认；配置不可用时省略）, seedream_image_generation（启用时）, (可选) request_clarification], customTools? })
8. await session.bindExtensions({ mode: 'rpc' })     ← MCP 在 session_start 连接；mode 必须写死 'rpc'
9. session.subscribe(事件投影 → UI 块 + SSE)
```

### 关键约束（实测/踩坑记录）

| 约束 | 依据 |
|---|---|
| 工具白名单：`read / write / edit / ls / grep` + `archify_guidelines/archify_save`，**不开 `bash`** | 票 07：追加模式保留 pi 编码代理提示词，收紧工具是主要缓解 |
| 资料查询默认注入：追加 `research_search / research_fetch / research_save`（同一个白名单数组；配置不可用时降级并提示） | 资料查询插件，见 [../research/deepseek-research-plugin.md](../research/deepseek-research-plugin.md) |
| 生图启用时注入 `seedream_image_generation`（同一个白名单数组；启用但缺 key 时降级 + warn）；参考图上传复用同一 Base URL/API Key 的 Files API，默认 1 天过期 | 见 [95-seedream.md](95-seedream.md) |
| `tools` 是**闭集成员清单**，自定义工具必须显式列入 | 参考仓库适配器 |
| 图示只走 `createArchifyExtension`（CLI 子进程，无 bash）；普通 SVG 只读；不引入 MCP | 见 [90-archify.md](90-archify.md) |
| skills 根用**绝对路径**，相对路径按 cwd 解析会 0 命中 | 参考仓库 `PI_SKILLS_RELATIVE_PATH` 注释 |
| `skillsOverride` 必须实现 | 票 04 实测：loader 会自动把发现的 `<skills>` 段追加进系统提示词 |
| 会话终态用 `agent_settled`（不是 `agent_end`） | 票 04 事件序实测 |
| 续接用 `SessionManager.open(文件)`，不用 `continueRecent`（会取到 mtime 最新=上一次尝试） | 参考仓库适配器 |
| `dispose()` 在扩展绑定点之前建好释放链 | `bindExtensions` 抛错时否则漏清理 MCP 子进程 |
| 冲突修复是**独立最小会话**：cwd = storageRoot，`noExtensions / noSkills / noContextFiles`，工具仅 `read/write/edit/ls/grep`，`SessionManager.inMemory()` | 不让创作提示词、技能、MCP、AGENTS.md 干扰修冲突；没有 bash 就不能绕过应用 reset/checkout |

### 系统提示词 = 追加

```
最终系统提示词 = pi 默认提示词
               + 类型 prompt.md（appendSystemPromptOverride）
               + 「当前文档」上下文块（标题/路径/MAIN.md 是否存在/资源清单）
               + loader 自动追加的 <skills> 段
```

默认规则只保留：写作角色、可写路径、以及「不要猜内容，用工具查清楚」。澄清、资料查询、图示等使用策略由类型 `prompt.md` 定义，或用工具描述自行判断；不在默认提示词里写死场景。

风险与开关见 [70-adr.md](70-adr.md) ADR-07。

## 类型改动 → 下一轮生效

`systemPrompt` 与 skills 在 `createAgentSession` 时快照，因此：

1. 保存类型 → 不做任何打断；
2. 下一轮 `prompt()` 前检查 `type.yaml` mtime：变了就**重建会话壳**（重新走装配 2–8），`SessionManager.open(同一会话文件)` 续接，历史与工具结果都在；
3. UI 徽标始终显示「下一轮生效」。

## 目录寻址与安全

- 所有 API 以「相对 storageRoot 的路径」为参数，服务端 `realpath` 校验必须落在 storageRoot 内（防 `..` 穿越）。
- 写文件一律走 `core/fs-safe`：临时文件 + rename 原子写；目录操作先建后删。

## 错误模型

- 服务层抛 `ServiceError(code, 中文原因, context)`；路由层映射 HTTP：`VALIDATION/400`、`NOT_FOUND/404`、`CONFLICT/409`、`INTERNAL/500`。
- 中文原因在前，vendor 原文（git 的 `fatal:`、pi 的错误）进 `context`，不在用户文案里裸奔。
