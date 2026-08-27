# dsh 0.1.2-alpha.1 对 dsp（dsh-serenity-plugin）的影响调研

> 状态：主线程核查完成；2 个子代理深度核查（node 服务面 / client+事件契约面）结果待合并
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

### ⚠️ 影响点 A：workspace RPC 信封变化（gateway 工作区白名单）

- **旧（rc.8/api-proxy）**：client 发 `{type:'client-request', rpcId, method:'workspace.list', payload}` → dsp gateway 拦截响应过滤 items（v1.22.6 修复）
- **新（0.1.2/Typert Remote）**：method 变为 Typert namespace/method 形状（`workspace/*`，如 `workspace/create`、`workspace/rename`、`workspace/delete`、`workspace/list` 对应方法经 `remote.workspace.*`）；client-request 信封类型保留但方法域重构
- **dsp 影响**：`gateway-proxy.ts` 的 `filterWorkspaceList`（v1.22.6 按 `method==='workspace.list'` 拦截）+ `workspaceDenyResponse` 需适配新 method 名与响应结构；**workspace.create 校验**（不在白名单 → 403）同理
- **验证方式**：升级后实测外部端口 3081 工作区列表加载 + 创建拦截

### ⚠️ 影响点 B：session surfaceOp 强制校验

- **新语义**：surface-eligible 事件（user/message、assistant/message 等）append 时**必须带 surfaceOp marker**，否则运行时抛错（`"surface-eligible and requires a surfaceOp marker"`）
- **dsp 现状**：rebuild.ts 的 user/message replace **已带** surfaceOp + sourceEventSeqs ✓；compaction/prune（log-only 非 surface-eligible）无 surfaceOp ✓
- **需全量复查**：context.ts / keeper.ts 的 ACC 注入 append（user/message）是否带 surfaceOp（v1.23.0 后注入面）——若缺需补
- **验证方式**：升级后 typecheck + 全测试 + 实测 ACC 注入/rebuild

### ⚠️ 影响点 C：tools.restrict run_code 保留名

- **新校验**：`tools.restrict()` 不能命名 `run_code`（PTC mode presentation transport 保留名）
- **dsp 现状**：SAFE_MODE_DENY_TOOLS = `['bash']`——**不触发**；handyman-preset-inherit deny `['handyman']`——安全
- **验证**：无需改动；如未来 safe-mode 扩展 deny 列表需避开 run_code

### ⚠️ 影响点 D：api 层 Typert Remote 化（间接）

- dsp 的 /serenity/* 路由经 webServer.register 注册（不受影响）；但 dsp client 若直接调 DSH RPC（如 fetchWorkspaces 的 workspace.list 信封）需按新方法域改
- dsp 自身 RPC（/serenity/config 等）走自有 HTTP 通道，**不依赖 api-proxy 白名单**（v1.22 架构已免疫）

## 5. 新能力（与 dsp 需求相关）

| 新能力 | 说明 | 与 dsp 相关性 |
|--------|------|-------------|
| **`dsh --profile acp`** | 官方 ACP server profile（automation-only，startup patchReload） | 🆕 **知识 CCC 价值释放需求（同日提出）的官方底座**——独立部署问答助手 + IM 机器人可复用官方 ACP 组合，或 dsp 在其上加 persona/约束 |
| **webhook 包**（packages/webhook） | webhook ingress | 未来 IM 桥接可能相关 |
| **session-persistence-sqlite** | SQLite 会话持久化（schema 19，无迁移） | dsp session 工具不受影响（文件级操作） |
| **storage 包族**（storage/storage-json/storage-sqlite/storage-domain） | 版本化 KV 域存储 | 未来可用（账号配置等） |

## 6. 结论与建议

**整体判断：dsp v1.24.9 在 0.1.2-alpha.1 下的大部分依赖面存续**（19 面中 16 面兼容确认），核心架构（工具/事件/settings/client slots）稳定。**确定性需适配点集中在 4 处**：

1. **workspace RPC 方法域**（gateway 工作区白名单）——功能性影响，外部访问场景
2. **session surfaceOp 强制校验**——需全量复查 dsp 的 append 调用点（rebuild 已合规，context/keeper 待核）
3. **tools.restrict run_code 保留名**——当前安全，未来扩展需避开
4. **api 层 Typert Remote 化**——dsp 自有 RPC 免疫，但 client 直调 DSH RPC 处需按新方法域

**建议**：
- 0.1.2-alpha.1 是**源码形态（未发布 npm）**，本地 rc.8 不受影响，**dsp v1.24.9 保持正常运行**——无需立即升级
- 待官方正式发布（rc.9+/0.1.x）后，按上述 4 点做一次适配轮（预估小工作量：gateway method 名 + append 复查）
- **dsp 的 client 依赖漂移防护**（未解决 #3）：升级时需复查 `dsh-client-ui-slots/primitives` 依赖（0.1.2 已确认 ui-slots 存续）
- **知识 CCC ACP 需求**：0.1.2 官方 `--profile acp` 是新底座选项，纳入方案讨论（docs/knowledge-ccc-release-research.md）

## 7. 待子代理合并

- 子代理 1（node 服务面）：10 个 API 面深度签名比对（已由主线程覆盖大部分，子代理补充细节）
- 子代理 2（client+事件契约）：client 包 + session 事件契约 + agent 事件 + preset 装配（主线程已覆盖，子代理补充）
