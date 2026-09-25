# dsp 功能块地图与抽象分层（Module Map）

> **地位**：本文件是 dsp **现况的单一真相源**——「哪个文件属于哪一层、它负责什么、它依赖谁、它被谁用」。
> **与顶层约束的分工**：`docs/dsp-top-level-constraints.md` 给**规则**（层怎么定义、依赖只许怎么走）；**本文件给落位**。两份文档**不许互相抄写**。
> **维护**：任何新增/删除/挪动模块 ⇒ **同批**改本文件（§6.2 退役纪律）。层判定用约束文档 §3.3 的准入三问。
> **数据来源**：2026-09-25 六域只读盘点（每域一位独立盘查者，逐文件读实现，不只看文件名）；grep 域 = `hooks/dsh-serenity-hooks/{src,tests}` ＋ `AI_LAB/dsh-serenity-plugin/{docs,CHANGELOG.md}`。

---

## 0. 怎么读这份文档

| 你想干什么 | 先读 |
|---|---|
| 我想加一个模块，不知道该放哪一层 | 约束文档 §3.3（准入三问）→ 本文件 §1（层总览） |
| 我要改一处衔接面（宿主 API/事件） | 约束文档 §2（衔接面细则）→ 本文件 §2.1（host）＋ §2.2（seams 接线表） |
| 我要删代码 | 约束文档 §6.2/§6.3（退役与死代码）→ 本文件 §3（欠账与违例） |
| 我要判断"改这段文本要不要发版" | 本文件 §2.2.3（注入面事实） |

**层代号**：L0 宿主缝 ／ L1 领域核心 ／ L2 服务与适配 ／ L3 工具与面 ／ L4 客户端半 ／ L5 开发面。
🔴 **`层` 一列写的是"当前落位"（现况），不等于"符合规则"** —— 违反依赖方向的落位记在 §3。

---

## 1. 规模与层总览（锚定 2026-09-25 实测）

| 项 | 读数 |
|---|---|
| `src/` 模块总数 | 顶层 `~70` ＋ `client/` 18 ＋ `host/` 5 ＋ `seams/` 9 ＋ `tools/` 15 ＋ `skills/` 1 ≈ **118** |
| 测试 | **113 文件 / 1799 用例**（锚定 2026-09-25 **⑤ 第 5 件 `58d58b2` 之后**的一次 `dsh-develop test` 读数；演进：1700 →（死代码第 1 批）1699 →（⑤ 第 1~5 件）1715 → 1733 → 1756 → 1767 → **1799**） |
| `docs/` 条目 | **72**（其中**绝大多数是历史设计/评审**，不是现行依据） |
| 对宿主包的直接 import | **146 处**（实测 grep `from '@deepseek-ai/…'` 或 `'cordis'`）⇒ 见 §3-1 |

---

## 2. 分域明细

### 2.1 L0 · 宿主缝 `src/host/`（5 个文件）

| 文件 | 层 | 一句话职责 | 输入（依赖） | 输出（谁用它） | 被测 |
|---|---|---|---|---|---|
| `host/contract.ts` | L0 | 宿主**服务/事件/版本契约表** ＋ 运行期探针 ＋ 版本判定 | `cordis` 的 `Events` 类型；`host/access.ts` | `index.ts`（装载期告警）、`container-status.ts`（health） | ✅ `host-contract` / `cordis-access` / `storage-domain` / `container-status` / `cro-turns` |
| `host/type-contract.ts` | L0 | **编译期类型闸门**：用宿主真类型反证我们的形状假设（17 条空 import ＋ 断言符号） | `cordis` ＋ 17 个 `import type {}` | **无运行时导出**；消费方 = `tsc` | ✅ `host/type-contract`（副作用导入 ＋ 镜像门禁） |
| `host/access.ts` | L0 | **宿主服务读取唯一收口**（读不到一律 `undefined`，不抛） | `ctx` 结构化读取（**零宿主 import**） | **19 个 src 文件**（gateway/api/rebuild/ccc-roots/skiff-core/tools…） | ✅ `host/access` / `host/cordis-access`（真 cordis） |
| `host/effect.ts` | L0 | 资源拆卸登记；缺 `ctx.effect` 时**响亮降级** | 宿主 `ctx.effect`（最小结构） | `seams/lifecycle`、`wake-scheduler`、`opencode-provider`、`deepseek-vision-patch`、`unattended-seam`、`cro-turns`（6 处） | ✅ `host/effect` |
| `host/storage-domain.ts` | L0 | 宿主**存储域**上的「会话 ↔ 轨迹」绑定表（§0L） | `host/access` → 宿主服务 `storageDomain`（**lazy**） | `index.ts`（openBindingDomain）、`trajectory-bound.ts`（type） | ✅ `host/storage-domain`（真 `defineDomain`） |

**衔接面的 12 条事实**（供"改衔接面"时对照，细节见约束文档 §2）：

1. **服务契约表**：`contract.ts:HOST_SERVICES` = 19 条，每条 `{id, name, access: 'injected'|'lazy', members, impact, required}`。
2. **运行期探针**：`probeHostContract(ctx, hostVersion)` / `hostContractReport`（**每次现探、不缓存**）/ `summarizeHostContract`；调用点 = `index.ts`（装载期）＋ `container-status.ts`（health）。
3. **事件名编译期锁**：`HOST_EVENT_NAMES`（14 个）`as const satisfies readonly (keyof Events)[]` ⇒ 宿主改事件名会**编译期红**。
4. **事件人读表**：`HOST_EVENTS`（14 条 `{name, site, impact, required}`）。
5. **类型契约断言**：`type-contract.ts` 的 `Expect<T>` / `Extends<A,B>` / `Ret<F>` ＋ 断言符号（`_ToolsRegister` / `_SessionsList` / `_SessionHeaderCwd` / `_PersistenceSnapshotCwd` / `_ContextPressure` / `_AppendPruneType` / `_EvInboxClaimed` / `_EvAssembleContext` …）。
6. **版本范围**：`REQUIRED_HOST_RANGE = '^0.1.7-rc.1'`、`REQUIRED_HOST_CEILING`（显式常量）、`checkHostVersion` / `compareSemver`。
7. **`inject` 列表**（`index.ts`，11 项）：`tools` / `webServer` / `sessions` / `shellEnv` / `skills` / `agentLoop` / `agents` / `systemPrompt` / `sessionProjections` / `settings` / `web`。**不在表内的服务**（`subagents` / `sessionTitle` / `tokenMeter` / `workspaceRegistry` / `sessionPersistence` / `sessionController` / `connection` / `storageDomain` / `llm`）一律经 `access.ts:hostService`（= `ctx.get`）取。
8. **`peerDependencies`**：18 项（全 `^0.1.7-rc.1`）＋ `peerDependenciesMeta.optional` 7 项。
9. **读取收口**：`access.ts` 的 `hostService` / `hostInjected` ＋ 类型化读取器（`hostSessions` / `hostAgents` / `hostWebServer` / `hostSettings` / `hostWeb` / `hostSubagents` / `hostLlm`）。
10. **生命周期**：`effect.ts:registerDisposer`（`ctx.effect` 缺失 ⇒ warn ＋ 返回 false）。
11. **存储域契约**：`storage-domain.ts:bindingDomainSpec()` —— **手写等价纯数据**，刻意**不 import** 宿主 `defineDomain`（保 peer-only）。
12. **包级声明面不变量**：`invariant.ts:REGISTERED_TOOLS`（11）＋ `verifyToolConsistency(manifestPath, registeredTools)`，对照 `dsh.plugin.json` 的 `contributes.tools`。

### 2.2 L0/L2 · 拦截缝 `src/seams/`（9 个文件）

| 文件 | 层 | 一句话职责 | 宿主事件/服务（字面量） | 主要导出 | 被测 |
|---|---|---|---|---|---|
| `bootstrap.ts` | L0/L2 | Anchored 锚定：0 工具锚定轮 ＋ epoch 晋升 ＋ 目录窄化/剥离 | `'session/event'`、`'agent/inbox/inserted'`、`'system-prompt/assemble'`、`'agent/pre-step'`(`{prepend:true}`) | `registerBootstrap` / `createEpochPromotion` / `hasUserMessageHistory` / `resolveBootstrapSettings` | ✅ `bootstrap` |
| `compact.ts` | L2 | 压缩成功后**重注入简短身份锚点** | `'session/event'`（只认 `compaction/end` 且无 `data.error`） | `registerCompactRetention` | ✅ `compact` |
| `context.ts` | L2 | CCC 内**播种 ACC 身份** ＋ 重启恢复激活会话 ＋ 3 类工具可见性同步 | `'agent/created'`(serial)、`'agent/pre-step'` | `registerContext` / `accMessage` / `accIdentityText` / `shouldAutoRestore` / `shouldRestoreActive` | ✅ `context` |
| `env.ts` | L2 | 注入 `DSH_SERENITY_ROOT` / `CCC` / `VERSION` shell 环境事实 | `ctx.shellEnv.register` | `registerEnv` / `resolveSerenityEnv` | 🟡 无专属测试（由 `acc-extras` 覆盖） |
| `guards.ts` | L2 | safe-mode / 路径逃逸 / 凭据 / 注册表 / 角色白名单**机械守卫** | `'tools/pre-execute'` ＋ `ctx.tools.guard()` ＋ `agent.ctx.tools.restrict()` | `registerGuards` / `decideGuard` / `syncSafeModeRestriction` / `sync|forgetImBridgeVisibility` / `sync|forgetExclusiveToolsVisibility` / `getRestrictDiagnostics` | ✅ `guards` |
| `keeper.ts` | L2 | post-execute **观察-增益**：计分提醒 ＋ rebuild 压力 ＋ SESSION.md 体积 | `'tools/post-execute'` | `registerKeeper` / `scoreTool` / `reminderText` / `rebuildReminderText` / `trajectoryCompactionReminderText` / `readContextPressure` / `readSessionMdMaxKB` | ✅ `keeper` ＋ `gate` / `rebuild` / `trajectory-skills` |
| `lifecycle.ts` | L2 | 会话销毁清 per-会话态 ＋ 卸载拆卸自起资源 | `'agent/disposed'`、`'session/disposed'`、`registerDisposer` | `registerLifecycle` / `cleanupSessionState` / `sessionIdOf` | ✅ `seams/lifecycle` |
| `opencode-skills.ts` | L2 | 把 CCC `.opencode/skills/*` 注册为 DSH **技能 provider** | `ctx.skills.registerProvider`（rank 250） | `registerOpencodeSkills` / `OPENCODE_PROVIDER` / `OPENCODE_RANK` | ✅ `opencode-skills` |
| `system-prompt.ts` | L2 | **Induction 8 块装配文本** ＋ 3 个 `systemPrompt.section` | `ctx.systemPrompt.section`×3、`ctx.tools.get('run_code')` | 11 个文本块函数 ＋ `serenitySystemPrompt` / `registerEntrySkillSection(Global)` / `registerTrajectorySkillSection` | ✅ `system-prompt` / `osp-alignment` / `trajectory-skills` |

#### 2.2.1 缝的接线总表（宿主事件 → 处理函数 → 影响）

| 宿主事件/服务 | 处理函数 | 影响什么 |
|---|---|---|
| `'agent/created'` | `context.ts`（async）→ `seed(agent)` | 注册 scoped `serenity-entry` section；`agent.inject(accMessage)` **播种身份**；同步 safe-mode / im-bridge / 专属工具 restrict |
| `'agent/pre-step'` | `bootstrap.ts`（`{prepend:true}`，先 `next()`） | bootstrap 阶段剥离 `source.kind ∈ {skill-catalog, agent-instructions}` |
| `'agent/pre-step'` | `context.ts`（`next()` 后组装） | 同步 3 类 restrict ＋ 2 个 section；首次进 CCC 返回 `{kind:'enter', messages:[accMessage,…]}`（`injected` Set 保证只一次） |
| `'agent/inbox/inserted'` | `bootstrap.ts` → `inbox.prepend('next-turn', …)` | 注入 2 条 `bootstrap-anchor-*` 锚定消息（`handyman-`/`skiff-` 前缀与插件来源消息跳过） |
| `'agent/disposed'` / `'session/disposed'` | `lifecycle.ts` → `cleanupSessionState()` | 清 6 项 per-会话态 |
| `'session/event'` | `compact.ts` | `compaction/end` 无 error ⇒ `agent.inject(accMessage)`（Skiff 会话旁路） |
| `'session/event'` | `bootstrap.ts` → `trackerFor(root).observe()` | 累计轮数；`compaction/end` 重置 boundary |
| `'system-prompt/assemble'` | `bootstrap.ts`（先 `next()`） | 未晋升：`boundary<0` ⇒ `tools:[]`；压缩后 ⇒ 筛到 `compactionTools` |
| `'tools/pre-execute'` | `guards.ts` → `decideGuard` | 命中 ⇒ `{kind:'deny', reason}` 短路 |
| `ctx.tools.guard(cb)` | `guards.ts`（同一 `evaluate`） | 只可 deny 的**终局不变式**（顺序无关） |
| `'tools/post-execute'` | `keeper.ts`（`next()` 后折叠） | 追加 `additionalContexts`（checkpoint 码 / rebuild 提示 / SESSION.md 体积提示）＋ 记用量统计 |
| `ctx.shellEnv.register` | `env.ts` 的 `BashEnvContributor.resolve` | 每次模型 shell 调用注入 3 个环境变量 |
| `ctx.skills.registerProvider` | `opencode-skills.ts` 的 `list()/get()` | CCC 技能进 DSH 技能目录（rank 250） |
| `ctx.systemPrompt.section`×3 | `system-prompt.ts` 三个 `text(context)` | 全局 `serenity-entry` ／ per-agent `serenity-entry`（同名最近层胜）／ `serenity-trajectory-skills` |
| `ctx.effect`（经 `host/effect.ts`） | `lifecycle.ts:disposeAll()` | 卸载/HMR 时停自起 listener 与微信桥轮询器 |
| `agent.ctx.tools.restrict({deny})`×3 | `guards.ts` 三个 `sync*` | 从工具 schema 移除 `bash` / `im-bridge` / `acc-diag` |

#### 2.2.2 注入面事实（**"改文案要不要发版"的判据来源**）

| 位置 | 注入名 / 载体 | 文本来源 |
|---|---|---|
| `system-prompt.ts` | `systemPrompt.section({name:'serenity-entry', order:-50})`（全局 ＋ per-agent scoped 同名 shadow） | `serenitySystemPrompt(root, scope)` 全文 |
| `system-prompt.ts` | `{name:'serenity-trajectory-skills', order:-45}` | **从 CCC/配置读**：`.opencode/serenity.json` 的 `trajectory.skills` ∪ 绑定 SESSION.md frontmatter 的 `skills:` ⇒ 各 `SKILL.md` 全文（**每请求重读，不缓存**） |
| 系统提示词 8 块 | `=== Serenity ACC / Metaphor / Principles / CCE / EAP / Tools / Session / SafeMode / Localstore / CodeMode ===` | 🔴 **硬编码在源码里**（仅 `ACC_VERSION` 从 `package.json` 读；`Persona` 块由插件配置 `persona.mode`/`overrideText` 驱动） |
| 同上 | CCC 入口 `SKILL.md` 全文（经 `sanitizeSkillContent` 过滤安全模式行） | **从 CCC 读** |
| `context.ts` / `compact.ts` 的 `agent.inject(accMessage(…))` | 对话消息流（非系统提示词） | 硬编码 4 行头 ＋ `${root}` ＋ 可选 `.dsh/PHASE2-PROMPT.md` 全文 |
| `keeper.ts` 的 `additionalContexts` | 对话消息 | **硬编码字面量**（3 条提醒文案） |
| `bootstrap.ts` 的 `inbox.prepend` | 对话消息（锚定轮） | 硬编码常量 `DEFAULT_ANCHOR_MESSAGES`（2 条） |

