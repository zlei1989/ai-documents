# 30 · 流式协议与消息块

## 一条流，不是两条

参考仓库有「事件流 + 消息流」两条 SSE；本应用只有**单会话聊天**，合并为**一条**：`GET /api/docs/[...path]/events?afterSeq=N`。

## SSE 契约（照抄参考仓库纪律，只留一份实现）

```
id: <seq>
event: <type>
data: <JSON>
<空行>
```

| 纪律 | 要求 |
|---|---|
| 具名事件 | 客户端必须逐个 `addEventListener(type)`；`onmessage` 只收默认事件（已知大坑） |
| 续订 | `Last-Event-ID` / `afterSeq` 语义一致；**先订阅、再读历史**，中间不留事件循环让出点（否则丢窗口） |
| 心跳 | 15s 一条注释帧，防反代/浏览器掐连接 |
| 首字节 | 开流前发 `: ready`，让客户端确认握手 |
| 终态 | 会话是长连接，**不因终态关流**（打开历史也要能看）；客户端在卸载时 `cancel()` |
| 增量合并 | 消息帧按 `mergeKey` 在 **16ms 窗口**合并，只留最后一条（否则 n token 的回复发 n 帧 = O(n²)） |
| 头部 | `X-Accel-Buffering: no`、`Cache-Control: no-cache` |

## 事件类型

```ts
type ChatEvent =
  | { type: 'message';   seq: number; at: string; message: ChatMessage }   // 快照（覆盖式）
  | { type: 'status';    seq: number; at: string; status: SessionStatus }  // idle | running | waiting | done | error
  | { type: 'notice';    seq: number; at: string; level: 'info'|'warn'|'error'; text: string }
  | { type: 'heartbeat'; seq: number; at: string }
```

`ChatMessage` 是块容器：

```ts
interface ChatMessage {
  id: string; mergeKey: string; role: 'user' | 'assistant';
  blocks: Block[];
  turn?: { round: number };
  final?: boolean; // 本轮最终回复；历史回放只保留它（加用户消息与已答复澄清卡）
}
type Block =
  | { kind: 'text';     text: string; streaming?: boolean }
  | { kind: 'thinking'; text: string; collapsed: true }
  | { kind: 'tool';     tool: 'read'|'write'|'edit'|'ls'|'grep'|'mcp'|'research'|'archify'|'image'; title: string; detail?: string; status: 'running'|'ok'|'error' }
  | { kind: 'attachment'; files: { name: string; size: number; relPath: string }[] }
  | { kind: 'selection'; source: 'MAIN.md'; chars: number; preview: string }
  | { kind: 'images'; images: { path: string; alt: string; size?: string }[] }
  | { kind: 'clarification'; groupId: string; intro?: string;
      questions: { id: string; text: string; allowOther: boolean; options: { label: string; value: string; description?: string }[] }[];
      status: 'pending' | 'answered' | 'expired'; answers?: Record<string, string> }
  | { kind: 'error';    text: string };
```

**生图结果块**：工具 `seedream_image_generation` 结束时，`ChatRuntime` 从结果 `details.images` 投影出 `images` 块，追加到同一条工具消息（工具卡 + 图片格子）。前端用 `assetBase` 映射缩略图；点击放大、右键加入聊天上下文。图片文件在 `assets/images/`，刷新后仍可显示。

**澄清提问**：模型调用 `request_clarification` 时不渲染工具卡，而是发一条 `clarification` 块消息；`pending → answered/expired` 用同一 `mergeKey` 覆盖，状态同步 `waiting → running`。答案走 `POST .../clarifications { groupId, answers }`，工具返回后同一轮继续。

**密度（已定）**：工具调用合并为一张小卡片（工具名 + 路径 + `+N −M`），附件用 chips（名+大小），thinking 默认折起。

## 持久化：两份文件，各司其职

| 文件 | 归属 | 内容 | 是否进 git |
|---|---|---|---|
| `sessions/<id>.jsonl` | **pi** | 模型上下文真相（`session`/`model_change`/`thinking_level_change`/`message`，树状 id/parentId） | 是 |
| `sessions/<id>.ui.jsonl` | 本应用 | 渲染块：用户消息原文、附件/选区注入、assistant 块快照、状态迁移 | 是 |

- 为什么两份：pi 会话文件是模型上下文，**不含** UI 需要的附件 chips 与选区元信息；而 UI 块若反向投影 pi 条目，会在工具结果格式变化时脆断。两份文件同目录、同提交，回滚天然一致。
- 写入：`appendFileSync`（O_APPEND，单进程串行）；读侧容错（坏行跳过 + WARN），写侧严格（契约校验失败直接抛）。
- `seq` 由**本模块**在文件内单调分配（maxSeq+1），不交给调用方发号。
- 会话 id 与文件：沿用 pi 的 `<ISO 时间>_<uuid>.jsonl` 命名；`ui.jsonl` 用同名去 `.jsonl` 后缀。

## 重连与回放

1. 客户端打开文档 → `GET .../events`（无 afterSeq）→ 服务端回放 `ui.jsonl` 全量；
2. 客户端渲染历史，随后接收增量；
3. 断线重连带 `afterSeq`（或 `Last-Event-ID`）；
4. 服务端在 `subscribe` 上先挂监听再读历史（顺序见上），保证不丢不重。

## 回放精简（刷新后只看决策与结果）

- 刷新（`afterSeq=0`）默认只回放：**用户消息 + `final=true` 的最终回复 + 已答复的澄清卡 + 带 `images` 块的消息**；普通工具卡、思考块、中间文本不进入历史，避免行数过多、溯源困难。
- 最后一轮状态仍是 `running` / `waiting`（刷新发生在生成过程中）时，保留当前轮全部事件，刷新后仍能看到实时过程（工具调用、思考、流式文本）。
- 旧会话没有 `final` 标记时，每轮最后一条带文本的 assistant 消息兜底视为最终回复。
- `?full=1` 可看完整回放；`sessions/ui.jsonl` 始终保留完整过程，不丢审计信息。
- 思考流（`thinking_delta`）实时下发为 `thinking` 块并显示「思考」；完成后属于中间过程，刷新时默认隐藏。

## 前端消费

- `packages/client/base/src/chat-stream.ts`：`EventSource` + 具名事件 + `mergeKey` 覆盖累积 + `requestAnimationFrame` 合并提交（一帧至多一次 setState）。
- `packages/client/ui/src/composite/chat/`：`chat-panel`（头/流/输入）、`block-registry`（按 `kind` 分派）、`text-block`（streamdown）、`tool-card`、`attachment-chips`、`selection-block`。
- 长会话：列表虚拟化推迟到有实测需要再做（当前在 Not yet specified 雾区）。

## 输入侧

- 发送：`POST /api/docs/[...path]/messages { text, attachments?, selections? }`；运行中再发必须带 `mode: 'steer' | 'followUp'`（pi 的 `prompt()` 在流式期间裸调会 reject）。
- 中断：`POST .../abort`。
- **选区上下文**：在正文预览或「编辑原文」里选中区域 → 右键「加入对话上下文」→ 暂存为 `selections` 缓存（可多处累积、可单个移除或清空）→ 随下一条消息作为 `selection` 块发送；发送成功后立即清空，不重复注入。预览里右键图片同样可加入，内容是那张图的 Markdown 引用；没有选区、也没点中图片时保留浏览器原生右键菜单。
