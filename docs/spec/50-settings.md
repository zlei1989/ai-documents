# 50 · 设置页

六个 Tab：**模型供应商 / 存储 / 类型 / MCP / Skills / 资料查询**，加一个全局的「模型选择」区块。

## 5.1 模型供应商

- 表格：`名称 | 协议（Anthropic Messages API / OpenAI Responses API）| Base URL | 模型数 | 操作`
- 新建/编辑弹窗：名称、协议、Base URL、API Key（**只写不读**；回显为掩码 `sk-…3a0f`）。
- 协议语义：`OpenAI Responses API`（`POST {baseUrl}/responses`）与 `Anthropic Messages API`（`POST {baseUrl}/v1/messages`）；测试调用与真实会话使用同一协议。`anthropic` 的 Base URL 可只填域名，程序自动补 `/v1`。
- **模型弹窗**（供应商行「模型」按钮）：上半展示已录入模型列表（模型 ID / 上下文窗口 / 最大输出 Tok / 支持图像），支持逐行编辑、删除；「手动添加」填名称（即供应商要求的 model ID）、上下文窗口、最大输出 Tok、支持图像。同 ID 不允许重复添加（引导去编辑），编辑时 ID 只读；被全局默认模型引用的模型不可删除。
- **远端拉取仍在同一弹窗**：`preview`（用已保存的 Key 调 `{baseUrl}/models`，anthropic 只填域名时自动补 `/v1`；展示可选项与上下文窗口）→ `import`（勾选合并进本地列表；上下文窗口随导入写入 `ModelInfo.contextWindow`）；不直接把远端全量落盘。已导入模型若远端返回了上下文而本地为空，用「补全已导入 N」一键写回，已有值不覆盖。
- **上下文提取**：从 `/models` 响应的常见字段（`context_length` / `context_window` / `max_model_len` / `max_input_tokens` 等，支持顶层及 `top_provider` / `model_info` / `limits` 等嵌套容器）读取上下文窗口，数字字符串也识别。
- **模型能力**：`ModelInfo.supportsImages` 可选，未声明按不支持图像处理；装配 pi 时映射为 `input: ['text']` 或 `['text', 'image']`。上下文窗口 / 最大输出 Tok 留空时分别回落 200,000 / 8,192；输入支持 `k` / `M` 单位（如 `300k`、`1M`、`1.5M`），保存前换算成整数。
- 路由：手动保存/删除走 `PUT/DELETE /api/providers/{id}/models`；远端预览/导入走 `POST /api/providers/{id}/models/preview|import`。
- 删除有引用检查（被类型锁定或在用会话引用时提示）。
- 落盘：应用配置目录 `config.json`，API key `chmod 0600`；pi 侧由 `ModelRuntime.registerProvider` + `setRuntimeApiKey` 在内存注入，**不落 pi 的 auth.json**。

### 5.1.1 火山引擎（Seedream 生图）

- 位置：模型供应商页**最下方**的「火山引擎」卡片，与聊天供应商分开（图片 API 不是聊天协议）。
- 字段：**启用 / Base URL / API Key / 默认模型 / 默认尺寸**；默认模型 `doubao-seedream-5-0-flash-260915`，默认尺寸 `1536x1024`（3:2 文章插图）。参考图上传复用同一个 Base URL / API Key 的 **Files API**，没有独立的临时存储配置。
- 默认尺寸是**可输入的下拉框**：预设 `1536x1024`（3:2 文章插图）、`2048x1152`（16:9 横幅）、`1024x1024`（1:1 方图）、`2048x2048`（1:1 2K）；也接受手填其它 `宽x高`。默认尺寸只用于**文生图**；图生图/编辑不传 `size` 时按模型默认，尽量保留参考图比例。工具参数 `size` 可覆盖；切到 4.5/4.0 时按模型支持的总像素范围调整。
- 默认模型是**可输入的下拉框**：预设 `doubao-seedream-5-0-pro-260628`（图层拆分/交互编辑/透明背景）与 `doubao-seedream-5-0-flash-260915`（更快）；也接受手填其它模型 ID 或 Ark Endpoint ID。预设清单在 `contracts` 的 `SEEDREAM_MODEL_PRESETS`。
- 密钥：只写不读；`GET /api/seedream` 回掩码 + `hasKey`；落 `config.json` 顶层 `seedream`（0600），不进 `settings`。
- 「测试连接与文件上传」：Ark 用 `size:"1x1"` 的非法请求做鉴权探针（不生成、不计费）；Files API 上传内置 1×1 PNG（`purpose=user_data`、文件名 = SHA-256、1 天过期），轮询到 `active` 并返回 File ID。
- 启用且配置完整时，创作会话注入唯一工具 `seedream_image_generation`；启用但缺 key/baseUrl/model 时降级为无工具 + warn notice。
- 参考图文件由方舟 Files API 托管，默认 1 天后自动过期；生图请求用 File ID 作为参考图，不依赖公网 URL。
- 保存后 `resetAllRuntimes()`，下一轮按新配置重建会话（历史靠会话文件续接）。