🔴 **结论（可直接引用）**：**系统提示词骨架与 3 条提醒文案全部硬编码 ⇒ 改它们必须改源码 ⇒ 重建 ＋ 发版**。
**运行时才读、改它不需发版**的文本只有 5 处：CCC 入口 `SKILL.md` 全文 ／ `trajectory.skills` 声明的 skill 全文 ／ `persona.overrideText` ／ `.dsh/PHASE2-PROMPT.md` ／ 黑名单规则的 `message`。

### 2.3 L2/L3 · 对外面与集成域（36 个文件，按子域分组）

| 子域 | 文件（层） | 一句话职责 | 对外形态 | 被测 |
|---|---|---|---|---|
| **网关（面 B）** | `gateway.ts`(L2) / `gateway-auth.ts`(L1) / `gateway-dsh-auth.ts`(L2) / `gateway-proxy.ts`(L2) | 双端口网关装配（登录页 ＋ 反代宿主主面 ＋ WS）；认证纯逻辑（会话/锁定/CSRF）；换取宿主的 `dsh-auth` cookie；反代辅助（polyfill/头部/workspace 过滤） | HTTP **3081**（`0.0.0.0`） | ✅ `gateway` / `gateway-dsh-auth` |
| **ACP（面 E）** | `acp-core.ts`(L1) / `acp-http.ts`(L3) | ACP JSON-RPC 服务端 ＋ 问答页 listener；建会话委托 `skiff-core` | HTTP **3100**（`127.0.0.1`） | ✅ `acp-core` |
| **微信（面 C ＋ 出站）** | `weixin-api.ts`(L2) / `weixin-bridge.ts`(L2) / `weixin-hook.ts`(L2) / `weixin-route.ts`(L2) / `weixin-send-api.ts`(L3) / `weixin-send-endpoint.ts`(L2) / `weixin-output-guard.ts`(L2) | iLink 协议底座 ＋ 媒体解密；桥（轮询/入站分发/主动发送）；事件 hook；配置与凭据读写；主动发送 HTTP 面；进程内 endpoint 槽；输出闸门（未发送即打回） | HTTP **3082**（`127.0.0.1`）／出站 HTTPS | ✅ `weixin` / `weixin-hook` / `weixin-send-api` / `weixin-output-guard` |
| **IM 抽象** | `im-bridge.ts`(L2) / `im-weixin.ts`(L2) | IM 通道注册表 ＋ 统一发送后端；`weixin` 的 `ImChannel` 实现 | 无（工具后端） | ✅ `im-bridge` / `im-weixin` |
| **输出守卫** | `output-guard.ts`(L1) / `output-guard-seam.ts`(L2) | 敏感词表/检测/打回文案；输出守卫钩子 ＋ `lastAssistantText` | 无（钩子） | ✅ `output-guard` |
| **Skiff** | `skiff-core.ts`(L2) / `skiff-debug.ts`(L3) / `skiff-registry.ts`(L1) / `skiff-role.ts`(L2) | 会话核心（建 agent/问答/工作台）；调试问答页（面 D）；内存注册表（**零 DSH 依赖**）；角色配置解析 | HTTP **3099**（`127.0.0.1`） | ✅ `skiff-core` / `skiff-debug` / `skiff-role`；注册表由 `guards.test` 覆盖 |
| **宿主补丁 / provider** | `deepseek-vision-patch.ts`(L2) / `opencode-provider.ts`(L2) / `web-fetch-provider.ts`(L2) | 给 deepseek 路由补 image 输入；opencode 路由自动补头/建路由；fetch 地址白名单解析器（放行 fake-ip 段） | 无（宿主 settings / provider 补丁） | ✅ 各自 |
| **面宿主** | `face-host.ts`(L2) | 对外面 listener 的**唯一启停真相源**（`startFace`/`stopFace`/`FaceSpec`） | 无（绑各面端口） | ✅ `face-host` |
| **配置与设置** | `config-ops.ts`(L2) / `settings-section.ts`(L2) / `localstore-ops.ts`(L2) | 插件**全局**配置读写；宿主设置面板 ns=`serenity-hooks`；CCC localstore 读写 ＋ git 策略 | 文件：`~/.dsh/serenity-hooks.json` ／ CCC `localstore.json` | ✅ `config-ops` / `settings-section` / `localstore` |
| **工具后端（`*-ops`）** | `git-ops.ts` / `fs-ops.ts` / `kit-ops.ts` / `container-status.ts` / `handyman-ops.ts` / `handyman-preset-inherit.ts`（均 L2） | 各工具的实现后端；`container-status` = CCC 身份/三原则/注册表两判据/时钟；`handyman-ops` = 杂工进度/提示词/白名单判定 | 无（工具后端）／文件 | ✅ `ops` / `fs-ops` / `container-status` / `handyman-ops` / `handyman-preset` |
| **发现与消息** | `skills-discovery.ts`(L2) / `message-source.ts`(L1) | 入口 skill/`SKILL.md` 发现与截断；ACC 注入消息 `kind` 的**单一真相源** | 文件 ／ 无 | ✅ 各自 |

#### 2.3.1 外露面总表（`ports.ts:FACE_PORTS`）

| 面 | 端口/host | 协议 | 默认开关（配置键） | 启动文件:符号 |
|---|---|---|---|---|
| **A main** | 3080 | HTTP/WS | 宿主决定（插件**不监听**，只挂 `/serenity/*`） | 宿主 DSH（不在本仓） |
| **B gateway** | 3081 / `0.0.0.0` | HTTP 反代 ＋ 登录页 | `readSimpleSettings().gatewayEnabled`（默认 **false**） | `gateway.ts:registerGateway` → `startFace('gateway')` |
| **C weixinSend** | 3082 / `127.0.0.1` | HTTP `POST /send` | `readAdvancedSettings().weixinApi.{enabled,port}`（默认 **true**） | `weixin-send-api.ts:registerWeixinSendApi` |
| **D skiffDebug** | 3099 / `127.0.0.1` | HTTP 问答页 | `readSimpleSettings().skiffEnabled`（默认 **false**） | `index.ts:registerSkiff` → `skiff-debug.ts:startSkiffDebugServer` |
| **E acpHttp** | 3100 / `127.0.0.1` | HTTP JSON-RPC ＋ 问答页 | `acpEnabled \|\| publicAskEnabled`（默认 **false**） | `index.ts:registerAcp` → `acp-http.ts:startAcpHttpServer` |
| 微信出站 | iLink `baseUrl` | HTTPS | 凭据 `WEIXIN_<ID>_{TOKEN,BASEURL,USERID}` | `weixin-api.ts`（`weixin-bridge` 调用） |

#### 2.3.2 配置读取面（**归属判据的取证**，I3）

| 读的地方 | 来源 | 键 |
|---|---|---|
| `config-ops.ts:readAdvancedSettings()` | 宿主全局 `~/.dsh/serenity-hooks.json`（节 `serenityAdvanced`） | `gateway.{enabled,host,port,accounts,workspaces,cookieSecure,allowWorkspaceCreate,totpEnabled}`、`publicAsk.{key,allowed}`、`weixinApi.{enabled,port}`、`persona` |
| `settings-section.ts:readSimpleSettings()` | 本插件 fiber **Config**（经宿主 settings 面板 `ns=serenity-hooks`） | `gatewayEnabled`/`rebuildEnabled`/`rebuildThresholdK`/`skiffEnabled`/`skiffDebugPort`/`acpEnabled`/`acpHttpPort`/`publicAskEnabled`/`croEnabled`/`unattendedEnabled`（旧嵌套形态 `gateway.enabled`、`skiff.debugPort`、`acp.httpPort` **亦收**） |
| `weixin-route.ts` / `skiff-role.ts` | **CCC** `.opencode/serenity.json` | `weixin.*`、`skiff.roles` |
| `localstore-ops.ts` / `weixin-route.ts` / `im-weixin.ts` | **CCC** `localstore.json`（节 `credential`\|`config`） | `WEIXIN_<ID>_*`、`localstore.gitTrack` |
| 不读配置（纯常量/机制） | — | `message-source` / `output-guard(.|seam)` / `face-host` / `ports` |

⇒ 🔵 **归属事实**：**"机制与开关"在插件全局或 CCC 配置**（符合 I3）；**"面向人的文本"里，系统提示词 8 块仍硬编码在源码**（见 §2.2.2）⇒ 这是 I3 未闭合的部分（= CCC 侧登记 A11「ACC 内嵌文案逐条审计」）。

### 2.4 L3 · 工具面 `src/tools/`（15 个文件）

| 文件 | 工具名 | 一句话职责 | 可见性条件 | 被测 |
|---|---|---|---|---|
| `tools/trajectory.ts` | `container_trajectory` | 轨迹生命周期（list/show/create/use/rebuild）＋ 跨轨迹投递（send-now/send-later）＋ CRO 指南 | 总是可见 | ✅ `cro-guide` / `session-title`（直接 import） |
| `tools/handyman.ts` | `handyman` | 委派 worker agent（foreground / background 双模式） | 总是可见；`model` 须在 CCC `handyman.models` 白名单 | ✅ `handyman-foreground` |
| `tools/cc-fs.ts` | `container_fs` | 容器文件系统 15 子命令（路径逃逸自动阻断） | 总是可见 | ⚠️ 无镜像测试（INDIRECT_COVERED ＋ `fs-ops.test`） |
| `tools/git.ts` | `container_git` | CCC git status/commit/push/log/pull/diff | 总是可见 | ⚠️ 无镜像测试（INDIRECT_COVERED ＋ `ops.test`） |
| `tools/msm.ts` | `msm` | 执行/发现已注册 MSM（单入口 ＋ 模糊候选） | 总是可见；skiff 角色另受 `msms` 白名单门控 | ⚠️ 无镜像测试（INDIRECT_COVERED） |
| `tools/kit.ts` | `dashboard` | health / time / wait 常开仪器 | 总是可见 | ⚠️ 无镜像测试（INDIRECT_COVERED） |
| `tools/praxis.ts` | `praxis` | 按 section 注入 eap/neat/cce 框架 | 总是可见 | ✅ `praxis` |
| `tools/localstore.ts` | `localstore` | 凭据/配置本地存储（credential/config 双命名空间） | 总是可见 | ⚠️ 无镜像测试（INDIRECT_COVERED） |
| `tools/container-admin.ts` | `container_admin` | CCC 管理面：role / msm / config 三域 | 总是可见 | ✅ `container-admin` |
| `tools/im-bridge.ts` | `im-bridge` | 经 IM 通道向家人 send/send-file/users/status | 需 `hasEnabledImChannel(root)` | ⚠️ 无直接 import（能力层由 `im-bridge.test` 覆盖） |
| `tools/acc-diag.ts` | `acc-diag` | 一次调用出 ACC 运行态全报告（live/唤醒时钟/注册表） | 需 CCC 在 `exclusiveTools` 声明（**fail-closed**） | ✅ `acc-diag` |
| `tools/eap.ts` / `tools/neat.ts` / `tools/cce.ts` | —（**不注册工具**） | 三份框架**文本常量**，由 `praxis.ts` 消费 | 无 | ✅ `acc-extras` |
| `tools/skiff-admin.ts` | —（**不注册工具**） | Skiff 角色逻辑（guide/validate/apply/list），经 `container_admin role` 暴露 | 无 | ✅ `skiff-admin` |

**注册路径事实**：装配点 = `src/index.ts:apply` → `ctx.tools.register(...)` ×**11**（工厂式 6 ＋ 常量式 5）。
- **顺序约束**：`registerImChannel(weixinChannel)` 必须早于工具装配 —— `createImBridgeTool()` 的 description 读 `imChannelIds()`。
- **清单三处一致（单一真相源）**：`src/invariant.ts:REGISTERED_TOOLS` ＋ `dsh.plugin.json` 的 `contributes.tools` 双列 11 名，由 `verifyToolConsistency()` 校验；`tests/register.test.ts` 断言 `register` 被调 11 次。
- **条件可见的统一实现**：`agent.ctx.tools.restrict({ deny: [...] })`（**从模型清单移除**，不是"看得到但被拒"），调用点全在 `seams/context.ts`（会话就绪 ＋ pre-step）：`im-bridge` ← `syncImBridgeVisibility`（判据 `hasEnabledImChannel`）／ `acc-diag` ← `syncExclusiveToolsVisibility`（判据 `EXCLUSIVE_TOOL_NAMES` ＋ `ccc.ts:readExclusiveTools`，fail-closed）。全体工具另受 `syncSafeModeRestriction`（`SAFE_MODE_DENY_TOOLS = ['bash']`）与 skiff 角色双白名单（pre-execute guard）两道 restrict。
- **工具 → 实现**（薄壳证据）：`acc-diag`→`diag-ops:runAccDiag`｜`cc-fs`→`fs-ops:runCcFs`｜`git`→`git-ops:runGit`｜`kit`→`kit-ops:runKit`｜`localstore`→`localstore-ops:runLocalStore`｜`msm`/`container_admin`→`msm-ops:runMsm(Async)`｜`handyman`→`handyman-ops:*` ＋ `host/access:hostSubagents` ＋ `agent-idle:waitAgentIdle`｜`im-bridge`→`im-bridge:runImBridge`｜`trajectory`→`trajectory-ops:*` ＋ `rebuild:queueRebuild`（**动态 import**）＋ `wake-registry:addWake` ＋ `wake-scheduler:sendToTrajectory` ＋ `trajectory-bound:*`。

### 2.5 L1 · 轨迹／会话／唤醒核心域（18 个文件）

