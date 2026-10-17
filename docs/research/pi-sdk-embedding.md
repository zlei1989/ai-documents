# Research · pi SDK 嵌入姿势（票 01）

调研日期：2026-05（本次会话）。信源均为 @earendil-works/pi 官方仓库（main 分支）文档与 SDK 示例；标注「未证实」处实现时需再核对导出签名。

## 1. 会话生命周期与 SessionManager 持久化路径 —— ✅ 可指向任意目录

- `createAgentSession()` 返回 `AgentSession`，「owns one conversation」；`session.dispose()` 中止活动并释放。
- 默认持久化；`SessionManager.inMemory()` 关闭落盘。
- **自定义会话目录（关键证据）**：`SessionManager.create(cwd, customDir)` 显式支持「Custom session directory (no cwd encoding)」；配套 `SessionManager.list(cwd, customDir)` / `continueRecent(cwd, customDir)` / `open(path)`。
  → 结论：把 `customDir` 指到 **Artifact 目录内**（如 `<doc>/.session/`）即可满足「会话史随文档 git 化」的定调决策。
- 重启重连：`SessionManager.list` 枚举 + `SessionManager.open(path)` 重开；树状结构，branch 切换不丢旧分支。
- `AgentSessionRuntime` 提供 `newSession/switchSession/fork/importFromJsonl`；替换会话后订阅要重绑。

