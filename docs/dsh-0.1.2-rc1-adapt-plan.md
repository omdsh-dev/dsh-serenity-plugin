# dsh 0.1.2-rc.1 对 dsp（dsh-serenity-plugin）的适配方案

> 状态：**方案已产出**（只读核查 + 落盘，未实施代码改动）
> 日期：2026-09-05（S142）
> 参考源码：`AI_LAB/dsh-harness-public`（已 checkout `dsh-v0.1.2-rc.1`，tag 提交 a66e470204；全 250+ 包 version = `0.1.2-rc.1`）
> 前置文档：`docs/dsh-0.1.2-alpha-impact-assessment.md`（0.1.2-alpha.1 评估，本方案为其 rc 实况修订）
> dsp 源码根：`AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/`（当前 v1.28.0，peerDeps `^0.1.0-rc.5`）

---

## 0. 摘要

| # | 适配点 | 严重度 | alpha 结论 | rc.1 实况修正 |
|---|--------|--------|-----------|--------------|
| A1 | client import 面（`@deepseek-ai/dsh-client-runtime` 包删除） | 🔴 编译级 | 成立（4 src 文件） | 成立，且**声明面还有 3 处**（package.json / tsdown / tsconfig×2） |
| A2 | workspace RPC：`workspace.list` unary | 🔴 行为级 | 预期"改 Typert method 名" | **更重：list unary 整个删除，改 follow 流**（见 §2 方案） |
| A3 | session surfaceOp 强制 | ✅ 合规 | 零改动 | 仍零改动（rc.1 校验与 alpha 一致） |
| B4 | **`dsh-settings` 便捷函数消失**（新增发现） | 🔴 编译级 | **漏判** | `installSettingsSection`/`settingsNamespace` 全仓零命中 → `ctx.settings.installSection(...)` |
| B5 | seams 事件/服务名 | ✅ 兼容 | 全保留 | 全保留（实证） |
| B6 | peerDependencies 版本范围 | ⚠️ 建议 | rc.5 → alpha.1 | → **`^0.1.2-rc.1`**（§3） |

---

## 1. 三项已知适配点 rc.1 实况

### 1.1 A1 client import 面（破坏成立，编译级）

**rc.1 实况**
- `packages/client/runtime/` **已删除**（client 目录现存：connection/hmr/locale/modules/store/ui-*/web，无 runtime）。`@deepseek-ai/dsh-client-runtime` 全仓零 package.json。
- 官方 client 插件统一 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（139 处实证；无独立 ClientContext 类型）。
- `SettingsScope` / `SettingsScopeSpec` / `SettingsScopeSnapshot` 落于 **`@deepseek-ai/dsh-client-ui-settings/client`**（`src/client/settings-contract.ts:8/37/54`，ui-settings `client/index.ts:32` 再导出；`client` 子路径导出见 package.json `./client`）。

**dsp 需改文件与精确行**

| 文件 | 行 | 现值 | 改法 |
|------|----|------|------|
| `src/client/index.ts` | :19-20 | `ClientContext`/`SettingsScope`/`SettingsScopeSpec` from `@deepseek-ai/dsh-client-runtime/client` | `ClientContext` → `Context as ClientContext` from `@deepseek-ai/cordis`；`SettingsScope`/`SettingsScopeSpec` → from `@deepseek-ai/dsh-client-ui-settings/client` |
| `src/client/SettingsSection.tsx` | :23 | 同上 | 同上（dsp 用法 `getSnapshot/subscribe/set` 与 rc.1 `SettingsScope` 接口 `getSnapshot/subscribe/mutate/set/unset` 完全一致；snapshot.status 值集 `loading/ready/unavailable` 一致 → 兼容） |
| `src/client/image-fallback-api.ts` | :10 | `ClientContext` from runtime | → `@deepseek-ai/cordis`（:70/:83 的 `ctx.get`/`ctx.sessions.binding` 运行时面签名未变） |
| `src/client/file-fallback-api.ts` | — | 无 runtime import | 类型检查级，随 tsconfig 更新 |
| `package.json` | :49 | `dsh.client.inject: ['@deepseek-ai/dsh-client-runtime']` | 删除该项（已删包）；client 的 settingsScope/slots/conversation/sessions 均经 cordis 服务注入，非包 import |
| `tsdown.config.ts` | :24-25 | `PLATFORM_MODULES` 含 `@deepseek-ai/dsh-client-runtime`(+`/client`) | 删除两行（dsp client bundle purity 插件对非 external 的 `@deepseek-ai/*` 值 import 才 throw；现全部 `import type` → 编译期擦除，不涉 bundle） |
| `tsconfig.json` | :32-33 | paths → `.npm-global/.../dsh-client-runtime` | 改为 `@deepseek-ai/dsh-client-ui-settings/client` 指向 rc.1 类型（npm 安装的 dsh 或 `.dsh/source/current`） |
| `client/tsconfig.json` | :15-16 | 同上 | 同上 |

