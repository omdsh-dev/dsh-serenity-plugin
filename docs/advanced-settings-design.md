# 高级设定面板与三功能设计（F1 双端口 / F2 超限重建 / F3 会话命名）

> 设计文档 — dsh-serenity-hooks v1.21 功能组。S142 需求细化产物，2026-08-26 定稿。
> 范围：三功能 + 宁静号高级设定面板（客户端 UI + 插件服务端 API + 配置模型）。

## 1. 背景与目标

用户需求（S142 新功能需求池）：DSH 运行时（dsh-serenity-hooks 插件）三个新能力：

| 编号 | 功能 | 一句话 |
|------|------|--------|
| F1 | Web UI 双端口 + 登录 | 维持 127.0.0.1 主端口不变，额外监听一个端口；额外端口需网页登录（账号+密码），登录后即原生 Web UI |
| F2 | 上下文超限自动清空重建 | SESSION.md + SESSION-KEEPER 已是实时上下文整理 → 压缩不再需要，超限时 LLM 主动触发 `session_rebuild` 清空重建（新会话路线） |
| F3 | dsh 会话命名受宁静号 SESSION 控制 | dsh 会话创建时自动命名为 `S###-YYYY-MM-DD`（编号+日期） |

**核心设计约束（用户明确，贯穿全部）**：所有实现**优先在 serenity-plugin（dsh-serenity-hooks）内完成，零改 DSH harness**。调研确认三功能全部插件侧可行。

## 2. 技术事实基础（调研结论摘要）

来源：2026-08-26 三线并行调研（子代理）+ 交叉验证，基于 `AI_LAB/dsh-harness-public` 源码。详细证据链见 SESSION.md S142。

### 2.1 F1 平台事实
- DSH webServer 单实例单 listener（`packages/host/webserver/src/index.ts`），host 仅 `127.0.0.1`/`0.0.0.0`，单 port；`--host 0.0.0.0` 被 CLI 显式拒绝
- 唯一请求层机制 `isTrustedApiRequest`（`client/connection/src/api-request-trust.ts`）= DNS-rebinding/CSRF 栅栏，**非认证层**；无 cookie/登录态
- 信任栅栏基于 Host 头：loopback 或 trustedHosts 通过

### 2.2 F2 平台事实
- compact 事件链 `compaction/start|summary|end`（log-only session 事件）——插件已监听 `compaction/end`（`src/seams/compact.ts`）
- `session.append('user/message', anchor, { surfaceOp: {op:'replace', start, end}, sourceEventSeqs: [...] })` 是公开 API（`core/session` surface.ts:239-242 硬校验 sourceEventSeqs 覆盖）——可绕过 compaction engine 直接替换 surface
- `contextPressure` 会话投影（token-meter）：`ctx.get('sessionProjections').snapshot(session).values.contextPressure` 提供 contextWindow/pressureTokens/projectedTokens
- `agent/request-error` CONTEXT_WINDOW_EXCEEDED = provider 确认溢出的唯一推送信号
- **无模型面压缩工具**（compaction/README.md:91 "Human command, not a model tool"）→ 自触发必须走插件 tool
- `SessionStartSource` 预留 `'clear'/'compact'` 但无实现；无"清空 context" API
- first-anchor（`src/seams/bootstrap.ts`）：`agent/inbox/inserted` 时对无 user/message 历史的新会话注入两条锚定消息 → **新会话自动获得完整 ACC 身份**（F2 新会话路线的依据）

### 2.3 F3 平台事实
- `sessionTitle.rename(session, title)` 服务（`packages/session/session-title/src/index.ts:363-383`）：source `kind:'user'` → **pin 住标题，自动生成停止调度**
- title 是 server 端 log 事件 + last-wins 投影，client 只读显示自动同步（session.list projections.title）
- Session 是 append-only log 无可变 name 字段；正规改写唯一路径 = `sessionTitle.rename`
- 插件已有 `ctx.agents.create({ sessionId })` 先例（`src/tools/loop.ts:150-159`），sessionId 可自定义
- 介入点：`ctx.on('agent/session-start')`（session 级，context.ts 已用）