| 文件 | 一句话职责 | 主要导出 | 被测 |
|---|---|---|---|
| `ccc.ts` | CCC 根/git/配置/路径守卫/黑名单（**含退役 autopilot 配置类型**） | `findSerenityRoot` / `loadSerenityConfig` / `resolveInside` / `matchBlacklist` | ✅ `ccc` / `guards` |
| `ccc-roots.ts` | **CCC 根解析的唯一判断层**（不新增持久状态） | `listCccs` / `cccRootForCwd` / `cccRootForExec` / `agentCwdFor` | ✅ `ccc-roots` |
| `trajectory-ops.ts` | 轨迹工具纯操作层：会话增查/激活/摘要 | `sessionEvents` / `createSession` / `useSession` / `listSessions` / `summarize` | ✅（7 个测试文件） |
| `trajectory-bound.ts` | 会话↔轨迹**绑定持久化** | `appendBound` / `readLastBound` / `listBoundSessionIds` / `pruneMissingBindings` | ✅ `trajectory-bound` |
| `trajectory-skills.ts` | frontmatter `skills:` 解析 ＋ 全文注入装配 | `buildTrajectorySkillsSection` / `parseDeclaredSkills` | ✅ `trajectory-skills` |
| `trajectory-assistant.ts` | token 常量 ＋ 风格门面 | `eventToken` / `EVENT_LABEL` / `ACK_PREFIX` / `IN_FLIGHT_HEADING` | ✅ `trajectory-assistant` |
| `wake-registry.ts` | **唤醒注册表纯数据层**（状态机，tmp+rename 写） | `loadWakeRegistry` / `addWake` / `splitDueWakes` / `finalizeWake` | ✅ `wake-registry` |
| `wake-scheduler.ts` | **中心调度器**：5min tick 投递 wake / CRO | `registerWakeScheduler` / `sendToTrajectory` / `wakeSchedulerState` | ✅ `wake-registry` / `container-status` |
| `rebuild.ts` | 超限清空重建（排队 → turn-stopping 执行） | `queueRebuild` / `registerRebuildTurnHook` / `buildRebuildAnchor` / `performRebuild` | ✅ `rebuild` |
| `cro.ts` | CRO 机制层：扫描/执行/快照/判定（**只 spawn 不 import**） | `evaluateCro` / `buildCroSnapshot` / `listCroTrajectories` | ✅ `cro` |
| `cro-log.ts` | CRO 唤起日志（两日窗，**写入即裁剪**） | `appendCroWakeLog` / `loadCroWakeLog` | ✅ `cro-log` |
| `cro-turns.ts` | 追踪"哪些载体正在跑轮次"（纯内存 Map，TTL 30min） | `registerCroTurnTracking` / `runningCarriersOf` | ✅ `cro-turns` |
| `cro-guide.ts` | CRO 编写指南正文（样例快照**由装配器派生**） | `CRO_GUIDE` / `croGuidePayload` | ✅ `cro-guide` |
| `clock-runtime.ts` | 时钟运行时工厂（两钟共用骨架，**零 import**） | `createClock` / `ClockOptions` / `ClockRuntime` | ✅ `clock-runtime` |
| `session-cleanup.ts` | DSH 旧会话**物理清理**（live 会话保护跳过） | `performCleanup` / `collectEligibleSessions` / `hasSessionLogById` | ✅ `session-cleanup` |
| `live-sessions.ts` | live 会话取数 ＋ 精简诊断（只读） | `diagLive` / `listLiveSessions` / `readSessionTitle` | ✅ `live-sessions` |
| `agent-idle.ts` | 等待 agent 空闲（含销毁竞速，**永不 reject**） | `waitAgentIdle` | ✅ `agent-idle` |
| `usage-stats.ts` | ACC 用量统计（skill/MSM 计数，结构有界） | `recordToolUsage` / `recordSkillInjections` / `loadUsageStats` | ✅ `usage-stats` |

**域内依赖方向**（A → B = A import B）：`trajectory-bound`→`ccc-roots`,`trajectory-ops`｜`wake-scheduler`→`trajectory-ops`,`trajectory-bound`,`cro`,`cro-turns`,`cro-log`,`clock-runtime`,`ccc-roots`｜`rebuild`→`ccc-roots`,`trajectory-assistant`,`trajectory-bound`,`trajectory-ops`｜`cro`→`ccc`,`trajectory-ops`｜`live-sessions`→`ccc-roots`,`trajectory-ops`｜`ccc-roots`→`ccc`。
**域内无环**（边单向收敛于 `trajectory-ops` / `ccc-roots` → `ccc`）—— 但**存在一条跨批环**，见 §3-6。

### 2.6 L4 · 客户端半 `src/client/`（18 个文件）

| 文件 | 一句话职责 | 依赖的宿主客户端服务 |
|---|---|---|
| `index.ts` | client 半入口：注册 **3 个槽位 ＋ 设置页**（只导出 `apply`） | `inject` slots/conversation/sessions/configForms；`configForms.get` ＋ `whileServed` |
| `SettingsSection.tsx` | DSH 原生设置页「Serenity」（内含 `SessionCleanupBlock`） | `PropsRuntime<'settings.section'>` ＋ `InjectFace{serenitySettings}` |
| `SafeModePanel.tsx` | 会话头状态胶囊 ＋ 自绘 popover（自算 fixed 坐标） | `PropsRuntime<'conversation.session.header.actions'>` ＋ `ui-primitives` 图标 |
| `ImageFallbackDock.tsx` | 图片被拒 ⇒ 自动落盘 ＋ 纯文本重发（**无 UI**，返回 null） | `PropsRuntime<'conversation.input.dock'>` ＋ `inputActions.{setDraft,removeAttachment,submit}` |
| `FileFallbackDock.tsx` | 非图片文件粘贴 ⇒ 落盘 ⇒ draft 追加路径 | 同上（`setDraft`） |
| `AccountsEditor.tsx` | 网关监听/账号 CRUD/工作区白名单面板 | 无插槽；经 `accounts-api` 走同源 HTTP |
| `WeixinBridgeEditor.tsx` | 微信桥：CCC 选择/扫码绑定/路由表 | 无插槽；`/serenity/cccs`｜`/serenity/weixin(+login)` |
| `PublicAskEditor.tsx` | 问答页白名单 chips ＋ key/地址/轮换 | 无插槽；`/serenity/public-ask`｜`/serenity/config` |
| `PersonaEditor.tsx` | 彩蛋模式：替换提示词段 | 无插槽；`fetchConfig`/`saveConfig` |
| `accounts-api.ts` / `file-fallback-api.ts` / `image-fallback-api.ts` | 客户端逻辑层（wire 类型、剪贴板筛选、触发判定/上传/重发） | `image-fallback-api` 用 `ctx.get('conversation')` ＋ `ctx.sessions.binding` |
| `host-type-contract.ts` | **client 半的宿主类型契约**（编译期反证，零运行时语句） | `import type` `ui-conversation` / `ui-slots` |
| `css-modules.d.ts` ＋ 4 个 `.css` | 类型声明与样式 | — |

🔴 **客户端半的两条结构事实**：① 它引用的宿主契约与 node 半**不同**（浏览器侧 `configForms`/`slots`/RPC）⇒ 由 `typecheck-host` 的 **client 半**单独把关（§2.5 的例外条款）；② **`vitest.config.ts` 的 coverage 把 `src/client/**` 整体排除** ⇒ 客户端半**不在覆盖率门禁内**（见 §3-9）。

### 2.7 测试面（**115 文件 / 1816 用例** —— 锚定 2026-09-25 **④ 第 1 步 `58b2891`** 时实测为 108/1699；其后 ⑤ 五件各加一批：`50ad1f3` → 109/1715，`ae195a7` → 110/1733，`e834e17` → 111/1756，`a5815c6` → 112/1767，`58d58b2` → **113/1799**；第 6 件（gateway 语义化）→ **113/1801**（同文件 +2）；第 7 件（lazy 守卫 ＋ 台账复核）→ **114/1807**（+1 文件 +6 用例）；第 8 件（**HTTP 对外面 `api.ts`**）→ **115/1816**（+1 文件 +9 用例）；第 9 件（同面补齐其余 5 条路由）→ **115/1822**（同文件 +6）；第 10 件（**破坏性端点** session-cleanup POST）→ **115/1826**（同文件 +4））

| 维度 | 读数 |
|---|---|
| 文件构成 | 仓根 `tests/` 9 ＋ `hooks/.../tests/` 97（顶层 88 ＋ `host/` 8 ＋ `seams/` 1）＋ `scripts/` 2 |
| 行数量级 | 小 59 ／ 中 41 ／ 大 8（大者：`weixin` 1264、`guards` 714、`gateway` 696、`rebuild`、`skiff-core`、`trajectory-bound`、`wake-registry`、`acp-core`） |
| 含替身（`vi.mock`/`vi.fn`/`stubGlobal`） | **45 文件** |
| 纯静态文本门禁（无 src 主体） | **7 文件**（`client-popover-clip-guard` / `client-css-tokens` / `compliance` / `coverage-gate` / `failure-policy` / `host-manifest` / `host/type-contract`） |
| 行为测试内夹源码文本断言 | 4 文件（`gateway` L465-499、`trajectory-bound` L307/319/475、`trajectory-skills` L300-328、`client-popover-clip-guard`） |
| **走生产入口（`import { apply }`）** | **仅 3 个**：`register` / `config-volatile` / `skiff-startup-retry` |
| 真机探针（依赖真宿主/真文档） | 2 个：`host/deepseek-vision-probe` / `-verify`（均自述诚实边界） |

**分层现状**：主体是「**真 fs（`mkdtempSync` 出临时 CCC）＋ 替身宿主包**」的集成测试；**纯函数单测占比很小**（十余个小文件：`accounts-api`/`file-fallback-api`/`totp`/`ports`/`time`/`status`/`message-source`/`skills-discovery`/`handyman-preset`/`praxis` 等）；**契约/类型钉**另有一簇（`host/type-contract` 明示"真正的断言发生在编译期"）。

---

## 3. 欠账与违例（**待处理清单**，供第 ④ 项重构）

> 判据：每条都要有**证据**（谁 grep 了什么、命中多少）。**只登记，不在这里下"删/不删"的结论**——处置见约束文档 §6。

### 3-1. I2「衔接面单点化」未达成（结构性欠账）

- **读数**：对宿主包的直接 import **146 处（含 2 行注释 ⇒ 真导入 144）**，**远不止** `src/host/` ＋ `src/seams/`。🔴 **读法**：I2 的原命令会把**注释里的 import 文字**算进去 ⇒ **引用此数必须标口径**（详见约束文档 §2.6 末「判据命令与已知盲区」）。
- **分布（已见）**：`tools/*` 取 `defineTool` / `ContentBlock`（工具 API 面，**必要接触**）；`rebuild.ts` / `wake-scheduler.ts` / `skiff-core.ts` / `unattended-seam.ts` / `cro-turns.ts` / `agent-idle.ts` / `acp-core.ts` / `output-guard-seam.ts` 等直接吃 `dsh-session` / `dsh-agent` / `dsh-llm` 的**类型**（**可收敛接触**）。
- ✅ **处置方向已细化（2026-09-25）⇒ 去约束文档看，本节不抄**：**§2.6 = 宿主接触点白名单**（W1 必要接触 / W2 待收敛 / W3 禁止 / L4 豁免）；**§2.7 = I2 收敛清单（实测快照）**。🔴 **单真相源**：白名单与清单**只写在约束文档**（复制 = 第二真相源，见 §2.2）。
- 🔴 **本轮实测的关键结论（一句话）**：I2 欠账的**真正落点不是"146"这个大数**，而是 **L1 里 6 / 18 个文件、16 行**命中 §3.2-3 —— `rebuild.ts` 7 ／ `wake-scheduler.ts` 3 ／ `cro-turns.ts` 2 ／ `agent-idle.ts` 2 ／ `ccc-roots.ts` 1 ／ `live-sessions.ts` 1；**其余 12 / 18 干净**（`clock-runtime.ts` 自述"零 import" **经实测为真**）。
- 🔴 **且这 6 个多半不是"待收敛"而是"定层错"**：§3.3 准入三问**第 1 问**即「碰宿主类型或服务吗？→ 是 ⇒ **L0**」⇒ 它们**按自己的准入判据就不该在 L1**。⇒ 处置 = **逐文件二选一**（**(a) 真解耦：接触注入化** ／ **(b) 重新定层：挪到 L0/L2 并同批改 §2.5／§3.2 归属**），**是裁决、不是机械重构** ⇒ 按 D85 逐个做。
- ✅ **子条款①「禁止 import 宿主内部实现路径」实测 0 处 ⇒ 达标**（此前未单列 ⇒ 容易被"146"这个大数掩盖成一个整体欠账）。
- 🔵 **顺带证伪一条便宜猜测**：`ccc-roots.ts` / `live-sessions.ts` 各只 1 行 `Context`，**曾怀疑是死导入**（可零风险删）—— **实测两处都真被用到**（`hostService(ctx,…)` ／ `hostSessions(ctx)`）⇒ **不是死代码**，只能走上面的 (a)/(b)。
- 🆕 🔴 **2026-09-25：读取入口（F-06）的残留收敛 —— 实测还剩 1 处**。`host/access.ts` 自述是"**唯一**读取宿主服务的入口"，实测仍有绕过：
  - ✅ **已收敛**：`src/api.ts` 的 `ctx.get('sessions')` → 改走 **`hostSessions(ctx)`**（**行为无影响**：`sessions` 是 injected ⇒ `hostInjected` 先属性读、再回落 `ctx.get`，是**超集**）。判据命令 = `grep "ctx\.get\(" src/**`，收敛后只剩 `api.ts` 一处。
  - ⏳ **待收敛（不是机械替换）**：`src/api.ts` 的 **`ctx.get('codeRuntime')`**（P2-7 的装配态探测）—— 该服务**不在 `HOST_SERVICES` 契约表里** ⇒ 要收敛得**先给它建契约条目 ＋ 类型化读取器**，属"补契约"而非"改调用"。

### 3-2. 只被 tests 用（或过度导出）的符号（候选，未判）

| # | 符号 | 现状 | 判据 |
|---|---|---|---|
| 1 | `host/access.ts:hostSessionCwds` | **只被 tests 用** | 定义 ×1 ／ 注释 ×1 ／ 测试导入 ＋ 5 处断言 |
| 2 | `host/contract.ts:HOST_EVENTS` | **只被 tests ＋ 注释用** | src 零 import；测试 `cro-turns.test.ts` / `host-contract.test.ts` |
| 3 | `host/effect.ts:__resetDisposerWarningsForTest` | 生产零调用（**刻意的测试辅助**） | 唯一消费者 `host/effect.test.ts` |
| 4 | `api.ts:senderIsWebUi` | **导出无消费者**（同文件内部调用 1 处） | 全仓外部零引用 |
| 5 | `seams/keeper.ts:compactionStateSnapshot` / `rebuildReminderStateSnapshot` / `__resetLogbookCompactionForTest` | src 仅声明行，消费方全是 tests | `keeper.test.ts` / `gate.test.ts` |
| 6 | `seams/guards.ts:getImBridgeVisibilityDiagnostics` / `getExclusiveToolsDiagnostics` | src 仅声明行，消费方全是 tests | `guards.test.ts`（对照：同族 `getRestrictDiagnostics` **有真消费者** `status.ts`） |
| — | **过度导出（本文件内用 ＋ tests 用）** | `keeper.ts` 6 个、`system-prompt.ts` 12 个、`context.ts`/`env.ts`/`opencode-skills.ts`/`bootstrap.ts`/`guards.ts`/`lifecycle.ts` 若干 | 各处 src 命中全落在声明文件内 |
| — | ❌ **不是死代码** | `invariant.ts`（tsdown 第二入口 ＋ `files` 含 `lib/invariant.js` ＋ `compliance.test.ts` E4 断言）、`host/type-contract.ts`（靠 `tsconfig include` 参与 `tsc`） | 见各自行 |

### 3-3. 重复实现（同一语义写多份）

