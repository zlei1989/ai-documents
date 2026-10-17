# 95 · 生图（火山引擎 Seedream）

## 目标

在 pi 会话里只注册**一个**工具 `seedream_image_generation`，覆盖：

- 文生图 / 图生图 / 多图融合 / 多参考图；
- 组图（`max_images`，5.0 lite / 4.5 / 4.0）；
- 图层拆分与交互编辑（5.0 pro / flash）；
- 流式输出；
- 联网搜索（5.0 lite）。

工具同时负责：本地参考图读取与上传、生成图下载与落盘、Markdown 引用、消息流结果块。模型不接触 base64 / 本地绝对路径。

## 配置

「设置 → 模型供应商」页最下方「火山引擎」卡片：

| 字段 | 默认 | 说明 |
|---|---|---|
| 启用 | 关 | 开启且配置完整时才注册 `seedream_image_generation` |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` | 只填域名会自动补 `/api/v3` |
| API Key | 空 | 只写不读；`GET /api/seedream` 只回掩码 + `hasKey` |
| 默认模型 | `doubao-seedream-5-0-flash-260915` | 下拉预设 `5.0 pro` / `5.0 flash`，也可手填其它模型 ID 或 Endpoint ID；工具参数 `model` 可覆盖 |
| 默认尺寸 | `1536x1024` | **文生图**默认 3:2 文章插图；图生图/编辑不传 `size` 时按模型默认，尽量保留参考图比例；下拉预设 3:2 / 16:9 / 1:1，也可手填其它 `宽x高`；工具参数 `size` 可覆盖 |

参考图上传复用同一个 Base URL / API Key 的 **Files API**（`POST {base}/files`），没有独立的临时存储配置。文件默认 **1 天后过期**，由 Files API 自动清理。

落盘：`~/.aidocs/config.json` 顶层 `seedream` 段（含 key，`0600`），不在 `settings` 里。
HTTP：`GET/PUT /api/seedream`、`POST /api/seedream/test`。

「测试连接与文件上传」做两件事：

1. **Ark 探针**：用 `size: "1x1"` 的故意非法请求验证鉴权；不生成图片、不计费。
2. **Files API 探针**：上传内置 1×1 PNG（`purpose=user_data`、1 天过期、文件名 = 内容 SHA-256），轮询到 `active`，返回 File ID。

## 默认值

- 文生图 `size=1536x1024`（3:2，文章插图）；设置里可改，工具参数 `size` 可覆盖；图生图/编辑不传时按模型默认；
- `output_format=jpeg`（4.5 / 4.0 不发送该字段）；
- **`watermark=false`**（显式 `watermark:true` 才加「AI 生成」水印）；
- `stream` 对支持流式的模型自动开启（默认 flash 下为关）；
- `web_search=false`、`transparent=false`。

## 工具参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `prompt` | string? | — | 生成/编辑提示词；`layers` 模式可省略（自动识别） |
| `mode` | `auto\|text\|image\|edit\|fusion\|layers` | auto | 按 images/edits/layers 推断 |
| `images` | string[] | [] | http(s) URL、`data:` URI、`assets/...`、本应用 `/api/docs/.../assets/...` 代理地址 |
| `edits` | `{ bbox?, instruction }[]` | — | 交互编辑；bbox 为输入图像像素坐标 |
| `layers` | `{ name?, bbox?, description? }[]` | — | 图层拆分元素；不填自动识别 |
| `model` | string | 设置默认 | 覆盖默认模型；可传 Endpoint ID |
| `size` | string | 文生图 1536x1024 | 档位或 `宽x高`；文生图用设置默认，图生图/编辑不传按模型默认；工具参数覆盖；图层模式支持 `auto` |
| `output_format` | `jpeg\|png` | jpeg | 4.5 / 4.0 不支持，显式传会报错 |
| `transparent` | boolean | false | 仅 pro/flash、单张图、强制 png |
| `max_images` | integer 1–15 | — | 组图；参考图 + 生成图 ≤ 15 |
| `stream` | boolean | 支持时 true | pro/flash 不支持 |
| `web_search` | boolean | false | 仅 5.0 lite |
| `watermark` | boolean | false | 是否加水印 |
| `title` | string | prompt 截断 | 文件名与 Markdown alt |

## 能力矩阵

| 族 | 参考图上限 | 图层拆分 | 组图 | 流式 | 联网搜索 | 透明背景 | output_format | size 档位 |
|---|---|---|---|---|---|---|---|---|
| 5.0 pro | 10 | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | 1K/1.5K/2K（图层另有 auto） |
| 5.0 flash（默认） | 10 | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | 同上 |
| 5.0 lite | 14 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | 2K/3K/4K |
| 4.5 | 14 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | 2K/4K |
| 4.0 | 14 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | 1K/2K/4K |
| 未知 / Endpoint ID | 14 | 透传 | 透传 | 显式 | 透传 | 透传 | 透传 | 透传 |

按模型 ID 前缀识别（`seedream-5` + `pro|flash` → 5.0；`seedream-4-5` / `seedream-4-0`）。无法识别的模型宽松透传，由 Ark 做最终校验。

## 模式与 prompt 组装

- `text`：不传 images；必须有 prompt。
- `image`：1 张参考图；必须有 prompt。
- `edit`：1 张参考图 + prompt；`edits` 的 bbox/instruction 会追加为
  `按下列标记区域精确编辑…` + `<bbox>l t r b</bbox>`。
- `fusion`：≥2 张参考图（多图融合 / 多参考图）。
- `layers`：1 张参考图 + `layer_decomposition:true`；`layers` 列表会追加为
  `将图片拆分为底图和独立图层…`；无 prompt/列表时省略 prompt（自动识别）。
- `auto`：有 `layers` → layers；有 `edits` → edit；否则按 images 数量推断。

尺寸档位只决定分辨率；宽高比、图片形状、用途要写进 prompt（Ark 规则）。

## 参考图上传（Files API）

参考图分三类：

1. `http(s)` 远程 URL：直接透传给 Ark（已经在远端）。
2. 文档内 `assets/...`：读文件；`data:image/...;base64,...`：解码。
3. 本应用 `/api/docs/<group>/<name>/assets/...` 代理地址：抽取 `assets/...` 尾段按当前文档读取；其它 localhost 地址直接报错。

本地 / data URI / 代理地址的图：

- 校验格式（png/jpeg/webp/gif/bmp/tiff/heic/heif）、单图 ≤30MB、路径在文档 assets 内（非符号链接）；
- 计算 **SHA-256**，**multipart 文件名 = 哈希（无扩展名）**，MIME 由 Blob `Content-Type` 表达；
- `POST {base}/files`，`purpose=user_data`，`expire_at = now + 1 天 + 5 分钟缓冲`：
  - 只带 `Authorization: Bearer <key>`；`Content-Type` 交给 fetch 生成 multipart boundary；
  - 响应 `status=processing` 时轮询 `GET {base}/files/{id}`，直到 `active`（最多 30s）；
  - 用返回的 **File ID** 作为生图接口 `image` 字段的值（远程 URL 仍按 URL 透传）；
  - Files API 的 detail/list 在当前线上不返回 `download_url`，因此不用预签名地址；如果后续 API 提供，再切换。
  - 若生图接口返回 400 图片参数错误（File ID 不被接受），自动用本地 bytes 回退为 `data:image/...;base64,...`，并在工具文本里说明；其他错误不回退。
- 会话级缓存按 SHA-256 记录 `fileId/expireAt`；同一张图重复引用直接复用 File ID，过期（1 天）后重传。
- **Files API 上传失败不阻塞生图**：例如 Base URL 为 `/api/plan/v3` 时 `/files` 返回 404，工具会用本地 bytes 自动回退 `data:image/...;base64,...`，并在工具文本里说明；图生图/编辑仍能完成。
- 文件 1 天后由 Files API 自动过期删除。

## 生成图落盘与返回

- 目录：`<artifactDir>/assets/images/`；
- 命名：单图 `<slug>.<ext>`；组图 `<slug>-1.<ext>`；图层底图 `<slug>-base.<ext>`、图层 `<slug>-layer-<z>.<ext>`（png）；同名自动 `-2`；
- 扩展名优先响应 `output_format`，其次魔数嗅探；
- 工具返回**相对路径** Markdown 引用，例如 `![城市夜景](assets/images/城市夜景.jpg)`；
- 模型把引用单独一行插入 `MAIN.md`；浏览器渲染时才映射成
  `/api/docs/<group>/<name>/assets/images/...`（工作区带 `?v=<imageEpoch>` 破缓存）。
- 生成图**不**上传 Files API；以后被当作参考图时会按需上传。

## 消息流生图结果

工具结束后，`ChatRuntime` 把 `details.images` 投影成 `images` 块，追加到同一条工具消息：

```ts
{ kind: 'images', images: [{ path, alt, size? }] }
```

- 多张图拼格子（最多 3 列；单图大图）；
- 点击打开页面级放大遮罩（Esc/点背景关闭，可新标签打开）；
- 右键菜单：加入对话上下文（Markdown 引用进入聊天输入框上方的选区缓存）、查看大图、复制 Markdown 引用；
- 刷新回放：`filterReplay` 保留带 `images` 块的消息，图片文件在 `assets/images/`，刷新后仍显示。

## 错误与边界

- 未启用：工具不注册；启用但缺 key/baseUrl/model：不注册 + 一条 warn notice，不阻塞创作。
- Key 无效 / 限流 / 额度 / 审核失败：中文原因；`OutputImageSensitiveContentDetected` 等单独翻译。
- 组图部分失败：保留成功图并列出失败 `image_index`；`InternalServiceError` 终止流。
- 流式中断 / 用户 abort：不写文件。
- 下载失败：保留 URL + 「24 小时内有效」，不算整体失败；该图不进入消息流格子。
- 参考图 Files API 上传失败会自动回退 base64，不阻塞生图；文件处理 failed / 处理超时才报错。
- 图层拆分多图、`layers`+`edits`、透明+jpeg、pro/flash+组图/流式/联网搜索、4.5/4.0+output_format 均在调用前报错。
