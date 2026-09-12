# 12 - 图片输入（多模态 content）处理审计与修复

日期：2026-09-11　状态：已修复（normalize + 显式省略提示），未发版

## 问题

客户端（如 Zotero 插件）发送 OpenAI 多模态格式：
`content: [{type:'text'},{type:'image_url',image_url:{url}}]`

现象分两类：
1. **`[object Object]`**：适配器把数组 content 直接拼进字符串模板。
   - 根因：`qwen-ai.ts` 的 `systemContent += msg.content` / `userContent = msg.content`（旧代码 ~L304-321）。
   - 次级风险：kimi/glm tool 消息路径 `String(msg.content || '')`；minimax `[TOOL_RESULT ...] ${msg.content || ''}`。
2. **图片静默丢弃**：所有文本化通道只 filter `type==='text'`，图片消失且模型不知情。

## 修复（本次提交）

- 新增 `src/main/proxy/utils/messageContent.ts`：
  `extractTextFromContent` / `countImagesInContent(s)` / `hasImageContent` /
  `buildImageOmissionNotice` / `flattenContentWithImageNotice`。
- `qwen-ai.ts`：拼接处全部改用 `extractTextFromContent`；`QwenAiMessage.content` 类型放宽为 `string | any[]`；有图片时附加省略提示。
- `kimi.ts` / `minimax.ts`：全部 `typeof content === 'string' ? content : ''` 读取点（各 5 处）改用工具函数；tool 结果字符串化修复；图片计数提示。
- `deepseek.ts` / `glm.ts`：tool 路径 `String(content)` 改为数组安全提取。
- `zai.ts`：数组 content 归一化为文本再进入 processedMessages；图片提示注入最后一个 user 消息。
- `qwen.ts` / `perplexity.ts` / `mimo.ts`：图片计数 + 省略提示。
- `utils/tools.ts`：`hasToolPromptInjected` / `isComplexQuery` 支持数组 content（此前数组消息会被当作空字符串，可能漏检客户端已注入的工具提示词）。
- 测试：`tests/providers/message-content.test.ts`（8 例，`node --experimental-strip-types --test` 运行，全过）。

## 现状矩阵（图片支持）

| 供应商 | 图片通路 | 行为 |
| --- | --- | --- |
| GLM | ✅ 真实上传（`uploadFile` + refs，base64/URL 均可） | 正常工作 |
| Qwen (国内) | ✅ 真实上传（workspace OSS 三步管线，best-effort，见下节） | 上传失败自动降级为省略提示 |
| Z.ai | 协议含 vlm_* features 但未实现上传 | 文本 + 省略提示 |
| Qwen AI (国际) | `files: []` 字段存在，上传协议未逆向 | 文本 + 省略提示 |
| Kimi / MiniMax / Perplexity / Mimo / DeepSeek | 无 | 文本 + 省略提示 |
| 自定义 OpenAI 兼容端点 | 直接透传（doForward 不改动 messages） | 取决于上游 |

## Qwen 国内版图片上传实现（2026-09-12 新增）

协议逆向自 `g.alicdn.com` 的 `@ali/qianwen-web@4.6.3` 前端包（`chunk-6057.js` 模块 15022 上传管线、`chunk-4857.js` 模块 83741 mime 常量与 `composeMessages()`）。

### 域名表

| 域名 | 用途 |
| --- | --- |
| `chat2.qianwen.com` | 主聊天 API（既有） |
| `chat-side.qianwen.com` | 会话文件记录（`/api/v2/file/record/add`、`/api/v2/file/record/delete`） |
| `workspace-res.qianwen.com` | 图片上传（`/1/oss_token`、`/1/oss/callback`） |
| `chat2-api.qianwen.com` | 预留（当前未使用） |

### 五步管线（`QwenAdapter.uploadChatImages`）