**a) `sessionIdOf`：⚠️ 2026-09-25 复核后**降级** —— 它们**不是**"同一函数的副本"，本项**不构成待处理欠账**

原判（"`seams/lifecycle.ts:sessionIdOf` 导出了，但 `cro-turns.ts`/`weixin-output-guard.ts`/`unattended-seam.ts` 各自另写私有同名副本 ⇒ 语义漂移风险"）**方向对、定性不准**，且**漏计两处**。实测（grep ＋ 逐个读实现）：

| # | 位置 | 读哪些形状 | 缺失时返回 | 消费者 |
|---|---|---|---|---|
| 1 | `seams/lifecycle.ts`（**export**） | `session.id ?? id ?? header.id`（**三种**） | `null`（且拒 `''`） | 🔴 **`src/**` 里 0 个 import**；仅 `tests/seams/lifecycle.test.ts` 引用（含 **8 条断言**：三类形状 ＋ 五类拒收） |
| 2 | `cro-turns.ts`（private） | **仅** `agent.session.id` | `null`（拒 `''`） | 本文件 4 处 |
| 3 | `weixin-output-guard.ts`（private） | `session.id ?? id`（**两种**） | `null`（拒 `''`） | 本文件 3 处 |
| 4 | `unattended-seam.ts`（private） | **仅** `agent.session.id` | **`''`**（**接受 `''`**） | 本文件 3 处 |
| 5 | `seams/bootstrap.ts`（局部闭包，**原判漏计**） | 只吃 **Session 对象**的 `id`（**不吃 Agent 包装**） | **`undefined`** | 本文件 4 处 |

⇒ 🔴 **结论：这五处不是"同一个函数的五份副本"，而是"同名、但语义各自不同的五个小工具"** —— 在**三个维度**上各自不同：
① **读路径**（`session` ／ `+id` ／ `+header.id`）—— 因为**调用点拿到的对象形状本来就不同**（Agent 包装 ／ 裸 Session ／ disposed 负载）；
② **缺失哨兵**（`null` ／ `undefined` ／ `''`）—— 各自匹配自己调用点的判空写法；
③ **空串政策**（四拒一收）。

⇒ **因此"合一"不是机械去重，而是一次语义裁决**：把 #2/#3 换成 #1 的读法会**放宽**它们的读路径（`agent.id` 从此也认）⇒ 属**行为变化**，不满足"功能无影响"（违反 D85 的判据）。
⇒ **处置 = 本项从「欠账」降级为「已登记的设计注记」；不合并。** 若日后确要合一，**须先定"以哪种形状与哨兵为准"** —— 那是**裁决**，不是重构。
⇒ **附带更正**：#1 的 `export` 属"**仅 tests 引用 ＋ 有真行为测试**"（§3-2 类）—— **不建议降级为模块内**，那等于**拆掉一条真行为钉**（8 条断言）。

**b) `isWriteTool`（§3-7c-5 亦记）**：`ccc.ts:isWriteTool(toolName)` 与 `seams/guards.ts:isWriteTool(toolName, action)` **签名不同**（后者多一个 `action` 判据）⇒ 同样**不是**机械可合的重复；且 `ccc` 版属"仅 tests 引用"（第 2 批候选）。

**c) 🆕 「CCC 名称」：**同名两义**（2026-09-25 随 ⑤ 第 4 件实测发现；`tests/seams/env.test.ts` 末组建有机械钉）

| # | 定义 | 取法 | 采用它的面 |
|---|---|---|---|
| 1 | **目录名**（dirName） | `basename(root)` | `seams/env.ts` 注入的 **`DSH_SERENITY_CCC`**（模型每个 shell 调用都能看到）｜`seams/system-prompt.ts:identityBlock` 写进**身份块的 `CCC:` 行**（模型每轮都看到）｜`ccc-roots.ts:listCccs().name` |
| 2 | **`.serenity` 首行**（cccName） | `readCccName(root)`（跳空行/`#` 注释） | **MSM 注册表路径** `.opencode/skills/<cccName>/references/mech-registry.json`（`msm-ops`）｜`container-status` 报告｜`fs-ops`｜`seams/guards` |

🔴 **判据（都是代码事实，非推测）**：`weixin-send-api.ts` 在**同一个对象**里**两个都输出**，且**分别命名**为 `dirName`（`e.name || basename(e.root)`）与 `cccName`（`readCccName(e.root)`）⇒ 作者**知道**这是两个东西；但 `env.ts` / `identityBlock` 把**目录名**直接命名为 `CCC`。
**影响**：若某 CCC 的 `.serenity` 首行 ≠ 根目录名（**测试夹具里就是这样**：`acc-extras.test.ts` 用 `.serenity` = `t` ＋ 随机 `mkdtemp` 目录名），则**模型被告知的 CCC 名** 与 **治理它 MSM 注册表的那个名字**不是同一个字符串。
**当前是休眠的**：本 CCC 内二者**恰好相同**（目录 `home-serenity` ＝ `.serenity` 首行）⇒ 无可见后果。
⚠️ **处置 = 登记待裁，本轮不动**（属"哪个是权威定义"的**语义裁决**，不是机械去重；且改任一处都会动到**模型可见文本**或**注册表路径**）⇒ 与 §3-3a 同类：**先定"以哪个为准"，再谈改**。

### 3-4. 无清理路径的 in-memory 状态（仅内存，重启自愈）

- `seams/bootstrap.ts`：`anchoredSessions` / `trackers` 无 disposed 清理。
- `seams/context.ts`：`injected` Set 无 disposed 清理。
- `seams/system-prompt.ts`：`sectionedAgents` / `trajectorySkillAgents` 无 disposed 清理。
- `seams/guards.ts`：`safeModeRestrictions` 无 forget 钩子（另两个族有 forget）。
- （CCC 侧同一族：keeper 的 `trackers` / `rebuildReminderStates`、`bootstrap` 的 `anchoredSessions` —— 已登记为 **A2**，属"建议不动"档。）

### 3-5. 对外面/集成域的导出面收敛候选（**只被 tests 用**，11 条）

判定方式：全仓 `*.ts`（含 src / tests / client / experiments）逐符号 grep 计数；下列每条"src 内零外部引用（只被自身内部或 tests 用）"。

| # | 符号 | src 命中 | tests 命中 |
|---|---|---|---|
| 1 | `skills-discovery.ts:findEntrySkill` | 2（定义 ＋ 自调） | `skills-discovery.test` 6 |
| 2 | `weixin-route.ts:isWeixinSessionId` | 1（定义） | `weixin.test` 2 |
| 3 | `weixin-bridge.ts:resetWeixinTypingCache` | 1（定义） | `weixin.test` 2 |
| 4 | `weixin-api.ts:buildClientVersion` | 2（定义 ＋ 文件内用） | `weixin.test` 3 |
| 5 | `acp-http.ts:acpHttpPort` | 1（定义；`index.ts` 只用 `acpHttpActive`） | `acp-core.test` 2 |
| 6 | `skiff-debug.ts:skiffDebugActive` / `skiffDebugPort` | 各 2（定义 ＋ 文件内 guard） | `skiff-debug.test` |
| 7 | `container-status.ts:containerIdentity` / `containerPrinciples` | 各 2（定义 ＋ `containerStatus` 内用） | `container-status.test` |
| 8 | `gateway-auth.ts:getFailState` | 4（定义 ＋ 3 处内部；经 `gateway.ts` re-export 但无人 import） | `gateway.test` |
| 9 | `face-host.ts:activeFaceNames` | 1（定义） | `face-host.test` 3 |
| 10 | `deepseek-vision-patch.ts:describeDeepseekVisionAction` | 1（定义） | `deepseek-vision-patch.test` 3 |
| 11 | `weixin-output-guard.ts:isManualOutputSession` | 1（定义） | `weixin-output-guard.test` 6 |

**疑似被后续版本替换/降为旁路（证据在注释里，须按 §6.2 先问"谁依赖它"）**：

| # | 对象 | 证据 |
|---|---|---|
| 1 | `weixin-send-api.ts` **整面** | 文件头自述「v1.31.0 起 agent 统一调 `im-bridge`……旧 CCC MSM `weixin-send` 已退役」；src 内消费者仅 `msm-ops.ts`（读 endpoint）＋ 自身。⚠️ **但面 C 是"公开面"**（HTTP 路由）⇒ 删除前必须查仓外消费者 |
| 2 | `gateway-proxy.ts:RANDOM_UUID_POLYFILL` | 兼容层，仅网关反代路径使用；tests 只断言字符串字面量 |

❌ **不是死代码（澄清项）**：`skiff-registry.ts` —— `skiff-core.ts` 显式 import 其 5 个函数并在 `seams/guards.ts` 直连 `skiffRoleFor` ⇒ **活代码**。

### 3-6. 🔴 **依赖环（违反 §3.2-2）：`rebuild.ts` ⇄ `tools/trajectory.ts`**

| 边 | 形态 | 已核（2026-09-25 实测 grep） |
|---|---|---|
| `rebuild.ts` → `tools/trajectory.ts` | **静态** `import { namingTitleFor } from './tools/trajectory.js'` | ✅ `rebuild.ts:61` |
| `tools/trajectory.ts` → `rebuild.ts` | **动态** `await import('../rebuild.js')` | ✅ `tools/trajectory.ts:410` |

⇒ 性质：**L1（领域核心）反向依赖 L3（工具面）**——既是**环**，也是**上行边**，同时违反 §3.2-1 与 §3.2-2。
⇒ 后果：`namingTitleFor` 是唯一把 `trajectory.ts` 拽进 L1 的东西；它让"改工具面"能影响领域核心的装载图。
⇒ 处置方向（第 ④ 项）：把那一个小函数**下沉**到 L1（或 `trajectory-ops`/`time` 这类中立模块），`rebuild` 与 `tools/trajectory` 各自向下依赖。**功能无影响的判据** = `namingTitleFor` 的输入输出与调用点不变 ＋ 全量测试绿。

✅ **已解（2026-09-25，工程化程序第 ④ 项·第 1 步）**：`sanitizeSessionSummary` ＋ `namingTitleFor` **下沉到 L1 的 `trajectory-ops.ts`**（零 DSH 依赖）。改动面 = 4 个文件：① `trajectory-ops.ts` 新增两函数 ② `rebuild.ts` 改从 `./trajectory-ops.js` 取（**删掉那条 L3 import**）③ `tools/trajectory.ts` 删两处定义、改为从 `../trajectory-ops.js` 取 ④ `tests/session-title.test.ts` 拆 import（两函数改指 L1）。

**复核判据（实测 grep）**：`src/**` 下 `tools/trajectory.js` 的 import **只剩 `index.ts`（组装点，非 L1）** ⇒ **L1 不再有任何 `tools/` 上行边**；仅存的跨层边 `tools/trajectory.ts → ../rebuild.js`（**动态、L3→L1 向下**）合法。
**功能无影响的证据** = 七项门禁全绿，且 test **108 files / 1699 tests** 与改前**逐字相同**（无用例增减）＋ 两函数签名与全部调用点未变。

⚠️ **一处可见的副作用（非行为影响，据实记）**：`pack-check` 的发布物文件数 **120 → 118** —— 打包器把两个共享 chunk（`session-cleanup-*.js` / `wake-scheduler-*.js`）**并回了 `index.js`**（模块图变了 ⇒ rolldown 的分块启发式随之改变）。**判据**：`lib/*.d.ts` 清单**未减**（仍 98 个）、`register.test` 的「apply 注册 11 工具」仍绿 ⇒ 这是**分块布局**变化，**不是模块丢失**。🔵 **通用教训**：改动模块图时，打包产物的**“文件数”会漂** —— 不要把它当成“必须恒定”的读数（要判丢失，看**类型清单**与**契约测试**）。

> 🔵 **为何 `sanitizeSessionSummary` 必须同批下沉**（否则只是把坏边改个名）：它是 `namingTitleFor` 的**私有助手**，若留在 L3，则 `trajectory-ops.ts`（L1）就得 `import '../tools/trajectory.js'` ⇒ **同一类上行边照旧存在**。⇒ **通用判据：搬一个函数之前，先查它的私有助手在哪一层。**

### 3-7. 核心域的死代码与退役残留（**候选，未判**）

**a) 导出但全仓零引用（连 tests 也不用）**：`ccc.ts:AutopilotTrajectorySettings`｜`ccc-roots.ts:ExecOrAgent` / `ListCccsOptions`｜`clock-runtime.ts:Clock`｜`cro.ts:readSessionMdBytes`（**已核：全仓仅定义点 1 处，零调用**）/ `CroDeps` / `CroParseResult` / `CroRunResult` / `CroOutcome`｜`cro-turns.ts:CroAgent`｜`cro-guide.ts` 的 `export { CRO_FILENAME, CRO_TIMEOUT_MS }`（使用方直接从 `cro.js` 取）｜`trajectory-assistant.ts:onSettlement`（空实现，文件头自述"无调用者"）｜`trajectory-bound.ts:ensureBindingsMigrated` / `getBindingStore`｜`trajectory-skills.ts:SKILL_MISSING_MARK`｜`usage-stats.ts` 若干类型/常量｜`wake-scheduler.ts:WakeSchedulerRuntime`（⚠️ `container-status.ts` 注释仍称其"未导出" ⇒ **注释过期**）。

**b) 仅 tests 引用**（生产无消费者）：`trajectory-ops.ts` 3 条 ／ `trajectory-bound.ts` 4 条 ／ `wake-registry.ts` 4 条 ／ `wake-scheduler.ts` 6 条 ／ `rebuild.ts` 6 条 ／ `cro.ts` 7 条 ／ `cro-log.ts`（除 `appendCroWakeLog` 外全部）／ `cro-turns.ts` 6 条 ／ `cro-guide.ts` 3 条 ／ `session-cleanup.ts` 3 条 ／ `live-sessions.ts` 2 条 ／ `usage-stats.ts` 9 条 ／ `trajectory-skills.ts` 3 条 ／ `trajectory-assistant.ts:styledToken` ／ `ccc.ts:isWriteTool`。

**c) 已被替代/废弃但仍在源码**：

| # | 对象 | 状态 |
|---|---|---|
| 1 | `trajectory-bound.ts:BINDINGS_REL_PATH`（`.bindings.json`） | 旧载体：D68 后权威载体 = 宿主存储域；此路径只剩**迁移源 ＋ 回退读** |
| 2 | `wake-registry.ts:removeWake`（＋ `tools/trajectory.ts` 注释里的 `wake-rm`） | 旧动作面 v1.33 已收敛；**唯一调用方是 tests** |
| 3 | `ccc.ts:AutopilotTrajectorySettings` ＋ `autopilotTrajectory`/`autotrajectory`/`autopilot` 三配置键 | ACC 侧 autopilot 2026-09-15 **已整段退场** |
| 4 | `ccc.ts:findGitRoot` 与**仓根包** `src/activation.ts:findGitRoot` 同实现两份 | ⚠️ **已核**：`activation.ts` 不在 `hooks/` 包内，而在**仓根包** `src/`（v0.1–v0.2 旧 runner 的遗留）——两份实现属**不同包**，不是同包重复 |
| 5 | `ccc.ts:isWriteTool` vs `seams/guards.ts` 同名局部实现 | 同一语义两份；`ccc` 版**仅 tests 引用** |
| 6 | **注释层残留** | 🔴 **2026-09-25 复核：原判两处均为假阳性**（两处皆是**显式历史留档**，非过期）⇒ 见正下方「注释层复核」。**真残留 = 3 处**：2 处已随第 1 批清掉，1 处留第 2 批 |