### 2.4 设置面板决策（用户拍板，含否决记录与终版分层）
- ❌ 否决（调研时）：dsh 原生设置面板（settings.section slot + settingsScope）——旧 RC `api-proxy.ts:126 WEB_SETTINGS_NAMESPACES` 静态白名单挡第三方 ns（官方标注 deferred work）
- ✅ **终版分层（2026-08-26 用户定稿，基于新 RC 复核）**：
  - **DSH 官方已实现 deferred work**（新 RC b150a551 起 `WEB_SETTINGS_NAMESPACES` 删除，`settings.describe({redactSecrets:true})` 全量暴露，api-proxy.ts:3161-3168）→ 第三方 ns 零改 DSH 进原生设置面板
  - **简单配置（开关、阈值）→ dsh 原生设置面板**：`ctx.settings.register(settingsNamespace('serenity-hooks'), schema)` + client `settings.section` slot
  - **复杂配置（账号列表 CRUD，含密码 hash）→ 宁静号高级设定面板**：扩展 SafeModePanel 为双 tab（状态/账号管理），数据走 localstore.json + `/serenity/config` API
  - 本地 DSH 已确认最新（用户核实），无兼容包袱
- 配置持久化：简单配置 → DSH settings.yaml（DSH 管）；账号列表 → localstore.json（宁静号管，git 已放行）

## 3. 方案设计

### 3.1 配置模型（分层：DSH settings + localstore）

**层 1：DSH settings（简单配置，原生设置面板）**

```jsonc
// settings.yaml 的 "serenity-hooks" section（DSH settings-file 自动管理）
serenity-hooks:
  gatewayEnabled: false      // F1 总开关
  rebuildEnabled: true       // F2 总开关
  rebuildThreshold: 0.9      // F2 触发比例（0~1）
  namingEnabled: true        // F3 总开关
```

注册：`installSettingsSection(ctx, settingsNamespace('serenity-hooks'), schema, entryConfig)`（settings/src/index.ts:863 标准路径；client `settings.section` slot 自动渲染 schema 表单）。

**层 2：localstore（复杂配置，宁静号高级面板）**

```jsonc
// localstore.json 的 "serenityAdvanced" 节（config-ops.ts 管理）
{
  "serenityAdvanced": {
    "gateway": {
      "host": "0.0.0.0",
      "port": 3081,
      "accounts": [
        { "id": "a1", "user": "yh", "passHash": "<scrypt hash>" }
      ]
    }
  }
}
```

- 账号列表 CRUD 走 `/serenity/config` API（GET 返回 user/id/hasPassword，**hash 永不落 wire**；PUT 新账号必带 pass，既有账号 pass 空=保留原 hash）
- 密码 hash：node:crypto scrypt（`config-ops.ts` 已实现 hashPassword/verifyPassword）

### 3.2 服务端 API 扩展（`src/api.ts` 新增路由）

| 路由 | 方法 | 认证 | 用途 |
|------|------|------|------|
| `/serenity/config` | GET | 主端口 loopback + `x-serenity-ui` 头 | 读账号列表（user/id/hasPassword，**无 hash**） |
| `/serenity/config` | PUT | 主端口 loopback + `x-serenity-ui` 头 | 账号 CRUD（新账号必带 pass；既有账号 pass 空=不修改） |
| `/serenity/login` | POST | 无（仅第二端口可达） | 账号密码登录 → 颁发 HttpOnly cookie |
| `/serenity/logout` | POST | cookie | 注销（清除 token） |
| `/serenity/session_rebuild` | POST | 主端口 + `x-serenity-ui` 头（或经 tool） | F2 重建触发（tool 的服务端执行面） |

