# Qwen AI

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen-ai |
| 官网 | https://chat.qwen.ai |
| API Base | https://chat.qwen.ai |
| 认证 | JWT Token |
| 凭据字段 | `token`, `cookies`（含 `refresh_token`） |
| Google / Gmail 登录 | 支持 |
| Token 自动续期 | 支持（见下） |
| 风控验证窗口 | 支持（见下） |

## Token 自动续期

Qwen AI 的 access token 有效期约 15 分钟，但 `refresh_token` Cookie 有效期约 300 天。应用在以下时机自动调用 `GET https://auth.qwen.ai/api/v2/auths/refresh`（携带 Cookie 中的 `refresh_token`）续期，并持久化新的 token 与 cookies：

- 代理转发对话请求前（临期或收到 `unauthorized` / `token has expired` 时强制续期并重试一次）
- 账号有效性检测前（token 临期时先续期再校验）
- OAuth 适配器 `refreshToken` 调用时

只要账号 cookies 中保留了 `refresh_token`，长期不重启应用也不会因 token 过期而不可用。

## 风控验证窗口（WAF）

当请求被阿里云 Baxia WAF 拦截（返回 `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR` 的 punish 载荷）时，应用会自动弹出一个验证窗口：

- 窗口加载 punish 链接中的滑动验证码，并尝试自动完成滑动（类人轨迹，最多 3 次），失败时可手动滑动
- 验证通过后自动收集窗口内所有 cookies 合并回账号存储，并自动重试被拦截的请求
- 注意：风控拦截通常基于 IP，若自动/手动滑动均无法通过，请更换网络环境后重试

## 默认模型

内置默认模型跟随 `https://chat.qwen.ai/api/models` 当前返回的可用清单。下线或只在旧 HAR 中出现的模型不再作为默认项，避免请求时返回 `Model not found`。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.8-Max | qwen3.8-max |
| Qwen3.7-Plus | qwen3.7-plus |
| Qwen3.7-Max | qwen3.7-max |
| Qwen3.6-Plus | qwen3.6-plus |

> 说明：`Qwen3.8-Max` 为最新旗舰模型；`Qwen3.7-Max`、`Qwen3.6-Plus` 为保留的原有默认模型，若 `/api/models` 已不再返回，请求时可能提示模型不可用，可改用 `Qwen3.8-Max`。

## 其他官网模型

以下模型来自 `backup/har/chat.qwen.ai2.har` 中实际调用对话的官网模型。它们不作为内置默认模型，用户可在供应商管理 -> 模型管理中自行添加：显示名称填左列，实际模型 ID 填右列。

| 显示名称 | 实际模型 ID | 备注 |
| --- | --- | --- |
| Qwen3.7-Max-Preview | qwen-latest-series-invite-beta-v24 | Preview |
| Qwen3.7-Plus-Preview | qwen-latest-series-invite-beta-v16 | Preview |
| Qwen3.6-Max-Preview | qwen3.6-max-preview | Preview |
| Qwen3.6-Plus-Preview | qwen3.6-plus-preview | Preview |
| Qwen3.5-Plus | qwen3.5-plus | 低版本 |
| Qwen3.5-Omni-Plus | qwen3.5-omni-plus | 低版本 |
| Qwen3.5-Flash | qwen3.5-flash | 低版本 |
| Qwen3.5-Max-Preview | qwen3.5-max-2026-03-08 | 低版本 Preview |
| Qwen3.5-397B-A17B | qwen3.5-397b-a17b | 低版本 |
| Qwen3.5-122B-A10B | qwen3.5-122b-a10b | 低版本 |
| Qwen3.5-Omni-Flash | qwen3.5-omni-flash | 低版本 |
| Qwen3.5-27B | qwen3.5-27b | 低版本 |
| Qwen3.5-35B-A3B | qwen3.5-35b-a3b | 低版本 |
| Qwen3-Max | qwen3-max-2026-01-23 | 普通 Qwen3 |
| Qwen3-235B-A22B-2507 / Qwen2.5-Plus | qwen-plus-2025-07-28 | HAR 页面标签存在歧义 |
| Qwen3-VL-235B-A22B | qwen3-vl-plus | 多模态 |
| Qwen3-Omni-Flash | qwen3-omni-flash-2025-12-01 | Omni |
| Qwen2.5-Max | qwen-max-latest | 低版本 |

## 适配状态

已适配：国际版网页对话、流式对话、非流式对话、多轮会话、账号级清理对话记录、思考模式后缀、模型别名。

后续验证：官网反爬请求头、模型接口版本、Preview 邀请模型是否仍可用、图片/多模态模型字段。

## 教程

1. 登录 `chat.qwen.ai`。
2. 打开 DevTools -> Application -> Local Storage，复制 `token`；如请求需要 Cookie，同时复制完整 Cookie 字符串。
3. 在供应商管理中添加 Qwen AI 账号，填入 `token`，可选填 `cookies`。
4. 在模型管理中使用默认模型；如需上表其他模型，手动添加显示名称和实际模型 ID。