**注释层复核（2026-09-25，死代码第 1 批随手做；**原判错在哪**与**真残留是什么**分开记）**

| 对象 | 原判 | 复核结论 |
|---|---|---|
| `trajectory-ops.ts` 文件头 | "仍列 `logbook/close/archive/health/qa`（代码已删）" | ⛔ **假阳性**：文件头**正确地**写着"旧 `logbook` 面里 close / archive / health / qa **四个动作已删**……其函数**同批删除**" ⇒ 这是**留档**，不是过期 |
| `clock-runtime.ts` 文件头 | "仍提 `wakeSchedulerEnabled` 闸（2026-09-21 已砍）" | ⛔ **假阳性**：原文写"（**原** `wakeSchedulerEnabled` 于 2026-09-21 所有者令砍掉 ⇒ 调用方**不传** `gate`）" ⇒ 同为**留档** |
| `clock-runtime.ts` 硬约束三 | （原判未列） | ✅ **真残留，本批已修**：原文"**现只余** autopilot `autopilotWakeEnabled`（缺省关）**一条**"——而 autopilot 已随 **v1.35.0 整段退场**，全仓 grep `autopilotWakeEnabled` = **零处代码、仅两处历史提及** ⇒ **当前零条闸在用**，已改写为"更正：当前零条闸在用" |
| `trajectory-ops.ts` 第二段注释 | （原判未列） | ✅ **真残留，本批已修**：原文"为什么**只有 6 个**"，而 `TRAJECTORY_ACTIONS` 实测 = **8**（list/show/create/use/rebuild/send-now/send-later/cro-guide），且与**同文件文件头**的"现行 **8 个**"**自相矛盾** ⇒ 已改为"v1.33 收敛时 6 个，其后追加 `send-now`/`cro-guide`" |
| `clock-runtime.ts` 的"回归钉"引用 | （原判未列） | ⏳ **真残留，留第 2 批**：两处以 `autopilot-trajectory.test.ts` 作"实测 / 回归钉"引用，而**该文件全仓已不存在**（`glob **/*autopilot*` 零命中）⇒ 属"**指向已删对象的断言**"；处置取决于 `bodyCountsTick` 的去留（见 §3-8 第 5 行），故**同批不动** |

> 🔵 **教训（判据纪律）**：**"注释里出现了已删对象的名字" ≠ "注释过期"** —— 必须读那句话**是断言现状、还是记录历史**。本条原判只按关键词命中，两边各错一次（假阳 2）。反向的坑也在：**关键词没命中的地方才有真残留**（本批两处真残留均非原判所指）。

### 3-8. 工具面的死代码候选

| # | 对象 | 读数 |
|---|---|---|
| 1 | `msm-ops.ts:MsmEntry`（export interface） | `src/**` 仅自身 8 处、`tests/**` **0 处** ⇒ 无外部消费者（纯类型）<br>🔴 **2026-09-25 复核更正：它出现在**公开签名**里** —— `loadMsmEntries(): MsmEntry[]` 与 `findEntry(): MsmEntry \| null` **都是导出函数** ⇒ 它是**契约类型**、**不是死代码**（"零消费者"只说明**仓内**没人直接写这个名字）。⇒ **本次不动它**；同批动的是第 4 行的 `MsmArgs`（**补导出**，方向相反） |
| 2 | `tools/praxis.ts:PRAXIS_INDEX` | `src/**` 除本文件 2 处外 0；**只被 tests 用** |
| 3 | `tools/trajectory.ts` 的 `sanitizeSessionSummary` / `renameDshSessionOnUse` / `activeInfoFromCreate` / `renameDshSessionForActive` | 包内自用，对外**只被 `session-title.test.ts` 引用** |
| 4 | ⚠️ 形状问题：`msm-ops.ts:MsmArgs` **未导出**，却被 `runMsm`/`runMsmAsync` 的**公开签名**引用 | 外部调用方只能传结构等价字面量（类型不可见 = 契约不完整）<br>✅ **2026-09-25 第 1 批已修**：补 `export`（**零行为变化**，纯类型面） |
| 5 | 🆕 `clock-runtime.ts:ClockOptions.bodyCountsTick`（**公开选项**） | `src/**` 除本文件"定义 + 实现"外**零调用**（唤醒调度器不传它）；`tests/**` 6 处显式传 `true`。**成因可判定**：它存在的唯一理由是 **autopilot 的记账语义**（"无 target 则不计 tick"），而 `autopilot-trajectory.ts` **已随 v1.35.0 整段退场** ⇒ **在产线已是死选项**。⚠️ 属**公开面**（导出接口的选项）⇒ 按 **D84 留待第 2 批单独确认**，本批不动 |
| 6 | 🆕 `seams/bootstrap.ts`：**「Anchored 变体」分支不可达** —— `registerBootstrap` 的 `system-prompt/assemble` 处理器里 `if (SETTINGS.zeroTools)` 的 **else 路径** | 🔴 **不可达（本次实测）**：`SETTINGS` = **模块级 `const`**（`resolveBootstrapSettings()`，**无参、零配置面**，文件头自述"协议固有"），其中 `zeroTools` **硬编码 `true`**，且**全仓无 setter、无处可改** ⇒ 该 `if` **恒真** ⇒ else 分支**永不执行**（其体：`bootstrapTools` ＋ 压缩后追加 `compactionTools` 的窄化 ＋ 缺一降级告警）。<br>⚠️ 属**公开面 / 需确认**档 ⇒ 按 **D84 归第 2 批**，**不自行删除**（先问「谁依赖它」）。<br>🔵 **旁证（本次实测）**：新增的 `tests/seams/bootstrap-register.test.ts` **不覆盖它** —— 那 18 用例断言的是 **`zeroTools` 路径内**的 `missing.length > 0` 降级分支（coverage stderr 实证 `bootstrap: expected compaction tools missing=["todo_write"]`），**与 else 分支是两处** |
| 7 | 🆕 `tools/msm.ts`：**两处 `gate.whitelist` 分支不可达**（skiff「白名单过滤」与「候选加已过滤前缀」） | 🔴 **不可达（本次实测；`tests/msm-tool.test.ts` 钉住可观测契约）**。**三读判据**：① msm.ts 只在 **name 为空**时把 action 传 `'list'`，否则传 `'exec'`；② `skiffMsmGate` **只在 `action === 'list'` 分支返回 `whitelist`**（exec 路只返 `{}` 或 `{reject}`）；③ 而 name 为空的那一路在处理器前段**已提前返回**（且那处 return 用的正是 whitelist）。⇒ 走到这两行时 `gate.whitelist` **恒为 `undefined`** ⇒ 过滤分支与「已过滤」前缀**永不生效**；**语义上也不亏**：skiff 的越权请求已在门控处 `{reject}` 抛错。<br>⚠️ 属**公开面 / 需确认**档 ⇒ 按 **D84 归第 2 批**，**不自行删除**。🔵 **旁证**：断言"白名单内但未注册的名字 ⇒ 走**无前缀**候选"的用例已随第 3 件落档（即该分支不执行的正向证据） |
| 8 | 🆕 `tools/trajectory.ts:advisoryHint` 的**空壳分支**（`!existsSync(mdPath)` ⇒ 提示"目录存在但没有 SESSION.md"） | 🔴 **不可达（本次实测；`tests/trajectory-tool.test.ts` 钉住实际失败点）**。**判据**：① `advisoryHint` **全仓只有一个调用点**（`use` 分支内），且它排在 `useSession(...)` **之后**；② `useSession` 对**同一个 mdPath** 已经做过 `existsSync` 校验并**会抛**（`has no SESSION.md — nothing to load.`）；③ 两次定位同 root 同 key（`findSession` 同参数）⇒ **同一个 entry** ⇒ 走到 `advisoryHint` 时文件**必然存在**。<br>⇒ 该分支**除"两步之间的竞态"外永不执行**；同函数末尾的 `catch { return null }`（`statSync` 抛）同理属竞态档。⚠️ **可读性上的意义**：它在 `use` 的**提示文案**里承诺了一条**永远不会出现的话**。⚠️ 属**语义档**（删掉它就失去竞态兜底）⇒ 按 **D84 归第 2 批**，**不自行删除**。🔵 **钉法**：测试断言"空壳目录 ⇒ 错误来自 `useSession`（含 `has no SESSION.md`），**不含** `空壳`" ⇒ 把"哪一步失败"变成机械事实，而不是靠读代码相信 |

### 3-9. 🔴 测试面缺口（**第 ⑤ 项的输入**）

✅ **2026-09-25 进展（最大的一件已补）**：**`src/seams/context.ts` 的 `registerContext` 此前零执行** —— 模块实测 **43.85%**、未覆盖行 = **148–285**，即该函数**整个从未被执行**，而它正是「**会话连续性**」的机制本体（播种 ACC 身份 ＋ 重启恢复激活会话 ＋ pre-step 兜底）。
⇒ 新增 `tests/seams/context-register.test.ts`（**16 用例**，按 L2 装配测试放 `tests/seams/`）：接线开关 ／ 播种幂等 ／ skiff 旁路 ／ **重启恢复链（正负控成对）** ／ **「context-only 必须 next() 委托」回归钉 ＋ 消息顺序**。提交 **`50ad1f3`**；test **1699 → 1715**。

✅ **2026-09-25 进展（第 2 件已补）**：**`registerBootstrap` 的四条缝处理器体此前无任何测试调用** —— grep 实证**全仓只有 `src/index.ts` 调它**，而 `tests/bootstrap.test.ts` 只测纯函数（设置解析／晋升 tracker）⇒ 四条处理器内的**分支逻辑从未被执行**。
⇒ 新增 `tests/seams/bootstrap-register.test.ts`（**18 用例**，L2 装配测试同放 `tests/seams/`）：**接线**（4 条缝各 1 个 handler）｜**`system-prompt/assemble` 首锚「目录窄化」**（`boundary<0` ⇒ **0 工具**；非 CCC／恒晋升／已晋升 ⇒ 完整目录；`boundary≥0` ⇒ 窄化到 `compactionTools`；**缺一 ⇒ 降级完整目录**；`tools` 非数组 ⇒ 原样）｜**`agent/pre-step` 首锚「剥离注入上下文」**（剥 `skill-catalog`／`agent-instructions`；无抑制来源 ⇒ **`toBe` 身份断言**返回同一对象；已晋升／非 CCC／`kind=reject`／`messages` 非数组 ⇒ 原样）｜**`agent/inbox/inserted` 锚定轮注入**（**逆序 prepend**；已有 `user/message` 历史 ⇒ 不重锚；handyman／skiff ⇒ 不锚定；`ACC_MESSAGE_KIND` ⇒ 不递归）。提交 **`ae195a7`**；test **1715 → 1733**（+1 文件 +18 用例）。
🔵 **"非空洞"的旁证（就写在 coverage 的 stderr 里，可直接引用）**：`bootstrap: expected compaction tools missing=["todo_write"] — bootstrap disabled, full catalog exposed` ⇒ **降级分支真被执行**；`bootstrap: anchor turns injected: 2 条` ⇒ **注入路径真被执行**，并顺带证实 `DEFAULT_ANCHOR_MESSAGES.length === 2`。⚠️ **诚实边界**：本件**不覆盖** `if (SETTINGS.zeroTools)` 的 else 分支（它在产线不可达，见 **§3-8 第 6 行**）。
🔵 **本件新得的判据**：🔴 **不要凭猜写常量字面量** —— 本件原先把 `ACC_MESSAGE_KIND` 猜成 `'serenity-bootstrap-anchor'`，**grep 实测 = `'plugin:dsh-serenity-hooks'`** ⇒ 已改为 **import 真常量**（不硬编码）。**同族判据**：凡"我以为是这个值"的断言，**先 grep 真值再写**。

✅ **2026-09-25 进展（第 3 件已补）**：**`src/tools/msm.ts` 的整个 `execute` 处理器 ＋ 四个私有助手此前零执行**（模块实测 **41.42%**；未覆盖面 = `agentSessionId` / `renderText` / `buildMsmIndex` / `suggestMsm` ＋ `execute` 全体）—— 即"**这个工具从没被真正跑过**"。⚠️ 它恰恰是**每轮都在用的那个工具**（`msm(...)`），故这条缺口的性质 = **最高频路径零行为证据**。
⇒ 新增 `tests/msm-tool.test.ts`（**23 用例**；L3 工具面测法 = **真实 CCC 夹具 ＋ 真注册表文件 ＋ 真 `skiffMsmGate`**，**只桩掉"跑子进程"那一步**）：工具面 ／ render 两分支 ／ 根解析失败 ／ 目录（空注册表／分组降序／无 skill 归位／空白名）／ 命中载荷（缺省 `args:[]`／透传／`inspect ⇒ --schema`／trim）／ 候选（name 与 description 双通道命中／`-` 回落／全无匹配回落目录／**limit=5**／flags 展示）／ **Skiff 门控五态**（白名单 list／内放行／外拒绝且不回显名字／未注册会话拒绝／白名单内未注册 ⇒ 无前缀候选）。提交 **`e834e17`**；test **1733 → 1756**（+1 文件 +23 用例）；build 与 pack-check **与改前逐字相同**（未动 `src`）。
🔵 **本件顺带产出**：**第二条不可达分支**（msm.ts 的两处 `gate.whitelist`）⇒ 已登记 **§3-8 第 7 行**，并在测试里钉住它的**可观测契约**（不是靠"我读了源码"）。

✅ **2026-09-25 进展（第 4 件已补）**：**`src/seams/env.ts` 的 `registerEnv`（整个函数）此前零执行**（模块实测 **70.21%**；未覆盖面 = 贡献者对象体 ＋ `ctx.shellEnv.register(…)`）—— 即"这条 shell-env 缝**从没被装配过**"。⚠️ 与**纯函数** `resolveSerenityEnv` 分开：后者**早有测试**（`acc-extras.test.ts`），故本件**不是重复测** —— 它测的是**注册动作 ＋ 贡献者契约 ＋ resolve 接线**（cwd 取值与 `process.cwd()` 回落），那三样此前零执行。
⇒ 新增 `tests/seams/env.test.ts`（**11 用例**）：装配一次且形态正确（缝名 ＋ 三条 `DSH_SERENITY_*` ＋ 各带 description）／cwd 在根内 · 子目录上溯 · 非 CCC ⇒ **空对象**／**无 agent ⇒ 回落 `process.cwd()`（用 `vi.spyOn` 控住，不依赖"本机仓库恰好位于某 CCC 内"）**／空 cwd 串两态／**🔴「CCC 名两套定义」的机械钉（见 §3-3c）**。提交 **`a5815c6`**；test **1756 → 1767**（+1 文件 +11 用例）；build 与 pack-check **与改前逐字相同**（未动 `src`）。
🔵 **本件顺带产出**：**「CCC 名」同名两义**（§3-3c）—— 夹具刻意让"目录名 ≠ `.serenity` 首行"（且带 `expect(basename(dir)).not.toBe(CCC_NAME)` 自控）⇒ 测试**能区分**两套定义；**若哪天统一了，本组会红**（那正是要的信号）。