### 1.2 A3 session surfaceOp（合规确认，零改动）

- rc.1 `packages/core/session/src/surface.ts:22-26`：`SURFACE_EVENT_TYPES` 仍仅 `user/message | assistant/message | tool/result` 三型；`surfaceOpOf`（:195-218）校验与 alpha 完全一致（surface-eligible 无 marker 抛错、非 surface 带 marker 抛错、replace 形状校验）。`compaction/prune` 不 surface-eligible。
- dsp 全仓 `.append(` 仅 `rebuild.ts:300/307` 两处：`compaction/prune` 无 marker（正确——非 surface 事件）；`user/message` replace 带 `surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs`（:312-313）→ **完全合规**。
- 附带确认：tools.restrict `run_code` 保留名校验不触发（dsp 仅 deny `['bash']`）。

### 1.3 B5 seams 事件/服务名（全兼容，实证）

dsp 监听的全部事件在 rc.1 保留（scope 过滤语义下全局 ctx.on 仍收到）：

| dsp 监听点 | 事件 | rc.1 出处 |
|---|---|---|
| seams/context.ts:174, gateway.ts:597 | `agent/session-start` | core/agent runtime-types.ts:224 |
| seams/context.ts:185, bootstrap.ts:366 | `agent/pre-step` | runtime-types.ts:238（waterfall + next） |
| rebuild.ts:355, output-guard-seam.ts:55 | `agent/turn-stopping` | runtime-types.ts:285（serial） |
| bootstrap.ts:264 | `agent/inbox/inserted` | runtime-types.ts:193 |
| handyman.ts:67, skiff-core.ts:274 | `agent/status` | agent-loop agent.ts:118 |
| guards.ts:337 | `tools/pre-execute` | core/tools index.ts:144（waterfall） |
| keeper.ts:168 | `tools/post-execute` | core/tools index.ts:152（waterfall） |
| compact.ts:50, bootstrap.ts:248 | `session/event` | core/session index.ts:74 |
| weixin-bridge.ts:394, autopilot-trajectory.ts:385 | `session/created` | core/session index.ts:52 |
| bootstrap.ts:316 | `system-prompt/assemble` | core/system-prompt index.ts:31（waterfall） |

服务名：tools/webServer(:165 register, WebRoute 同形)/sessions/shellEnv(:100)/skills(:392 registerProvider)/agentLoop(:377)/agents(:249 create:399 resume:418)/systemPrompt(:432 section)/sessionProjections(:208)/sessionTitle(:400 rename)/agentPresets(:164 composeFrom:455 composedPreset:475)/compaction(:98)/workspaceRegistry(:115 list:181) —— **全部存续**。`cordis` 裸名经 tsconfig `paths` 双映射（:38-39 同指 `@deepseek-ai/cordis` 物理路径）→ 类型合并互通，非破坏。

---

## 2. ⚠️ A2 workspace 白名单重设计（按 follow 流）— 核心方案

### 2.1 rc.1 实况（比 alpha 更重的变化）

