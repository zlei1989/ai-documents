# 我的文档 · aidocs

纯本地的 Markdown 创作工作台：把「一类文档怎么写」沉淀成可复用的 **ArtifactType**（提示词 + 技能 + MCP + 资源），在文档工作区里边聊边写，产物落成 `MAIN.md` + 附件目录，全程 git 版本化。

## 核心概念

| 术语 | 含义 |
|---|---|
| **ArtifactType（类型）** | 一类文档的方法论包：`prompt.md` + `type.yaml`（勾选 skills / MCP / 模型）+ `resources/`，创作时注入会话 |
| **Artifact（产物）** | 一篇文档 = 一个目录，入口 `MAIN.md`，带 `assets/`、`research/`、`sessions/` |
| **Group（分组）** | Artifact 的一级归类 |
| **消息流** | 创作过程的块状事件流（文本 / 思考 / 工具调用 / 生图结果格子），文档就绪后收起 |

完整词表见 [GLOSSARY.md](GLOSSARY.md)。

## 快速开始

前置：**Node ≥ 22.19**（pi 内核要求）、**pnpm 12**、**git**。

```bash
pnpm install
pnpm dev          # http://127.0.0.1:3084
```

安装报 `ERR_PNPM_IGNORED_BUILDS` 时，在 `pnpm-workspace.yaml` 的 `allowBuilds` 里逐项置 `true`（pnpm 12 是 mapping，不是 list）。

想用 `uvx` 启动 Python 写的 MCP 服务器（`uvx mcp-server-fetch` 之类），先装 **uv**：macOS `brew install uv`；Windows `winget install astral-sh.uv`；Linux `curl -LsSf https://astral.sh/uv/install.sh | sh`（默认落在 `~/.local/bin`）。应用解析命令时会额外找 `~/.local/bin`、`/opt/homebrew/bin`、`%APPDATA%\npm` 这些常见目录，并把命中的目录补进子进程的 `PATH`，所以不依赖启动应用时那份 PATH。

存储目录可以选任意可写位置：Windows 的盘符（`D:\我的文档`）、UNC 共享，macOS / Linux 的任意目录都行，不存在会自动创建（只拒绝把磁盘根目录当仓库）。配置在用户主目录的 `~/.aidocs/config.json`（Windows 是 `C:\Users\<你>\.aidocs\config.json`；含密钥，不进 git），文档与类型在你的 storageRoot（本身是 git 仓库，备份它即可）。

首次使用三步：设置 → **模型供应商**（协议 / baseUrl / key / 模型）→ 设置 → **存储**（选目录、初始化 git）→ 设置 → **类型**（写提示词）；然后到 `/docs` 新建文档开聊。需要 AI 配图时，在「模型供应商」页最下方再配置 **火山引擎（Seedream）** 的 Base URL / API Key 并启用（参考图走同一个 Key 的 Files API，默认 1 天过期）。

配置在 `~/.aidocs/config.json`（含密钥，不进 git），文档与类型在你的 storageRoot（本身是 git 仓库，备份它即可）。Windows / macOS / Linux 路径规则一致：路径校验用 `node:path`，不写死 POSIX 或盘符写法。

## 代码结构

```
apps/web/                Next 16 页面壳 + API 路由
packages/server/
  contracts/             zod 契约，前后端唯一真相源
  core/                  配置 / 路径 / 事件日志 / git / 技能 / 调研
  agents/                pi 会话装配与事件投影
  api/                   服务层函数
  archify/               图示引擎适配（JSON IR → SVG 海报 / viewer）
packages/client/
  base/                  SWR hooks + SSE 订阅
  ui/                    shadcn 风格组件
```

依赖单向：`apps/web → client → server/{api,agents,core,archify} → contracts`。
命令：`pnpm dev` / `pnpm build` / `pnpm typecheck` / `pnpm test`。

## 页面

`/docs` 文档树 + 正文 · `/workspace/<group>/<name>` 正文 + 聊天（创作主界面） · `/types/<name>` 类型编辑 · `/settings` 设置（MCP 页支持粘贴 Claude / Cursor / VS Code / Zed / OpenCode 等客户端 JSON，预览后导入）

## 深入

- 设计与决策：[docs/spec/00-overview.md](docs/spec/00-overview.md)（总览，另有 10-storage / 20-architecture / 30-streaming / 40-flows / 50-settings / 60-ui / 70-adr / 80-handoff / 90-archify）
- 调研与评估：[docs/research/](docs/research/)