✅ **2026-09-25 进展（第 5 件已补）**：**`src/tools/trajectory.ts` 的 `execute` 分派面从未被调用** —— 模块实测 **57.66%**，`fstat-no` 逐条命中 6 处：`agentScope` / `agentDshSession` / `currentBoundDirName` / `renderText`（＋ `output.render`）/ `renderWakeEntry` / `advisoryHint`。既有 `trajectory-ops.test.ts`（纯函数）与 `session-title.test.ts`（重命名门面）**都不碰 `execute`** ⇒ 典型"**被提到、但从没被执行**"。
⇒ 新增 `tests/trajectory-tool.test.ts`（**32 用例**；**真实现 ＋ 真夹具**）：工具面/render ／ 根解析失败 ／ list（含空库两态）／ show ／ create（summary 必填·dry-run 豁免·issue 豁免·真建目录＋写 `create` 审计绑定）／ **use**（summary 必填·未找到·happy 写 `activate` 绑定·**G1 切换守卫（拒 / `--force` 放行 + `action=switch` + note）**·重复 use 仍 `activate`·无 append ⇒ 不写绑定·**悬空绑定剪枝两态**）／ **重命名门面两态**（`sessionTitle` 在 ⇒ 收到 `S900-<日期>-<概括>`；不在 ⇒ 不抛只告警）／ **advisory 陈旧与新鲜两态** ＋ **空壳的真实失败点**／ send-later（三守卫·回执渲染·长消息截断 `>120`）／ send-now 守卫 ／ rebuild 两条守卫 ／ cro-guide ／ 未知动作。
🔴 **打桩只两处，且理由写进文件头**：① `session-cleanup.js` 的 `hasSessionLogById`（**宿主会话日志面在测试里不可能为真** ⇒ 打成可控开关；不桩它则"剪枝"分支恒剪掉刚写的绑定 ⇒ 断言变成**环境耦合的假绿**）② `setBindingStore(null)`（把绑定钉回 CCC 内 `.bindings.json`，与 `trajectory-bound.test.ts` 同款 ⇒ 全程密闭）。
提交 **`58d58b2`**；test **1767 → 1799**（+1 文件 +32 用例）；build 与 pack-check **与改前逐字相同**（未动 `src`）。
🔵 **本件顺带产出**：**第三条不可达分支**（`advisoryHint` 空壳档，§3-8 第 8 行）＋ **一条夹具纪律**：`exec` 夹具**必须带 `cwd`** —— 缺它会让 `agentCwdFor` 回落 `process.cwd()`，于是工具去**跑测试的那个真 CCC 根**里找夹具会话（本轮实测报 `Session not found: S900`，**症状与"逻辑错"不可区分**）。

🔵 **挑靶方法（可复用，本条即 ⑤ 的工作法）**：**先看 coverage 表的"未覆盖行号"** —— 它直接指出"哪个函数从没跑过"，**别凭感觉挑**；写测前**读源码确认替身安全**（本次核了 `registerEntrySkillSection` / `registerTrajectorySkillSection` **均内部 try/catch**、且后者无绑定即早返回 ⇒ 缺 `agent.ctx` **不抛**，故 `agent.inject` 的断言才可靠）。

✅ **2026-09-25 进展（第 6 件已补：语义深度 · 把 §3-9 #10 的接线钉配上语义孪生）**：靶 = `gateway.test.ts` 的 **v1.22.3 崩溃防护**那条链（线上真实事故：外部连接中断 ⇒ unhandled `'error'` ⇒ **整个 dsh web 进程崩**），而它此前**只有源码字符串钉**（`readFileSync(src)` ＋ `toMatch(/req\.on\('error'/)`）。
⇒ 新增 **`v1.22.3 语义化` 两条用例**（同文件，**真 listener ＋ 真 socket RST ＋ 真上游**）：① 反代路径 ② WS upgrade 路径，各自断言 **中断之后进程与面都还活着**（能再拿到一次正常反代响应）。test **1799 → 1801**；`src/**` 零改动 ⇒ build（`lib/client.js` **201986 B**）与 pack-check（**118 文件**）**与改前逐字相同**；typecheck / coverage **exit 0**。
🔴 **本件产出一条发现（真 socket 实测，未写成断言 —— 不把"当前缺陷"固化成"期望值"）**：
   · **① 反代路径**：客户端 RST 之后**上游那条请求并未被销毁**（5s 内仍悬挂）。**机制已定位**：网关 `proxy()` 走 `req.pipe(target)` ⇒ 请求**已 complete**，而 Node 只对"**未读完**的请求"在 socket 出错时补发 `req`/`res` 的 `error`（对照实验：处理器**不读**请求 ⇒ `req:error` 触发；**pipe 读完** ⇒ **一个事件都不触发**）⇒ **`req.on('error')` / `res.on('error')` 这两条在这条最常见路径上不会触发**（真正接住 socket 错误的是 Node 自己的 http server）。
   · **② WS upgrade 路径**：RST 之后上游 usock **1.5s 内未关闭**；**原因未定位**（复刻探针本身不成立 = **读数器失败** ⇒ 不作判据、不下结论）。
   · **性质**：**不是死代码，是"防护覆盖面不足 + 上游悬挂"**（行为缺口）⇒ 与 §3-8 的四条不可达分支**不同档**；**待 owner 裁**（改判据/改实现/维持现状）。
   · **诚实边界**：本件证明的是**崩溃回归**这一半（RST 之后进程不崩、面可用）；"对端是否被销毁"**只登记读数、不做断言**。
⚠️ **本项剩余靶（同法挑）**：**只剩「客户端半零行为测试」（下表 #1~#3）** —— 它是**结构性**缺口（无 jsdom ＋ `src/client/**` 被排除在覆盖率门外），不是"某个函数没跑"，**处置要先有裁决**（要不要为它引入 DOM 测试环境）。✅ **`seams/bootstrap.ts` 已攻（第 2 件）**——其残余未覆盖行 = **不可达的 else 分支**（§3-8 第 6 行）⇒ **不再当靶**。✅ **`tools/msm.ts` 已攻（第 3 件）**——同理（`gate.whitelist` 两处，§3-8 第 7 行）。✅ **`seams/env.ts` 已攻（第 4 件）**——`registerEnv` 已全覆盖。✅ **`tools/trajectory.ts` 已攻（第 5 件）**——未覆盖的 6 个函数全部触达；**残余 = `advisoryHint` 的竞态档**（§3-8 第 8 行）⇒ **亦不再当靶**。<br>🔵 **⇒ 服务端半（`src/**`，覆盖率门禁内的部分）已无"零执行函数"级缺口**；后续 ⑤ 的增量应转向**语义深度**（行为断言密度 / 边界与错误路径）

🔴 **2026-09-25 校正（第 8 件的实测）**：上面那句只对**当时那五个靶**成立 —— 同批复查覆盖率报告后发现**更大的缺口根本不在那五个靶里**（详见下方「第 8 件」）。
✅ **2026-09-25 进展（第 8 件已补：HTTP 对外面 —— 补的是**最薄的一块**）**：**`src/api.ts` 的 `registerStatusApi`（9 条 `/serenity/*` 路由，约 530 行）此前从未被执行**，连同 6 个私有助手（`readBody`／`sendJson`／`senderIsWebUi`／`requireWebUi`／`resolveWorkspace`／`requireCcc`）**全是零执行**。🔴 **为什么覆盖门禁没拦住**：门禁只要求"**测试源码里 import 过它**"（= 本节第 5 行的缺口形态）—— `accounts-api.test.ts` 提过 `api.ts` ⇒ 判"已覆盖"，而**77% 的语句从未运行**（本件起点实测：**23.55% 语句**）。
⇒ 新增 **`tests/api-status-api.test.ts`（9 用例；真 listener ＋ 真 HTTP 往返 ＋ 真 CCC 夹具）**：**接线自证**（9 条路由真注册 ＋ 全在 `/serenity/` 前缀 ＋ 无重复）｜handymen GET/405｜status GET（CCC 内 `root=<ccc>`／CCC 外 `root: null` 的**降级不是报错**）｜🔴 **safe-mode 正负成对**（无 WebUI 头 ⇒ 403 **且标记文件绝不出现**；带头 ⇒ 200 **且 `.serenity-safe-on` 真的落盘**，开关双向都验）｜image-upload（403／**落盘实证**／类型白名单 400）｜file-upload（**可执行扩展名 400 ＋ 盘上无文件**，并配正控）｜未知路径不接管。
**读数（同一 743 语句分母，可对比）**：`api.ts` **23.55% → 51.14%**（175 → 380 条语句，**+205**）；全仓语句 **92.07% → 92.86%**。test **1807 → 1816**（+1 文件 +9 用例）。
🆕 🔴 **本件顺带测到一条现状缺陷（已登记待裁）**：超 64KB 的 POST 体 ⇒ `readBody` `reject` **并 `req.destroy()`** ⇒ socket 被销毁 ⇒ handler 随后那句 `sendJson(res, 400, {error:'body too large'})` **写不出去** ⇒ 客户端看到的是 **ECONNRESET**，而**不是**预期的 400 JSON ⇒ **该错误分支在实践里不可达**。（安全性质仍成立：硬断**确实拦住了动作**，已用负控钉住。）处置 = **(a)** 改实现（先排空再回 400）／**(b)** 改判据（承认"硬断"是刻意的 DoS 防护）⇒ **待 owner 一句话**。
🔵 **顺带实证了 §3-1 那处登记残留（裸 `ctx.get`）的失败模式差异**：夹具**不提供** `ctx.get` 时，status 端点因那处裸调用直接抛 ⇒ 被 catch 吞成 **400（整端点不可用）**；而走收口层（`hostService`，异常吞掉返回 undefined）本应**降级为 `codeRuntime: null`**。⇒ **"唯一读取入口"欠账不只是整洁问题，它决定"降级"还是"全挂"。**

✅ **2026-09-25 进展（第 9 件：把这块 HTTP 面补齐 —— 其余 5 条路由）**：第 8 件只覆盖了 `status` ／ `handymen` ／ `image-upload` ／ `file-upload`，本轮补 **`config` ／ `cccs` ／ `public-ask` ／ `weixin` ／ `session-cleanup`**（同文件 +6 用例）。
🔴 **两条纪律（写测试时就要定）**：① **写操作只落临时全局配置** —— `/serenity/config` 的 PUT 与 public-ask 的 key 轮换**都会写全局配置**（`globalConfigPath()` 认 `SERENITY_HOOKS_CONFIG`）⇒ 夹具把它指到临时文件，**绝不碰真机配置**；② **破坏性动作不测** —— `session-cleanup` 只验 **GET 的 dryRun 预览**（POST 会**真删**会话，本轮不动）。
关键断言：PUT 配置 ⇒ **文件真落盘**（读到 `tester`）**且明文口令既不上 wire 也不落盘**（回包不含明文、盘上是 hash）｜public-ask **rotate 真换 key**（新 ≠ 旧，且再 GET 拿到的是新 key ⇒ 不是内存态幻觉）＋ 非法 action ⇒ 400｜weixin 三道门（无头 403 ／ 缺 `ccc` ⇒ `missing ccc param` ／ 非 CCC ⇒ `no CCC found from:`）＋ **脱敏不变量**（body 里不出现 `token`）｜cccs ⇒ 数组 ＋ POST 405｜cleanup ⇒ `dryRun: true` 且 `candidates.length === count`。
**读数（同一 743 语句分母）**：`api.ts` **51.14% → 70.12%**（380 → 521 条，**+141**）｜全仓语句 **92.86% → 93.43%**。test **1816 → 1822**。
⏭️ **`api.ts` 剩余 ≈27%**：主要是 **weixin 的四个 POST 动作**（login-start ／ remove-account ／ save-routes ／ set-enabled）；**session-cleanup 的 POST 已补**（见第 10 件）。

✅ **2026-09-25 进展（第 10 件：**破坏性端点** —— `session-cleanup` 的 POST 真删）**：先补**夹具**再测（`DSH_HOME` 隔离到临时目录；`sessionsRootDir()` 认它 ⇒ 删的只是夹具自造的 `<tmp>/sessions/<project>/<id>/session.jsonl`）。**三条断言按重要性**：
① 🔴 **live 保护＝该端点的安全底线** —— 宿主里正在跑的会话**即使超龄也不许删**（夹具造 `live-1`（60 天）＋ 假 ctx 报 `live` ⇒ GET 候选里**没有它**、POST 后**目录仍在**）；② 阈值语义（超龄删／未超龄留）；③ **非会话目录不动**（无 `session*.jsonl` 的目录不进候选）。
🔴 **无 WebUI 头 ⇒ 403 且盘上什么都没变**（同款"守卫的实质证据是动作没发生"）。
🔵 **夹具自证**：所有 `makeSession()` 造的路径必须先断言 `startsWith(process.env.DSH_HOME!)` ⇒ 防"隔离失效、删到真机会话"。
**读数**：`api.ts` **70.12% → 72.81%**（521 → 541 条）｜**累计三轮 23.55% → 72.81%（+366）**｜全仓 **93.43% → 93.51%**｜test **1822 → 1826**。，或按 §5.1「更要有语义断言」处理下表 #10 的接线钉。<br>⚠️ **上列百分比是"某次 coverage 跑的实测读数"**（锚定 2026-09-25 ⑤ 开工时那一跑），**不是"当前值"**（每次补测都会变）⇒ 引用时须标时点（§4.2-㉞ 同族）。