详见 [95-seedream.md](95-seedream.md)。

## 5.2 存储目录

- 路径选择（目录选择器）+ 校验（绝对路径、可写、不能是磁盘/共享根目录）。**不限制存放位置**：Windows 盘符与 UNC、macOS / Linux 任意可写目录都接受，校验只用 `node:path`，不写死 POSIX 或盘符；`~` / `~/x` 自动展开。
- 校验失败原因按平台给示例：Windows 用 `D:\我的文档`，macOS / Linux 用 `/Users/you/我的文档`。
- git 状态区块：是否仓库 / 当前分支 / 最近提交 / 未提交变更 / 未解决冲突数 /「初始化版本历史」按钮（未初始化时）。
- 远端同步：显示远端名与脱敏地址、tracking ref、`↑领先 / ↓落后`；「拉取」「推送」「刷新」三个按钮，只在拉取/推送时访问网络。
  - 未配置远端时显示 `git remote add origin <url>` 提示并禁用按钮；有冲突 / 合并进行中时禁用拉取与推送。
  - 推送前按文件夹提交未提交改动：`docs/<group>/<artifact>`、`types/<name>`、`skills/<name>`、根目录各生成一个 `human: <标签> · 推送前提交` 提交；结果在按钮下方逐条列出（标签 / short sha / 文件数）。派生数据不进提交，分组提交失败则中止推送。
  - 拉取产生冲突：自动启动 pi 修复，抽屉里实时展示 `read/edit` 工具调用、修复说明与最终状态；可中止修复，修复结束后可「放弃合并」回到拉取前。
  - 推送被远端领先拒绝：提示「先拉取」，不 force push。
- 自动提交开关（默认开），debounce 数值（默认 2s/8s）；合并冲突期间自动提交自动跳过。
- 迁移提示：切换 storageRoot 不会搬数据，只切换视图。

## 5.3 类型

类型管理的**唯一入口**（编辑器里不放列表与切换，见 60-ui §6.2）。

- 表格：`名称 | 描述 | 规模（技能 · MCP · 资源）| 锁定模型 | 操作`；名称链到类型编辑器。
- 新建弹窗：来源（空白新建 / 复制现有类型，整目录拷贝 `type.yaml` + `prompt.md` + `resources/`）、类型名（目录名，可用中文，不可含 `/ \` 或以 `.` 开头，≤80 字）、描述。
- 行操作：`编辑`（进类型编辑器）、`复制`（预填「原名-副本」）、`删除`（二次确认；软删到 `.trash/types/`）。
- 类型名即目录名即 id，重命名请用「复制 + 删除」，不原地改目录名。
- 编辑器顶栏同样提供 `复制类型` / `删除`，与列表页等价；删除后回跳 `/settings#types`。
- 落盘：`<storageRoot>/types/<类型名>/{type.yaml,prompt.md,resources/}`。

## 5.4 MCP（全局）

- 表格：`名称 | 传输（stdio / http）| 命令或 URL | 状态 | 操作`。
- 新建弹窗：stdio（command + args + env）或 http（url + headers）。
- **启动器（launcher）**：`npx` / `uvx` / `bunx` / `pipx` / `python3 -m` 这类「先解析包、再起服务端」的命令，元数据（示例参数、安装方式、是否现下包）只在 `contracts/mcp-launcher.ts` 里写一份，设置页、「猜名字」、探针失败原因共用。
  - stdio 弹窗给「常用启动器」快捷按钮（`npx` / `uvx` / `bunx` / `pipx`）：命令空着时才填示例参数，已有参数不覆盖；选中后当场显示「要装什么」。
  - 命令解析（`core/mcp-command.ts`）：先按 PATH，再找各平台常见安装目录 —— POSIX 的 `~/.local/bin`（uv / uvx / pipx）、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`；Windows 的 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`~/scoop/shims` 等。Windows 上按 `PATHEXT` 匹配 `.exe` / `.cmd` / `.bat`，PATH 变量名大小写不敏感（`Path` 也认）。Finder / 桌面图标启动的宿主 PATH 里没有这些目录，`uvx` 会「明明装了却找不到」。
  - 探针与注入**共用同一份解析**：探针绿了、会话里起不来的假成功是这里最贵的 bug。起 stdio 子进程时把解析到的目录补进 `PATH`（用户写的 env 原样保留），因为 pi 的 stdio 传输是 `{ ...process.env, ...config.env }`。
  - 失败原因分两类：已知启动器直说缺什么（`uvx` ⇒ 先装 uv：Windows `winget install astral-sh.uv` / macOS `brew install uv` / Linux `curl -LsSf https://astral.sh/uv/install.sh | sh`），未知命令才回落到「请检查 PATH，或填写绝对路径」；探针仍然只查可执行性、不启动进程。
  - 导入时「猜名字」按包名：`mcp-server-fetch` / `mcp_server_time` ⇒ `fetch` / `time`（剥 `mcp-` / `server-` 前缀，连字符与下划线都认）；`--from` / `--python` 这类选项的取值不参与猜名字。