安全设计：
- **简单配置（开关/阈值）不经本 API**——由 DSH settings 层管理（原生面板 schema 表单，wire 自带 redact 语义）
- 账号读写仅在**主端口**（127.0.0.1 loopback）+ `x-serenity-ui` 头门控（沿用 api.ts:132/171 既有模式）——账号管理只能本机/登录后的 WebUI 做
- 密码 hash 永不 GET 返回（只返回 `hasPassword: true/false` + user/id 列表）
- 登录/会话 token 仅存第二端口 server 的内存表 + HttpOnly cookie（重启即失效——用户决策"重启重新登录"）

### 3.3 F1：双端口网关（新文件 `src/gateway.ts`）

```
插件 apply 时（config.gateway.enabled）：
  ├─ createServer(第二端口 host:port)          // node:http，独立于主 webServer
  │   ├─ 请求 → 检查 HttpOnly cookie token
  │   │   ├─ 无/无效 → 返回登录页（内嵌 HTML，极简：user+pass+submit）
  │   │   ├─ POST /serenity/login → 验证账号 → Set-Cookie → 跳转 /
  │   │   └─ 有效 → 反向代理 → http://127.0.0.1:${ctx.webServer.port}
  │   │       ├─ Host 头改写为 127.0.0.1:<主端口>（过信任栅栏）
  │   │       ├─ HTTP 转发：http.request + pipe
  │   │       └─ upgrade（WS）：转发握手 + socket pipe
  └─ dispose：server.close() + token 表清空
```

要点：
- 端口/地址来自配置（3.1），默认 `0.0.0.0:3081`（家庭内网可达；主端口维持 127.0.0.1 现状）
- 登录页为插件内嵌字符串（无外部资源，适配任何部署）
- 代理保持主端口请求语义不变（path/query/body/headers 原样 + Host 改写）
- 明文 HTTP（用户决策；HTTPS 场景走外部专业反代）

### 3.4 F2：session_rebuild（新 tool + keeper 扩展 + 新会话路线）

**执行链（LLM 主动触发，用户决策）**：
```
SESSION-KEEPER（post-execute）扩展：
  计分提醒（现状） + 新增 contextPressure 检查：
    超 thresholdRatio → 提醒文本追加：
      "[SESSION-REBUILD] 上下文接近上限（{ratio}）。如需清空重建，
       可在适当时机调用 session_rebuild（将归档当前会话并开启新会话）。"

LLM 判断 → 调用 session_rebuild tool：
  ① 归档当前会话：SESSION.md 标记 completed + 目录移 AGENT_SESSIONS/_archived/
     （Ship of Theseus：旧会话完整留存，供后续重建推理）
  ② 创建新会话：ctx.agents.create({ sessionId: `S${next}-${today}`, meta: {cwd, agentPreset}, setup })
     （sessionId 走 F3 命名规则）
  ③ 注入锚点消息：新会话首条 = SESSION.md 路径 + 简短摘要 + 重建指令
     （agent.inject 先例；完整身份由 first-anchor + systemPrompt.section 自动恢复）
  ④ 返回结果：{ oldSession, newSession, anchor } 给 LLM
```

**接管原生 compact**：装配层将 `@deepseek-ai/dsh-compaction-basic` 的 `auto: false`（或插件配置禁用自动压缩）——避免双写冲突；`compaction/end` 重注入逻辑（compact.ts）保留作兜底（若外部手动 /compact）。

**tool 注册**（`src/tools/rebuild.ts`，对齐 loop.ts 模式）：
- 名称：`session_rebuild`
- 参数：`{}`（无参数；一切从当前会话推导）或 `{ note?: string }`（可选：给新会话的一句话背景）
- 门控：仅 CCC 内（findSerenityRoot）+ config.rebuild.enabled

### 3.5 F3：会话命名（新 seam `src/seams/session-title.ts`）