| # | 缺口 | 证据 / 读数 |
|---|---|---|
| 1 | **客户端半零行为测试** | 8 个 `.tsx` ＋ 4 个 `.css` **无任何行为/渲染测试**；根因可判定 = 两份 vitest 配置 `environment: 'node'` 且 `devDependencies` **无 jsdom** ⇒ 客户端半在测试面上**不可执行** |
| 2 | **客户端半不在覆盖率门禁内** | `hooks/vitest.config.ts` 的 `coverage.exclude` 含 `src/client/**`（阈值 statements 60 / branches 55 / functions 55 / lines 60） |
| 3 | **槽位装配无门禁看护** | `client/index.ts` 的 3 次 `slots.register` ＋ `configForms.whileServed` 无测试；且 `coverage-gate.test.ts` 的过滤条件 `.filter(rel => !rel.includes('client/'))` 把整个 `client/` 排除 |
| 4 | ~~**白名单残留项**：`coverage-gate` 的 `INDIRECT_COVERED` 含 `autopilot-trajectory.ts`~~ ⇒ 🔴 **2026-09-25 复核：原判已陈旧、本行销账** | **实测** `INDIRECT_COVERED` = **12 项**（`gateway-auth` / `gateway-proxy` / `cc-fs` / `git` / `kit` / `msm` / `handyman` / `localstore` / `trajectory` / `cce` / `eap` / `neat`），**不含** `autopilot-trajectory.ts`⇒ 该残留已在某轮被清掉，**无需再动**（判据 = 读 `coverage-gate.ts` 的常量表，不是读本行） |
| 5 | 🔴 **缺口形态 = "未被真正执行"，不是"未被提及"** | `coverage-gate.test.ts` 用正则 `['"][^'"]*\/mod\.js['"]` 在**测试源码文本**里匹配 import 字符串 ⇒ **"提到即算覆盖"**。本仓**不存在门禁意义上裸奔的模块**（这一区别决定第 ⑤ 项该怎么补） |
| 6 | **只有 3 个测试走生产入口** | `register` / `config-volatile` / `skiff-startup-retry` 才 `import { apply } from '../src/index.ts'` |
| 7 | 🔴 **fake ctx 的已知盲区（有真实先例）** | 真宿主 cordis 的 `Context` 是 **Proxy**：访问**未在 `inject` 声明**的服务名会**抛错**，而普通对象 ctx 只返回 `undefined` ⇒ v1.31.3 handyman foreground **真机报** `cannot get property "subagents" without inject`，而"**全部 fake ctx 单测都是绿的**"（证据 = 同仓 `host/cordis-access.test.ts` 注释）<br>🆕 ✅ **2026-09-25 补一条机械守卫（在调用点也有保护力）**：新增 **`tests/host/lazy-service-access.test.ts`** —— **lazy 服务不得被直接属性读**（名单**从 `HOST_SERVICES` 派生、不手抄**；🔴 **先剥注释与字符串字面量**再匹配，防"docstring 里的 `ctx.subagents`"造出假阳性 —— CCC 侧 `hasCliEntry()` 就踩过同款坑）。含**三条正控**：① 真实属性读能被抓 ② 注释/串里的不算 ③ **真实文件双面控**（`tools/handyman.ts` 原文含 `ctx.subagents`、剥后必须为空）＋ **扫描域自证**（文件数 > 50 且被排除的 `access.ts` 确实在域内）⇒ 防"扫了零个文件 ⇒ 永远绿" |
| 8 | **唯一的真宿主访问层测试可整体 skip** | `host/cordis-access.test.ts` 用宿主真实 cordis（peer-only，本仓不安装）；"一个都找不到时（CI runner 未装 DSH 宿主）**整体 skip**" |
| 9 | ~~**行为证据指向不存在的落点**~~ ⇒ 🔴 **2026-09-25 复核：表述失真（结论改了）** | `ui-probe/` **存在**，只是**不在本插件仓** —— 它在 **CCC（宁静号仓）**：`AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/ui-probe/`（`measure.mjs`（测量唯一真相源）／`probe.mjs`／`verify.mjs`／`mock-probe.mjs`／`chain.mjs`／`explore.mjs`／`launch-cdp.sh` ＋ `artifacts/` 真机读数）。⇒ **真问题 = 指针不可解析**（注释用**仓内相对路径**写法 ⇒ 读的人在本仓找不到，会被误读成"指向已删目录"）——**已修**：`client-popover-clip-guard.test.ts` 注释改为写明**仓分离**与真实位置 |
| 10 | 行为测试内夹源码文本断言 | `gateway` L465-499 ／ `trajectory-bound` L307/319/475 ／ `trajectory-skills` L300-328（读 `src/**` 文本）⇒ 属于"接线钉"，不构成行为证据<br>🆕 **2026-09-25：`gateway` 那组已配语义孪生** —— 新增 **v1.22.3 语义化**（真 listener ＋ 真 socket 硬断 RST ＋ 真上游）：**进程不崩 ＋ 中断后网关仍可用**。🔴 **顺带产出一条发现**（见下方"第 6 件"）⇒ `gateway` 的字符串钉**保留**（互补：钉管"实现还在"，语义组管"崩没崩"）；其余三处**仍未语义化** |

#### 3-9a 🔴 台账复核（2026-09-25 · 逐行重新取证）

🔴 **为什么值得单独跑一遍**：**本表是 ⑤ 的挑靶输入** —— 输入失真会直接变成**白干的一轮**（先例：一条已撤销的观察项被当成在办项**连续携带五轮**）。⇒ **把本表当输入之前，先重读对应代码，而不是信本表的字面。**

| # | 原判 | 复核结论（2026-09-25 实测） | 判据（可重跑） |
|---|---|---|---|
| 1 | 客户端半零行为测试 | ✅ **仍成立** | `hooks/vitest.config.ts` `environment: 'node'`；`package.json` devDeps **无 jsdom / happy-dom** |
| 2 | 客户端半不在覆盖率门禁内 | ✅ **仍成立** | 同文件 `coverage.exclude` 含 **`src/client/**`**；阈值 60/55/55/60 |
| 3 | 槽位装配无门禁看护 | ✅ **仍成立** | `coverage-gate.test.ts` 的 `.filter((rel) => !rel.includes('client/'))` —— **一次性排除整个 `client/`** |
| 4 | 白名单残留项 | 🔴 **陈旧 ⇒ 已销账** | `INDIRECT_COVERED` 实测 **12 项**，**不含** `autopilot-trajectory.ts` |
| 5 | 缺口形态 = "未被真正执行" | ✅ **仍成立** | 该门禁用正则 `['"][^'"]*\/mod\.js['"]` 在**测试源码文本**里匹配 import ⇒ **提到即算覆盖** |
| 6 | 只有 3 个测试走生产入口 | ✅ **仍成立（实测恰为 3）** | grep `from '../src/index.ts'` → `register` ／ `config-volatile` ／ `skiff-startup-retry` |
| 7 | fake ctx 的已知盲区 | 🟡 **部分已闭（2026-09-25 又加一层）** | ① `tests/host/access.test.ts` 早有 **cordis-like Proxy**（未声明 inject 的服务名**直接属性读抛错**）；② 🆕 **新增 `tests/host/lazy-service-access.test.ts`** 把"**lazy 服务不得直接属性读**"变成机械守卫 ⇒ 保护力从"access 层可见"扩到"**调用点可见**"；⚠️ **批量套件的 ctx 仍是普通对象**（未迁移，非阻塞） |
| 8 | 真宿主访问层测试可整体 skip | 🟡 **设计如此，不是缺口** | `cordis-access.test.ts` 末尾自检：`if (process.env.CI) return`（CI 允许跳过）／**本机必须解析到宿主 cordis，否则明确失败**；🔵 本机实测**未 skip（6 用例真跑）** |
| 9 | 行为证据指向不存在的落点 | 🔴 **表述失真 ⇒ 已修** | `ui-probe/` **存在**，在 **CCC** 而非本仓（详见第 9 行更正 ＋ 测试注释） |
| 10 | 行为测试内夹源码文本断言 | 🟡 **部分已闭** | `gateway` 那组**已配语义孪生**（第 6 件）；`trajectory-bound` 两处**其语义孪生已在同文件内**（"走 `appendBound` 生产路径"的 F1 正控组）；`trajectory-skills` 两处是**缺席检查**（SEP 符号/散文在 `src/**` 命中 0）——**"缺席"无法行为化**，保留字符串形态即可 |

🔵 **本次复核净结果**：**销账 1**（#4）／**更正表述 1**（#9）／**部分已闭 3**（#7、#10，＋第 6 件当日的 gateway）／**降级为"设计如此" 1**（#8）。
⇒ **真正还开着的 = #1~#3（客户端半，**待裁决**：要不要引入 DOM 测试环境）＋ #5/#6（**形态事实**，不是待办）＋ #7 的"批量套件 ctx 未迁移"（可选增强，非阻塞）。**
🆕 🔴 **同日补充证据（第 8 件）：第 5 行的"提到即算覆盖"不是理论风险，它已经真的藏住了一个模块** —— `src/api.ts`（**整个 HTTP 对外面**）在门禁眼里"已覆盖"，实测却是 **23.55% 语句／`registerStatusApi` 从未执行**。⇒ **下次再想用"门禁绿"当"这块有测试"的证据之前，先看覆盖率读数**（本条即该判据的实证）。

### 2.8 L5 · 开发面：容器集成测试台 `bench/`（＋ CCC 侧驱动）

