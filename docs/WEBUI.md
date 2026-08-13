# WEBUI — Serenity 插件实时状态 + safe-mode 开关（client half）

> 状态：阶段 1 完成（服务端接口，v1.6.0）；阶段 2 client bundle 进行中。
> 需求：safe-mode 由用户**直接 WebUI 实时开关**（非斜杠命令、非模型中介）；WebUI 显示 Serenity 插件实时状态。

## 架构

```
┌─ 浏览器（client half）───────────────────────────┐
│ 输入框停靠栏 SafeModePanel（React）              │
│   ├─ 状态显示：ACC 版本 / CCC 根 / safe-mode 开关 │
│   │            / 黑名单条数 / keeper 阈值 / loop 模型 │
│   └─ 开关 → fetch POST /api/serenity/status      │
└──────────────┬───────────────────────────────────┘
               │ 同源 HTTP（trust fence 内）
┌──────────────▼───────────────────────────────────┐
│ Node（dsh-serenity-hooks 插件）                   │
│  registerStatusApi（ctx.httpServer 路由）         │
│   GET  ?workspace=… → getStatus()                 │
│   POST {workspace, on} → setSafeMode() 写/删标记  │
│   守卫实时读取 .serenity-safe-on → 写即生效        │
└──────────────────────────────────────────────────┘
```

## 服务端（阶段 1 ✅，已实现并测试）

- `src/status.ts`（纯逻辑）：`getStatus(cwd)` → `{root, accVersion, safeModeOn, blacklist, threshold, loopModel}`；`setSafeMode(root, on)` → 写/删 `.serenity-safe-on`
- `src/api.ts`：`ctx.httpServer.register` 路由 `/api/serenity/status`（GET 状态 / POST 切换）
- 插件 Config 新增 `api: boolean`（缺省 true），`inject` 增 `httpServer`
- 测试：`tests/status.test.ts`（5 用例）；全仓 60/60

## 客户端（阶段 2，进行中）

- `package.json`：`dshClient: { platform: 'web', inject: [...] }` + `exports["./client"]`
- `tsdown.config.ts`：双 bundle（node `lib/index.js` + 浏览器 `lib/client.js`，`window.__ModuleLoader__.load({id, factory})`），平台模块 external（react、`@deepseek-ai/dsh-client-*`）
- `src/client/index.ts`：`inject: ['slots', 'conversation', 'sessions', 'locale']`，注册 `conversation.input.dock` 槽 → `SafeModePanel`
- `src/client/SafeModePanel.tsx`：读取活跃会话 workspace → fetch 状态 → 渲染开关 + 状态；点击切换 POST

## 部署（阶段 2 完成后）

1. 构建 client bundle（tsdown）
2. `load-plugin.sh` 复制含 client 的插件（**复制时保留 `exports["./client"]` 与 `lib/client.js`**——需确认 load 脚本不删 client 产物）
3. **重启 dsh web**（Node half 启动时扫描 Loader 条目里的 dshClient 包，编入 boot graph，`/plugins/<id>/client.js` 服务）
4. 浏览器刷新 → 输入区出现 SafeModePanel

## 验证清单

| 项 | 期望 |
|----|------|
| 停靠栏出现 | 输入框上方/下方出现 Serenity 状态条（ACC 版本 + safe-mode 开关） |
| 状态显示 | CCC 根 / 黑名单条数 / keeper 阈值 / loop 模型正确（读 .dsh/serenity.json） |
| 开关生效 | 点击 ON → `.serenity-safe-on` 创建 → agent 的 bash 立即被守卫 deny；OFF → 恢复 |
| 实时性 | 无刷新，状态即时反映（fetch 轮询/变更后刷新） |

## 约束与风险

- client bundle 构建需 tsdown + lightningcss（参照 dsh-external/dsh-ui-progress 自包含预设）
- boot graph 启动时扫描 → 加 client 需重启一次
- `/api` 信任围栏：客户端与服务器同源（127.0.0.1:3080），无跨源问题
- 部署副本需保留 client 产物（load-plugin.sh 的 rm 清单要排除 lib/client.js）

## 参考

- client half 机制：`@deepseek-ai/dsh-client-modules`（Node half 扫描/哈希/服务 `/plugins`）
- 参照实现：`AI_LAB/dsh-external-refs/dsh-ui-progress`（输入停靠栏 + 服务端工具联动）
- UI 槽：`conversation.input.dock` / `conversation.chat.toolview`（官方既有槽）