- 「测试连接」探针：四态（未测 / 连接中 / 成功 + 工具数 / 失败 + 原因）。
- **粘贴 JSON 导入**（多方言，先预览后落盘）：
  - 认得的形状：`mcpServers` 信封（Claude Desktop / Claude Code / Cursor / Windsurf / Cline / Continue）、`servers` 信封（VS Code，`inputs` 等兄弟键整份丢掉并点名）、`context_servers`（Zed）、`mcp`（OpenCode 的 `local` / `remote`）、`mcp_servers`、`amp.mcpServers`、本应用数组、单台服务器、无信封的 name-keyed map、JSONC（注释 / 尾逗号 / BOM）。
  - 字段归一：`type` / `transport` / `kind`（含 `streamable-http`、`local` / `remote`）；`httpUrl` / `serverUrl` / `endpoint` / `baseUrl` 等等价 URL；`command` 支持字符串或数组（OpenCode）；`args` 支持数组或空格分隔字符串；`env` / `environment` / `envVars` 与 `headers` / `http_headers` 等多别名合并；数字 / 布尔的 env / headers 值转字符串并记备注；`enabled` / `disabled` 都认，`enabled` 优先。
  - 边界：`sse` 按 http 导入并在预览里提示旧 SSE 可能不兼容；`sdk` 明确拒绝；跨传输字段（stdio 里的 url / headers、http 里的 command / args / env）丢掉并逐行点名；`${…}` 占位在 env / headers 的值里只认 `${环境变量名}`，在 url / command / args 里一个都不认（VS Code 的 `${input:…}` 会被拒）。
  - 预览：每条显示名称 / 传输 / 端点或命令 / 新增或覆盖 / 被丢字段与备注；支持逐条「跳过」；只有名字是猜出来的行可改名；同批重名会阻断该行；「先清空现有条目」默认关。确认计数与落盘用同一份解析结果。
  - 上限：256 KB / 100 条（先于解析拦下）；解析不碰 IO，放在 `contracts`，设置页与 `POST /api/mcp` 共用。
- 路由：`GET /api/mcp`；`POST /api/mcp` 兼容单条、数组、`{ servers, clear }` 与 `{ text, clear }`（服务端用同一份多方言解析器）；`DELETE /api/mcp?name=…`。
- 注入：按类型勾选渲染成 `mcp.json` 给 `createMcpExtension()`，agentDir 指向应用配置目录。

## 5.5 Skills（全局）

- 来源两个位置：`~/.agents/skills/*`（个人）+ `<storageRoot>/skills/*`（项目级，随 git）。
- 列表：名称 / 描述 / 来源 / 启停开关；点开看 `SKILL.md` 预览（左树右详情）。
- agentskills 规范：`<name>/SKILL.md`，frontmatter `name` + `description`；不合格条目也入列并给中文原因。
- **停用语义**：全局停用优先于类型勾选（UI 标灰 + 原因）。

## 5.6 资料查询（多源搜索 / 抓取）