- `packages/api/workspace-controller/src/index.ts:57-120`：Remote 方法仅 `create/rename/delete/insertBefore/insertSessionBefore/archiveSession` + `follow`（`@Remote({mode:'stream'})`）。**无 `list` unary**（`@Remote('list')` 只剩 directory-picker 的目录列表，非工作区）。
- **工作区列表 = follow 流**：`WorkspaceFollowFrame`（types.ts:126-127）= `{type:'baseline', value:{items, archivedSessionIds}}` + `upsert/remove/order/archived` 增量（feed.ts:82-93 实证：先 baseline 后增量）。
- 传输：HTTP 反代层**无法按响应过滤** —— follow 走 WebSocket mux（`/api/remote.mux`，stream-protocol.ts:6；gateway index.ts:205-228 registerUpgrade）。WS 上跑 JSON 文本帧 `RemoteStreamServerMessage`（stream-protocol.ts:260-263：`{type:'item',streamId,value}` / `{type:'end'}` / `{type:'error'}`），value 即 WorkspaceFollowFrame。
- dsp gateway 现反代 WS 为**纯双向 pipe**（gateway.ts:463-465 `usock.pipe(socket); socket.pipe(usock)`）——不解析帧内容。
- 影响三处 dsp 代码：`accounts-api.ts:169-191` `fetchWorkspaces()`（`POST /api/workspace.list` → rc.1 返回 `gateway/invocation-unavailable` → 恒空数组 → AccountsEditor 下拉空）；`gateway.ts:203` `method==='workspace.list'` 过滤永不命中；`gateway.ts:258` `workspace.create` 校验（**create unary 仍存在**，此拦截有效，仅需复核信封：unary 仍 `POST /api/workspace.create` + client-request 信封，connection/src/client/rpc.ts:34-60 实证）。

### 2.2 方案选型

#### 2.2.1 白名单**意图**澄清（前置）

原 v1.22 白名单拦截两层：① client「工作区列表**可见性**」过滤（filterWorkspaceList 删 items）→ 让外部用户只看到授权工作区；② 「create 路径**校验**」（workspaceAllowed + 403）→ 防建越权工作区。rc.1 下 ① 的数据源与传输都变了；② 的 create 仍可拦。

#### 2.2.2 方案 A（推荐）：帧层过滤 + baseline 重写 —— 反代 WS 终结并重构

在 dsp gateway 的 WS upgrade 处理中，把 `/api/remote.mux` 从纯 pipe 改为**协议终结代理**：解析上行 `RemoteStreamClientMessage`（open/cancel，open 帧含 `endpoint`），对 `workspace/follow` 流在下行改写：

