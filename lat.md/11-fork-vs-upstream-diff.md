# Fork 与上游 xiaoY233/Chat2API 差异对比

> 对比基准：上游 v1.4.0（shallow clone） vs 本仓库 v1.6.5。
> Fork 时已清除上游 git 历史（见 CHANGELOG 1.5.0「清除 xiaoY233 源仓库信息」），两仓库无公共祖先，
> 故采用文件树 diff 对比：**94 个文件差异，+6811 / −3807 行**。
> 对比日期：2026-09-05

## ① 版本与发布体系

| 项目 | 上游 | 本仓库 |
|---|---|---|
| 版本 | 1.4.0 | 1.6.5 |
| Electron | ^33.0.2 | ^43.1.0 |
| Vite / electron-vite | 5.4 / 2.3 | 7.3 / 5.0 |
| electron-builder | ^25.1.8 | ^26.15.3 |
| 发布目标 | github owner=`xiaoY233` | owner=`wxs0625`（Chat2API-WXS） |
| 发布脚本 | 仅 `scripts/release.js` | `release.js` 重写 + 新增 `auto-release.js`、`autostart-dev.sh` |
| CHANGELOG.md | 无 | 有（完整 1.5.0–1.6.5 记录） |
| release.yml | 基础版 | 重构为 create-release + 三平台矩阵，支持 Linux arm64 构建 |

## ② 新增功能（上游完全没有）

- **自定义供应商解锁**（v1.6.0，自定义供应商入口在 fork 中开放/完善）
- **俄语支持**：新增 `src/renderer/src/i18n/locales/ru-RU.json`（上游仅 en-US + zh-CN），语言选择器相应扩展
- **登录能力标注**：`LoginCapabilityBadge.tsx` 组件 + 登录能力审计体系（`lat.md/08`、`lat.md/09`）
- **账号并发控制**：`src/main/proxy/accountConcurrency.ts` + `tests/providers/account-concurrency.test.ts`
- **定时调度器**：`accountStatusScheduler.ts`（账号状态定时检查）、`modelUpdateScheduler.ts`（模型列表定时更新）
- **开机自启真实落地**：`src/main/lib/autoStart.ts`
  - Linux：写 XDG `~/.config/autostart/chat2api.desktop`（chmod 755），root 自动追加 `--no-sandbox`
  - Win/mac：`app.setLoginItemSettings`
  - 每次启动幂等同步已保存的 autoStart 配置

## ③ 平台与稳定性修复

- **Linux root 运行**：`--no-sandbox` 自动注入（避免 Chromium setuid 沙箱 SIGTRAP 崩溃）
- **优雅退出**：监听 `SIGTERM / SIGINT / SIGHUP` 后 `app.quit()`，避免关机时 apport 弹「应用程序已意外关闭」
- **托盘状态同步**：代理自启动成功后调用 `TrayManager.updateProxyStatus(true)`，托盘不再误显示「已停止」
- **应用内登录修复**：UA 修正 + 重试机制（kimi 等 OAuth / in-app login 流程）
- 9 个内置供应商配置均有更新（kimi / qwen / qwen-ai / zai 等的 OAuth、模型列表、令牌提取配置）

## ④ 文档与工程

- 新增 `lat.md/` 项目记忆体系（10 个文件：项目地图、代理工作流、Gemini 计划、登录审计、i18n 计划、委派 backlog、研究来源、登录能力审计、供应商目录调查、Jules 看板、本文件）
- `AGENTS.md`、`README.md`、`README_CN.md`、`docs/providers/*` 大幅扩充
- 新增测试：`tests/providers/account-concurrency.test.ts` 等

## ⑤ 保持不变的部分

- **9 个内置供应商集合完全一致**：deepseek、glm、kimi、minimax、mimo、perplexity、qwen、qwen-ai、zai
- 核心架构未变：Koa 代理 + provider 适配器 + sessionManager + electron-store
- 其余依赖版本一致：`ali-oss ^6.23.0`、`canvas ^3.2.1`、`zustand ^5`、`koa ^2.15` 等

## 附：差异文件规模

- 仅 fork 新增（A）：CHANGELOG.md、lat.md/*、scripts/auto-release.js、scripts/autostart-dev.sh、
  src/main/lib/autoStart.ts、src/main/proxy/accountConcurrency.ts、src/main/store/accountStatusScheduler.ts、
  src/main/store/modelUpdateScheduler.ts、src/renderer/src/components/providers/LoginCapabilityBadge.tsx、
  src/renderer/src/i18n/locales/ru-RU.json、tests/providers/account-concurrency.test.ts
- 修改（M）约 80 个：release.yml、package.json(-lock)、src/main/index.ts、ipc/handlers.ts、
  oauth（adapters/kimi、inAppLogin、manager、tokenExtractionConfig）、全部 9 个 builtin provider 配置、
  proxy（forwarder、loadbalancer、routes、server、adapters）、store（store.ts、types.ts）、
  renderer（Providers、LoginDialog、AddAccountDialog、Settings、i18n、proxyStore、settingsStore）等