```
ctx.on('agent/session-start', ({ agent }) => {
  仅 CCC 内 + config.naming.enabled：
    sessionId = agent.session.id
    若 sessionId 匹配 S### 模式（宁静号编号）→ 不覆盖（已有编号）
    否则：生成「新宁静号编号」：读取 AGENT_SESSIONS/ 现有最大 S### + 1
          → title = `S${next}-${YYYY-MM-DD}`
          → ctx.get('sessionTitle')?.rename(agent.session, title)
          （user source → pin 住，DSH 自动命名不再调度）
})
```

要点：
- 时机 = session-start（session 已 live，rename 的 live 检查通过——F3 子代理确认）
- `ctx.get('sessionTitle')` 可选服务守卫（未装配则跳过）
- peerDependencies 补 `@deepseek-ai/dsh-session-title`（类型 + 约定）
- blank 显示语义接受（命名后无消息列表隐藏——用户确认）

### 3.6 高级设定面板（client 重构；复杂配置=账号管理）

**槽位**：`conversation.session.header.actions`（现有 SafeModePanel 同槽，list 槽可多条目）

**结构**（重构 SafeModePanel → 双 tab 大面板；简单配置已移出——由 dsh 原生设置面板承担）：
```
┌─ Serenity 徽章（绿点 + v1.21）────────────────┐
├─ 点击展开：弹出大面板（role=dialog）           │
│  ┌─ Tab 栏： [状态] [账号]                    │
│  ├─ 状态 tab（现状内容保留+扩展）：            │
│  │    CCC / loop / 守卫 / safe-mode 大开关    │
│  │    loops 运行状态列表                      │
│  │    + gateway 服务状态（监听地址/端口/账号数）│
│  ├─ 账号 tab（复杂配置，自绘 CRUD）：          │
│  │    gateway 监听 host/port 字段            │
│  │    账号列表（行：user / 密码(掩码) / 删除； │
│  │      +添加行；新账号必填密码）             │
│  │    底部：保存按钮（PUT /serenity/config）  │
│  └─ 提示行：开关/阈值等简单配置请到 dsh 设置面板│
└──────────────────────────────────────────────┘
```

**无滚动条约束（用户明确）**：面板尺寸扩大（如 560×480 CSS），内容在视口内完整容纳；设计时按紧凑布局规划（账号 tab 行列表 + 状态 tab 现状）。若内容超出 → 压缩行距/字号，**不允许出现滚动条**。

**组件拆分**（保持模块清晰）：
- `SafeModePanel.tsx` → 徽章 + 弹层外壳 + tab 切换（重构）
- `SettingsTab.tsx`（新）：设定 tab（三节表单 + 账号 CRUD）
- 样式：`SafeModePanel.css` 扩展（沿用 --dsw-alias-* 语义 token 明暗自适应）

### 3.7 配置读写客户端通道

- **账号层**：client fetch `GET/PUT /serenity/config`（主端口同源 + x-serenity-ui 头，api.ts 模式）；server 端 `config-ops.ts` 管 localstore.json `serenityAdvanced` 节（已实现：hashPassword/verifyPassword/read/write/update/toWire/applyWirePatch）
- **简单配置层**：DSH settings 原生通道（`ctx.settingsScope.bind()` client 读写 settings.yaml `serenity-hooks` 节；`settings/document-updated` 监听失效）