| 组件 | 它做什么 | 关键实现手段 | 缺口 |
|---|---|---|---|
| `bench/Dockerfile` | 常驻干净镜像：**真宿主 ＋ 本插件** | `node:22-bookworm-slim`；`npm i -g @deepseek-ai/dsh@${DSH_VERSION}`（ARG 默认 **0.1.7-rc.1**）＋ `pnpm`；apt 装 `zstd`（V5 读数器）/`tini`；`ENV DSH_HOME=/root/.dsh`；`mkdir /logs /ccc && touch /ccc/.serenity`；`ENTRYPOINT tini -- entrypoint.sh`；`EXPOSE 3080` | **无任何模型凭据注入**；不发布端口；插件安装刻意放在启动期（同一镜像三用） |
| 🆕 `bench/profile-patch.yml` | **把容器的默认模型指向"我们真有凭据的那个"**（键 A 路由 ＋ 键 B 默认模型，§2.9 第 4 行） | 两段 `- id:` 条目（`llm-pi-ai` 路由 `minimax-bench` ＋ `agent-default-model ⇒ minimax-bench/MiniMax-M3`）；**刻意不含任何密钥** —— 路由只写 `apiKeyEnv: MINIMAX_BENCH_API_KEY` | ⚠️ **patch 语义 = 按 id 整体替换（不深合并）** ⇒ 每条要写全字段；baseURL 形状抄自本机真实 patch（**本机那一份用的是内联 `apiKey`** ⇒ 容器里刻意改用 `apiKeyEnv`） |
| `bench/entrypoint.sh` | 落 profile patch → 装插件 → 起宿主 → 保活 | 落（步 0c，**起宿主之前**）：把 `$PROFILE_PATCH`（= 挂进来的 `/ccc/profile-patch.yml`）`cp` 到 `/root/.dsh/profiles/web/cordis.patch.yml`，并 `sha256sum` 落 `/logs/profile-patch.sha256`（**V9d 读数源**）｜装：`dsh plugin --profile web add "link:$PLUGIN_LINK"`（优先，需目录存在）／否则 `add "$PLUGIN_SPEC" --registry "$NPM_REGISTRY"`（可为容器内 `.tgz`）｜起：先 `: > /logs/dsh-web.log` 清结果文件，再 `nohup dsh web > /logs/dsh-web.log 2>&1 < /dev/null &`｜保活 `sleep infinity`；**单步失败永不 exit** | 🔴 **本文件不碰密钥值** —— patch 里只有 `apiKeyEnv: MINIMAX_BENCH_API_KEY`（**一个名字**），真值由 `docker run -e` 在**运行期**注入（约束文档 §5.4-5）；patch 落地依赖 `$PROFILE_PATCH` 由 `up` 传入（未传 ⇒ 只记一行日志、默认模型仍是镜像内的） |
| `bench/verify.sh` | 容器内**只读**验收 **19 条** ＋ 落 `/logs/verify.json` | grep / curl / sha256 / `zstd -dc`（逐条见下） | V0 依赖 `vpush`；V5/V5b/V7b/**V9 家族** 依赖 `turn` |
| `bench/v8-client-check.mjs` | V8 客户端交付层探针 | 读 profile 里的 `lib/client.js` ＋ `package.json#dsh.client`，再 `fetch http://127.0.0.1:3080/` | **非真浏览器证据**（作者自述边界） |
| CCC 侧驱动 `bench-docker`（MSM） | 远端 Docker 全生命周期 | `setsid -w ssh` ＋ `SSH_ASKPASS`；后台脱离 ＋ `*.done`/`*.code` 标记轮询；base64 分块过桥 ＋ sha256 自证；子命令 `probe/sync/build/up/wait/logs/verify/**secretcheck**/vpush/sh/clogs/turn/down/list` | 🔴 **`cmdUp` 已改**：推 patch（`PROFILE_PATCH_REMOTE` → 挂 `/ccc/profile-patch.yml:ro`）＋ `-e PROFILE_PATCH` ＋ **裸 `-e MINIMAX_BENCH_API_KEY`**（docker 语义：不给值 ⇒ 从 CLI 环境取）；🔴 **密钥只走 launch 环境前缀，不写 payload 文件**（旧写法会把密钥**留在远端盘上**）＋ payload 首行**正控**断言该变量非空。⚠️ 仍存：`cmdTurn` 请求体**不带 model**（宿主不从请求读模型） |

**容器内生命周期与落点**：步 0 `dsh --version` → `/logs/host-version.txt`（V1 读数源）｜步 0c 落 profile patch → `/logs/profile-patch.sha256`（**V9d 读数源**）｜步 1 装插件 → `/logs/plugin-install.log`（V2b 读数源）｜步 2 起宿主 → `/logs/dsh-web.log` ＋ `/logs/dsh-web.pid`｜步 3 `sleep infinity`。
**路径**：`DSH_HOME=/root/.dsh` ⇒ profile = `/root/.dsh/profiles/web/`（**宿主设置文档 = `/root/.dsh/profiles/web/cordis.patch.yml`**）；会话日志 = `/root/.dsh/sessions/**/session.v*.jsonl.zstd`；CCC 根 = `/ccc`（含 `.serenity`）。

**判据清单（V0~V9 共 19 条）**

| 判据 | 断言什么 | 怎么读 | 前置 |
|---|---|---|---|
| **V0** | 容器内 `verify.sh` = 本地 `vpush` 推入的那份 | `sha256sum` vs `.sha256` 文件 | **必须先 `vpush`** |
| V1 | 宿主版本 = `$DSH_VERSION` | `/logs/host-version.txt` | 容器已起 |
| V2 / V2b | 插件进了 profile ／ 安装无报错 | `ls -d .../@shgroup/*` ／ `plugin-install.log` 无 error 命中 | 安装已跑 |
| V3 / V3b | 启动无「跳过/不兼容」／ 我方日志前缀在场 | `dsh-web.log` grep | 宿主已起 |
| V4 | 插件自报版本（状态端点） | `curl /serenity/status` → `.accVersion` | 宿主已起 |
| **V5** / V5b | **身份播种真进了会话**（ACC 横幅）／宿主真创建过 agent | `zstd -dc sessions/**.jsonl.zstd \| grep 横幅` ／ `bootstrap: anchor turns injected` | **必须先 `turn`** ＋ zstd CLI |
| V6 / V6b / V6c | 设置面板装配无报错 ／ 契约层无 `host contract BROKEN` ／ 两条 settings 依赖功能未被静默跳过 | `dsh-web.log` grep | 宿主已起 |
| V7 / V7b | 我方缝在运行期真被调用 ／ 首个真实轮走到 bootstrap 缝 | `dsh-web.log` grep | V7b **必须先 `turn`** |
| V8 | 客户端 bundle 交付 ＋ 槽位注册在场 | `node v8-client-check.mjs` | 宿主已起；探针已 `vpush` |
| 🆕 **V9** | **真实轮次正常收束**（`"turn/end" … "kind":"completed"`） | `zstd -dc sessions/**.jsonl.zstd` ＋ grep | **必须先 `turn`** ＋ zstd CLI |
| 🆕 **V9b** | 该轮**用的就是我们指定的路由/模型**（`"provider":"minimax-bench"`） | 同上 | 同上 |
| 🆕 **V9c** | 会话日志里**零**凭据错误（`MISSING_CREDENTIAL` 命中 = 0） | 同上 | 同上 |
| 🆕 **V9d** | profile patch **真落地**（`/logs/profile-patch.sha256` 在 ＋ patch 里路由名命中 > 0） | `cat` sha ＋ grep 路由名 | `up` 时传了 `PROFILE_PATCH` |

> 🔵 **V9 家族为什么必须新增（判据纪律）**：**"缝被走到" ≠ "功能可用"** —— V5/V7b 在**没有任何模型凭据**的容器里**照样全绿**，而那时**每条真实轮次都以 `MISSING_CREDENTIAL` 结束** ⇒ 旧判据集**结构性回答不了** owner 的问题（"装完能不能真的用"）。V9 家族把三件事拆成三档（**收束** / **模型身份** / **零凭据错误**）＋ V9d 补**装配面**旁证。EXPECT 可用 `EXPECT_PROVIDER` / `EXPECT_MODEL` 覆盖（默认 `minimax-bench` / `MiniMax-M3`）。

**192.168.1.4 实测状态（锚定 2026-09-25 16:1x，读数器 = `bench-docker list`）**：**新容器** `dsh-bench-r20260925-1614-4eb2` running（镜像 **`dsh-bench:0.1.7-rc.2`**，1.04 GB —— **第 ⑥ 项实测的载体**，证据见 §2.9 对账表）｜**旧容器** `dsh-bench-mb3` 仍在 running（镜像 `dsh-bench:0.1.7-rc.1`，1.08 GB，起动 **2026-09-24 02:23 +08:00**）｜两镜像并存｜远端磁盘 `/` 489G ／ 已用 360G ／ **可用 109G（77%）**。
（**历史读数**，锚定 2026-09-25 15:31，勿当前值用）：当时只见 `dsh-bench-mb3`（重启 0 次，`ExitCode 0`，≈37h）｜`PortBindings {}`（3080 **仅 EXPOSE**，未发布）｜挂载 `/opt/dsh-bench/dist:/ccc/dist:ro`（⇒ 该容器是 **tarball 模式**起的）｜`RestartPolicy no`。

### 2.9 ✅ 第 ⑥ 项改动点清单（**已取证 · 2026-09-25 16:1x 已执行**）

**目标（owner 令）**：容器里跑通 —— **能安装 → 装完能启动 → 启动后功能可用 → 全程用真实模型（MiniMax）**。

⚠️ 下表（第 1~9 行）是**动手之前的取证记录**（"当时是什么状态"）——**不是现状**；**处置与结果见 §2.9a**。

| # | 事实 | 取证 |
|---|---|---|
| 1 | **现在跑不了真实对话轮**：轮次会以 `MISSING_CREDENTIAL`（`model: deepseek-flash`）结束 | `docs/host-adaptation-bench-design.md` 实测记录 ＋ 容器内无任何 key 层（Dockerfile/entrypoint/`cmdUp` 均不注入，无 `.credentials.yaml`、无 `.env`） |
| 2 | **模型不能按轮指定**：`turn` 的请求体无 model，宿主 `agentOptions()` 只吃部署默认 | `session-controller` 的 `agentDefaultModel.currentSelection()` |
| 3 | 部署默认在**镜像内 base bundle** 写死：`provider: deepseek-official` / `model: deepseek-flash` | base `cordis.patch.yml` |
| 4 | **要改的两个键（都在 `/root/.dsh/profiles/web/cordis.patch.yml`）** | 世代判据 = `tests/host/deepseek-vision-verify.test.ts` 的候选表；0.1.7 起设置按 profile 条目投影 |
| | **键 A（路由）**：`- id: llm-pi-ai` → `config.providers.<route>` = `{ api:'openai-completions', baseURL, apiKeyEnv:'MINIMAX_API_KEY', models:[{id:'MiniMax-M3'}] }` | `docs/config-catalog.md`（`providers` 形状）＋ `llm-pi-ai/README.md`（目录外路由必须给 `api` ＋ `baseURL` ＋ **非空 models**）；该条目在 base bundle 里是**零路由挂载** |
| | **键 B（默认模型）**：`- id: agent-default-model` → `config.provider` / `config.model`（该配置只有 `provider`/`model`/`reasoningEffort`） | `docs/config-catalog.md` |
| 5 | **patch 语义**：按 **id 定位整体替换**该条目 config（**不深合并**） | 历史记录（S142 快照） |
| 6 | **凭据注入两条可用层**：`docker run -e MINIMAX_API_KEY=…`（**启动环境快照**优先级最高）／或写 `/root/.dsh/.credentials.yaml` 的 `refs:` 节 | `credentials-local` 的层序：启动环境 > `$DSH_HOME/.credentials.yaml` > `/ccc/.env` > `/root/.dsh/.env` |
| 7 | MiniMax M3 的 OpenAI 兼容端点 = `api.minimaxi.com/v1`（**逐字 baseURL 未取证**，本机真实 profile patch 在 CCC 外） | 本仓 `CHANGELOG.md` ＋ 归档会话记录 |
| 8 | 要改的文件：① `bench/entrypoint.sh`（装插件后、起宿主前 → 写 profile patch 与/或导出 key）② `.opencode/.../bench-docker.ts` 的 `cmdUp()`（`envs`/`mounts`；密钥从 `findRoot()` 的 `localstore.json` 读，现只读 SSH 口令）③ 若要 patch 常驻则 `bench/Dockerfile` ④ **`bench/verify.sh` 现无「真实轮次成功」判据**（V5/V7b 只判缝走到）⇒ 第 ⑥ 项要**新增判据** | 各文件 |
| 9 | profile patch 送进容器**现状无通道**（`cmdUp` 的 `mounts` 或 entrypoint 内 heredoc 二选一） | ✅ **已选 mount** |

#### 2.9a ✅ 执行对账（2026-09-25；载体 = 容器 `dsh-bench-r20260925-1614-4eb2`，实测 **PASS=19 / FAIL=0**）

| # | 原事实 | 处置 | 证据（读数） |
|---|---|---|---|
| 1 | 轮次以 `MISSING_CREDENTIAL` 结束 | ✅ **已解** | **V9 = 完成轮次 3**｜**V9c = `MISSING_CREDENTIAL` 命中 0**；会话日志逐字：`"turn/end" … "kind":"completed"`、助手输出含 **`BENCH-OK`**、usage `input 9894 / output 22 / cacheRead 3712` |
| 2 | 模型不能按轮指定 | ➖ **不改宿主** —— 沿用「部署默认」这条既有机制（即键 B） | **V9b = 模型命中 7**（`"provider":"minimax-bench","model":"MiniMax-M3"`）；`cmdTurn` 请求体**仍不带 model**（刻意） |
| 3 | 部署默认在镜像 base bundle 写死 `deepseek-official` / `deepseek-flash` | ✅ **被 patch 覆盖** | **V9d**（`profile-patch.sha256` 在 ＋ 路由名命中 > 0）＋ V9b |
| 4 | 要改的两个键（键 A 路由 ／ 键 B 默认模型） | ✅ **两键都写** | **新增** `bench/profile-patch.yml`（41 行，**无密钥**）；⚠️ patch 语义 = **按 id 整体替换、不深合并** ⇒ 条目必须写全字段（本轮再次印证） |
| 5 | patch 语义 = 按 id 定位整体替换 | ✅ 已按此写 | 同上 |
| 6 | 凭据两条可用层（启动环境 ／ `.credentials.yaml`） | ✅ **选「启动环境快照」那条**（`docker run -e`） | `secretcheck` 三读数：**S1 = 1**（容器进程环境**含** ⇒ 有它才可能有真实轮次）｜**S2 = 0**（镜像 `Config.Env` **不含** ⇒ 没 bake 进层）｜**S3 = 0 个文件**（远端文件系统**不含** ⇒ 没落盘）；密钥长度 125（**只打印长度，不打印值**）。**未**走 `.credentials.yaml` |
| 7 | MiniMax M3 的 baseURL = `api.minimaxi.com/v1`（**当时逐字未取证**） | ✅ **已取证（逐字）** | 本机真实 profile patch 只读取证：route `minimax-cn-coding-plan`｜`api: openai-completions`｜`baseURL: https://api.minimaxi.com/v1`｜`models: [MiniMax-M3]`｜`apiKeyEnv: MINIMAX_CN_CODING_PLAN_API_KEY`（⚠️ 本机实际靠该文件里的**内联 `apiKey`** 生效）⇒ 容器内**另起名 `minimax-bench`** ＋ `apiKeyEnv: MINIMAX_BENCH_API_KEY`（**刻意不用内联**，内联 = 密钥进文件） |
| 8 | 要改的文件 ①②③④ | ✅ ① `bench/entrypoint.sh`（步 0c 落 patch ＋ 写 sha256）② `bench-docker.ts` 的 `cmdUp()`（推 patch ＋ 挂载 ＋ `-e PROFILE_PATCH` ＋ `-e` 密钥）＋ `runDetached` 加 `launchEnv` ＋ 新增 `secretcheck` ④ `bench/verify.sh`（**新增 V9 家族 4 条**）｜➖ ③ `bench/Dockerfile` **未改**（patch 走 mount ⇒ 不必 bake） | 插件仓提交 **`46362e5`** ／ CCC 仓提交 **`dace4f08`** |
| 9 | patch 进容器无通道 | ✅ **选 mount 通道**：`PROFILE_PATCH_REMOTE → /ccc/profile-patch.yml:ro` ＋ `-e PROFILE_PATCH=<容器内路径>` | 同上（`up` 每次重推） |

🔵 **本项顺带确立的两条纪律**：
1. 🔴 **密钥不得进 `runDetached` 的 payload** —— payload 逐字落远端盘（`<runDir>/<step>.payload.sh`）⇒ 旧写法会把密钥**留在盘上**。**正解 = launch 环境前缀**（`KEY=value <payload>`）＋ payload 里写**裸 `-e KEY`**（docker 语义：不给值 ⇒ 从 CLI 环境取）＋ payload 首行**正控**断言该变量非空（否则失败形态是"容器能起、每轮都失败"，**看起来像模型问题**）。
2. 🔵 `DEFAULT_DSH` 仍是 **`0.1.7-rc.1`**（`bench-docker.ts` 顶部常量，**不指行号**），而实测靶已到 **rc.2** ⇒ 每次都要显式 `--dsh-version=0.1.7-rc.2`。**登记待裁**（改默认值 = 一处小行为变更）。

🔴 **凭据纪律（与约束文档 §5.4-5 一致）**：key **只能运行时注入**，**不得 bake 进镜像层**。

---

## 4. 数据真相源（持久化读写表）

| 持久化数据 | 路径 | 谁写 | 谁读 | 清理路径 |
|---|---|---|---|---|
| **唤醒注册表** | `AGENT_SESSIONS/wake-registry.json` | `wake-registry.ts`（`addWake`/`updateWake`/`finalizeWake`） | `wake-scheduler.ts`（每 tick）、`container-status.ts`、`tools/trajectory.ts` | `finalizeWake` 终态同笔删行 ＋ `purgeFinalizedWakes`；超窗记 `missed` |
| **绑定（权威）** | 宿主存储域 `~/.dsh/storages/`，域 `serenity_bindings` / 表 `bindings` | `trajectory-bound.ts`（`appendBound`/`supersedeOtherBindings`/`pruneMissingBindings`） | `trajectory-bound.ts`、`seams/{context,keeper,system-prompt}`、`tools/trajectory.ts` | `supersedeOtherBindings` ＋ `pruneMissingBindings`（有界） |
| **绑定（旧载体）** | `AGENT_SESSIONS/.bindings.json` | 仅迁移期 `migrateBindingsToDomain` | 回退读（域中无该会话记录时） | 迁完**停写**；**无删除动作**（历史文件留存）⇒ 见 §3-7c-1 |
| **CRO 唤起日志** | `<轨迹目录>/cro-wake-log.json` | `cro-log.ts:appendCroWakeLog` | 仅本模块（**无外部读方**） | 写入时按 2 日窗裁剪 ⇒ **结构上不存在"忘了清"** |
| **ACC 用量账本** | `<CCC>/_tmp/acc-usage.json` | `usage-stats.ts`（`recordToolUsage`/`recordSkillInjections`） | **无程序读方**（`keeper.ts` 明确忽略返回值） | 无清理步；靠名长 120 / 每桶 ≤1000 键**结构有界** |
| **rebuild 诊断** | `AGENT_SESSIONS/.rebuild-diag.json` | `rebuild.ts:writeRebuildDiag` | **无程序读方**（设计即"人可读通道"） | 单对象覆盖写，天然有界 |
| **restrict 诊断** | `AGENT_SESSIONS/.restrict-diag.json` | `seams/guards.ts` | **无程序读方** | 覆盖写 |
| **轨迹本体** | `AGENT_SESSIONS/<目录>/SESSION.md` | `tools/trajectory.ts`（create/use）＋ agent 手写 | `trajectory-ops` / `rebuild` / `cro` / `wake-scheduler` / `seams/system-prompt` | 无删除；完成态由 `[x]` 推导；归档走 `container_fs mv` |
| **CRO 程序** | `<轨迹目录>/continuous-re-occurrence.ts` | **CCC 用户**（ACC 从不写） | `cro.ts`（**spawn，不 import**） | 用户删文件即停用（**无 enabled 字段/注册表**） |
| **DSH 会话日志** | `$DSH_HOME/sessions/--<slug>--/<id>/session[.vN].jsonl(.zstd)` | 宿主 | `session-cleanup.ts`、`live-sessions.ts` | `performCleanup` 物理删（live 会话跳过） |

**孤儿判定（事实，非缺陷结论）**：
- **只写不读**（无程序消费者，用途 = 人工审计）：`acc-usage.json`、`.rebuild-diag.json`、`.restrict-diag.json`。
- **写者即读者**：`cro-wake-log.json`。
- **只读不写**：`.serenity` ／ CCC `serenity.json` ／ `SKILL.md`。

---

## 5. 待补（本文件的未完成部分）

| 域 | 状态 |
|---|---|
| `src/host/`（L0） | ✅ §2.1 |
| `src/seams/`（L0/L2） | ✅ §2.2 |
| `src/tools/` ＋ `msm-ops.ts`（L3） | ✅ §2.4（＋ 死代码 §3-8） |
| 轨迹/会话/唤醒核心域（L1） | ✅ §2.5（＋ 依赖环 §3-6、死代码 §3-7、数据真相源 §4） |
| 对外面与集成域（L2/L3） | ✅ §2.3（含外露面总表 §2.3.1、配置读取面 §2.3.2） |
| `src/client/`（L4）＋ 测试面 | ✅ §2.6（客户端半）／ §2.7（测试面）／ §3-9（测试缺口） |
| `scripts/` / `bench/`（L5） | ✅ §2.8（集成测试台 ＋ 判据清单 **V0~V9 共 19 条**）／ §2.9 ＋ **§2.9a（第 ⑥ 项 · 已执行对账）** |

⇒ **六域全部到齐**（2026-09-25）。本文件自此为**完整的现况地图**；后续按 §6.2 与新增/删除同批维护。