1. **提取**：`extractImageDataUrls()` 只收集 `role==='user'` 且 `type==='image_url'` 的部分，支持 data URL（base64/URI 编码）与 http(s) URL（`resolveImageBytes`）。
2. **限额**：单图 ≤ 10MB（`QWEN_IMAGE_MAX_SIZE`），单次 ≤ 10 张（`QWEN_IMAGE_MAX_COUNT`），超出计入 `skippedCount` 并 warn。
3. **申请凭证**：`POST {workspace}/1/oss_token`，body `{file_name, content_type:'application/octet-stream', content_md5, size}`；`content_md5` = `computeContentMd5Base64()`（Node `crypto` md5 → base64，等价前端 SparkMD5+btoa）；headers 用既有 `getApiHeaders(ticket)`，params 用 `getApiParams({req_id})`。
4. **上传 OSS**：`PUT {host}/{encodeURIComponent(object)}`，headers = `flattenOssHeaders(oss_headers)` + `Content-Type` + `Content-Md5` + `authorization`，params `{req_id, biz_id:'ai_qwen'}`；随后 `POST {workspace}/1/oss/callback` body `{file_md5, file_name, file_type, bucket, endpoint, object, entry:'qwen_pc'}` → 取 `material_cdn_url || material_url` 与 `ws_gid`。
5. **登记会话**：`POST {chat-side}/api/v2/file/record/add`，body `{fileName, fileType:'image', resourceKey:id, resourcePath:url, fileSize, model:'Qwen', sessionId, batchId, resourceInfos:[{key,url}]}`；**best-effort**，失败仅 warn 不中断。

### 消息形态（与前端 `composeMessages()` 一致）

```js
messages: [
  { content:'', mime_type:'image/url', status:'complete',
    meta_data:{ resource_infos:[{url, id, file_format, file_name, file_size:String()}] } },
  { content: finalContent, mime_type:'text/plain', meta_data:{ ori_query: finalContent } }
]
```

图片消息**在前**、文本在后。

### 签名与风控结论

- 前端上传请求带霸下/AWSC 签名（依赖浏览器指纹 + `sec.qianwen.com` 设备注册），Node 侧不可复现；AGENTS.md 禁止绕过访问控制，因此本实现**不携带签名**，与既有 chat 调用同等待遇（best-effort）。
- `workspace-res.qianwen.com` 是否强制校验签名**未经真实账号验证**；若返回 403/签名类错误，`chatCompletion` 自动降级为"图片上传失败"省略提示，不会中断对话。
- 风险已知悉：若风控标记无签名上传，理论上可能影响账号（前端存在 `ACCOUNT_BLOCKED` 处理路径）。

### 纯函数导出（可单测，`tests/providers/qwen-image-upload.test.ts` 6 例）

`computeContentMd5Base64` / `imageFileTypeFromName` / `flattenOssHeaders` / `buildImageResourceInfos` / `buildImageMessages` / `extractImageDataUrls`，类型 `QwenUploadedImage`。

### Node strip-types 导入修复（顺带）

- `parseToolCallsFromText` 定义在**文件** `src/main/proxy/utils/toolParser.ts`，不在目录 `toolParser/index.ts`；`qwen.ts` 与 `streamToolHandler.ts` 的导入已修正为 `./toolParser.ts`。
- `streamToolHandler.ts` 原先还从 `toolParser/index.ts` 导入不存在的 `createBaseChunk`（HEAD 遗留，Vite 下被 tree-shake 掩盖，Node ESM 下会抛 `SyntaxError`），已移除。

## 后续可选（未做）

- Qwen AI 国际版上传逆向：`chat.qwen.ai` 当前 TLS 握手失败（直连与代理均 HTTP 000 / `ERR_CONNECTION_CLOSED`），协议未知，按用户决策保留省略提示。
- Z.ai：开启 `vlm_tools_enable` 等 + 图片上传协议。

## 已知无关失败测试（修改前即失败）

- `provider-flow.test.ts`："Z.ai docs mark provider temporarily unavailable…"（docs 与断言不同步）
- `tool-calling/*.test.ts`："model mapping UI protects built-in mappings…"