## 4. 文件改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/gateway.ts` | 新增 | F1 第二监听器 + 登录 + 反代 + WS pipe |
| `src/config-ops.ts` | 新增（已完成） | localstore `serenityAdvanced` 节读写 + scrypt hash + wire 形态 |
| `src/settings-section.ts` | 新增 | host 侧 `installSettingsSection(serenity-hooks, schema)` 简单配置注册 |
| `src/tools/rebuild.ts` | 新增 | F2 session_rebuild tool |
| `src/seams/session-title.ts` | 新增 | F3 会话命名 |
| `src/seams/keeper.ts` | 修改 | 扩展 contextPressure 提示 |
| `src/api.ts` | 修改（进行中） | + /serenity/config（账号 CRUD）+ /serenity/login 等路由 |
| `src/index.ts` | 修改 | Config 段 + apply 注册新模块 |
| `src/client/SafeModePanel.tsx` | 重构 | 双 tab 大面板（状态/账号） |
| `src/client/AccountsTab.tsx` | 新增 | 账号 tab（CRUD 表单） |
| `src/client/SettingsSection.tsx` | 新增 | dsh 原生设置面板的 serenity-hooks section（简单配置 schema 表单） |
| `src/client/SafeModePanel.css` | 扩展 | 大面板样式 |
| `tests/*` | 新增/修改 | config-ops/gateway/rebuild/session-title 单测 + 面板组件测试 |
| `package.json` | 修改 | peerDeps + @deepseek-ai/dsh-session-title + @deepseek-ai/dsh-settings + client peers；版本 1.21.0 |
| `dsh.plugin.json` | 修改 | 版本 + 工具清单 + session_rebuild |
| `CHANGELOG.md` | 修改 | v1.21.0 条目 |

## 5. 实现顺序（依赖驱动）

1. **config-ops + /serenity/config API**（地基：账号模型 + 路由 + 单测）——config-ops.ts 已完成，api.ts 路由已加
2. **settings-section**（简单配置：installSettingsSection + client SettingsSection 组件 + 单测）
3. **F3 会话命名**（最小依赖：seam + peerDep + 单测）
4. **F2 rebuild**（tool + keeper 扩展 + 归档逻辑 + 单测）
5. **F1 gateway**（第二 server + 登录 + 反代 + 单测）
6. **面板重构**（双 tab UI + 账号 CRUD；依赖 1-5 的 API）
7. **发布**：typecheck/test/build → 版本三处（package.json/dsh.plugin.json/CHANGELOG）→ npm publish → github-push → deploy → restart-web

## 6. 测试计划

| 面 | 测试 |
|----|------|
| config-ops | localstore 账号节读写、密码 hash 不回传、applyWirePatch（新账号必带 pass/既有账号保留）、scrypt hash/verify |
| settings-section | schema 注册、namespace 存在、开关/阈值类型校验 |
| gateway | 登录成功/失败、cookie 校验、Host 头改写、代理转发（mock 主端口）、WS upgrade（mock） |
| rebuild | 归档逻辑（SESSION.md completed + _archived/ 移动）、新会话创建、锚点注入、门控（非 CCC/enabled=false） |
| session-title | 命名格式、S### 递增、重复 session-start 幂等、enabled=false 跳过 |
| keeper | contextPressure 提示追加、原计分提醒不回归 |
| 面板 | 组件渲染（双 tab 切换、账号 CRUD、保存→PUT） |
| SettingsSection | 原生面板 section 渲染、值绑定（settingsScope mock） |

## 7. 版本与发布

- 版本：**v1.21.0**（三功能 + 双层配置面板 = 新特性集）
- 发布流程：S142 决策 #3（bump 三处 → test → publish 显式 registry → github-push → deploy → restart-web）

## 8. 明确不做的（边界，E↑）

- ❌ 改 DSH harness（webserver 多端口、session-title 原生等——全部回避；settings 白名单已由官方新 RC 解决，非本次改动）
- ❌ HTTPS/TLS（明文 HTTP；HTTPS 场景用外部专业反代）
- ❌ 原生 compact 的"清空"改造（改为插件 session_rebuild 接管 + auto:false）
- ❌ 模型面自动触发 rebuild（必须 LLM 主动调用 tool——用户决策，防止误清空）
- ❌ 多 CCC 设置隔离（配置在 localstore.json 全局，CCC 级差异后续再议）
- ❌ 账号密码进 DSH settings（复杂结构 + 秘密，归宁静号 localstore 管；DSH settings 只承载布尔/数字简单配置）