- **baseline 帧**（`{type:'item', value:{type:'baseline', value:{items,...}}}`）：`items` 按白名单前缀过滤，`order`/`archived` 保持；
- **upsert 帧**：非白名单 workspace → 丢弃该 item（客户端模型永不看到越权路径）；remove/order/archived 透传（白名单外的 id 在客户端基线不存在，remove/order 无害）；
- **其他 endpoint**（session/*、settings/* 等）原样透传。

**帧解析边界**：WS 帧是完整 JSON 文本消息（stream-protocol.ts 的 parse 均以整条 text 为单位），双向 pipe 改成**按消息边界分帧**即可（自行维护 partial buffer + `\n`? —— 需确认 WS 文本帧是否带分隔；Node ws 消息天然按帧回调，但 dsp 用原生 `http` upgrade + pipe，无 ws 库 → 需引入极简帧边界逻辑或直接依赖消息完整性假设。**实施前需验证上游消息是否逐帧 write（writev/单 write 保证一帧一次到达）**——若否，需自行实现 WS 帧解码（RFC 6455 帧头 + 掩码），工作量大）。

**替代子方案 A′（更轻，推荐优先）**：**不改 WS**。host 侧直接暴露白名单数据源 —— 利用 dsp gateway 本就同 host 进程（经 `ctx` 持有 `workspaceRegistry.list()`，index.ts:181 同步枚举 `Workspace[]`，字段 id/path/title/sessionIds），在 gateway 的 `/serenity/config` GET 响应里附一个 `knownWorkspaces`（从 `ctx.workspaceRegistry.list()` 投影 path/title 并按白名单过滤）→ **AccountsEditor 下拉改为读 gateway 自有配置接口**（已有 `/serenity/config`，AccountsEditor 已在 fetchConfig），不再碰 DSH RPC。**零 WS 介入、零帧协议风险**。白名单校验（create 拦截）维持现状。列表"可见性过滤"改为：白名单路径本身由用户配置（管理面），外部用户的工作区导航 UI 不暴露越权 workspace —— 但注意 rc.1 下**外部浏览器自身的 workspace follow 流仍会拉到全量列表**（DSH 内建 UI 用 `ctx.workspaces.list`，不经 dsp），dsp 无法在反代层隐藏它 —— 若要求外部用户"看不到越权工作区"，则必须方案 A 帧过滤（或接受 DSH UI 全量可见、dsp 面板只列授权）。**此取舍需用户拍板**。

#### 2.2.3 方案 B：弃列表过滤，白名单仅用于 create 校验 + 面板手动路径

- `gateway.ts:203` 的 list 过滤分支删除（rc.1 无 list）；`filterWorkspaceList`/`workspaceDenyResponse` 保留 create 校验用途（workspaceDenyResponse 的 rpcId/信封核对 rc.1 unary 信封）。AccountsEditor 的 knownWorkspaces 下拉移除，白名单改手输路径 chip（现 UI 已支持手动输入路径 —— AccountsEditor.tsx workspaces state + toggleWorkspace）。
- 外部用户经 DSH 内建 UI 仍看到全量工作区（无法避免），但**越权操作被 create 校验 + 后续读写拦截兜底**（白名单语义从"列表可见性"弱化为"操作授权"）。
- 成本最低；**若用户对"外部可见列表"无硬性隔离要求，此为最优**。

### 2.3 精确改动点（方案 B 基线与 A′ 增量）

| 文件 | 行 | 改动（B） | 改动（A′） |
|---|---|---|---|
| `src/gateway.ts` | :169-170 | method 解析保留（unary 仍 `POST /api/<method>`） | 同 |
| `src/gateway.ts` | :203-214 | **删除** workspace.list 过滤分支 | 同（改在 WS 侧，见下） |
| `src/gateway.ts` | :256-298 | create 拦截保留，复核 403 信封与 rc.1 `workspace/create` 入参（`{path}` → 读 body path） | 同 |
| `src/gateway.ts` | :425-493 | WS upgrade 纯 pipe 保留 | **方案 A 时改协议终结（见 2.2.2）** |
| `src/gateway-proxy.ts` | :39-62 | `filterWorkspaceList` 删除或改 create-only | 保留 create-only；新增 config 投影 |
| `src/client/accounts-api.ts` | :160-191 | `fetchWorkspaces()` 删除或改读 gateway `/serenity/config.knownWorkspaces` | A′：改为读 config（与 fetchConfig 合并/并行） |
| `src/client/AccountsEditor.tsx` | :49-58/:286-299 | 移除下拉 or 改手输 | 下拉数据源改 config |
| `src/index.ts`/`src/config-ops.ts` | config wire | — | A′：knownWorkspaces 投影段（host 侧 workspaceRegistry.list 白名单过滤） |

### 2.4 推荐
**先实施方案 A′ + B 组合**（零帧协议风险、改动集中在 gateway/config 自有通道）：白名单下拉数据源改走 `/serenity/config`（host `workspaceRegistry.list()` 投影）；list 过滤分支删除；create 校验保留。**若用户要求外部浏览器"看不到"越权 workspace（DSH 内建 UI 也隐藏）**，再评估方案 A 帧级终结（需先验证 WS 帧到达原子性，工作量大，建议单独立项）。

---

## 3. peerDependencies 版本范围更新建议（B6）

### 3.1 rc.1 版本事实
- dsh-harness-public 全 workspace（250+ 包）version = **`0.1.2-rc.1`**（package.json 实证）。
- 官方包 peer 依赖基线：`@deepseek-ai/cordis`（rescope 自原 cordis，vendor/cordis 包名实证）为 peer + dev 双声明。

### 3.2 建议
dsp `package.json` peerDependencies（:54-70）逐项更新：

```jsonc
// 现值 → 建议值
"@deepseek-ai/dsh-agent": "^0.1.0-rc.5"      → "^0.1.2-rc.1"
"@deepseek-ai/dsh-agent-loop": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-agent-presets": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-compaction": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-host-webserver": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-llm": "^0.1.0-rc.5"         → "^0.1.2-rc.1"
"@deepseek-ai/dsh-session": "^0.1.0-rc.5"     → "^0.1.2-rc.1"
"@deepseek-ai/dsh-session-title": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-shell": "^0.1.0-rc.5"       → "^0.1.2-rc.1"
"@deepseek-ai/dsh-shell-env": "^0.1.0-rc.5"   → "^0.1.2-rc.1"
"@deepseek-ai/dsh-skill": "^0.1.0-rc.5"       → "^0.1.2-rc.1"
"@deepseek-ai/dsh-system-prompt": "^0.1.0-rc.5" → "^0.1.2-rc.1"
"@deepseek-ai/dsh-tools": "^0.1.0-rc.5"       → "^0.1.2-rc.1"
"cordis": "^4.0.0-rc.7"                       → "@deepseek-ai/cordis": "^4.0.0-rc.7"（建议改 rescope 名；tsconfig 双映射保留过渡）
```

**语义**：`^0.1.2-rc.1` 允许 `>=0.1.2-rc.1 <0.2.0`，涵盖 rc.x 后续与正式 0.1.2；官方 0.1.1-rc.2 系不满足 → 升级门槛正确。
**peerDependenciesMeta**（:71-90 optional 标注）保持原样。
**client 类型依赖**（ui-settings/ui-slots/ui-conversation/ui-primitives/ui-locale）：随 npm 安装的 dsh 传递提供，无需显式 peer；但 tsconfig/client paths 需指向 rc.1 类型。

### 3.3 版本切换注意
- `tsconfig.json`/`client/tsconfig.json` 的 paths 现指向 `.npm-global/lib/node_modules/@deepseek-ai/dsh/...`（rc.8 安装）与 `.dsh/source/current/...`（源码）混合 → 升级后统一指向 rc.1 类型源。
- dsp `dsh.client.inject` 删 runtime 包（§1.1）。

---

## 4. 实施顺序建议

1. **编译面（先修红）**：A1 四 src 文件 import + package.json/tsdown/tsconfig 声明；B4 settings-section.ts 改 `ctx.settings.installSection`（+ inject 'settings'）；peerDeps 升 `^0.1.2-rc.1`。
2. **行为面**：A2 方案 A′/B（gateway list 分支删、create 校验复核、AccountsEditor 下拉数据源换 config 投影）。
3. **验证**：typecheck 全绿 → headless/浏览器冒烟 → 外部 3081 端口工作区列表/创建拦截实测。

---

## 5. alpha 评估 vs rc.1 差异结论

- **alpha A1/A3/run_code 结论全部仍成立**；A1 声明面补充 3 文件（package.json/tsdown/tsconfig×2）。
- **alpha A2 低估**：workspace 非改名而是 list unary 删除 + follow 流化 → HTTP 响应过滤架构失效，需 WS 帧级方案或降级（§2）。
- **alpha 漏判**：`installSettingsSection`/`settingsNamespace` 消失（node half 唯一编译级破坏，§1.3/B4）。
- 无其他新破坏（B4/B5 全兼容面实证）。

> 本方案基于 dsh-harness-public@0.1.2-rc.1 真实源码 read/grep 实证；未运行构建/测试（只读审计）。
