# dsh 0.1.2-alpha.1 对 dsp（dsh-serenity-plugin）的影响调研

> 状态：**已完成**（主线程 19 面 + 2 子代理深度核查合并）
> 日期：2026-08-27（S142）
> 背景：用户预告 dsh 0.1.2-alpha.1 已 push GitHub（alpha 不发布 npm，面向插件作者参考；破坏性变更密集，为后续减少破坏）

## 1. 版本与基线

- **dsh-harness-public 基线**：b150a551（2026-08-13）→ **cd5ef81481**（0.1.2-alpha.1，release/dsh-0.1.2-alpha.1 合并提交，含 `release(dsh): 0.1.2-alpha.1`）
- **根 package.json version**：`0.1.2-alpha.1`（已确认）
- **本地运行时**：npm 安装版 rc.8（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh`）——**当前 dsp v1.24.9 适配的是 rc.8**；0.1.2-alpha.1 是 GitHub 源码形态，未发布 npm
- dsp 当前状态：v1.24.9（package.json/dsh.plugin.json/CHANGELOG 三处一致，npm 已发布，运行时 ACC 1.24.9）

## 2. 0.1.2-alpha.1 主要架构变化（影响面总览）

| 变化 | 性质 | 对 dsp 影响 |
|------|------|------------|
| **api 层 Typert Remote 化**（api-proxy → workspace/settings/session 多 controller + typert RPC gateway） | 大重构 | ⚠️ **workspace RPC 信封变化**——`workspace.list` → `remote.workspace.*`（Typert namespace/method），dsp gateway 工作区白名单过滤（v1.22.6 依赖 `method==='workspace.list'` 拦截）**需适配新 method 名** |
| **Code Mode → PTC 重命名** | 改名 | ⚠️ 需确认：dsp system-prompt.ts:485 用 `ctx.tools.get('run_code')` 检测——`run_code` **工具调用名仍保留**（PTC 是 mode 名非工具名），检测逻辑仍有效 |
| **session 事件词汇 fail-closed 收紧** | 破坏性 | ⚠️ surfaceOp 现在**强制要求 marker**（surface-eligible 事件无 marker 直接抛错）——**dsp rebuild.ts 已带 surfaceOp ✓**；需全量复查 dsp 其余 append 调用 |
| **examples/acp-agent → snapshots/session 重组** | 结构 | 无影响（测试结构） |
| **新增 webhook / schedule / storage / session-query / spill / workspace 包** | 新增 | 无影响（新能力） |
| **single-dsh-application-launcher**：只有 `dsh` CLI + profile 启动受支持应用 | 决策 | ✅ dsp deploy 走 profile bundle/patch 机制，兼容；custom profile patchReload live |
| **新增 `dsh --profile acp` 官方 profile** | 新增 | 🆕 **与知识 CCC ACP 需求直接相关**（用户同日提出的 ①问答助手 ②IM 机器人 底座） |

## 3. dsp 依赖面逐一核查（主线程，19 面）

### 3.1 Node half 服务面（✅ 全部存续）

| # | 包/服务 | dsp 用法 | 0.1.2 结论 |
|---|---------|---------|-----------|
| 1 | `@deepseek-ai/dsh-session`（packages/core/session） | append/surfaceOp/sourceEventSeqs/deriveEventMessage/SessionId | ✅ 存续；`session.append` surfaceOp 强制校验加强；`session/event`/`session/created` 事件 + SessionStore.get/list 存续 |
| 2 | `@deepseek-ai/dsh-agent`（packages/core/agent） | agents.create/AgentHandle/steer/followup + agent/session-start|pre-step|request-error|turn-stopping|created|disposed | ✅ 全部存续（CreateAgentOptions/AgentHandle/create/resume/register + 全部事件名与载荷） |
| 3 | `@deepseek-ai/dsh-tools`（packages/core/tools） | defineTool/register/guard/restrict + tools/pre-execute|post-execute | ✅ 存续；**tools.restrict 新增 run_code 保留名校验**（"cannot name reserved PTC mode presentation transport run_code"）——dsp SAFE_MODE_DENY_TOOLS 只 deny `['bash']`，**不触发**；PreToolDecision/PostToolDecision/ToolExecution/ToolRunContext 存续 |
| 4 | `@deepseek-ai/dsh-system-prompt`（packages/core/system-prompt） | systemPrompt.section(order -50) | ✅ 存续；order 必须有限数 + 同 order 按 code-unit 名排序（dsp -50 安全）；system-prompt/assemble 事件 waterfall 化 |
| 5 | `@deepseek-ai/dsh-settings`（packages/settings） | settingsNamespace/register/installSettingsSection | ✅ 完整存续（settingsNamespace/settings.register/installSettingsSection 签名兼容）；settings.describe 全量暴露仍在 |
| 6 | `@deepseek-ai/dsh-shell-env`（packages/shell/shell-env） | BashEnvContributor/register | ✅ 存续（variables/resolve + register 签名兼容） |
| 7 | `@deepseek-ai/dsh-skill`（packages/skill/skill） | SkillProvider/registerProvider | ✅ 存续；**list 可返回 `SkillProviderObservation` 新形态**（dsp opencode-skills 返回纯数组仍兼容，但需留意） |
| 8 | `@deepseek-ai/dsh-host-webserver`（packages/host/webserver） | webServer.register/registerUpgrade/port | ✅ 存续（WebRoute exact/prefix + WebUpgradeRoute + register/registerUpgrade/port 签名兼容；host 仅 127.0.0.1|0.0.0.0） |
| 9 | `@deepseek-ai/dsh-compaction`（packages/compaction） | compaction/start|summary|end|prune 事件 | ✅ 完整存续（事件链 + compaction/prune shadow-price + checkpoint 校验更强：successful end 需 summary）——dsp v1.23.5 shadow-price 修复合规 |
| 10 | `@deepseek-ai/dsh-session-title`（packages/session/session-title） | titles.rename(session, title) | ✅ 存续（SessionTitleService.rename 签名兼容；user source pin 语义保留） |
| 11 | `@deepseek-ai/dsh-agent-presets`（packages/preset/agent-presets） | agentPresets.composeFrom/mount/composedPreset | ✅ 存续（composeFrom/mount/recompose/select 签名兼容） |
| 12 | `@deepseek-ai/dsh-llm`（packages/llm/llm） | createUserMessage/Message/MessageSource/ContentBlock | ✅ 存续（createUserMessage content+source 必填，role/id 自动；UserMessage source.kind 契约保留） |
| 13 | sessionProjections（packages/session/session-projection） | contextPressure 投影 | ✅ 存续（`ctx.sessionProjections.snapshot(session).values.contextPressure` 签名兼容；token-meter 注册投影） |
| 14 | codeRuntime（packages/code-runtime） | ctx.get('codeRuntime') | ✅ 存续 |

### 3.2 Client half 面（✅ 存续）

| # | 包/服务 | dsp 用法 | 0.1.2 结论 |
|---|---------|---------|-----------|
| 15 | `@deepseek-ai/dsh-client-ui-slots`（packages/client/ui-slots） | PropsRuntime/SlotCore.register（single/list/keyed/chain） | ✅ 存续（SlotCore.register + 五种 slot 完整；PropsRuntime 导出） |
| 16 | `@deepseek-ai/dsh-client-ui-settings`（packages/client/ui-settings） | settingsScope.bind + settings.section slot | ✅ 完整存续（SettingsScopeBinder.bind + settings.section list slot + SettingsScopeSpec 签名兼容） |
| 17 | `@deepseek-ai/dsh-client-runtime/client`（packages/client/runtime） | ClientContext | ✅ 存续 |

### 3.3 装配/开发面（✅ 兼容）

| # | 面 | dsp 用法 | 0.1.2 结论 |
|---|----|---------|-----------|
| 18 | profile/bundle/patch | cordis.patch.yml insert + dsh.plugin.json + bundle 层二选一 | ✅ 兼容（profile-plugin-bundles + single-dsh-application-launcher 决策：bundle 机制保留，custom profile patchReload live；dsh-develop deploy 的 staging 双锚 + profile 双目标逻辑仍有效） |
| 19 | dsh.plugin.json 契约 | contributes.tools（描述性） | ✅ 无影响（插件清单是描述性元数据；0.1.2 新增 plugin-inventory Typert Remote 只读投影） |

## 4. 确定影响点（需 dsp 适配）

### ⚠️ 影响点 A：workspace RPC 信封变化（gateway 工作区白名单）— 需适配

- **旧（rc.8/api-proxy）**：client 发 `{type:'client-request', rpcId, method:'workspace.list', payload}` → dsp gateway 拦截响应过滤 items（v1.22.6 修复）
- **新（0.1.2/Typert Remote）**：method 变为 Typert namespace/method 形状（`workspace/*`）；client-request 信封类型保留但方法域重构
- **dsp 精确改动点**：`gateway.ts:169-170`（`url.pathname.slice('/api/'.length)` 解析 method）/203（`method === 'workspace.list'` 过滤）/258（`/api/workspace.create` 校验）+ `gateway-proxy.ts` `filterWorkspaceList`（解析 `result.value.items` 结构）——需按新 method 名与 Typert Remote 结果形态适配
- **验证方式**：升级后实测外部端口 3081 工作区列表加载 + 创建拦截

### ✅ 影响点 B：session surfaceOp 强制校验 — 已排除（dsp 合规）

- **新语义**：surface-eligible 事件（user/message、assistant/message 等）append 时**必须带 surfaceOp marker**，否则运行时抛错（`"surface-eligible and requires a surfaceOp marker"`）
- **dsp 现状（双子代理 + 主线程交叉确认）**：全部 append 仅 rebuild.ts 两处——user/message replace **已带** surfaceOp + sourceEventSeqs ✓；compaction/prune（log-only 非 surface-eligible）无 surfaceOp ✓；context.ts/keeper.ts 的 ACC 注入走 createUserMessage + followup/steer（**不经 session.append**，不受影响）
- **结论**：完全合规，零改动

### ⚠️ 影响点 C：tools.restrict run_code 保留名

- **新校验**：`tools.restrict()` 不能命名 `run_code`（PTC mode presentation transport 保留名）
- **dsp 现状**：SAFE_MODE_DENY_TOOLS = `['bash']`——**不触发**；handyman-preset-inherit deny `['handyman']`——安全
- **验证**：无需改动；如未来 safe-mode 扩展 deny 列表需避开 run_code

### ⚠️ 影响点 D：api 层 Typert Remote 化（间接）

- dsp 的 /serenity/* 路由经 webServer.register 注册（不受影响）；但 dsp client 若直接调 DSH RPC（如 fetchWorkspaces 的 workspace.list 信封）需按新方法域改
- dsp 自身 RPC（/serenity/config 等）走自有 HTTP 通道，**不依赖 api-proxy 白名单**（v1.22 架构已免疫）
- 子代理确认：dsp client 用的 `session.prompt`/`conversation.draftImages` 都在 Remote 之上，签名未变（运行时兼容，类型建议收紧为 `ClientResult`）

## 5. 新能力（与 dsp 需求相关）

| 新能力 | 说明 | 与 dsp 相关性 |
|--------|------|-------------|
| **`dsh --profile acp`** | 官方 ACP server profile（automation-only，startup patchReload） | 🆕 **知识 CCC 价值释放需求（同日提出）的官方底座**——独立部署问答助手 + IM 机器人可复用官方 ACP 组合，或 dsp 在其上加 persona/约束 |
| **webhook 包**（packages/webhook） | webhook ingress | 未来 IM 桥接可能相关 |
| **session-persistence-sqlite** | SQLite 会话持久化（schema 19，无迁移） | dsp session 工具不受影响（文件级操作） |
| **storage 包族**（storage/storage-json/storage-sqlite/storage-domain） | 版本化 KV 域存储 | 未来可用（账号配置等） |

## 6. 结论与建议

**整体判断：dsp v1.24.9 在 0.1.2-alpha.1 下兼容性良好**——**node half 零改动**（10 个服务面 + 全部事件契约签名兼容），**client half 1 处编译级破坏**（`dsh-client-runtime` 包删除）。确定性需适配点 3 处 + 建议项 4 条：

### 需适配（3 处）

1. **🔴 client half import 面（编译级，3 文件）**：`@deepseek-ai/dsh-client-runtime` 包在 0.1.2 **删除**——
   - `ClientContext` → 改从 `@deepseek-ai/cordis` 导入（`import type { Context as ClientContext }`，官方所有 client 插件同款）
   - `SettingsScope`/`SettingsScopeSpec` → 改从 `@deepseek-ai/dsh-client-ui-settings/client` 导入（服务名 `settingsScope` + 方法签名 bind/getSnapshot/subscribe/set/unset 不变）
   - 涉及文件：`src/client/index.ts`、`src/client/image-fallback-api.ts`、`src/client/SettingsSection.tsx`（+ `file-fallback-api.ts`）
2. **⚠️ workspace RPC 方法域（gateway 工作区白名单）**：api-proxy `workspace.list` → Typert Remote `workspace/*` 命名空间——`gateway.ts:169-170`（method 解析）/203（list 过滤）/258（create 校验）+ `filterWorkspaceList` 响应结构需按新 method 名与 Typert Remote 结果形态适配；client-request 信封类型保留但方法域重构
3. **⚠️ api 层 Typert Remote 化（间接）**：dsp 自有 /serenity/* 走 webServer.register 免疫；client 直调 DSH RPC（fetchWorkspaces 信封）需按新方法域核对

### 建议项（非阻塞，4 条）

4. **slot 注册包 `ctx.slots.inject`**：官方新惯用法 `ctx.slots.inject(name, () => ctx.slots.register(...))`（等待声明、防 HMR 声明消失）；dsp 当前直接 register 能工作（三个目标槽 header.actions/input.dock/settings.section 在 0.1.2 全部保留，kind/scope 不变）
5. **`dsh.plugin.json` 非 harness 识别格式**：全仓 grep 零命中——harness 只消费 package.json `dsh.bundle.patch`/`dsh.profile.bundles` + `cordis.patch.yml`；`contributes.tools` 概念不存在（工具走 ctx.tools.register）。应标注为自维护元数据或并入 package.json `dsh` 段（不影响装配）
6. **peerDependencies 版本范围**：0.1.0-rc.5 → 0.1.2-alpha.1（正式发布时）
7. **locale-owned UI copy**（可选）：官方 `verify-client-ui-i18n` 拒绝硬编码文案；dsp client 有中文字面量，第三方插件不强制，若未来进官方装配面需迁移

### 已排除风险（3 处，零改动）

- **session surfaceOp 强制校验**：dsp 全部 append 仅 rebuild.ts 两处（compaction/prune log-only 正确无 marker + user/message 带 surfaceOp+sourceEventSeqs 全覆盖）——**完全合规**（子代理双确认）
- **tools.restrict run_code 保留名**：dsp SAFE_MODE_DENY_TOOLS 只 deny bash——不触发
- **skill list Observation 新形态**：纯数组仍合法（联合类型）

**建议**：
- 0.1.2-alpha.1 是**源码形态（未发布 npm）**，本地 rc.8 不受影响，**dsp v1.24.9 保持正常运行**——无需立即升级
- 待官方正式发布（rc.9+/0.1.x）后做一次适配轮：**client half 3 文件 import 面 + gateway workspace method 适配**——预估小工作量（编译面改动为主）
- **dsp 的 client 依赖漂移防护**（未解决 #3）：升级时需复查 client 依赖（0.1.2 已确认 ui-slots/ui-primitives/ui-conversation/ui-settings 全部存续；**dsh-client-runtime 删除**是唯一消失包）
- **知识 CCC ACP 需求**：0.1.2 官方 `--profile acp` 是新底座选项，纳入方案讨论（docs/knowledge-ccc-release-research.md）

## 7. 子代理结论（已合并）

### 子代理 1（node 服务面，10 面）— 全部兼容，零改动

webServer（register/port）/ sessions（get/list/header.cwd）/ agents.create（CreateAgentOptions 完全匹配 handyman.ts）/ sessionTitle.rename / settings（installSettingsSection 签名一致 + describe 全量暴露）/ shellEnv（BashEnvContributor + DshEnvironmentKey）/ skills.registerProvider（SkillCandidate 字段全匹配 opencode-skills.ts）/ systemPrompt.section（scoped 同名 shadow 保留）/ tools（register/guard/restrict/get/defineTool 签名不变）/ ctx.get 四服务（tokenMeter.estimateMessage / sessionProjections.contextPressure / codeRuntime / agentPresets.composedPreset+composeFrom）——**全部签名兼容**。

### 子代理 2（client + 事件契约）— 1 编译级破坏 + 其余兼容

- **破坏**：`@deepseek-ai/dsh-client-runtime` 包删除（ClientContext → cordis Context；SettingsScope → ui-settings/client）
- **兼容**：session.append surfaceOp 强制（dsp 已达标）、createUserMessage/deriveEventMessage、compaction 事件链、全部 agent 事件（session-start/pre-step/tools×2/request-error/turn-stopping/status）、AgentHandle.followup/steer、决策类型、tools.guard/restrict、agentPresets.composeFrom、profile/bundle/patch 装配、`__ModuleLoader__` client 加载、`dsh.client` manifest、ui-primitives/ui-conversation/ui-settings 导出
- **新能力**：webhook 包（ctx.webhookRuntime + webhook-github 签名适配器——可与 F1 网关互补的无人值守外部入口）、code-runtime PTC 模式、Remote BFF 迁移产物（dsp 用的 session.prompt/conversation.draftImages 都在 Remote 之上，签名未变）

### 事件契约面（双子代理交叉确认）— 全部兼容

`agent/status`（fused dispatcher 注入 agent，dsp 的 payload.agent===agent 仍成立）/ `agent/turn-stopping` / `agent/session-start` / `agent/pre-step` / `tools/post-execute` / `session/event(session,event)` / `compaction/prune`+surfaceOp replace 的 shadow-price 协议——**完整保留**。