- **默认注入**：资料查询不是可选项，没有启用开关；创作会话始终尝试装配三个 pi 工具。配置不可用时才降级为无工具 + warn notice，不阻塞创作。
- **作用**：给创作会话注册三个 pi 工具 —— `research_search`（**多源**检索，`sources` 可多选）、`research_fetch`（抓网页正文）、`research_save`（把带来源的整理稿写进 `research/`）。数据源全景见 [../research/data-sources.md](../research/data-sources.md)，DeepSeek 接口事实见 [../research/deepseek-research-plugin.md](../research/deepseek-research-plugin.md)。
- **默认源**：`web`（DeepSeek 联网搜索）每次 `research_search` 都会自动执行，模型不用手动加；其余源由模型按内容类型选择（论文 → crossref/openalex、生物医学 → europepmc/pubmed、预印本 → arxiv、公版书 → gutenberg、物种 → gbif、临床 → clinicaltrials、报告 → worldbank、欧盟统计 → eurostat）。
- **使用方式**：是否查、何时查由模型结合当前任务决定；默认提示词只要求“不猜内容，用工具查清楚”。工具描述提供多源能力，具体强制规则由类型提示词定义。
- **key 来源**：不新增密钥存储，只借用「模型供应商」里所选那条的 API Key（默认自动挑 `baseUrl` 指向 `deepseek.com` 的供应商）。表单里的 **Base URL** 只决定接口地址（默认 `https://api.deepseek.com`）；其余数据源全部是免 key 的开放接口。
- **三个区块**：① 供应商下拉 + Base URL + 「测试连接」（真打一次 Search，失败也给中文原因，HTTP 200）；② **数据源清单**（逐个勾选启停，`web` 固定为「必查」；`GET /api/research/sources` 下发，与模型看到的清单同源）；③ 默认条数（1–50）与「默认返回正文」开关（默认关）。
- **工具参数**：`research_search({ query, sources?, limit?, year_from? })`；`limit` 1–10（默认 5，每个源生效），`year_from` 对 crossref/openalex/europepmc/pubmed 生效。多源并发、按源分组、跨源按 DOI/URL 去重；单源失败只在该源下标注，不影响其它源；全部失败才抛错。
- **生效时机**：配置在 `createAgentSession` 时快照；保存后服务端 `resetAllRuntimes()` 释放在跑会话，下一轮按新配置重建（`SessionManager.open` 续接会话文件，历史不丢）。UI 文案写明「本轮会话自动重建」。
- **降级**：找不到可用供应商 / 缺 key → 不阻塞创作，会话照建，只发一条 warn notice「资料查询未生效」。
- **计费提示**：`web` 的 Search / Fetch 各按成功请求 5 元/1000 次、账号各 5 QPS；失败、无结果、超时不计费。其余源免费。
- **落盘**：`settings.research = { providerId, baseUrl, count, needContent, disabledSources }`（`config.json`，不含 key；`disabledSources` 存「停用」，新源默认开启）。

## 5.7 模型选择三层

| 层 | 位置 | 优先级 |
|---|---|---|
| 全局默认 | 设置页顶部「默认模型」 | 最低 |
| 类型锁定 | `type.yaml: model` | 中（锁定则忽略会话临时选择） |
| 会话临时 | 聊天栏顶部的模型下拉 | 最高（不落盘，仅本会话） |

解析顺序：会话临时 → 类型锁定 → 全局默认。任何一层解析不到 → 报错并指向设置页。

### 思考强度（与默认模型同卡）

- **入口**：设置 →「默认模型」卡里的「思考强度」下拉，与默认模型同一个「保存」按钮提交。
- **档位**：`off（关闭）/ low / medium / high`，落盘 `settings.thinkingLevel`，默认 `off`。只开四档：pi 的 `xhigh`、`max` 需要模型侧 `thinkingLevelMap` 显式映射，第三方供应商普遍不声明，选了也会被 pi 向下取整。
- **装配语义**：会话创建时快照。档位 ≠ `off` 时，`ModelRuntime.registerProvider` 把该模型声明为 `reasoning: true` 并给 `createAgentSession({ thinkingLevel })`——**两者必须成对**：pi 的 `getSupportedThinkingLevels()` 对没有 `reasoning` 的模型只返回 `['off']`，只给档位会被静默 clamp 成 off。`off` 保持不声明，与加这个开关之前的行为完全一致。
- **生效时机**：保存后服务端 `resetAllRuntimes()`，下一轮按新档位重建会话（`SessionManager.open` 续接会话文件，历史不丢）。
- **失败模式**：模型不支持思考却选了档位 → 供应商拒请求（不静默降级）；UI 文案要求这种情况选「关闭」。

## 5.8 设置页的形态

- 左侧竖向 Tab（沿用 shadcn `Tabs` 竖向变体），右侧内容区。
- 表格用 TanStack Table；表单用 react-hook-form + zod（契约来自 `contracts`）。
- 所有写操作成功用 sonner toast，失败用 item 级错误 + toast。