出处：[examples/sdk/11-sessions.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts)、[docs/sdk.md#sessionmanager-api](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

## 2. 系统提示词注入 —— ✅ 替换或追加均可

`DefaultResourceLoader({ cwd, agentDir, systemPromptOverride: () => "...", appendSystemPromptOverride: (base) => [...base, ...] })` → `await loader.reload()` → 传入 `createAgentSession({ resourceLoader })`。

- `systemPromptOverride` 时建议同时给 `appendSystemPromptOverride: () => []`，否则会叠加 `~/.pi/agent/APPEND_SYSTEM.md`。
- `session.systemPrompt` 只读，返回当前生效值。

出处：[examples/sdk/03-custom-prompt.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)

## 3. 内置工具 cwd / 边界 —— ✅ cwd 显式可控；无硬沙箱

- `createAgentSession({ cwd, tools: [...] })`：工具名从 `read/bash/edit/write/grep/find/ls` 中挑；cwd 定制时「createAgentSession() applies that cwd when it builds the actual built-in tools」。
- **注意**：未见硬沙箱/路径白箱文档——「AI 只能改本 Artifact 目录」要靠 cwd + prompt 约束 + （可选）自定义工具，不能假设有内核级限制。
- 自定义工具走扩展系统 `pi.registerTool()`（见 06-extensions 示例）。

出处：[examples/sdk/05-tools.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)

## 4. subscribe 事件流 —— ✅ 结构清楚

```ts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { /* 流式文本 */ }
});
```

- 事件覆盖：message updates、tool execution、queues、compaction、retries、run lifecycle。
- `message_end` = 权威完成消息；`agent_end` = 一次低层 run 结束（后续可能还有自动恢复/排队）；**`agent_settled` = 真正的终态信号**（→ 我们「消息流完成后收起」就用它）。
- 具体事件类型清单以导出声明为准（docs 未逐项列全，实现时看 `message-types.md` 与 d.ts）。

出处：[docs/sdk.md#subscribing](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

## 5. 中途交互与 compaction —— ✅ API 齐全

- 流式中再发 prompt 必须选 `steer()`（插当前 turn 后）或 `followUp()`（本次 run 完成后）；裸 `prompt()` 会 reject。返回值 `"queued" | "handled"`。
- `abort()` 停止并等空闲；`waitForIdle()` 只等。
- compaction：自动，`SessionManager` 重建上下文时对 active branch 应用 compaction；事件流有 compaction 事件。细节文档：[docs/sessions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)（本调研未展开，长会话 UX 属于 Not-yet-specified 雾区）。

出处：[docs/sdk.md#prompting](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

## 6. Skills 注入 —— ✅ skillsOverride 钩子

- `DefaultResourceLoader({ skillsOverride: (current) => ({ skills, diagnostics }) })`：可过滤当前发现的 skills、追加内联 `Skill` 对象（`createSyntheticSourceInfo(path, { source: "sdk" })`；字段含 name/description/filePath/baseDir/disableModelInvocation）。
- `loader.getSkills()` 返回 `{ skills, diagnostics }` 可预览发现结果。
- 发现位置：`cwd/.pi/skills`、`~/.pi/agent/skills` 等；兼容 agentskills 规范（SKILL.md frontmatter）。
  → 我们的「全局 Skills + 类型勾选清单」= 扫全局 skills 目录 + skillsOverride 按 type.yaml 勾选名单过滤。

出处：[examples/sdk/04-skills.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/04-skills.ts)、[docs/skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

## 7. MCP 注入 —— ✅ 官方扩展，SDK 需显式加

```ts
new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [createMcpExtension(), (可选) createCodemodeExtension({mode:"on"}), createToolSearchExtension()] });
```
- `createMcpExtension()` 默认「reads mcp.json from the agent directory and the trusted project」→ 我们把 agentDir 指到应用配置目录并生成 `mcp.json`（按类型勾选清单渲染）。
- MCP 在 `session_start` 时连接 → SDK 会话要调 `await session.bindExtensions({})`。
- codemode/tool_search 默认 inactive，经 `settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] })` 开启（纯 MCP 工具调用不需要 codemode，可省）。
- **未证实**：`createMcpExtension()` 是否支持直接传服务器配置对象（不生成 mcp.json）——实现时核对该函数签名/源码。

出处：[examples/sdk/14-codemode-mcp.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)、[docs/sdk.md#codemode-mcp](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

## 8. 模型供应商 —— ✅ auth.json + models.json 可定制路径

- `ModelRuntime.create({ authPath, modelsPath })` → `createAgentSession({ modelRuntime, model })`：凭证与模型清单文件位置完全可控（→ 应用配置目录）。
- `modelRuntime.setRuntimeApiKey("anthropic", key)`：运行时注入 key，可不落盘。
- `models.json` 的 `providers` 节可为内置 provider 改 `baseUrl`，并加自定义模型条目 `{ id, api: "openai-completions" | ... }`（Azure 例）；通用「自建 OpenAI/Anthropic 协议端点」的完整 schema 细节本文未逐一展开，见 [docs/models.md#configure-a-compatible-endpoint](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。
- `auth.json` 支持 API key、OAuth、`"key": "!command"` 命令惰性取数。
- 供应商覆盖面：Anthropic/OpenAI/DeepSeek/Google/Mistral/Groq/Cerebras/xAI/OpenRouter/Moonshot/Kimi/MiniMax 等 30+，各配环境变量名（`ANTHROPIC_API_KEY` 等）。
  → 应用的 Provider 表（协议/baseUrl/key/模型列表）→ 落盘为 pi 的 `models.json` + `auth.json`（或运行时 key），映射层很薄。

出处：[examples/sdk/09-api-keys-and-oauth.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts)、[docs/providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)

## 9. Next.js server 侧嵌入 —— ⚠️ 经验判断（无官方背书）

- pi 包为 ESM、Node 目标（`main: dist/index.js`），要求 Node ≥ 22.19。Next 16 route handlers 默认 Node runtime，可跑。
- 建议把 `@earendil-works/pi-coding-agent`（及其依赖 `pi-agent-core/pi-ai/pi-mcp`）列入 `next.config` 的 `serverExternalPackages`，避免被 webpack/turbopack 打包。
- 会话是长驻进程内对象：需要模块级（globalThis 缓存）会话注册表，避免 dev 热重载丢会话；生产单进程 OK。
- 「无法打包或 ESM 问题」的兜底：pi 支持 RPC 子进程模式（docs/rpc.md/cli-integration.md），即降格为子进程 JSON 协议。（经验判断）

出处：[docs/sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[docs/cli-integration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)

---

## 结论一句话

pi 的所有嵌入边界（sessionManager/resourceLoader/settingsManager/modelRuntime/extensionFactories）都有显式注入点，「每文档一目錄一持久会话 + 自定义系统提示词 + 勾选 Skill/MCP + 自有供应商表」全覆盖，无阻塞项；唯二实现期核实点：`createMcpExtension` 参数签名、Next serverExternalPackages 实测。
