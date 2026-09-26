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
| `settings-section.ts:readSimpleSettings()` | 本插件 fiber **Config**（经宿主 settings 面板 `ns=serenity-hooks`） | `gatewayEnabled`/`rebuildThresholdK`/`skiffEnabled`/`skiffDebugPort`/`acpEnabled`/`acpHttpPort`/`publicAskEnabled`/`croEnabled`/`unattendedEnabled`（旧嵌套形态 `gateway.enabled`、`skiff.debugPort`、`acp.httpPort` **亦收**）。🔴 **v1.49.0 起 `rebuildEnabled` 已砍掉**（超限重建恒开、无总闸） |
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

### 2.7 测试面（**126 文件 / 2065 用例** —— 锚定 2026-09-25 **④ 第 1 步 `58b2891`** 时实测为 108/1699；其后 ⑤ 五件各加一批：`50ad1f3` → 109/1715，`ae195a7` → 110/1733，`e834e17` → 111/1756，`a5815c6` → 112/1767，`58d58b2` → **113/1799**；第 6 件（gateway 语义化）→ **113/1801**（同文件 +2）；第 7 件（lazy 守卫 ＋ 台账复核）→ **114/1807**（+1 文件 +6 用例）；第 8 件（**HTTP 对外面 `api.ts`**）→ **115/1816**（+1 文件 +9 用例）；第 9 件（同面补齐其余 5 条路由）→ **115/1822**（同文件 +6）；第 10 件（**破坏性端点** session-cleanup POST）→ **115/1826**（同文件 +4）；第 11 件（weixin 三个写动作）→ **115/1830**（同文件 +4）；第 12 件（**gateway 装配链**：登录面 ＋ 反代面）→ **115/1842**（同文件 +12，分两笔：`82d0dcf` 后为 1835，`a936d75` 后为 1842）；第 13 件（**文件发送三步链**）→ **116/1854**（+1 文件 +12 用例）；第 14 件（**container_git 远程流程 ＋ 失败注入**）→ **117/1866**（+1 文件 +12 用例）；第 15 件（**微信扫码登录全链 ＋ 假 iLink 后端**）→ **118/1876**（+1 文件 +10 用例，见 §2.7a）；第 16 件（**§3-9 #10 的语义孪生 ＋ 台账复核**）→ **118/1879**（同文件 +3）；第 17 件（**`api.ts` 错误与边界分支批**）→ **118/1887**（同文件 +8，见 §2.7b）；第 18 件（**残余 catch 与尾部支线**）→ **118/1893**（两文件 +6，见 §2.7c）；第 19 件（**MSM 管理面 ＋ 安全边界**：`msm-ops.ts`）→ **119/1923**（+1 文件 +30 用例，见 §2.7d）；第 20 件（**打回闸门缝的边界与失败路径**：`output-guard-seam.ts`）→ **119/1931**（同文件 +8 用例，见 §2.7e））；第 21 件（**`container_fs` 的守卫面与路径校验**：`fs-ops.ts`）→ **120/1951**（+1 文件 +20 用例，见 §2.7f））；第 22 件（**超限重建的执行面与失败面**：`rebuild.ts`）→ **121/1962**（+1 文件 +11 用例，见 §2.7g））；第 23 件（**重建第二片 ＋ 三处「疑不可达」证伪**：`rebuild.ts` **三面全满**）→ **121/1970**（同文件 +8 用例，见 §2.7h））；第 24 件（**面 B 的 WS 反代残余面**：`gateway.ts`）→ **122/1973**（+1 文件 +3 用例，见 §2.7i））；第 25 件（**DSH 安装位置探测的三条候选 ＋ 失败终态**：`status.ts` **三面全满**）→ **122/1980**（同文件 +7 用例，见 §2.7j））；第 26 件（**面 B 的 DSH BrowserAuth cookie 注入面**：`gateway.ts` 的接线）→ **123/1984**（+1 文件 +4 用例，见 §2.7k））；第 27 件（**面 B 的装配与生命周期面**：`sync()` 四态）→ **124/1988**（+1 文件 +4 用例，见 §2.7l））；第 28 件（**`acp-http.ts` 的门控／路由／入参边界面**）→ **124/2003**（同文件 +15 用例，见 §2.7m））；第 29 件（**`wake-registry.ts` 的读面容错／写面失败／结案清理**）→ **124/2018**（同文件 +15 用例，见 §2.7n））；第 30 件（**`unattended-seam.ts` 的装配面／守卫面／清理面**）→ **124/2029**（同文件 +11 用例，见 §2.7o）；第 31 件（**`api.ts` 的 `resolveWorkspace` 默认箭头**）→ **124/2031**（同文件 +2 用例，见 §2.7p））；第 32 件（**`tools/*` 的 `output.render` 通路**，9 文件一次触达）→ **125/2049**（+1 文件 +18 用例，见 §2.7q））；第 33 件（**`tools/*` 的 `execute` 通路**，5 个 `execute` ＋ `handyman.parseJobs`）→ **126/2062**（+1 文件 +13 用例，见 §2.7r））；第 34 件（**面规格的意图读取通路**：`skiffDebugSpec` 经 `faceEnabled` ＋ **产出 §3-8 第 18 行的结构发现**）→ **126/2065**（**同文件** +3 用例，见 §2.7s））

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

#### 2.7a ✅ ⑤ 第 15 件：微信扫码登录全链 ＋ **假 iLink 后端**（2026-09-25 17:4x）—— 收掉一条**明文登记的边界**

**这条边界原是上一笔自己写下的**（`tests/api-status-api.test.ts` 末尾）："**刻意不测 `login-start` 与"带账号的 enable"**：前者 `fetchQRCode()` 要真连微信后端、后者 `syncCccBridge()` 会真起轮询循环 ⇒ **当前没有假微信后端**，贸然测就是把测试接到真网络上。它们的夹具设计留作后续。" —— 本件就是**把那个假后端建出来**。

**做法（零生产语义改动）**：
1. **假 iLink 后端 = 本进程内一台真 HTTP server**，实现两个端点：`GET /ilink/bot/get_bot_qrcode?bot_type=` 与 `GET /ilink/bot/get_qrcode_status?qrcode=`；
2. 经 `weixin-api.ts` **自带的测试注入点** `__setWeixinFetchForTest()`（生产零调用）注入一个 fetch：**把 `ilinkai.weixin.qq.com` 的请求改指假后端，其余原样放行**（本机 serenity API 走 node:http，不受影响）；
3. ⇒ `apiGet` 整条链（URL 组装 → **真 socket** → abort 计时器 → `res.ok`/`res.text()` → JSON 解析）**全被走到**，而**一个字节不出本机**。这严格强于"把 fetch 换成返回假 `Response` 的函数"（那会跳过真实 HTTP 层）。

**实测读数（判据一律看盘上状态，不看响应自述）**：`api.ts` 语句 **70.12% → 91.38%**（521 → **679/743**）｜分支 **70.44%**（143/203）｜函数 **91.3%**（21/23）｜全仓语句 **94.93% → 95.2%**（24578/25815）｜**test 1866 → 1876**（+1 文件）。覆盖 9 组：`login-start` 正常（**假后端真收到请求 ＋ `bot_type` 透传**）／传输层 503 ⇒ 400／轮询 wait→confirmed 全链（**凭据真落 `localstore.json` 的 `WEIXIN_WECHAT_1_TOKEN` ＋ 账号真进 `serenity.json` ＋ loginKey 被消费**）／confirmed 无 `bot_token` ⇒ error ＋ **盘上零改动**（负控）／`expired` ⇒ 登录项被清／未知 key 404 ＋ 非 GET 405 ＋ 无 UI 头 403／**TTL 时间旅行**（`vi.useFakeTimers({toFake:['Date']})`：新 `login-start` 清过期项 ＋ 过期项轮询 ⇒ `expired`）／带账号 `set-enabled`（200 ＋ 配置落盘；**无凭据 ⇒ 不启桥**）／**已绑定账号 ⇒ enable 真把桥起起来**（`weixinBridgeStatus()` 可见；disable ⇒ 停）。

🔴 **本件顺带抓到一条待裁（不是缺陷声明，是登记）**：`login-start` 对 iLink 的**业务返回码不做校验** —— 后端以 `HTTP 200 + {errcode:40001}` 报失败时，端点回 **200 且 `qrcode` 为空**（`fetchQRCode` 只走 `apiGet` ＋ `JSON.parse`；`assertIlinkOk` 按设计只挂在**发送类**调用上）。**兜底在客户端**（`WeixinBridgeEditor.tsx` 判 `!res.ok || !qrcode_img_content || !loginKey` ⇒ 面板照常报失败，不是静默假绿）⇒ 是否把校验也挂到 QR/登录面 = **行为变更，待 owner 拍板**。首跑时我把它当成"应当 400"，红下来分诊才发现是**我的期望写错**（判据纪律"红不一定是我的错，也不一定是它的错"）。

#### 2.7b ✅ ⑤ 第 17 件：`api.ts` 的**错误与边界分支**（2026-09-25 18:0x）—— 64 → **22** 条未覆盖语句

**挑靶法（本件确立，可复用）**：`coverage/src/index.html` 里**已无任何 `file low/medium` 行**（每个 src 文件 ≥80%）⇒ 挑靶不能再看"按文件排序"，要**逐文件读未覆盖分支**：从 `coverage/src/<f>.ts.html` 的 **`cline-no`** 反推源行（该文件的 `class="text"><pre>` 块起始 HTML 行 = 源行 1；`api.ts` 锚定本件那版报告实测 **源行 = HTML 行 − 808**）。⚠️ 换文件/换一跑偏移就变 ⇒ **必须重算，不许抄这个数**（§4.2-㉞ 同族）。

**本轮只做"不需要裁决"的那一档**（405 ／ 404 ／ 取值兜底 ／ 事件通知失败 ／ 账号移除），**不碰**待裁项（`readBody` 超限体在实践里被 `req.destroy()` 变成 ECONNRESET ⇒ 断言"400"会把假期望固化）。

| 覆盖的簇 | 判据要点（都看**盘上/ wire 读数**，不看响应自述） |
|---|---|
| `resolveWorkspace` 两条真路径 | `?sessionId=` ⇒ 取会话 `header.cwd`（**首选**）；无 sessionId ⇒ **遍历 live 会话**挑出能解析成 CCC 的 cwd；＋负控（非 CCC 的 cwd **不被采用**） |
| `/serenity/handymen` | `workspace` 指向真 CCC ⇒ 走 `listActiveHandymen(root)` 分支（既有用例只测了"无 CCC ⇒ 空表"） |
| `/serenity/status` POST | 解析不到 CCC ⇒ **404** ＋ **盘上零改动**（负控：`.serenity-safe-on` 不得出现）；非 GET/POST ⇒ 405 |
| 两条上传端点 | 🔴 **方法检查排在守卫之前**（GET **不带** UI 头仍应是 **405** 而不是 403 —— 顺序本身是契约）＋ 无 CCC ⇒ 404 ＋ **盘上无 `_tmp/` 落盘** |
| `/serenity/weixin` GET **带账号** | `bound` 按 localstore 凭据**两态**（有/无 token）＋ 脱敏强化（**token 值本身**不出现在 wire） |
| `/serenity/weixin` POST 边界 | 非 POST ⇒ 405；**缺 `ccc` ⇒ 400 `missing ccc param`** |
| `remove-account` **成功路径** | 账号从 `serenity.json` 消失 ＋ 凭据从 `localstore.json` 消失（**路由表不动**）——此前只测了缺参 400 |
| `/serenity/config` PUT | 🔴 **`emit` 抛错仍回 200**（`serenity/config-updated` 只是通知，不是保存的一部分） |

**读数（同一 743 语句分母）**：`api.ts` **91.38% → 97.03%**（679 → **721/743**；分支 **70.44% → 78.4%**（167/213）；函数 **21/23 → 22/23**）｜全仓语句 **95.21% → 95.37%**（24620/25815；分支 83.08%；函数 94.52%）｜test **1879 → 1887**（同文件 +8 用例）。

🆕 🔴 **本件顺带判定一条"构造上不可达"（已登记 §3-8 第 9 行）**：`resolveWorkspace` 里那句 `catch { /* 遍历失败 → 空列表 */ }` **进不去** —— 它 try 的三条语句里，`hostSessions(ctx)` 经 `hostInjected` → `hostService` **三层都吞异常**（模块契约："服务缺失/读取失败一律返回 undefined，不抛错"），剩下的是一个 `typeof … === 'function'` 判断与一次赋值 ⇒ 除非 `sessions.list` 是"读属性即抛"的 **getter**，永不进 catch。🔵 可读性上它在注释里承诺了一条不会发生的话 ⇒ 同 §3-8 家族，**归第 2 批待裁，不自行删除**。

⏭️ **剩余 22 条（下一轮靶，多数可廉价覆盖）**：四条端点的 **catch 块**（用**真实故障形态**触发：`sessions.get` 抛错 ⇒ 端点 catch ⇒ 400；请求体坏 JSON ⇒ 400）、`public-ask` 的非 PUT/GET ⇒ 405 与其 catch、`session-cleanup` 尾部（~706-708 / ~719-720）、`weixin /login` 的 catch（~657-658，触发面待判定）。⚠️ 逐条先判"**用户能不能真走到**"：走不到的就登记成 §3-8 候选，**不硬凑测试**。

#### 2.7c ✅ ⑤ 第 18 件：`api.ts` **残余 catch 与尾部支线**（2026-09-25 18:1x）—— 22 → **2 条**（`api.ts` 达 **99.73%**）

**判据主轴：用"真实故障形态"触发 catch，不 mock 制造异常**（§4.2-㊾）。三种形态都是产线上真会发生的：

| 故障形态 | 覆盖到的分支 | 读数 |
|---|---|---|
| **宿主服务读取抛错**（cordis Proxy 对未声明服务确实会抛）—— `sessions.get` ／ `sessions.list` | `handymen` ／ `cccs` 的 catch ⇒ 400；**`session-cleanup` 的 catch** ⇒ 400（该处 `sessions.list()` 是**裸调用**，不被收口层吞） | 三条 catch 各自 `error` 文案逐字含故障串 |
| **请求体不是合法 JSON**（面板发坏包） | `config PUT` ／ `public-ask PUT` 的 catch ⇒ 400 | — |
| **CCC 布局被写坏**（`.opencode` 被占成一个普通文件） | **`weixin /login` 的 catch**（confirmed 落盘时抛）⇒ 400，**不是崩** | 落在 `api-weixin-login.test.ts`（那里才有假 iLink 后端） |
| 服务可用性降级（非异常） | `config GET` 的 `workspaceRegistry.list()` 抛错 ⇒ **仍 200 ＋ `knownWorkspaces: []`**（面板显示"暂无可选工作区"，不是整页失败） | — |
| 方法边界 | `public-ask` 非 PUT/GET ⇒ 405；`session-cleanup` 非 GET/POST ⇒ 405 | — |

🔵 **一条实测纠正（记下来免得后人再踩）**：我最初想用 **`DSH_HOME` 指向一个文件**（会话根不可读）触发 `session-cleanup` 的 catch —— **实测回 200**（该端点自己把"根不可读"容错成"零候选"）⇒ 这条 catch 的触发面是**服务调用抛错**，不是 fs。⇒ 已在用例注释里写明，避免后人重复假设。

**读数（同一 743 语句分母）**：`api.ts` **97.03% → 99.73%**（721 → **741/743**；分支 **78.4% → 82.74%**（187/226）；函数 22/23）｜全仓语句 **95.37% → 95.44%**（24640/25815；分支 83.25%；函数 94.52%）｜test **1887 → 1893**（两文件 +6 用例）。

🔴 **剩余 2 条 = 唯一那条构造上不可达的 `catch`**（§3-8 第 9 行：`resolveWorkspace` 的"遍历失败 → 空列表"）⇒ **`api.ts` 的语句覆盖已到头**：再往上只剩"给不可达分支硬凑测试"这类**负价值**动作。⚠️ 另有一条**函数**（22/23）未执行 —— ✅ **面已定（⑤ 第 19 件顺带查明）**：是 `resolveWorkspace` 里那句**默认箭头** `let listCwds: () => string[] = () => []`（它是"宿主 sessions 服务缺 `list`"时的兜底）。🔴 **它不可达吗？不 —— 它可达**：`resolveWorkspaceCore` **无条件调用** `listCwds()`（`api.ts` 的 `for (const cwd of listCwds())`）⇒ 只要传一个**没有 `list` 的 `sessions`** 就被执行；现有用例都恰好提供了可用的 `list` ⇒ 它成了 `api.ts` **最后一个未执行函数**。⇒ **下次碰 `api.ts` 时的廉价靶**（与那条 `catch` **不同档**：那条是构造上不可达，这条只是"还没走到"）。




---

#### 2.7d ✅ ⑤ 第 19 件：**MSM 管理面 ＋ 安全边界**（`msm-ops.ts`，2026-09-25 18:0x）—— 分支 **59.54% → 82.52%**

**挑靶依据 = 分支覆盖率**（不是语句）：`msm-ops.ts` 当时语句 83.83% ／ **分支 59.54%**（897 语句、22 函数中 4 个未执行）—— 它是"**船上的机器**"（MSM 注册表 ＋ `register`/`deregister`/`check` 管理动作 ＋ exec 装配 ＋ 安全边界）。

🔴 **既有测试的分工缺口**（这正是本件存在的理由）：`ops.test.ts`（exec ／ 未注册 ／ register **成功** ＋ M1）｜`acc-extras.test.ts`（guide ／ catalog ／ `--schema` ／ `--format=json` ／ **词法**逃逸）｜`msm-tool.test.ts`（**mock 掉 `runMsmAsync`**）｜`container-admin.test.ts`（**mock 掉 `runMsm`**）
⇒ **真 `runMsm`/`runMsmAsync` 的管理面、真 symlink 逃逸、M4 判定、`--list` 协议，此前全未测**。

⇒ 新增 **`tests/msm-admin.test.ts`（+1 文件 / 30 用例）**：

| 块 | 判据形态 |
|---|---|
| `register` 五态 ＋ 落盘 | 缺参 ／ **path 逃逸（并断言注册表未被创建 = 不动盘）** ／ 脚本不存在 ／ 重名（追加断言"没被写第二遍"）／ flags 非 JSON 数组（"坏 JSON"与"JSON 但非数组"**两态**）｜首建 **v1 wrapper** ＋ 缺省 `usage` ＋ flags 落盘｜**既有裸数组 ⇒ 保持裸数组**（不自作升级）|
| `register`/`deregister` **精提交** | **真 git 仓**（`git init` ＋ **repo-local** `commit.gpgsign=false`，免被机器级配置否决）：断言 commit 文案 ＋🔴 **`git show --name-only` 只列注册表一个文件** ⇒ 机械证明是"只 add 注册表"而**不是 `add -A`** |
| `deregister` | 成功（**盘上条目真消失** ＋ wrapper 形态保持）／未注册抛错（**且盘上不动**）／**无 `.serenity`** 仍抛 not registered（不崩）／裸数组形态保持 |
| `list` | 空 ⇒ `(no MSM registered)`；有条目 ⇒ 行格式；**flags 有/无两态** ＋ `type` 缺省回落 `<string>` ＋ `skill`/`category`/`description` 回落 `-` |
| `--list` 协议 | 返回 `{name, category}` 数组（缺 category ⇒ `null`）＋🔴 **"脚本未被 spawn"用副作用标记文件证明**（返回值对 ≠ 脚本没跑）|
| 🔴 **真 symlink 逃逸** | CCC 内建一条**指向根外**的 symlink 作 `type:"path"` flag 的值 ⇒ `--out=link` 与 `--out link` **两种形态都拒**｜**正控**：指向**根内**的 symlink **放行且脚本真执行** ⇒ 证明判据在**甄别**，不是"见 symlink 就拒" |
| M4 ＋ 扫描边 | flag 名含 `path/file/dir` 但 `type≠path` ⇒ issue（"已标 path"／"名字无关"／**无 `name`** 三态为负）｜悬空 symlink ／ 名为 `*.ts` 的**目录** ／ `.test.ts` ／ 非脚本扩展名 ／ **库模块**（无 shebang ∧ 无 `main()`）⇒ 均不上报 M3（**真入口上报 = 正控**）|
| `hasCliEntry` 读失败 | `chmod 000` ⇒ **按入口上报**（不静默漏候选）＋ 同文件**仅**恢复权限后**不再上报** ⇒ 差异只在"读得出来吗"（root 上如实 `skipIf`）|
| `runMsmAsync` | **免 spawn 两段**（非 exec ⇒ 委托 ／ `--list` 协议）｜**真跑**（bun 在场）：成功 ⇒ exit 0 ＋ stdout 透传；非零退出 ⇒ **码透传 ＋ 追加 TIP**，带 `--help` 则**不加** TIP |

**读数（同一 897 语句分母、同一 206 分支分母）**：`msm-ops.ts` 语句 **83.83% → 96.98%**（752 → **870/897**，+118）；分支 **59.54% → 82.52%**（**170/206**）；函数 **18/22 → 21/22**｜全仓语句 **95.44% → 95.9%**（24640 → **24758/25815**，**分母不变** ⇒ +118 全部来自本文件）；分支 83.25% → **83.76%**；函数 94.52% → **94.85%**｜test **1893 → 1923**。提交 **`44fdcee`**（1 file / +456）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（typecheck ／ test ／ coverage 三关全绿）。

🔴 **诚实边界（本件刻意不覆盖的四类，别当欠账）**：
1. **`bunExecutablePath()` 的 win32 候选循环** —— 首行 `platform !== 'win32'` 即返回 `'bun'` ⇒ Linux 上是**平台门**；同一段的 `branch-0 cbranch-no` 即"循环确实没跑"的机械证据。
2. **「bun 缺失 ⇒ 回落 npx」整段 ＋ 其内层 `catch` ＋ `isBunMissing()` 的 true 分支** —— 需要"本机没有 bun"；本机**有** bun（报告里 `execFileAsync(bunBin, …)` 那一行是**已执行**）⇒ 只能留白。
3. **两处构造上不可达**（§3-8 第 11/12 行）—— 硬凑用例会把"从不发生"固化成"期望形态"。
4. 剩余分支 = `err.killed`／`err.code`／`err.stdout`／`err.stderr` 的 `??` 兜底侧（需"子进程异常退出且这些字段缺失"的形态）。

🔵 **本件新得的两条方法读数**：
- 🔴 **覆盖率报告的「函数」计数在"数组字面量里的多行箭头"上会失真** —— `BUN_EXE_CANDIDATES` 三个箭头里**只标出 1 个 `fstat-no`**（`LOCALAPPDATA`），而同一段的 `cbranch-no` 证明整段**都没跑**。⇒ **读"函数数"必须连 `cbranch-no`／`cstat-no` 一起看**，**别把"没标 fstat-no"当成"跑过了"**（判据纪律 ㊽ 的加强版）。
- 🔵 **"没 spawn"要用副作用自证** —— 协议分流的判据不能只断言返回值（返回值对、而脚本同时也被跑了，是可能的）⇒ 让脚本**落一个标记文件**，断言它**不在**。

🔵 **同批销掉一条挂账**：§2.7c 末尾"另有一条函数（22/23）未执行、面未定" ⇒ **面已定**（详见该段更正）：是 `resolveWorkspace` 的**默认箭头**兜底，且**可达**（`resolveWorkspaceCore` 无条件调用 `listCwds()`）⇒ 归"还没走到"档，下次碰 `api.ts` 时的廉价靶。

---

#### 2.7e ✅ ⑤ 第 20 件：**打回闸门缝的边界与失败路径**（`output-guard-seam.ts`，2026-09-25 18:1x）—— 该文件**三面全满 100%**

**靶** = `output-guard-seam.ts`（`agent/turn-stopping` 时检测**外部面**最终输出，命中敏感词即 `agent.steer` 打回重生成）—— 属**用户可见行为**；挑靶依据 = **分支覆盖率**（当时 62.06%，除已退役的 `diag-ops` 外最低）。
🔴 **缺口形态**：既有 `tests/output-guard.test.ts` 那组**只走顺利路径**（外部面 ∧ 有文本 ∧ steer 不抛 ∧ turn 有值）⇒ 下列**产线真会走到**的分支从未被执行：

| 分支 | 为什么产线会走到 |
|---|---|
| `payload` 无 agent ⇒ return | 宿主事件形状不保证齐全 |
| 会话 id 缺失 ⇒ 判非外部面 ⇒ 不检测（＋ `id ?? 空串` 回落） | 非常规会话／重建中的载体 |
| `session.header` 缺失 ⇒ cwd 回落 `process.cwd()` | 宿主未填 header 的会话 |
| 无可用最终输出（**四种事件形状**）⇒ 返回空串 ⇒ 不检测 | 工具调用轮、多形态事件流：`?? e.data?.content` ／ 非 text 块 ／ 两个 content 都缺 `?? []` ／ 非 `assistant/message` 事件 |
| `payload.turn` 缺失 ⇒ **两条日志各自**回落 `?` | 宿主不带 turn 的事件 |
| `agent.steer` 抛错 ⇒ 不向外抛 ＋ 告警（**Error 与非 Error 两态**） | steer 可失败；且打回机制失效**不得拖垮 turn** |

**判据形态（三条，均可复用）**：① `vi.spyOn(process,'cwd')` 钉在**无 `.serenity` 的临时目录** ⇒ 不依赖"本机仓库恰好位于某 CCC 内"（与 `tests/seams/env.test.ts` 同款先例）｜② `vi.spyOn(console,'log'/'warn')` **断言日志正文含 `turn=?`** ⇒ "回落真的发生了"的机械证据，而不是"我读了源码"｜③ steer 抛错用例断言 **不抛 ＋ 告警含 `steer failed`**。

**读数**：`output-guard-seam.ts` 语句 **96.19% → 100%**（101 → **105/105**）；分支 **18/29 → 38/38**；函数 **3/3** ⇒ **三面全满**｜全仓语句 **95.9% → 95.92%**（24758 → **24762/25815**）；分支 83.96% → **83.98%**（4804/5720）；函数 94.85%（866/913）｜test **1923 → 1931**（同文件 +8 用例）。提交 **`40eab4e`**（1 file / +144）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（typecheck ／ test ／ coverage 三关全绿）。

🔴 **本件最重要的读数纪律（🆕 与 §2.7d 同族，两条合起来才是完整的）**：**分支覆盖率的分母也会随"执行"而变** —— 本文件的**分支分母由 29 → 38**（源码一字未改！），因为 istanbul 只在相关区域**被执行后**才展开其分支条目。⇒ **跨跑的百分比不可直接比**（"62.06% → 100%" 混了两个分母）；**可比的是绝对覆盖量（18 → 38 条）**。
🔵 **同族三条（写覆盖率读数的自检清单）**：① **三个数都要连分母**（判据纪律 51）② **函数的**计数在"数组字面量里的多行箭头"上会**漏标**（§2.7d）③ **分支的**分母随执行而**变**（本条）。

---

#### 2.7f ✅ ⑤ 第 21 件：**`container_fs` 的守卫面与路径校验**（`fs-ops.ts`，2026-09-25 18:2x）—— 分支 **64.36% → 90.86%**

**靶** = `fs-ops.ts`（`container_fs` 工具面，**高频**）；挑靶依据 = **分支覆盖率**（除已退役 `diag-ops` 与已满的 `output-guard-seam` 外最低）。
🔴 **缺口形态**：既有 `tests/fs-ops.test.ts` 走**顺利路径**（正常读/写/删 ＋ 注册表保护 ＋ 词法逃逸），报告里成片的 `cbranch-no`/`cstat-no` **全是守卫与边界**。

⇒ 新增 **`tests/fs-ops-guards.test.ts`（+1 文件 / 20 用例）**：

| 块 | 判据形态（🔵 可复用） |
|---|---|
| **守卫 17 条** | 缺参 ／ 不存在 ／ 未知动作 —— **逐条断言精确文案**（用 `expect(fn, msg)` 带上"是哪个 action 漏了"）|
| **根外绝对路径** | 写动作 ⇒ 抛 `outside serenity root`；🔴 `rm` ⇒ 记 `[SKIP]` 且**同批合法目标照删**（`continue` 而非 abort）＋ **根外那一个没被动过**（盘上正控）|
| 根内绝对路径 | `list`/`tree`/`info`/`find` 的 `startsWith("/")` 正常侧 |
| 🔴 **写路径 symlink 逃逸** | 根内 link → 根外：`touch`/`append` 都拒（`resolves via symlink to … outside serenity root`）＋ **正控：根外那份内容未被追加**（拒绝是有效的，不只是文案）|
| 破坏性动作边界 | `mkdir` 两态（已有目录 ⇒ 友好返回／已有文件 ⇒ 抛）｜`rm` 的 `not found` ／ **dry-run 文件与目录**（`(recursive)` 只在 recursive 时出现）｜**空目录 `rmdirSync` 真删**（与"非空 ⇒ SKIP"成对）｜`mv`/`cp` **自动建父目录**｜`touch` 已存在 ⇒ 只改时间戳（**内容不截断**）|
| 注册表保护 | 命中**文件** ⇒ 文案指向 `container_admin msm register/deregister`；命中**祖先目录且文案含 `remove`**（cccName = `remove-ccc`）⇒ 报 `refusing to remove`（另一文案档）｜🔴 **`无 .serenity ⇒ 注册表不受保护`**（保护以 cccName 为键）|
| 元数据兜底档 | `humanSize` 三档（**真 2 KB / 2 MB 文件**）｜`detectFileType` 的 `other`（**真 unix socket**）｜`getFileInfo` 的 `catch`（**悬空 symlink** ⇒ `{other,0,?,?}`，不崩）｜symlink 指向目录 ⇒ 按**目标**判为 `dir` |

🔴 **本件产出的一条真缺口（已用 `it.fails` 登记，修好即翻红）**：`fs-ops.ts` 的 **`relative` 动作只用 `absPath.startsWith(root)`**，而同文件的写路径校验用的是 `pathInside(resolve(root), absPath)` ⇒ **"根前缀兄弟目录"**（如 `<root>-sib`）被误判为根内 ⇒ 返回一个**逃出根**的相对路径（`../<basename>-sib`）而不报错。属**读-only** 动作（不写盘 ⇒ 风险低），但**判据不一致本身**是该登记的。⇒ 待裁（属行为变更）。
🔴 **另一处"构造上不可达"**（已入 §3-8 第 13 行）：`detectFileType` 的 `symlink` 档 —— 本模块**所有调用点都传 `statSync`**（跟随符号链接），没有任何地方传 `lstatSync` ⇒ `isSymbolicLink()` **恒假**。

**读数**：`fs-ops.ts` 语句 **96.21%**（508/528）｜分支 **90.86%**（**209/230**）｜函数 **17/17 = 100%**｜全仓语句 **95.92% → 96.03%**（24762 → **24792/25815**，+30）；分支 **84.85%**（4902/**5777**）；函数 94.85%（866/913）｜test **1931 → 1951**（+1 文件 +20 用例）。提交 **`194847e`**（1 file / +264）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（typecheck ／ test ／ coverage 三关全绿）。
⚠️ **读数口径（承 §2.7e）**：上一跑记的 `fs-ops.ts` 分支 **64.36%** **未记分母**，而本跑分母 = 230 ⇒ **百分比跨跑不可直比**；**可比的是本跑的绝对量 209/230**。⇒ 这就是 §2.7e 那条纪律的第二次实证。

⏭️ **本靶剩余（一片可收，供下一轮）**：`tree` 的 `dirsOnly` 过滤递归／`maxDepth` ／ **`reveal` 的 darwin 与未知平台分支及其 catch**（`node:os.platform` 可 mock ⇒ 可覆盖）／ `find` 的 `maxDepth`·readdir 抛错·stat 抛错（悬空 symlink 入搜索树）／ `exists` 的绝对路径侧 ／ `touch`·`append` 的建父目录 ／ **`process.platform === 'win32'` 三处（平台门，Linux 不可达）**／ `find` 正则 catch（疑不可达）。

---

#### 2.7g ✅ ⑤ 第 22 件：**超限重建的执行面与失败面**（`rebuild.ts`，2026-09-25 18:5x）—— 分支 **68.75% → 88.69%**

**靶** = `rebuild.ts`（**破坏性能力**：清空对话历史 ＋ 自动继续）。既有 `tests/rebuild.test.ts` 覆盖**顺利路径**（排队 → replace → steer 自动继续）；本件只补**出错时用户/agent 看到什么** ⇒ 新增 **`tests/rebuild-executor.test.ts`（+1 文件 / 11 用例）**：

| 块 | 判据（🔵 = 可复用形态）|
|---|---|
| `queueRebuild` 的门 | **会话定位失败** ⇒ 报出是哪个 id。🔴 **v1.49.0 起「总闸关」那道门已砍掉** —— 改为**砍闸回归钉**：`__setSimpleSourceForTest` 注入残留的 `rebuildEnabled:false` ⇒ **照样排队**（旧键静默忽略） |
| 会话名回落 | 无内存活跃信息 ⇒ 由 mdPath 目录名派生；**目录名不含 `S###` ⇒ 绑定行 `sessionId=undefined`**（不编造 S 号）|
| turn 钩子守卫 | `payload` 无 agent ⇒ return，且**队列原样保留** |
| **TTL 丢弃** | `vi.useFakeTimers()` ＋ `setSystemTime` 推进 20min（TTL = 10min）⇒ 清队列 ＋ 记 `ttl-dropped` ＋ **绝不误清空 surface** |
| **meter 三态** | 无服务 ⇒ 退化（只 replace）｜**有 `estimateMessage` ⇒ 真走钩子里的包装箭头**（原 `fstat-no` 转绿）＋ prune 定价 7｜有服务但该方法非函数 ⇒ 同样退化 |
| surface 边界 | 完全空 ／ **只剩 node 0（系统提示，宿主保护）** ⇒ 均记 `empty-surface` 且不 replace |
| 🔴 宿主拒绝 replace | `append` 抛错 ⇒ 记 `failed` ＋ warn ＋ **不打断 turn**；队列已清（不留悬挂） |
| 诊断写盘失败 | 把 `AGENT_SESSIONS` 由目录换成**同名文件**（真故障形态）⇒ 吞掉，且 **replace 与 steer 都照做** |
| 重命名三态 | `sessionTitle.rename` 可用 ⇒ 收到 `(真实 session 对象, S###-日期-概括)`｜服务缺失 ⇒ 跳过｜抛错 ⇒ warn「不阻断」，重建与自动继续照做 |
| 诊断根回落 | agent 无 `header.cwd` ⇒ `?? process.cwd()`；⚠️ **用 `vi.spyOn(process,'cwd')` 钉在临时目录**（否则会写进真仓库）|

**读数**：`rebuild.ts` 语句 **99.61%**（**514/516**）｜分支 **68.75% → 88.69%**（**102/115**）｜函数 **14/14 = 100%**｜全仓语句 **96.03% → 96.15%**（24792 → **24822/25815**，+30）；分支 85.21%（4944/**5802**）；**函数 866 → 867**（＝那条 meter 包装箭头真被执行）｜test **1951 → 1962**。提交 **`9113356`**（1 file / +361）；`src/**` 零改动 ⇒ build ／ pack-check 不强制。

🔴 **本件两条方法论产出（都值得后人照做）**：
1. **诊断计数是"进程级"的** —— `diagState` 是模块单例（源码 P3 已注明"不可跨重启累加比较"）；**同一进程内多个用例同样会累加** ⇒ 断言必须取**增量**（先读 before，再断言 `after === before + 1`），否则**用例之间按顺序耦合**。🔵 **本轮首次就踩到**：`rebuiltCount` 期望 1、实得 6。
2. **覆盖报告的 `cbranch-no` 取向要连 `cstat-no` 一起读** —— 同一行的 `branch-0` 有时标"隐含 else 未走"、有时标"真分支未走"，**只看标记名会读反**。🔵 **实测反例**：`getActiveSessionInfo()?.sessionId ?? …` 的 `??` 右侧明明已被用例走到，报告仍标 `branch-0`。

⏭️ **本靶剩余（一片可收）**：`buildRebuildAnchor` 两处（`activeMdPath` 在根外 ／ `sessionName === ''`）｜`parseSessionContextFromEvents` 的三守卫（`!message` ／ `text ?? ''` ／ `.join('') ?? ''`）＋ 那个 `catch`｜`performRebuild` 的 `if (!event) continue`｜rename 的**匿名目录 else**（目录名不含 `--S###--`）｜两处 `(error as Error)?.message ?? error` 的 `?? error` 侧｜`turn ?? '?'` 的缺省侧。

---

#### 2.7h ✅ ⑤ 第 23 件：**重建第二片 ＋ 三处「疑不可达」证伪**（`rebuild.ts`，2026-09-25 18:2x–18:3x）—— 该文件**三面全满 100%**

**靶** = §2.7g 的 ⏭️ 清单（同一个文件、同一批用例文件 `tests/rebuild-executor.test.ts`，本件**在其内部扩用例**）。⚠️ 接手时**门禁是红的** ⇒ 本件前半段是"红→绿"，后半段才是覆盖率。

🔴 **接手即红：两条都在新用例里，且都是我的断言文案猜错**（**不是生产缺陷**）：
| # | 期望（猜的） | 实得 | 真因（**回源码取证**） |
|---|---|---|---|
| ① | `^no-session-id` | `2026-08-30--no-session-id` | `renameAfterRebuild` 里 `dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')` **只喂 `sessionId`**；标题最终由 `namingTitleFor` 成形，它**只认 `/^S\d+$/`**，否则**整个回退 `dirName`（且 summary 被丢弃）** |
| ② | `turn=?` | `(turn ? ended)` | 本文件的模板是 `(turn ${payload.turn ?? '?'} ended)`；而 `turn=?` 是**另一个文件**（`output-guard-seam.ts`，§2.7e）的措辞 |

⇒ ① 改为**两形态**（这才是那条 `replace` 真正的作用面）：`2026-08-30--no-session-id` ⇒ **逐字 = 目录名、不含概括**｜`2026-08-30--S123`（**无尾 `--`**，故 `--S###--` 匹配不上）⇒ `S123-2026-08-30-概括` ——🔴 **只有这一形态才走得到那条 `replace`**（否则它看似"死代码"，实则活在最窄的那条路上）。
🆕 🔴 **纪律：文案断言必须回「本文件」源码取证，不可从兄弟文件的地图段抄** —— 同族措辞跨文件**不通用**（② 就是抄了 §2.7e 的 `turn=?`）。

🔵 **本件最大产出：三处「疑不可达 / 未走到」被判为可达，且已覆盖**（判据都是"该行/该分支翻绿"的机械证据，不是"我读了源码"）：
1. `parseAnchorMdPath` 的 **`catch`** —— 🔴 **可达**（原为 §3-8 **第 14 行**的候选 ⇒ **不登记**）：源码只写 `message.content?.map(...)`，**无 `Array.isArray` 守卫** ⇒ `content` 是**字符串**时 `.map` 不是函数 ⇒ `TypeError` 进 catch。**判据**：加该形态前，本文件**唯一残余的两条未覆盖语句**正是 `catch` 体的 `return null` 与 `}`（`coverage` 的 `cstat-no` 实测）⇒ 加完**两条一起翻绿**。
2. `.map` 三元 **else 侧**（**非 text 内容项**，如 `{type:'image'}`）—— 可达（多模态消息常态）＋ 已覆盖。
3. `getActiveSessionInfo(dshSessionId)?.sessionId ?? sessionNameFromMdPath(mdPath)` 的**左侧**（活跃存储命中）—— 可达（**生产常态**：`use` 之后重启重建）＋ 已覆盖：用导出的 `setActiveSessionInfo('s1', …)` 注入 ⇒ 断言**锚点里含活跃会话名** ＋ 绑定行 `sessionId` = 活跃名。

**读数（锚定 18:29 那一跑）**：`rebuild.ts` 语句 **99.61% → 100%**（514 → **516/516**）｜分支 **88.69% → 100%**（**102/115 → 121/121**）｜函数 **14/14** ⇒ **三面全满**｜全仓语句 **96.15% → 96.16%**（24822 → **24824/25815**）；分支 **85.45%**（4964/**5809**）；函数 94.96%（867/913）｜**121 文件 / 1970 用例**（1962 → 1970）。提交 **`da75409`**（1 file / +129 −3）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（typecheck ／ test ／ coverage 三关全绿）。
⚠️ **读数口径（承 §2.7e，第三次实证）**：分支分母 **115 → 121**、语句分母恒 **516**，**源码一字未改** ⇒ 跨跑百分比不可直比；可比的是**绝对量 102 → 121**。

🔵 **两条可复用的挑靶/判据形态**：
1. **"某文件唯一残余的未覆盖语句"是高信噪信号** —— 先读 `coverage/src/<f>.ts.html` 的 `cstat-no`／`cbranch-no` **看清是哪几行**，再决定写什么形态（本件正是因为看清残缺就是那个 `catch`，才去证它可达）。
2. **"疑不可达"要用「真实故障形态」证伪或坐实**（㊾）—— 字符串 `content` ／ 图片内容项 ／ 活跃存储命中，三者都是产线真形态，比 mock 强。

🆕 🔴 **交接块自身的"预期读数"也会错**：上一块写「预期 `121/1969`」，实测 **1970**（追加段实为 **8 条 `it`**；而该块列 ①~⑦ 却在末项写"第 8 个用例"，**自相矛盾**）⇒ **交接块的预期数必须复测再引用**（与纪律 51/52 同族：**它也是读数**）。

⏭️ **本靶剩余**：`buildRebuildAnchor` 两处（`activeMdPath` 在根外 ／ `sessionName === ''`）｜`parseSessionContextFromEvents` 的**三守卫**（`!message` ／ `text ?? ''` ／ `.join('') ?? ''`）｜`performRebuild` 的 `if (!event) continue`｜两处 `(error as Error)?.message ?? error` 的 `?? error` 侧。⚠️ 本文件的**语句/分支/函数三面已满** ⇒ 上述残余应属"报告未展开"或已随手被覆盖，**下一步应先复核再决定是否值得开工**。

---

#### 2.7i ✅ ⑤ 第 24 件：**面 B 的 WS 反代残余面**（`gateway.ts`，2026-09-25 18:3x）—— 分支 **70.49% → 74.07%**

**靶** = `gateway.ts`（已满靶之外分支最低者之一）。新增 **`tests/gateway-ws.test.ts`（+1 文件 / 3 用例）**。

🔴 **本件第一条产出 = 纠正上一块的推断**：§2.7h 的"下一靶"提示里写着"整个 upgrade handler 未覆盖" —— **回报告逐行复核后发现不成立**：既有 `tests/gateway.test.ts` 的 v1.22.3 组**早就跑过一条已认证 WS upgrade**（断言 101 回写）⇒ 该段**不是整块未覆盖**，残余只有四类真分支。
⇒ 🆕 **纪律：不许把「上一块的叙述」当读数** —— "某段未覆盖"要**逐行读报告**（`cbranch-no`/`cstat-no`）才成立（与 §2.7h 的"文案断言要回本文件取证"同族：**兄弟块的叙述同样不是证据**）。

| 残余分支（逐行核对） | 覆盖它的形态（真 listener ＋ 真 socket ＋ 真上游） |
|---|---|
| `!authed(req)` **真侧** ＋ 其 3 条语句 | 裸 socket 发 upgrade **不带 Cookie** ⇒ 断言 **`received === ''`**（零字节回写）＋ 🔴 **上游 `upgradeSeen === false`**（请求根本没转出去 —— 比"没建立隧道"更强的判据） |
| upgrade 侧 `Array.isArray(v) ? v.join(', ')` | 上游 101 响应带**两条 `set-cookie`** ⇒ 断言客户端收到 `set-cookie: wsa=1, wsb=2` |
| `if (head.length > 0)` ／ `if (uhead.length > 0)` | 握手与载荷**同一次 write**（双向）⇒ 断言 `CHELLO` 到上游并 echo 回客户端、`UHELLO` 到客户端 |
| `upstream.on('response')` **整块**（非 101 透传） | 上游对 upgrade 回**普通 403**（含两个**应被过滤**的跳头）⇒ 断言客户端收到 `403` ＋ body ＋ **`connection:`/`upgrade:` 不得出现** ＋ 连接被 end（**不是挂起**）—— 即 v1.22.2 `ERR_INVALID_HTTP_RESPONSE` 的另一半回归钉 |

🔵 **判据形态（可复用）**：客户端**不引 WS 库**，用裸 `net` 手写 upgrade 请求 ⇒ 断言的是**客户端 socket 上真实收到的字节**；"载荷与握手同一次 write"是让 `head`/`uhead` 非空的**确定性做法**（报告随后证实两条分支翻绿）。

**读数（锚定 18:37 那一跑）**：`gateway.ts` 语句 **90.86% → 93.66%**（617 → **636/679**，+19）｜分支 **70.49% → 74.07%**（**86/122 → 100/135**，绝对量 **+14**）｜函数 **10/11**｜全仓语句 **96.16% → 96.23%**（24824 → **24843/25815**，+19）；分支 **85.5%**（4980/**5824**）；函数 94.96%（867/913）｜**122 文件 / 1973 用例**。提交 **`21e1e01`**（1 file / +293，新建）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（typecheck ／ test ／ coverage 三关全绿）。
⚠️ **读数口径（承 §2.7e，第四次实证）**：分支分母 **122 → 135**、语句分母恒 **679**，**源码一字未改** ⇒ 跨跑百分比不可直比；可比的是**绝对量 86 → 100**。

🔴 **诚实边界（刻意不覆盖，别当欠账）**：① 两处 `socket.write(...)` 的 `catch`（要 write 抛错 ＝ socket 已坏）② `usock.on('error')` 的销毁体（需**上游** socket 报错；上一条 RST 用例实测"上游未在 1.5s 内关闭"⇒ 触发面待定）③ `ures.statusCode ?? 101` ／ `statusMessage ?? 'Switching Protocols'` 的**默认侧**（上游写 101 却不给状态短语 ⇒ 近乎畸形报文）④ `req.url ?? '/'`（Node 对 HTTP 请求恒给 `url`）。

⏭️ **本靶剩余（供下一轮；⚠️ 均不属 WS 面）**：`buildDshCookieProvider` **整段**（`connection` 服务命中 ⇒ **dsh cookie 注入反代**，含首次诊断日志两态）｜`sync()` **生命周期四态**（`sig === lastSig` 早返回 ／ 重建前 `current.dispose()` ／ `!enabled` 停止日志 ／ `accounts === 0` 文案 ／ sync 失败 catch）｜`agent/created` 的 **cwd 迁移**（`cccRootForCwd` ＋ `migrateLegacyLocalStore`）。

---

#### 2.7j ✅ ⑤ 第 25 件：**DSH 安装位置探测的三条候选与失败终态**（`status.ts`，2026-09-25 18:4x）—— 该文件**三面全满 100%**

**靶** = `status.ts` 的 `readDshVersion()` —— **读已安装 DSH 版本**，属**衔接面**（ACC 得知道 DSH 装在哪、什么版本）。既有 `tests/status.test.ts` 只走过"**第三条候选恰好命中**"这一条路（本机 `~/.npm-global` 真有安装）⇒ 前两条 env 候选、`catch`、`return null` 终态**全未执行**。

🔴 **本件第一条产出 = 一条实测发现（推翻我自己写下的假设）**：我原计划"用 `process.env.HOME` 驱动第三条候选"（依据：`os.homedir()` 在 POSIX 上读 `$HOME`）—— **首跑即红**：改了 `HOME` 仍读到**本机真实安装**（返回真版本 `0.1.7-rc.2`）。
⇒ **结论：在本进程内改 `process.env.HOME` 不改变 `os.homedir()`**（机制**未定位**：Node 侧缓存 ／ 不经 env —— 两种解释都未被证伪）⇒ 要驱动第三条候选与 null 终态**只能对 `homedir` 做替身**。
🔵 **纪律（本件新增）：替身要「默认透传真实现」**（`home === null` ⇒ 原样调用真 `homedir()`），且**局限在需要它的用例里** —— 既拿到确定性，又不让整份测试"活在假环境里"。

| 覆盖的簇 | 形态（**前两条候选刻意不 mock**：真临时安装根 ＋ 真 env） |
|---|---|
| `npm_config_prefix` 命中 | 真临时安装根 ⇒ 取它，且**优先于** APPDATA（两候选都真存在的**正控**） |
| `APPDATA\npm` 回落 | 删掉 `npm_config_prefix` ⇒ 走 Windows 审计问题 13 的那条候选 |
| `catch` 前进（ENOENT） | 候选目录**在、`package.json` 不在** ⇒ `readFileSync` 抛 ⇒ **不中止**，继续下一个候选 |
| `catch` 前进（坏 JSON） | 候选文件**不是合法 JSON** ⇒ 同样继续（**坏文件 ≠ 中断**） |
| 无 `version` 字符串 | `{"version":123}` ⇒ 跳过该候选（不返回数字／undefined） |
| 第三条候选（`~/.npm-global`） | 🔵 **读数器自证**：设替身 ⇒ **真跟着替身走**（拿到假版本）—— 没有这一步，⑦ 的 null 可能是"替身没生效"的**假绿** |
| 🔴 全部失败 ⇒ `null` | 坏 JSON ＋ 无 version ＋ 替身指向空目录 ⇒ `null`（**读不到 ≠ 抛错**） |

**读数（锚定 18:42 那一跑）**：`status.ts` 语句 **92% → 100%**（92 → **100/100**，+8）｜分支 **73.33% → 100%**（**11/15 → 17/17**，绝对量 **+6**）｜函数 **3/3** ⇒ **三面全满**（🔴 判据 = 该文件报告里 **`cstat-no`/`cbranch-no` 零命中**）｜全仓语句 **96.23% → 96.26%**（24843 → **24851/25815**，+8）；分支 **85.58%**（4986/**5826**）；函数 94.96%（867/913）｜**122 文件 / 1980 用例**（同文件 +7）。提交 **`fec1c03`**（1 file / +122 −2）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（三关全绿）。
⚠️ **读数口径（承 §2.7e，第五次实证）**：分支分母 **15 → 17**、语句分母恒 100，**源码一字未改** ⇒ 不可直比；可比的是绝对量 **11 → 17**。
🔵 **同批销掉一条弱断言**：该文件原有 ④「`dshVersion` 是 null 或 string 皆可」——**实际上什么都没判** ⇒ 已由本组的确定性断言取代（原注释留在测试文件里作对照）。

⏭️ **下一靶：`weixin-hook.ts`（分支 73.33% ＝ 22/30）—— 但本件已先替后人复核过，结论是"不建议按这个数直接开工"**：其残余**多为平台门** —— ① 「bun 缺失 ⇒ 回落 node」整条链（**本机有 bun** ⇒ 不可达）② `child.on('error')`（需 spawn 失败）③ `runOnce` 的 spawn 同步 try/catch；而它的**真 spawn 路径已测**（`tests/weixin-hook.test.ts` 已有 5 例：真脚本 / 脚本缺失 / 路径逃逸 / 超时 / 非 0 退出）。
⇒ 可做的只剩 `input.file` 真侧 ／ stdout·stderr 日志两档（约 4 处）。🔴 **建议改挑别的靶，或把这 4 处当"顺手"而非独立一件**。

---

#### 2.7k ✅ ⑤ 第 26 件：**面 B 的 DSH BrowserAuth cookie 注入面**（`gateway.ts` 的接线，2026-09-25 18:4x）—— 分支 **74.07% → 78.47%**

**靶** = `gateway.ts` 对 `gateway-dsh-auth.ts` 的**接线**。🔵 **先复核的结论**：纯函数面（`pickDshCookie` ／ `exchangeDshCookie` ／ `mergeCookieHeader` ／ `createDshCookieProvider`）**已被 `tests/gateway-dsh-auth.test.ts` 全量覆盖**（该文件报告里**无 `cstat-no`**）⇒ 缺口**只在线**：
- `buildDshCookieProvider`：connection **可取／不可取**两态 ／ **首次诊断日志** ／ **成功缓存** ／ **外层 catch**
- `upstreamHeaders`：`dshCookie !== undefined` ⇒ **合并进反代上游的 cookie 头**

🔴 **为什么值得钉 = 这就是"与 DSH 的衔接面"本体**：v1.28.2 线上 bug —— DSH 0.1.2-rc.1 引入 BrowserAuth 后，3081 的反代请求**没有 dsh browser cookie** ⇒ 主端口 **401「dsh web authentication required」**（**整个公网面不可用**）。
🔵 **判据落在「上游真收到的 `cookie` 头」上**（不是"函数返回了什么"）：假主端口**记录 `req.headers.cookie`** ⇒ 一眼读出"注入发生没有、有没有把外部 cookie 覆盖掉"。

| 用例 | 形态与判据 |
|---|---|
| ① **无 connection**（旧 dsh／非 web 装配） | 上游**只**看到 `serenity_session=`（🔴 **正控**：先证请求真带着会话 cookie 到了上游，否则阴性判据毫无意义）＋ 诊断日志 `✗ 不可取` **只打一次**（连发两次请求验证） |
| ② **有 connection 且换取成功** | 上游**同时**看到 `dsh-auth-xyz=v1.body.sig` 与 `serenity_session=`（**合并语义** —— 不覆盖外部 cookie）＋ 诊断 `✓ 已内存换取` 一次 ＋ 🔴 **成功被缓存**（`authenticatedUrl` 计数 ＝ 1） |
| ③ **换取失败**（`authorizeIndex` 不写 set-cookie） | 不注入；🔴 **失败不被缓存**（`authenticatedUrl` 计数 ＝ **2** ⇒ 下次仍重试）—— 正/反两个**计数读数**都不含时间，**无 flake** |
| ④ `connection.authenticatedUrl` 是**抛错的 getter**（cordis「未声明属性一读就抛」的真形态） | 命中**外层 catch** ⇒ 不注入，且**面照常 200**（衔接面异常**不得**拖垮面本身） |

**读数（锚定 18:45 那一跑）**：`gateway.ts` 语句 **93.66% → 96.17%**（636 → **653/679**，+17）｜分支 **74.07% → 78.47%**（**100/135 → 113/144**，绝对量 **+13**）｜函数 **10/11**｜全仓语句 **96.26% → 96.33%**（24851 → **24868/25815**，+17）；分支 **85.67%**（5001/**5837**）；函数 94.96%（867/913）｜**123 文件 / 1984 用例**（+1 文件 +4 用例）。提交 **`c0c3ae4`**（1 file / +269，新建）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（三关全绿）。
🔵 **机械佐证（不只是"测试绿了"）**：该段原先在报告里成片的 `cstat-no`（`buildDshCookieProvider` 整段 ＋ 注入那一行）**已全部消失**。
⚠️ **读数口径（承 §2.7e，第六次实证）**：分支分母 **135 → 144**、语句分母恒 **679**，**源码一字未改** ⇒ 不可直比；可比的是绝对量 **100 → 113**。

⏭️ **本靶剩余（下一轮的自然续，仍属"装配与生命周期面"）**：`sync()` 的**生命周期四态** —— ① 重建前 `current.dispose()`（`sig` 变化）② `!enabled` ⇒ 停面 ＋ 日志 ③ 同步失败 catch（`gateway 同步失败`）④ `agent/created` 的 **cwd 迁移**（`cccRootForCwd` ＋ `migrateLegacyLocalstore`，含 `lastSig = null; sync()`）。
⚠️ **其余残留均为已登记边界**：`readBody` 超限体（待裁 ①）／WS 两处 `socket.write` catch（§2.7i）／`usock.on('error')`（§2.7i）。

---

#### 2.7l ✅ ⑤ 第 27 件：**面 B 的装配与生命周期面**（`gateway.ts` 的 `sync()`，2026-09-25 18:4x）—— 分支 **78.47% → 82.23%**；该文件**残余只剩已登记边界**

**靶** = `registerGateway` 里 `sync()` 的**四条真路径**（§2.7i／§2.7k 两件只攻了它的**请求处理面**）。

🔵 **驱动方式（本件确立，可复用）**：`ctx.on` 不再用 `vi.fn()`，改为**把监听器记下来再手动触发** ⇒ 三条事件入口（`agent/created` ／ `serenity/config-updated` ／ `serenity/settings-changed`）**全都成了可测入口**（此前它们只是"注册了但没人调用"）。

| 用例 | 形态与判据 |
|---|---|
| ① `!enabled` ⇒ **停旧面 ＋ 日志** | 开→关开关 ＋ 触发 `settings-changed` ⇒ `faceActive` **变 false** ＋ 日志含 `gateway 已停止` ＋ 🔴 **再连不上**（正控的反面：端口真被让出）—— 一并覆盖 `current.dispose()` 与 `!enabled` 两段 |
| ② `serenity/config-updated` ⇒ **`lastSig = null` 强制重建** | 配置**无任何实质变化**也必须重建 ⇒ 判据 = `gateway 已启动` 日志**由 1 条变 2 条** ＋ 重建后反代照旧 200 |
| ③ **同步失败 ⇒ catch 兜底** | 真故障形态：**设置源读取抛错**（`readSimpleSettings()` **无 try/catch** ⇒ 一路冒到 `queue` 的 `.catch`）⇒ 告警含故障串，且 🔴 **面仍活着、反代照常 200**（同步失败**不得**拖垮已起的面） |
| ④ `agent/created` 的 **cwd 迁移** | CCC 根（`.serenity` ＋ localstore 旧节）＋ 🔴 **必须先删全局文件** —— `migrateLegacyLocalstore` 见全局文件存在即 `return false`，**这是该路径的前置条件**，不删永远只测到 false 支 ⇒ 断言日志含 `已迁移 serenityAdvanced` ＋ **真写盘**（全局文件里出现那个 legacy 账号）＋ **幂等**（再触发不重复迁移） |

**读数（锚定 18:48 那一跑）**：`gateway.ts` 语句 **96.17% → 98.23%**（653 → **667/679**，+14）｜分支 **78.47% → 82.23%**（**113/144 → 125/152**，绝对量 **+12**）｜函数 **10/11**｜全仓语句 **96.33% → 96.38%**（24868 → **24882/25815**，+14）；分支 **85.79%**（5017/**5848**）；函数 94.96%（867/913）｜**124 文件 / 1988 用例**（+1 文件 +4 用例）。提交 **`e9ed90f`**（1 file / +278，新建）；`src/**` 零改动 ⇒ build ／ pack-check 不强制（三关全绿）。
🔵 **机械佐证**：该段原先成片的 `cstat-no`（`current.dispose()` ／ `!enabled` 停止日志 ／ 同步失败 catch ／ cwd 迁移 ／ `lastSig = null`）**已全部消失**。
⚠️ **读数口径（承 §2.7e，第七次实证）**：分支分母 **144 → 152**、语句分母恒 **679**，**源码一字未改** ⇒ 不可直比；可比的是绝对量 **113 → 125**。

⏭️ **本靶状态 = 只剩已登记边界（可视为"到头"）**：该文件残余 **12 条未覆盖语句**逐行核对后**全部**是 ① `readBody` 超限体（**待裁 ①** —— 硬凑会把假期望固化）② WS 两处 `socket.write` 的 catch ＋ `usock.on('error')`（**§2.7i 已登记**：需"socket 已坏"／"上游 socket 报错"）⇒ 🔴 **建议换靶**（`wake-registry.ts`／`unattended-seam.ts`／`acp-http.ts` 三件先逐行复核），或等 owner 拍板待裁 ① 后再回头收尾。

#### 2.7m ✅ ⑤ 第 28 件：**`acp-http.ts` 的门控／路由／入参边界面**（2026-09-25 18:5x–19:0x）—— 语句 **94.65% → 100%**，函数 **18/19 → 19/19**

**挑靶（先复核再开工）**：把 75% 档三件逐一读报告 —— `acp-http.ts` 语句 **94.65%（637/673）／分支 75.4%（92/122）／函数 18/19**｜`unattended-seam.ts` 97.26%（285/293）／分支 75%（51/68）｜`wake-registry.ts` 97.62%（329/337）／分支 75%（63/84）⇒ **`acp-http.ts` 绝对缺口最大（30 分支 ＋ 36 语句 ＋ 1 个从未执行的函数），且它没有专属测试文件**（既有覆盖率来自 `acp-core.test.ts` 的端点用例，锚定 18:4x–18:5x 那一跑）。
🔵 **HTML→源行映射（本次实测）**：`coverage/src/acp-http.ts.html` ⇒ **源行 = HTML 行 − 1411**（换一跑必重算，㉞ 同族）。

**落在既有文件里是刻意的**：夹具（`fakeCtx` ＋ ephemeral 端口 ＋ `__setSimpleSourceForTest` 替身 ＋ 三个 `vi.mock`）已全在 `tests/acp-core.test.ts`，另起文件要复制 ~120 行 ⇒ **增熵**。故新增的 15 用例作为该文件里的新 `describe('acp-http: 门控 / 路由 / 入参边界面（⑤ 第 28 件）')`。

| 用例 | 形态与判据（**逐行读 `cstat-no`/`cbranch-no` 后判可达**才写） |
|---|---|
| ① **双闸读取** | `faceEnabled(acpHttpSpec(...))` 三态：acp 开／ask 开／**两个都关 ⇒ false** —— 收掉那个**从未被执行**的函数（`enabled` 回调，`fstat-no`） |
| ② **两闸全关仍机械启动** | `startAcpHttpServer(ctx, 0)` **照样监听** ＋ 日志含 `未开启任何面` ⇒ 钉住 `face-host` 的不变量"**`startFace` 不读 `spec.enabled()`**、意图由调用方保证" |
| ③ **ACP 关闭 ⇒ 403** | acp 关 ＋ ask 开 ⇒ `POST /` 回 `{error:'ACP JSON-RPC disabled (…)'}`（门控的**真侧**，此前只走过开门那一侧） |
| ④ **真 parse error 帧** | `POST /` 发**非 JSON 体** ⇒ **400** ＋ `[{jsonrpc:'2.0', id:null, error:{code:-32700, message:'parse error'}}]` |
| ⑤ **问答页关的 /c/ 两条路由** | `GET /c/<name>` ⇒ 未启用提示页（200）｜`POST /c/<name>/ask` ⇒ 403 `public ask disabled`｜`GET /nope` ⇒ 404 `not found` |
| ⑥ **问答页开的 404** | GET 与 POST 两侧未知路径 ⇒ 404 |
| ⑦ **`/ask` 三类坏体** | `{bad` ／ `null` ／ `"str"` ⇒ 400 `invalid JSON body`（**体解析先于 ccc 解析**） |
| ⑧ **`/c/<name>/ask` null 体** | 400 `invalid JSON body`（**体解析先于 key 校验** —— 顺序本身是判据） |
| ⑨ **兼容面两条路都出真答** | `name` 命中 ⇒ 200 ＋ `answer:'a'`；`ccc` = **一个未被发现的根**（另建临时 CCC，非 `defaultRoot`）⇒ 走"**按 root 直接构造**"分支，角色从**那个根**读 ⇒ 200 ＋ `answer:'a'`（🔵 不只是"走到那几行"，而是**该分支真能用**） |
| ⑩ **403 两态** | `name` 未命中 ／ `name` 与 `ccc` 都没给 ⇒ 403 `container is not open for public ask` |
| ⑪ **question 三态** | 缺失 ／ 全空白 ／ **非字符串** ⇒ 400 `empty question` |
| ⑫ **无角色 ⇒ fail-closed** | 一个只有 `.serenity`、**没有 `.opencode/serenity.json`** 的根 ⇒ 400 `no skiff role available in ccc: <root>`（**不静默 200**） |
| ⑬ **顶层 500 兜底** | 真故障形态：**设置源抛错**（`readSimpleSettings()` 无 try/catch）⇒ 500 ＋ `{error:'settings-source-boom'}` ⇒ 面不崩、不挂死 |
| ⑭ **无默认根 ⇒ cwd 上溯** | 不传 root ⇒ `cccsOf` 走 `defaultRoot \|\| (cccRootForCwd(process.cwd()) ?? '')` 的右支 ⇒ 见下方**发现** |
| ⑮ **对任意抛出物都成立** | 抛**非 Error**（字符串）⇒ 500 ＋ `{error:'plain-string-boom'}`（走 `(err as Error)?.message ?? String(err)` 的右支） |

**读数（锚定 2026-09-25 18:5x–19:0x 那一跑）**：`acp-http.ts` 语句 **94.65% → 100%**（637 → **673/673**，+36）｜分支 **75.4% → 94.63%**（**92/122 → 141/149**，绝对量 **+49**）｜函数 **18/19 → 19/19 全满**。全仓语句 **96.38% → 96.52%**（24882 → **24918/25815**，🔴 **分母不变 ⇒ +36 全部来自本文件**）；分支 **85.79% → 86.22%**（5017/**5848** → 5066/**5875**）；函数 94.96% → **95.07%**（867 → 868/913）｜**124 文件 / 2003 用例**（同文件 +15）。门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。
🔵 **机械佐证（不只是"测试绿了"）**：该文件的 `cstat-no`/`cbranch-no`/`fstat-no` 标记数由 **64 → 6**（`grep -c` 层面可复核）—— 唯一剩下的是下面「诚实边界」那 8 条。

🔴 **本件最重要的一条发现（第 ⑭ 用例首跑即红，而**红的是我的期望**）**：我原判"无默认根 ⇒ 发现列表为空 ⇒ 空态页"，**实测解析到了外层那个 CCC** —— 本仓被检出在 `<某 CCC>/AI_LAB/dsh-serenity-plugin` 之下，`cccRootForCwd(process.cwd())` 上溯命中的正是**包含本仓的那个 CCC**（渲染出的卡片是它的目录名，且带 1 个问答角色）。
⇒ 三条结论：① 源码注释的"缺省回落进程 cwd 上溯（既有语义）"**是真会命中的**，不是空转；② 该用例改为**环境自适应断言**（不在任何 CCC 内 ⇒ 断言空态；在内 ⇒ 断言卡片名 = 外层 CCC 的目录名）；③ 🔴 **它的期望值由「独立读数器」算出**（测试里自己从 `process.cwd()` 上溯找 `.serenity`），**刻意不复用 `cccRootForCwd`** —— 用实现去验实现是自证（与 §2.7j 的"读数器要先证明不瞎"同族）。

🔵 **顺带发现（未在本件处置，仅登记）**：既有用例 `acp-http: HTTP JSON-RPC 端点（ephemeral 端口） > 非法 JSON → 400 parse error 帧` **标题名不符实** —— 它实际发的是**合法 JSON 对象** `{bad:'json'}`，断言的是 **200 ＋ `-32600 invalid request`**（"400 parse error"那句只对**非 JSON 体**成立）。⇒ 真正的 parse error 路（**400 ／ `-32700` ／ `id:null`**）**此前零覆盖**，由本件 ④ 首次覆盖。🔴 **我没改它的标题**（不属于本件范围；改标题会动既有用例 → 留给后续"文案与断言对齐"的一次性收口）。

🔴 **诚实边界（8 条残余分支，逐条判据 ⇒ 已登记 §3-8 第 14／15 行）**：全部是 `??` / `||` 的**防御性默认值**，其左操作数在可达空间内**恒非空**：常量门 1 条（`FACE_PORTS.acpHttp.host ?? '127.0.0.1'`）｜平台门 2 条（`req.url ?? '/'`、`remoteAddress || 'unknown'`——真 HTTP 请求二者必有）｜**构造上不可达 4 条**（`split('?')[0] ?? '/'`、`cMatch[1] ?? ''`、`aMatch[1] ?? ''`、`filter(Boolean).pop() ?? cccValue`）｜环境相关 1 条（`cccRootForCwd(process.cwd()) ?? ''`——本机 cwd 在 CCC 内 ⇒ 不触发）。⇒ **刻意不为它们硬凑用例**（硬凑 = 把"从不发生"固化成"期望形态"）。

#### 2.7n ✅ ⑤ 第 29 件：**`wake-registry.ts` 的读面容错／写面失败／结案清理**（2026-09-25 19:0x）—— 语句 **97.62% → 100%**，分支 **75% → 96.29%**

**挑靶（先复核）**：75% 档剩下的两件里，本件选 `wake-registry.ts`（97.62% ＝ 329/337｜分支 75% ＝ 63/84）而**没选** `unattended-seam.ts`（97.26% ＝ 285/293｜分支 75% ＝ 51/68）—— 判据不是 branch% 大小，而是**残余的性质**：本文件那 8 条未覆盖语句**全是失败面与清理面**（两处 `catch` ＋ `purgeFinalizedWakes` 的写盘路径），而 `unattended-seam.ts` 的残余多为「平台门 ＋ 已登记边界」。锚定 19:0x 那一跑。

🔴 **本件最值钱的一处**：**`purgeFinalizedWakes` 的真写盘路径从未被执行过** —— 它正是「**owner 2026-09-19 裁「直接删」**」把那张只增的表（实测 **308 KB / 143+ 条**）刹住的那条路。此前只有"无可清 ⇒ 空转"这一侧被跑到，**真正清掉 143 条的那段代码一次都没跑过**（测试夹具的注册表每次都从零起）。
🔵 **HTML→源行映射（本次实测）**：`coverage/src/wake-registry.ts.html` ⇒ **源行 = HTML 行 − 739**（换一跑必重算，㉞ 同族）。

🔴 **失败路径一律用「真实故障形态」注入（㊾）——不用 mock**：两处注入物都是**盘上的真实形态**：① 注册表正文是**损坏的 JSON**（本表随 CCC git、人可手改 ⇒ 真会坏）② **路径被占成目录**（`wake-registry.json.tmp` 被一个目录占住 ⇒ `writeFileSync` EISDIR ⇒ `saveWakeRegistry` 的 catch）。🔵 一个故障形态**同时覆盖多条分支**：坏表 ⇒ `loadWakeRegistry` catch ＋ 五个消费者各自的 `if (error)` 早退。

| 用例 | 形态与判据 |
|---|---|
| ① 坏 JSON ⇒ load 回空表 ＋ error | **不抛**（调用方决定是否告警）；错误串含 `唤醒注册表解析失败` |
| ② 坏表之下五个动作各自回稳定错误 | `addWake`／`updateWake`／`removeWake`／`finalizeWake`／`purgeFinalizedWakes` **全回 `ok:false`**，purge 的 `purged:0`；🔴 **判据落在盘上**："读不出来 ⇒ **一个字节都不许改**"（前后逐字比对） |
| ③ 手改容错（形状） | `entries` 非数组 ⇒ 空表；`null`／数字／字符串／缺 `id`／缺 `target`／缺 `at` **一律丢弃该条而不阻断整表**；**未知 `state` 不丢条目** ⇒ 回落 `pending` |
| ④ 手改容错（数值） | `createdBy`/`createdAt` 非串 ⇒ `''`；`attempts` 非数 ⇒ `0`；🔴 **`Number.isFinite` 那一侧**：JSON **源码里**写 `1e999` ⇒ 解析成 **Infinity** ⇒ 也算 `0`（⚠️ `JSON.stringify` 表达不了这点——它会把 Infinity 写成 `null`，故本用例必须写字面量） |
| ⑤ 注册表路径被**占成目录** | load **报错而非抛**（`readFileSync` 对目录 EISDIR） |
| ⑥ 写盘失败 ⇒ **addWake** | `ok:false` ＋ 🔴 **不留下半个表**（`existsSync` 为假 —— 失败不得产生一个"看起来已登记"的表） |
| ⑦ 写盘失败 ⇒ **updateWake** | `ok:false` ＋ 盘上那条**逐字未变**（失败不得"看起来已改"） |
| ⑧ 写盘失败 ⇒ **removeWake** | `ok:false` ＋ `removed:null` ＋ 那条**仍在盘上** |
| ⑨ 写盘失败 ⇒ **finalizeWake** | `ok:false` ＋ `removed:null` ＋ 那条**仍在盘上**（**结案不能"半结"**） |
| ⑩ 写盘失败 ⇒ **purge** | `{ok:false, error:<写入失败>, purged:0}` ＋ 盘上逐字未变（🔴 **不许只报"清掉了"而实际没落盘**） |
| ⑪ finalizeWake 命中 | 返回的 `removed` **带终态与结果文案**（终态只在返回值上留痕）＋ **表里不留行** |
| ⑫ **purge 真清理** | 2 pending ＋ 3 终态 ⇒ `purged:3` ＋ 盘上**只剩两个 pending**（真写盘，不是内存里过滤） |
| ⑬ 无终态 ⇒ **不写盘** | `purged:0` ＋ 盘上**逐字不动**；🔴 连"表都不存在"时也**不得凭空建一个空表** |
| ⑭ 未知 id | `finalizeWake`／`updateWake` 都回 `wake_not_found: <id>`，且**报错不得顺带建条目** |
| ⑮ `at` 无法解析 | `addWake` **原样透出** `parseWakeAt` 的错误（`!parsed.ok` 分支） |

**读数（锚定 2026-09-25 19:0x 那一跑）**：`wake-registry.ts` 语句 **97.62% → 100%**（329 → **337/337**，+8）｜分支 **75% → 96.29%**（**63/84 → 104/108**，绝对量 **+41**）｜函数 **14/14**（本来就满）。全仓语句 **96.52% → 96.55%**（24918 → **24926/25815**，🔴 **分母不变 ⇒ +8 全部来自本文件**）；分支 **86.22% → 86.57%**（5066/**5875** → 5107/**5899**）；函数 95.07%（868/913）｜**124 文件 / 2018 用例**（同文件 +15）。门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。
🔵 **机械佐证**：该文件的标记数 **30 → 4**，剩下 4 条**全是构造上不可达的防御性默认值**（§3-8 第 16 行）。

🔵 **一条可复用的手法（本件新增）**：**"失败不得留下痕迹"要落在盘上断言，不是落在返回值上** —— 本件 6 条写失败用例**每条都同时断言"返回 `ok:false`"与"盘上逐字未变（或压根没建文件）"**。返回值是**声明**，盘上内容才是**事实**（与 ㊿「远程操作断言远端状态而非返回文本」同一条思路的近亲）。

#### 2.7o ✅ ⑤ 第 30 件：**`unattended-seam.ts` 的装配面／守卫面／清理面**（2026-09-25 19:1x）—— 语句 **97.26% → 100%**，分支 **75% → 91.66%**

**挑靶（先复核）**：75% 档最后一件。残余的性质 = **三条 handler 的守卫与 catch ＋ 装配 catch ＋ 卸载 disposer** —— 全是**两条铁律**的落点（「本模块的任何失败都不得影响 turn 收尾」／「防按载体只增」），**不是**纯防御性 `??` ⇒ 值得开工。锚定 19:1x 那一跑。
🔵 **HTML→源行映射（本次实测）**：`coverage/src/unattended-seam.ts.html` ⇒ **源行 = HTML 行 − 651**（换一跑必重算，㉞ 同族）。
🔵 **先查"哪些已经测过"**：既有 `tests/unattended-seam.test.ts` 已覆盖**语义主体**（闸门／用户在场判据／CRO 让位／验证码回路／假完成打回／让位清理）；本件只补**它驱动不到的形态**——因为既有 `harness()` 把**事件处理器表与 effect 回调都吞掉了**，畸形 payload 与"卸载"两类形态**结构上驱动不了**。

🔴 **驱动方式（本件关键）**：自建 `seamRig()` —— 装配一个**暴露 handler 表 ＋ effect 回调**的 ctx（`on` 记录、`effect` 收集），于是"畸形 payload""卸载"都成了可测入口。**既有 harness 一行未改**（新块自带夹具）。

| 用例 | 形态与判据 |
|---|---|
| ① **装配面** | `ctx.on` 不可用（`registerUnattendedSeam({})`）⇒ **不抛** ＋ 🔴 **四个事件各自响亮降级**（日志恰 4 行）⇒ 钉「装配不可成为启动单点」 |
| ② turn-stopping 守卫 | 载体 id 非串 ⇒ 短路**在"取事实"之前**（零 steer）＋ 🔴 **正控**：同一条链只换 id ⇒ 真注入 |
| ③ turn-stopping | payload 里**没有 agent**（`{}` ／ `undefined`）⇒ 直接返回、不抛 |
| ④ `delegationDepth` | **缺省 ⇒ 视为主会话**（仍注入）；显式 `2` ⇒ 不代理（对照，同一用例内正反成对） |
| ⑤ turn-stopping catch | 真故障形态：**宿主形态的抛错 getter**（`.session` 一读就抛，同 §2.7k 的 `authenticatedUrl`）⇒ 吞掉 ＋ 记一行（**turn 收尾不被本机制影响**） |
| ⑥ claimed 守卫 | 载体 id 取不到 ⇒ 什么都没记；🔴 **`turn` 非数字 ⇒ 记作 `-1`**（判据 = `isUserTurn(sid, -1)` 为真 —— **用户在场信号不丢**，而不是"当没发生"） |
| ⑦ `cwdOf` 回落 | `header.cwd` 取不到 ⇒ 回落 `process.cwd()`（让位照常发生）。🔴 **刻意不绑定轨迹** ⇒ 那条 I/O 路径无落点、只回 false（**不把测试写进真 CCC**） |
| ⑧ claimed catch | 同上抛错 getter ⇒ 吞掉 ＋ 记一行（不干扰宿主事件链） |
| ⑨ 两条 disposed 守卫 | id 缺失／畸形（`{}` ／ `''` ／ 数字）⇒ 直接返回，且 🔴 **不得误清别的载体**（正控：另一个载体的代理段仍在） |
| ⑩ **卸载 disposer** | 捕获 `effect` 回调并执行（`rig.effects[0]!()()`）⇒ **两张进程内表都清空**（代理段 ＋ 用户轮次）⇒ 钉「按载体只增」的**卸载面** |
| ⑪ 流水落盘失败 | 真故障形态：**`unattended-log.json.tmp` 被占成目录** ⇒ 如实记一行「流水未落盘」，而 🔴 **机制本体照常**（打回已发生） |

**读数（锚定 2026-09-25 19:1x 那一跑）**：`unattended-seam.ts` 语句 **97.26% → 100%**（285 → **293/293**，+8）｜分支 **75% → 91.66%**（**51/68 → 77/84**，绝对量 **+26**）｜函数 **9/9**（本来就满）。全仓语句 **96.55% → 96.59%**（24926 → **24936/25815**，**分母不变**）；分支 **86.57% → 86.78%**（5107/**5899** → 5134/**5916**）；函数 95.07%（868/913）｜**124 文件 / 2029 用例**（同文件 +11）。门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。
⚠️ **口径诚实说明**：全仓语句 **+10**，其中本文件 **+8**；另 **+2 未逐一定位**（🔵 **推测**：本件 ① 首次用**缺 `effect` 的 ctx** 装配本缝 ⇒ 触达 `host/effect.ts` 的「`ctx.effect` 不可用 ⇒ 响亮降级」那几行 —— 属**推测**，未做逐文件对账）。
🔵 **机械佐证**：该文件标记数 **26 → 7**，剩下 7 条**全是构造上不可达的防御性默认值**（§3-8 第 17 行）。

🔴 **本件首跑红一条，而红的是我的期望**（同 §2.7m 的家族）：第 ⑩ 用例我写成"先开代理段、再 claim（kind=user）"⇒ 断言"代理段还在"**失败**（得到 null）。**真因是设计**：`claimed` 一旦发现代理段存在，**当场让位清掉它**（`user-returned` ⇒ `clearProxyRun`）—— 那正是「**单一续驱者**」的实现。⇒ 改法不是放宽断言，而是**修正顺序**（先 claim 记轮次、后开代理段），并在用例里写明"反过来写就测不到"。🔵 **教训形态**：**"我的夹具顺序"本身就是被测语义的一部分** —— 顺序错了，测到的不是 bug 而是另一条正确行为。

---

#### 2.7p ✅ ⑤ 第 31 件：**`api.ts` 的 `resolveWorkspace` 默认箭头**（2026-09-25 19:2x）—— 该文件**函数面 22/23 → 23/23 全满**

**靶** = `api.ts` 的**唯一未执行函数**：`let listCwds: () => string[] = () => []`。🔵 **面是上一件之前就定好的**（§2.7d 末尾那条"挂账销项"已把它从"疑不可达"改判为**可达**：`resolveWorkspaceCore` 无条件调用 `listCwds()`）。锚定 19:1x 那一跑。
🔵 **HTML→源行映射（本次实测）**：`coverage/src/api.ts.html` ⇒ **源行 = HTML 行 − 1551**（换一跑必重算，㉞ 同族）。
🔵 **挑靶依据 = 逐行读 `fstat-no`／`cstat-no`，不按 branch% 排序硬上**：当时 `api.ts` 语句面已 99.73%，**另一处 2 条属构造上不可达**（地图 §3-8 第 9 行已登记）⇒ **补掉这条函数即可让该文件函数面全满**，是**廉价靶**。

🔴 **为什么既有用例没覆盖到（本件要回答的问题）**：⑤ 第 17 件那组测的是**"列表在场"的两条路**（`sessions.get` ／ `sessions.list`）—— 而默认箭头只在**宿主连 `sessions` 服务都没有**时才存活到被调用。夹具 `bootApi()` 的 `ctx.get` 对 `sessions` 在**两个 want 旗标都未给**时**返回 `undefined`** ⇒ 正好是那个形态。

| 用例 | 形态与判据 |
|---|---|
| ① **默认箭头被真调用** | `bootApi()`（不带任何 opts）⇒ `ctx.get('sessions') === undefined` ⇒ `hostSessions` 得 `undefined` ⇒ `sessions?.list` 非函数 ⇒ `listCwds` **保持默认箭头** ⇒ `listCwds()` 回空表 ⇒ **回落 `process.cwd()`**。🔴 **环境自适应断言**：由**独立读数器** `enclosingCccFromCwd()`（测试内自建、从 `process.cwd()` 上溯找 `.serenity`）算期望值 —— 在外层 CCC 内 ⇒ 断言 `root` = **那个外层 CCC**；不在任何 CCC 内 ⇒ 断言 `root` 为 `null`（同 §2.7m 的家族） |
| ② **判别性对照** | `bootApi({ liveSessionCwds: [ccc] })` ⇒ `list` 在场 ⇒ 落点**变成**它给的 cwd（`toBe(ccc)`）**且** `not.toBe(enclosingCccFromCwd())` ⇒ 证明 ① 的结果**确实来自默认箭头那条路**，而不是碰巧与 cwd 上溯同值 |

🔵 **独立读数器（刻意不复用 `cccRootForCwd`）**：用实现去验实现是**自证**（同 §2.7j 的"读数器本身要先证明不瞎"）。⇒ 本件的**对照用例是判别性的**（②把落点挪走，于是①的断言不再是"两边都算得出同一个值"的空断言）。

**读数（锚定 2026-09-25 19:19 那一跑）**：`api.ts` **函数 22/23 → 23/23（100%）**；语句**恒 99.73%**（**741/743**，分母不变 —— 剩下 2 条即源 200/201 那处 catch 的注释＋`}`，**构造上不可达**，**别去硬凑**）；分支 **82.96%**（190/229）。全仓语句 **96.59%**（24936 → **24937/25815**，分母不变）；分支 **86.78%**（5134/**5916** → 5137/**5919**，🔵 分母随执行而变，§2.7e 系列）；函数 **95.07% → 95.18%**（868/913 → **869/913**，**+1 恰为本件那条箭头**）。**124 文件 / 2029 → 2031 用例**（同文件 +2）。门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。
🔵 **机械佐证（本件的直接验收判据）**：`coverage/src/api.ts.html` 里 **`fstat-no` 归零**（grep 该报告全文，命中 **0**）；残余 `cstat-no` **恰 2 条**，HTML 1751／1752 行 ⇒ 按本次偏移 **1551** 映射回**源 200／201 行**（`/* 遍历失败 → 空列表 */` ＋ `}`）**逐字对上** ⇒ 与 §3-8 第 9 行登记的"三层吞异常 ⇒ 不可达"**同一条**，无新增缺口。

---

#### 2.7q ✅ ⑤ 第 32 件：**`tools/*` 的 `output.render` 通路**（9 文件一次触达，2026-09-25 19:2x）—— 函数面 **+17**，`fstat-no` **44 → 27**

**靶** = §3-9b 复扫聚类的 **A 类**（`tools/*` 的 render 面：**9 文件 / 23 处**）。🔴 **本件是"用扫描结果挑靶"的第一个件** —— 靶不由上一块的 ⏭️ 叙述推出，而由报告本身推出（§3-9b 立的那条纪律的首次执行）。
**新增** `tests/tools-render-face.test.ts`（**+1 文件 / 18 用例**）。

🔴 **可达性先在源码层取证（本件全部断言的前提，不是样板）**：读 `@deepseek-ai/dsh-tools` 的 `defineTool` 实现 —— 它返回**普通对象**，其 `output.render(args, value)` 就是 `return userRender(args, value)`。⇒ 两条推论：
① `tool.output.render(...)` **确实可达**；
② 🔴 **本件刻意不用 `vi.mock('@deepseek-ai/dsh-tools')`**（`acc-diag.test.ts` 用的是 identity 桩 `defineTool: (o) => o`）—— 走**真的 `defineTool`** ⇒ 测到的是**产线那个包装**，不是替身。
🔵 **同批的自证**：测试首条用例先钉"**9 个工具对象都真的暴露 `output.render`**"，并断言 `TOOLS` 长度 = 9（**扫描域自证** ⇒ 防"扫了零个 ⇒ 永远绿"，同 §3-9 #7 的写法）。

🔵 **9 个靶的构造分两族**（本件要处理的实际差异）：**模块级常量** `praxisTool` ／ `ccFsTool` ／ `gitTool` ／ `localstoreTool`；**工厂** `createKitTool(ctx)` ／ `createContainerAdminTool(ctx)` ／ `createImBridgeTool()`（**无 ctx**）／ `createHandymanTool(ctx)` ／ `createAccDiagTool(ctx)`。🔵 **实测：5 个工厂在"构造"时都不碰 `ctx`**（`ctx` 只在 `execute` 体内被用）⇒ 传一个空壳即可；`ctx` 的类型**从工厂形参派生**（`Parameters<typeof createKitTool>[0]`），**不额外 import `cordis` 的类型**。🔵 **`args` 传什么是无所谓的** —— 9 个 render 闭包**全部忽略第一个形参**（`(_args, value)`，或名为 `args` 但体内只读 `value`）。

| 用例 | 形态与判据 |
|---|---|
| ① **可达性自证** | 9 个工具对象都暴露 `output.render`（拿不到 ⇒ **响亮抛错**，不静默跳过）；＋ `TOOLS` 长度自证 |
| ② **字符串值** | 每个工具 ⇒ **恰好一个 `text` 块**、正文**逐字相等**（`textOf()` 先验形状再取正文） |
| ③ **判别性探针**（同用例内） | 喂一个**长得像 JSON 的字符串**（`{"a":1}`）⇒ 必须**原样透传**；若实现被写成"先 stringify"或两分支接反 ⇒ 这里会得到**带转义的引号串** |
| ④ **非字符串值**（仅 8 个 json 工具） | 归一化为 `JSON.stringify(value, null, 2)`；样本刻意用**键序非字典序 ＋ 嵌套 ＋ 混合类型**（同时钉"缩进 2"与"键序保持插入序"）＋ **正控**：期望值本身必须含换行（否则该断言对"没缩进"也成立 ⇒ 空断言） |

⚠️ 🔴 **契约边界（决定 praxis 少一条用例 —— 这是本件唯一的"刻意不做"）**：`output.schema` **只有 `praxis` 是 `{ type: 'string' }`**，其余 8 个都是 `{ type: 'json' }`。而 `praxis` 的 `execute` **恒返回字符串**（`EAP_CONTENT` / `NEAT_CONTENT` / `CCE_CONTENT` / `PRAXIS_INDEX`）⇒ 那条 `JSON.stringify` 支线**在产线永不执行**（"构造上不可达／防御性归一化"档）。**刻意不测它** —— 硬凑会把"从不发生"固化成"期望形态"（同 §2.7b／§2.7n 的判断）。🔵 **本件要的是函数面**（`fstat-no` 归零），**进入函数即可**，不需要把不可达支线填满。✅ **事后复核佐证**：`praxis.ts` 残余 `cbranch-no` **恰 1 条，且就是那句 `value : JSON.stringify(value, null, 2)`** ⇒ "它是唯一残余"是**读数**，不是断言。

**读数（锚定 2026-09-25 19:25 那一跑）**：
- 🔴 **机械判据（本件的直接验收）**：`coverage/src/**/*.html` 的 **`fstat-no` = 27 处**（改前 44）——🆕 **`44 → 27` 是本件开工前"预登记"的预测值，实测逐字命中**（同 §2.7i/o 家族：预测可证伪才算判据）。
- **A 类**：**23 处 → 6 处**（亦为预登记值，命中）。残余 = **5 个 `execute`**（`cc-fs`／`git`／`kit`／`localstore`／`im-bridge`）＋ **`handyman.parseJobs`**（它只在 `jobs` 多任务编排路径被调用 ⇒ 归"execute 面"那件，见下）。
- **9 文件函数面**：`praxis` ／ `acc-diag` ／ `container-admin` **→ 100%**；`cc-fs` ／ `git` ／ `localstore` → **66.66%**（2/3）；`kit` ／ `im-bridge` → **75%**（3/4）；`handyman` → **90.9%**（10/11）。⇒ 每处**恰余 1 个未执行函数**，且都恰是上面点名的那一个。
- **全仓**：语句 **96.59% → 96.73%**（24937 → **24971/25815**，**分母不变**）；分支 **86.78% → 86.88%**（5137/**5919** → 5173/**5954**，🔵 分母随执行而变，§2.7e 系列）；函数 **95.18% → 97.04%**（869 → **886/913**）——🔴 **`+17` 恰等于"本件覆盖的 17 处"**（8 文件各 2 处 ＋ `acc-diag` 1 处），**函数面这一对账是本件最硬的一条交叉验证**。
- **125 文件 / 2049 用例**（+1 文件 +18 用例；**改前预登记为 2049 ⇒ 命中**）。
- 门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。

🔵 **本件顺带查明（另一处"残余的性质"，供下一件）**：`container-admin.ts` 残余 `cbranch-no` **3 条，全在 `role` 域的 `execute`**（`gate.reject` 抛出 ／ `case 'apply'` ／ `default` 抛出）——**不在 render 面** ⇒ 证明本件把该文件的 render 面**真的做满了**，残余属"execute 面"那件。

⏭️ **下一件（第 33 件）= 同族的"execute 面"**：5 个 `execute` ＋ `handyman.parseJobs`。🔴 **风险面与 render 面不同**（要吃各自的 `ctx`/`exec` 夹具 ⇒ 正是 §3-9 #7 的 **fake ctx 盲区**所在）⇒ **必须单独一件、单独判据**，不可与本件混做。

---

#### 2.7r ✅ ⑤ 第 33 件：**`tools/*` 的 `execute` 通路**（5 个 `execute` ＋ `handyman.parseJobs`，2026-09-25 19:3x）—— 函数面 **+6**，`fstat-no` **27 → 21**；🔴 **`src/tools/` 函数面 60/60 全满**

**靶** = §3-9b 复扫后的**残余 A 类**（6 处 / 6 文件）—— 即 §2.7q 点名留给本件的那 6 处。🔵 本件与 §2.7q 的**唯一分工判据**：`render` 面**不吃夹具**（`args` 随便传），`execute` 面**要吃 `ctx`/`exec`**。
**新增** `tests/tools-execute-face.test.ts`（**+1 文件 / 13 用例**）。

🔴 **夹具纪律（本件最容易翻车的地方）**：`exec` 一律用**真值形态** —— `{agent:{session:{header:{cwd}}}}`（`cccRootForExec` 读的就是这条链），`cwd` 指向**临时 CCC**；⚠️ **`exec` 必须带 `cwd`**（否则回落 `process.cwd()`，工具会去**跑测试的那个真 CCC 根**里找夹具 —— 同 §2.7e 的 `trajectory-tool` 教训：**症状与"逻辑错"不可区分**）。三个夹具：`ccc`（有 `.serenity` ＋ `handyman` 配置）／`outside`（**无** `.serenity`）／`gitCcc`（有 `.serenity` ＋ 真 `git init`）。

🔴 **本件的核心产出 = 「无 CCC」时三种不同政策并排钉住**（此前从未被执行过 ⇒ 从未被钉住；三者是**同一个问题的三种设计选择**，任一处被改成另一种，本组先红）：

| 工具 | 无 CCC 时的行为 | 判据 |
|---|---|---|
| `container_fs` ／ `container_git` ／ `localstore` | **抛** `NO_CCC_FROM_AGENT_CWD` | 期望值取自**真常量**（不硬编码文案） |
| `dashboard` | **不抛** ⇒ `status: degraded`（对齐 osp 未激活语义） | 🔴 **判别性**：不能只断言 `status`（"任何原因的 degraded"都会让它绿）⇒ 同时钉 `principles.P1_rooted.pass === false` |
| `im-bridge` | **不抛** ⇒ **结构化** `{ok:false, code:'CCC_UNRESOLVED'}` | 稳定错误码 ＋ 稳定语义 |

**其余用例（在 CCC 内的正常面）**：`container_fs root` ⇒ 返回值**逐字等于夹具目录**（最强形态：不是"有个 root 字段"，而是"根解析结果 = 我造的那个目录"）｜`container_git status` ⇒ **真 git ＋ 真解析**（见下方首跑红）｜`dashboard time` ⇒ `epoch_ms` 与 `Date.now()` 相差 <5s（**正控式**：常量返回值也能让"字段存在"变绿）｜`localstore list` ⇒ `{scope:'credential', keys:[]}`（**空库是真实初态**）｜`im-bridge` 未知通道 ⇒ `CHANNEL_UNKNOWN` 且提示含通道名。
**handyman 三态**：数组项缺 `label` ⇒ `parseJobs` 返回 null ⇒ **响亮抛错**（且**没有任何子代理被起**）｜合法 jobs 但**超 `maxParallel`** ⇒ 抛上限错误（夹具把 `maxParallel` 调成 1 ⇒ **不需要起任何子代理**就能走到这条校验）｜🔴 **登记一条不可达边界**（见下）。
**契约面一条**：非法 `enum` ⇒ 抛 `ToolArgsError` ——🔵 这条是"**本件用真 wrapper 而非 identity 桩**"的直接回报（桩掉 `defineTool` 就没有这层校验），与 §2.7q 的选择一致。

🔴 **登记一条"经工具面不可达"（本件把散文变成了机械读数）**：`parseJobs` 首行是 `if (!Array.isArray(raw) || raw.length === 0) return null`，**但**工具面声明 `jobs: { type: 'array' }` ⇒ 真 wrapper **在执行前**就按 schema 拒掉非数组 ⇒ 该支线**经工具面不可达**（`parseJobs` 未导出、唯一调用点就在本 `execute` 内）⇒ **刻意不硬凑**（house rule：别把"从不发生"固化成"期望形态"）。✅ 本件用一条**正控**把它钉成读数：喂 `jobs: 'nope'` ⇒ 得到的是 `ToolArgsError`（**不是**那条 `parseJobs` 错误）⇒ 不可达性**可复现**。

🔴 **本件首跑红一条，而红的是我的期望**（同 §2.7m／§2.7o／§2.7q 的家族）：`container_git status` 我断言 `clean: true`，实测 **false**。**真因是夹具而非代码** —— 本夹具为了让根解析成立，必须在目录里放 `.serenity`，而**那个文件自己就是未跟踪文件** ⇒ 该仓库**永远不会干净**。
🔵 **教训形态（可复用）**：**"在临时 CCC 里 `git init` 后仓库是干净的"是一个不成立的初态** —— CCC 标记文件本身就是未跟踪内容。⇒ 改法**不是**放宽成"有个 `clean` 字段"，而是**改钉它真正报告的东西**：未跟踪条目**恰好两条且逐条对上**（`?? .serenity` ／ `?? keep.txt`）＋ `summary` 文案 ⇒ 这比 `clean:true` **更能**证明"真跑了 git 且真解析了输出"。

**读数（锚定 2026-09-25 19:30 那一跑）**：
- 🔴 **机械判据（预登记 → 实测，三项逐字命中）**：`fstat-no` **27 → 21**；**A 类 6 → 0**（`tools/*` 残余**清零**）；test **126 文件 / 2062 用例**。
- **函数面 `+6`，恰等于靶数**（5 个 `execute` ＋ `parseJobs`）：全仓 **886 → 892/913（97.69%）** —— 与 §2.7q 同款的**绝对值对账**。
- 🆕 **域级里程碑**：**`src/tools/` 的函数面 = 60/60（100%）** ⇒ **整个工具面已无"零执行函数"**（该目录语句 95.98%、分支 84.71%，残余都是已登记的分支档，不是未执行函数）。
- **全仓**：语句 **96.73% → 96.89%**（24971 → **25014/25815**，分母不变）；分支 **86.88% → 86.94%**（5173/**5954** → 5197/**5977**，🔵 分母随执行而变）。
- 门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。

⏭️ **⑤ 的下一档（本件之后）**：A 类已清零 ⇒ 只剩 **B 类**（`readSimpleSettings().enabled` 闭包：`gateway.ts` ＋ `skiff-debug.ts`，2 处，廉价）与 **C 类**（12 文件 / 19 处单点，含 `seams/guards` 4 处 —— **逐条先证可达性再动手**）。

---

#### 2.7s ✅ ⑤ 第 34 件：**面规格的「意图读取」通路**（`FaceSpec.enabled` ← `faceEnabled`，2026-09-25 19:3x）—— 函数面 **+1**，`fstat-no` **21 → 20**；🔴 **本件一半是靶、一半是发现**

**靶** = §3-9b 的 **B 类**（`readSimpleSettings().enabled` 闭包，2 处 / 2 文件）。🔴 **但本件只覆盖了其中 1 处** —— 另一半在动手前被判为**构造上不可达**。**本件的价值恰在这个分档**。
**改的是既有文件**：`tests/skiff-debug.test.ts`（**+3 用例，文件数不变**）。

🔴 **本件的方法学主线 = 挑靶四条的第 ③④ 条（可达性 ／ 残余的性质）真的挡住了一次"假绿"**：
1. **先查谁读它**：`grep -n "\.enabled()" src/` ⇒ **四个面都声明**（`weixin` ／ `acp-http` ／ `gateway` ／ `skiff-debug`）；`grep -n "faceEnabled(" src/` ⇒ **全仓只有一个读者、且只有一处调用点**（`weixin-send-api.ts`）。
2. ⇒ **`gateway` ／ `acp-http` ／ `skiff-debug` 三处的声明当前无人读取**。
3. **再分档**：另两个未读者**各有 spec 构造函数**（`acpHttpSpec` ／ `skiffDebugSpec`）⇒ 可按**既有形态**（§2.7m 的 acp 三态写法）覆盖；**`gateway` 不行** —— 它的 `enabled` 是 `startFace({...})` 里的**内联字面量**，`gateway.ts` **没有 spec 构造函数**（唯一导出是 `registerGateway`）⇒ 对象**从不外泄** ⇒ **既不会被读，也无法以同一形态取到**。
4. ⇒ **决定**：`skiff-debug` 那处**照测**（用**文档化的读者** `faceEnabled`，不是自造调用）；`gateway` 那处 **刻意不写测** —— 拦截 `startFace` 抓字面量能把覆盖率涂绿，但那既把"产线从不发生"固化成"期望形态"，**又会把上面这条发现掩盖掉**。⇒ 改为**登记为 §3-8 第 18 行**（② 第 2 批待裁），本件只留机械读数。

🔵 **沿用而非新造（先例就在本会话）**：§2.7m 覆盖 `acp-http` 的同一字段时用的就是 `const spec = xxxSpec(...); expect(faceEnabled(spec)).toBe(...)` 三态写法 ⇒ 本件**照抄同一形态**（挑靶的"形态是否同一"再次兑现）。

| 用例 | 形态与判据 |
|---|---|
| ① 🔴 **读数器自证** | 注入的开关**真的被 `readSimpleSettings` 读到**（否则后两条可能是**空断言**）—— 先证明读数器不瞎 |
| ② **意图随开关走** | `skiffDebugSpec` **只构造一次**，构造后改开关再读 ⇒ 开 `true`／关 `false`，且 **`on !== off`**（判别性：若该闭包是常量，本条先红）。🔵 这同时钉住语义 = **`enabled` 是每次调用实时读设置，不是构造时快照** |
| ③ **规格形状** | `spec.port` 逐字等于入参；`name` ／ `host` 为非空串、`handler` 为函数（**不硬编码模块私有常量** —— `FACE_SKIFF_DEBUG` ／ `SKIFF_DEBUG_HOST` 均未导出） |

**读数（锚定 2026-09-25 19:35 那一跑）**：
- 🔴 **机械判据（预登记 → 实测，三项逐字命中）**：`fstat-no` **21 → 20**（`skiff-debug.ts` 从名单消失；`gateway.ts` **按登记保留**）；test **126 文件 / 2065 用例**（**文件数不变**，故 126）；函数面 **892 → 893**。
- 🔵 **一处值得记的口径细节**：本件**语句面完全不变**（25014/25815，与上一跑逐字相同）—— 因为 `enabled: () => …` 所在的行**本来就已被执行**（对象字面量在 `startFace` 调用处求值），**翻的只有"函数是否被进入"**。⇒ 又一次实证 §4.2-㊽：**`fstat-no` 与 `cstat-no` 是两件事**（这里只动前者）。
- **B 类**：**2 处 → 1 处**（`skiff-debug` 已赎；`gateway` 那处**不是"待赎"而是"不可达"** ⇒ 已移出 ⑤ 靶单、移入 **§3-8 第 18 行**）。🔴 **这是 §3-9b B 类"形态同一"判断的一次自我更正**：两处**表面同形**，**可达性不同**。
- **全仓**：语句 **96.89%**（25014/25815，**不变**）／分支 **86.94% → 86.95%**（5197/**5977** → 5198/**5978**）／函数 **97.69% → 97.8%**（892 → **893/913**）。
- 门禁：typecheck ✅ ／ test ✅ ／ coverage ✅ exit 0（`src/**` 零改动 ⇒ build ／ pack-check 不强制）。

⏭️ **⑤ 的下一档（本件之后）**：B 类剩 1 处**但不可达** ⇒ **下一靶应直接进 C 类**（**12 文件 / 19 处**），其中 **`seams/guards` 4 处皆带 `cstat-no`**（整函数连语句一起没跑 ⇒ 最可能是真靶）⇒ **逐条先证可达性再动手**。

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
| `clock-runtime.ts` 的"回归钉"引用 | （原判未列） | ✅ **真残留，2026-09-25 已修**（提交 `1081d91`）：两处以 `autopilot-trajectory.test.ts` 作"实测 / 回归钉"引用，而**该文件全仓已不存在**（随 v1.35.0 autopilot 退场）。⇒ **只修引用**：所述行为与断言**都真实存在**，落在 `clock-runtime.test.ts`（『bodyCountsTick=true → 工厂不记账，由 body 决定』／『闸关时 start ⇒ 事件仍必须挂上』／『闸先关后开 → 可补武装』）⇒ 已把引用改指真实文件并**补上断言原文**。⚠️ 原文以为"处置取决于 `bodyCountsTick` 的去留（§3-8 第 5 行）"—— **实测不必**：改的是**引用**，不是 `bodyCountsTick` 本身 |

**🆕 同批新发现：第 3 处悬空引用（`host/contract.ts`，同一次核验抓到）**

| 对象 | 悬空对象 | 结论 |
|---|---|---|
| `host/contract.ts` 的 storageDomain 段 | `tests/host/storage-domain-probe.test.ts` | ✅ **真残留，2026-09-25 已修**（同一提交 `1081d91`）：那是**一次性探针**，**2026-09-19 已转化**为长期契约用例 `tests/host/storage-domain.test.ts` —— 🔵 **该目标文件头部第 10 行自述此事**（"本文件由 §0L 的一次性探针**转化而来**（原 `storage-domain-probe.test.ts`）"），第 17 行自证"**兄弟 fiber** 拓扑" ⇒ 原引用指向的是**改名前的旧名**，而注释**没跟着改** |

🔴 **本档的核验方法（可重跑，一次抽全、逐个对账）**：把 `src/**` 里出现的所有 `<name>.test.ts` 抽出（本次 **11 个引用**），逐个对 `tests/**` 实际清单核验 ⇒ **3 个解析不到**（即上表两行 ＋ 本表一行），**全部已修**；其余 8 个（`cordis-access` ／ `host-contract` ／ `storage-domain` ／ `gateway` ／ `face-host` ／ `deepseek-vision-probe` ／ `trajectory-bound` ／ `clock-runtime` ／ `config-volatile` ／ `trajectory-ops`）**均存在**。🔵 **两个非测试项不算悬空**：`cro-guide.ts` 里的 `continuous-re-occurrence.dev.test.ts` 是**给用户看的示例名**（不是仓内对象）；`msm-ops.ts` 里的 `dev-kit.test.ts` 属 **CCC 仓**、不在本包。
🔴 **沉淀判据（本档最值钱的一条）**：**注释里的引用也是真相源，也会漂** —— 删／改／重命名测试文件时，`src/**` 里指向它的注释**不会有任何机械信号**（编译过、测试绿、覆盖率不变）。⇒ 它是**静默失效**的一族，与 v1.30.5 的错误码漂移、`today` 的"指向已删对象"同族。**建议长期做法** = 本档这条核验法（抽 `src` 的测试引用 → 对 `tests` 清单核验），可做成常备体检项。

> 🔵 **教训（判据纪律）**：**"注释里出现了已删对象的名字" ≠ "注释过期"** —— 必须读那句话**是断言现状、还是记录历史**。本条原判只按关键词命中，两边各错一次（假阳 2）。反向的坑也在：**关键词没命中的地方才有真残留**（本批两处真残留均非原判所指）。

### 3-8. 工具面的死代码候选

| # | 对象 | 读数 |
|---|---|---|
| 1 | `msm-ops.ts:MsmEntry`（export interface） | `src/**` 仅自身 8 处、`tests/**` **0 处** ⇒ 无外部消费者（纯类型）<br>🔴 **2026-09-25 复核更正：它出现在**公开签名**里** —— `loadMsmEntries(): MsmEntry[]` 与 `findEntry(): MsmEntry \| null` **都是导出函数** ⇒ 它是**契约类型**、**不是死代码**（"零消费者"只说明**仓内**没人直接写这个名字）。⇒ **本次不动它**；同批动的是第 4 行的 `MsmArgs`（**补导出**，方向相反） |
| 2 | `tools/praxis.ts:PRAXIS_INDEX` | `src/**` 除本文件 2 处外 0；**只被 tests 用** |
| 3 | `tools/trajectory.ts` 的 `sanitizeSessionSummary` / `renameDshSessionOnUse` / `activeInfoFromCreate` / `renameDshSessionForActive` | 包内自用，对外**只被 `session-title.test.ts` 引用** |
| 4 | ⚠️ 形状问题：`msm-ops.ts:MsmArgs` **未导出**，却被 `runMsm`/`runMsmAsync` 的**公开签名**引用 | 外部调用方只能传结构等价字面量（类型不可见 = 契约不完整）<br>✅ **2026-09-25 第 1 批已修**：补 `export`（**零行为变化**，纯类型面） |
| 5 | 🆕 `clock-runtime.ts:ClockOptions.bodyCountsTick`（**公开选项**） | `src/**` 除本文件"定义 + 实现"外**零调用**（唤醒调度器不传它）；`tests/**` 6 处显式传 `true`。**成因可判定**：它存在的唯一理由是 **autopilot 的记账语义**（"无 target 则不计 tick"），而 `autopilot-trajectory.ts` **已随 v1.35.0 整段退场** ⇒ **在产线已是死选项**。⚠️ 属**公开面**（导出接口的选项）⇒ 按 **D84 留待第 2 批单独确认**，本批不动 |
| 19 | 🆕 `trajectory-ops.ts:today` —— **模块内私有函数，全仓零调用**（⑤ 第 38 件实测） | 🔴 **死代码（不是"还没走到"）**。**判据可重跑**：在 `hooks/` 内 grep `today` ⇒ **全仓只有 1 处命中 = 它自己的定义**（`src/trajectory-ops.ts` 的 `function today()`），**零调用点**。<br>**它是怎么被发现的**：原本按"未执行函数"当 ⑤ 靶（`fstat-no` 点名了它与 `resolveSessionByTitle`），**动手前的可达性取证把它挡下了** —— 同一批量里 `resolveSessionByTitle` 有活调用点（`seams/context.ts` 的标题 reconcile 分支），而 `today` **一个都没有**。<br>**成因（R↓）**：它只是 `localDate()` 的一行转发（`return localDate()`），推测是某次重构后**调用点被改写、函数忘了删**（本文件别处改用 `localDate(...)` 直调）。⚠️ 属**可读性／死代码档** ⇒ 按 **D84 归第 2 批待裁**（第 1 批判据 = **零引用 ∧ 非公开面**；它是私有函数 ⇒ **其实符合第 1 批判据**，只是当时未被发现）。🔴 **不自行删除** —— 待 owner 逐条确认那一批时一并处置。<br>🔵 **本条的真正价值 = 一条判据**：**`fstat-no` 里混着"死代码"** ⇒ **挑靶不能只看"未执行"，必须问"它有没有调用点"**。⑤ 靶（= 有调用点、只是没走到）与 ② 候选（= 没调用点）**是两档**，混合登记会同时污染两份台账 |
| 20 | 🆕 `skiff-core.ts:isResumeFallbackError` —— **同款死代码 ＋ 注释与实现已分叉**（⑤ 第 39 件实测） | 🔴 **死代码**。**判据可重跑**：`isResumeFallbackError` 在 `hooks/` 内 grep ⇒ **唯一命中是它自己的定义**（`src/skiff-core.ts`），**零调用点**（第 19 行同款形态）。<br>🔴 **比第 19 行更值得记的一点 = 它的注释描述了一条代码已不再执行的策略**：函数头写「resume 失败是否应降级 create：**仅当**会话无持久化 log（首次）或持久化未配置时。**其他错误（损坏/版本不符/live 占用）→ 透传**（真问题不掩盖）」，而调用侧（`createSkiffAgent` 的 `catch`）现在是 **v1.27.2 用户拍板后的语义**：「**resume 失败一律降级新建**（不再透传——透传会让微信桥静默"不唤醒"）」＋ 打印堆栈。<br>⇒ **两处并存即误导**：读到函数头的人会以为"有些错误会透传"，而实际**一律降级**。⚠️ 属**语义档**（删掉它就顺带消掉一条矛盾的注释）⇒ 按 **D84 归第 2 批待裁**，**不自行删除**。<br>🔵 **旁证**：`tests/skiff-core.test.ts` 有多条 resume 降级用例（它们断言的是**降级发生了**，不是"哪些错误该降级"）⇒ **没有测试钉住这个函数**，也就没人发现它已死 |
| 21 | 🆕 `skiff-core.ts:liveReuseRef` 返回对象里的 `dispose: async () => {}`（**空操作**，`fstat-no`） | 🔴 **不可达 —— 但成因与 19／20 不同（这条是"被外层返回类型挡住了"）**。<br>**取证（三步，都可重跑）**：① `dispose` 是 **`AgentHandle` 上的成员**；② `createSkiffAgent` 的返回类型 **`SkiffAgentRef` 只挑 `{ handle, agent, sessionId, resumed }`** ⇒ `liveReuseRef` 造的那个 `dispose` **只挂在内层 handle 上**；③ **全仓零调用** —— `ref.handle.dispose()` 在 `src/**` 无命中（四个调用方 `acp-core` ／ `weixin-bridge` ／ `acp-http` ／ `skiff-debug` 都只读 `agent` 与 `handle` 的**其它**成员）。<br>⇒ **它存在的意义 = 满足 `AgentHandle` 的必填成员**，而**没有任何调用方会执行它**。<br>🔴 **本条的教训（比结论值钱）**：我原本把它当 ⑤ 靶（"测一下这个空操作"），**写测时被自己的断言打回** —— 断言 `typeof ref.dispose === 'function'` **红了**，因为外层根本不转发它。⇒ **这正是"先证可达性"的价值**：若我照原计划"造个测试让它变绿"，就得写成 `ref.handle.dispose()` —— 那是**顺着自己的假设改测试**，会把"产线从不发生"固化成"期望形态"。<br>⚠️ 按 **D84 归第 2 批待裁**（它是"空操作占位"，删它要动 `AgentHandle` 的类型必填性）。<br>🔵 **同族三连的定性**（19／20／21）：`today` = 私有函数零调用 ⇒ **该删**；`isResumeFallbackError` = 零调用**且注释与实现分叉** ⇒ **该删（顺带消矛盾）**；本条 = **活类型契约的占位** ⇒ **该留但该记**。**同一张 `fstat-no` 榜上混着三种性质**，处置不能一刀切 |
| 6 | 🆕 `seams/bootstrap.ts`：**「Anchored 变体」分支不可达** —— `registerBootstrap` 的 `system-prompt/assemble` 处理器里 `if (SETTINGS.zeroTools)` 的 **else 路径** | 🔴 **不可达（本次实测）**：`SETTINGS` = **模块级 `const`**（`resolveBootstrapSettings()`，**无参、零配置面**，文件头自述"协议固有"），其中 `zeroTools` **硬编码 `true`**，且**全仓无 setter、无处可改** ⇒ 该 `if` **恒真** ⇒ else 分支**永不执行**（其体：`bootstrapTools` ＋ 压缩后追加 `compactionTools` 的窄化 ＋ 缺一降级告警）。<br>⚠️ 属**公开面 / 需确认**档 ⇒ 按 **D84 归第 2 批**，**不自行删除**（先问「谁依赖它」）。<br>🔵 **旁证（本次实测）**：新增的 `tests/seams/bootstrap-register.test.ts` **不覆盖它** —— 那 18 用例断言的是 **`zeroTools` 路径内**的 `missing.length > 0` 降级分支（coverage stderr 实证 `bootstrap: expected compaction tools missing=["todo_write"]`），**与 else 分支是两处** |
| 7 | 🆕 `tools/msm.ts`：**两处 `gate.whitelist` 分支不可达**（skiff「白名单过滤」与「候选加已过滤前缀」） | 🔴 **不可达（本次实测；`tests/msm-tool.test.ts` 钉住可观测契约）**。**三读判据**：① msm.ts 只在 **name 为空**时把 action 传 `'list'`，否则传 `'exec'`；② `skiffMsmGate` **只在 `action === 'list'` 分支返回 `whitelist`**（exec 路只返 `{}` 或 `{reject}`）；③ 而 name 为空的那一路在处理器前段**已提前返回**（且那处 return 用的正是 whitelist）。⇒ 走到这两行时 `gate.whitelist` **恒为 `undefined`** ⇒ 过滤分支与「已过滤」前缀**永不生效**；**语义上也不亏**：skiff 的越权请求已在门控处 `{reject}` 抛错。<br>⚠️ 属**公开面 / 需确认**档 ⇒ 按 **D84 归第 2 批**，**不自行删除**。🔵 **旁证**：断言"白名单内但未注册的名字 ⇒ 走**无前缀**候选"的用例已随第 3 件落档（即该分支不执行的正向证据） |
| 9 | 🆕 `api.ts:resolveWorkspace` 的 **`catch { /* 遍历失败 → 空列表 */ }` 不可达**（005 第 17 件实测） | 🔴 **判据（三层吞异常）**：该 try 体内只有三条语句 —— `hostSessions(ctx)`（→ `hostInjected` → `hostService`，**三层各自 `try/catch` 且契约写明"服务缺失/读取失败一律 undefined、不抛错"**）、一个 `typeof sessions?.list === 'function'` 判断、一次赋值 ⇒ 唯一能抛的是"**读 `.list` 属性即抛**"的 getter（构造性场景，产线无此形态）。<br>⚠️ 属**可读性档**（它在注释里承诺了一条永不发生的话："遍历失败 → 空列表"）⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。🔵 **旁证**：新增的 §2.7b 那批用例**刻意不覆盖它** —— 硬凑（造一个抛错 getter）会把"从不发生"固化成"期望形态"。 |
| 10 | 🆕 ⑤ 第 17 件**剩余 22 条**（四条端点 catch ／ `public-ask` 405+catch ／ `session-cleanup` 尾部 ／ `weixin /login` catch） | ⏭️ **不是死代码，是"还没走到"** ⇒ 下一轮靶。逐条先判"用户能不能真走到"：能 ⇒ 用**真实故障形态**补测；不能 ⇒ 挪进本表当候选。 |
| 8 | 🆕 `tools/trajectory.ts:advisoryHint` 的**空壳分支**（`!existsSync(mdPath)` ⇒ 提示"目录存在但没有 SESSION.md"） | 🔴 **不可达（本次实测；`tests/trajectory-tool.test.ts` 钉住实际失败点）**。**判据**：① `advisoryHint` **全仓只有一个调用点**（`use` 分支内），且它排在 `useSession(...)` **之后**；② `useSession` 对**同一个 mdPath** 已经做过 `existsSync` 校验并**会抛**（`has no SESSION.md — nothing to load.`）；③ 两次定位同 root 同 key（`findSession` 同参数）⇒ **同一个 entry** ⇒ 走到 `advisoryHint` 时文件**必然存在**。<br>⇒ 该分支**除"两步之间的竞态"外永不执行**；同函数末尾的 `catch { return null }`（`statSync` 抛）同理属竞态档。⚠️ **可读性上的意义**：它在 `use` 的**提示文案**里承诺了一条**永远不会出现的话**。⚠️ 属**语义档**（删掉它就失去竞态兜底）⇒ 按 **D84 归第 2 批**，**不自行删除**。🔵 **钉法**：测试断言"空壳目录 ⇒ 错误来自 `useSession`（含 `has no SESSION.md`），**不含** `空壳`" ⇒ 把"哪一步失败"变成机械事实，而不是靠读代码相信 |
| 11 | 🆕 `msm-ops.ts:protocolResult` 末尾的 `return undefined`（⑤ 第 19 件实测） | 🔴 **构造上不可达**：该函数的入参类型是**联合类型**，而 `prepareExec` 只可能产出 `{list: …}` 或 `{schema: …}` 两种形态 ⇒ 前两个 `if` 已覆盖全部可能，第三句永不可达。⚠️ 属**可读性档**（一个类型上穷尽的分派多写了一句兜底）⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。🔵 **旁证**：新增的 `tests/msm-admin.test.ts` **刻意不为它硬凑用例**（给不可达分支造输入 = 把"从不发生"固化成"期望形态"，与第 9 行同款判断）。🔵 **它的兄弟句**（`if (!protocol) return undefined`）**是可达的**，已被每一条非协议 exec 用例覆盖 ⇒ 两者别混为一谈 |
| 12 | 🆕 `msm-ops.ts:assertPathInsideRoot` 内层 `catch` 的"**realpath 失败 ⇒ 放行**"那句（⑤ 第 19 件实测） | 🔴 **构造上不可达**：进入该分支的前提是 `existsSync(abs)` 为真；而 `realpathSync` 抛错的实际成因（路径上某级目录**不可搜索**，EACCES）会让 `existsSync` **同样为假** ⇒ 根本进不到 `catch`。其余能抛的成因（ENOENT 竞态）同理被同一道 `existsSync` 挡在外面。<br>⇒ 该 `catch` 里**唯一可达**的是它自己那句 `if (e.message.includes('symlink')) throw e`（**正控已做**：`tests/msm-admin.test.ts` 的 symlink 逃逸用例正是从 try 体内抛出、由它重抛出来的）。⚠️ 属**语义档**（删掉它就失去"权限异常不误伤合法路径"的兜底意图）⇒ 按 D84 归**第 2 批**，**不自行删除** |
| 14 | 🆕 `acp-http.ts` 的**四处「构造上不可达」防御性默认值**（⑤ 第 28 件实测） | ① `(req.url ?? '/').split('?')[0] ?? '/'` 的**后半** —— `String.prototype.split` **恒返回 ≥1 个元素** ⇒ `[0]` 永不是 nullish（前半 `req.url ?? '/'` 属平台门，见第 15 行）② `decodeURIComponent(cMatch[1] ?? '')` —— 该正则 `/^\/c\/([^/]+)$/` **命中即第 1 组必存在** ⇒ 组取值永不为 undefined ③ `decodeURIComponent(aMatch[1] ?? '')` —— 同上（`/ask` 那条正则同款）④ `cccValue.split('/').filter(Boolean).pop() ?? cccValue` —— 进得来就已过 `cccValue !== ''` 守卫 ⇒ 切分后**至少一个非空段** ⇒ `pop()` 永不为 undefined。<br>⚠️ 均属**可读性档**（类型上合法、本模块永不产生的取值）⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。<br>🔵 **旁证**：本件 15 条用例**刻意不覆盖这四行** —— 硬凑（造空串 url／空正则组）等于把"从不发生"固化成"期望形态"（与第 9／11／12 行同款判断） |
| 17 | 🆕 `unattended-seam.ts` 的**七处防御性默认值**（⑤ 第 30 件实测 —— 该文件标记数 **26 → 7**，剩的就是这七条） | **构造上不可达（3 条）**：① `logEvent` 里 `res.error ?? '未知原因'` —— `appendUnattendedLog` 的**两条失败返回路径都拼了非空 error 串**（守卫返回 `'缺少 CCC 根或轨迹目录名'`、catch 返回 `无人值守流水写入失败（…）`）⇒ 右支不可达 ② `doneNonce` 那处 `nonces[nonces.length - 1] ?? null` —— 已判 `length > 0` ⇒ 下标必在界内 ⇒ 取出的元素必为 string ③ `nonce: run?.nonce ?? null`（accept/cap 分支内）—— 🔴 **该分支的两个出口都以 `run` 非空为条件**（`accept` 在 `if (doneMatches && run)` 内、`cap` 在 `run &&` 内）⇒ `run?.nonce` 恒为 string。**需"非 Error 抛出"（4 条）**：④ `ctx.on` 抛错时 `(err as Error)?.message ?? err` ⑤ `agent.steer` 抛错时同款 ⑥ claimed 观察 catch 同款 ⑦ turn-stopping 处置 catch 同款 —— 会抛的是**宿主回调**（`ctx.on` / `agent.steer`），实际只会抛 `Error`。<br>⚠️ 七条均属**可读性／类型守门**档 ⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。<br>🔵 **旁证**：本件 11 条用例**刻意不覆盖这七条** —— 为④⑤⑥⑦造"宿主抛字符串"等于把"从不发生"固化成"期望形态"（与第 9／11／12／14／16 行同款判断） |
| 16 | 🆕 `wake-registry.ts` 的**四处「构造上不可达」防御性默认值**（⑤ 第 29 件实测 —— 该文件标记数 **30 → 4**，剩的就是这四条） | ①／② 两处 `catch` 里的 `String((err as Error)?.message ?? err)` 的**右支**（`loadWakeRegistry` 的解析 catch ／ `saveWakeRegistry` 的写入 catch）—— 会抛的只有 `JSON.parse` ／ `readFileSync` / `mkdirSync` / `writeFileSync` / `renameSync`，**它们只抛 Error**（`message` 恒存在）⇒ 要走到 `?? err` 需"非 Error 抛出"，产线无此形态 ③ `addWake` 里 `saved.error ?? '写入失败'` —— `saveWakeRegistry` 失败时 `error` **恒为字符串**（它自己拼的文案）⇒ 右支不可达 ④ `removeWake` 里 `removed ?? null` —— `splice(idx, 1)` 在 `idx ≥ 0` 时**恒返回 1 个元素**（上一行才刚判过 `idx < 0` 已返回）⇒ 解构出的 `removed` 恒不为 undefined。<br>⚠️ 四条均属**可读性／类型守门**档（类型上合法、本模块永不产生的取值）⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。<br>🔵 **旁证**：本件 15 条用例**刻意不覆盖这四条** —— 硬凑（造非 Error 抛出）等于把"从不发生"固化成"期望形态"（与第 9／11／12／14 行同款判断）。🔵 **其中①②是"新暴露"的**：这两行此前整行未执行（`cstat-no`），补测跑通后才**暴露出**行内的 `??` 分支 ⇒ 再次实证**分支分母会随执行而变**（§2.7e 系列） |
| 15 | 🆕 `acp-http.ts` 的**常量门／平台门／环境门各一处**（⑤ 第 28 件实测） | ① **常量门** `ACP_HTTP_HOST = FACE_PORTS.acpHttp.host ?? '127.0.0.1'` —— `ports.ts` 里 `acpHttp.host` 是**字面量 `'127.0.0.1'`** ⇒ `??` 右支对**当前常量表**不可达（该 `??` 只是为 `string \| null` 这个类型守门）② **平台门** `(req.url ?? '/')` ＋ `req.socket.remoteAddress \|\| 'unknown'` —— Node 的 HTTP 解析器**拒绝没有请求目标的请求行**（走 `clientError` 销毁 socket，**handler 根本收不到**），而 TCP socket 的 `remoteAddress` 恒有值 ⇒ 二者要真为假需**非 TCP 形态的 socket** ③ **环境门** `cccRootForCwd(process.cwd()) ?? ''` —— 只有"cwd 上溯找不到任何 `.serenity`"才触发；本机 cwd 在 CCC 内 ⇒ 不触发（🔵 第 ⑭ 用例**环境自适应**：换到无外层 CCC 的环境它会断言空态页）。<br>⚠️ 同属**可读性／防御性**档 ⇒ 按 D84 归**第 2 批待裁**，**不自行删除** |
| 13 | 🆕 `fs-ops.ts:detectFileType` 的 **`symlink` 档**（⑤ 第 21 件实测） | 🔴 **构造上不可达**：`detectFileType` 的三个调用点（`getFileInfo` ／ `tree` 的 walk ／ `info`）**全部传 `statSync` 的结果**，而 `statSync` **跟随**符号链接（悬空链接则直接抛 ⇒ 走 `getFileInfo` 的 `catch`）⇒ `stat.isSymbolicLink()` **恒假**。⇒ 要真产生 `symlink` 档得改用 `lstatSync`（那本身又是一次行为变更）。⚠️ 属**可读性档**（一个类型上合法、本模块永远不产生的取值）⇒ 按 D84 归**第 2 批待裁**，**不自行删除**。<br>🔵 **机械旁证（不是"我读了源码"）**：新增的 `tests/fs-ops-guards.test.ts` 用**真 symlink 指向目录**实测 ⇒ 判为 `dir`（**不是** `symlink`），并用**悬空 symlink** 实测落入 `other` 档（即 `catch` 路径） |
| 18 | 🆕 **`FaceSpec.enabled`：「四个面都声明了它，全仓只有一个读者」**（⑤ 第 34 件实测 —— 本条是**结构性发现**，不是某一段代码） | 🔴 **三条 grep 读数（都可重跑）**：① **该字段是类型的必填项** ⇒ **四个面全都写了** —— `weixin-send-api.ts:270` ／ `acp-http.ts:87` ／ `gateway.ts:442` ／ `skiff-debug.ts:397`；② **全仓只有一个读者** = `faceEnabled`（`face-host.ts:157`，其体内是全仓唯一一处 `spec.enabled()`）；③ **该读者只有一处调用点** = `weixin-send-api.ts:318`。⇒ **另外三处的声明当前无人读取**（grep `faceEnabled(` = 1 命中）。<br>⇒ 性质 = **装配缺口，不是疏忽**：`face-host.ts` 的文件头把这个字段的用途写明为"装配层据此判该面此刻应否在监听，**替代各面 sync 里手写的 `want` 判据**"—— 即**迁移只做了 `weixin` 那一面**；`gateway`／`acp-http`／`skiff-debug` 的装配层仍在**直接读设置**（例：`gateway.ts` 的 `readSimpleSettings().gatewayEnabled`）。<br>🔴 **其中 `gateway` 那处性质更硬 = "构造上不可达"**：它的 `enabled` 是 `startFace({...})` 里的**内联字面量**，而 `gateway.ts` **没有 spec 构造函数**（该文件唯一导出是 `registerGateway`）⇒ 该对象**从不外泄** ⇒ 既不会被 `faceEnabled` 读，**也无法在测试里按 §2.7m 的形态取到**。🔵 **旁证（本件正是靠它分的档）**：另两个未读者各有 spec 构造函数（`acpHttpSpec` ／ `skiffDebugSpec`）⇒ 能用同一形态覆盖（前者已于 §2.7m 覆盖、后者于 **§2.7s** 覆盖）；**只有 `gateway` 不行**。<br>⚠️ 按 **D84 归第 2 批待裁**，**不自行删除**（删它要动类型的必填性，是接口级裁决）。⚠️ 🔴 **也不要给 `gateway` 那处硬凑测试**（拦截 `startFace` 抓内联字面量 = 把"产线从不发生"固化成"期望形态"，**且会把本条发现涂绿掩盖掉**）—— 这正是 **§2.7s**「刻意不给它写测」的理由。 |

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
**读数**：`api.ts` **70.12% → 72.81%**（521 → 541 条）｜**累计三轮 23.55% → 72.81%（+366）**｜全仓 **93.43% → 93.51%**｜test **1822 → 1826**。

✅ **2026-09-25 进展（第 11 件：weixin 的三个**写动作**）**：`save-routes` ／ `set-enabled` ／ `remove-account` —— 三者都只写 **CCC 自己的 `.opencode/serenity.json`** ⇒ 临时 CCC 夹具即可（无需假后端）。
- 钉住：`save-routes` **形状三态拦截**（非数组／空 user／空 role）＋ **角色白名单**（必须 ∈ 该 CCC `skiff.roles`，被拒时**配置不落盘**）＋ 🔴 **`省略 routes` = 清空表**（"整体替换"语义；**首跑我把它当非法输入，实测 200** ⇒ 已改成正面钉住）｜`set-enabled`：**无账号 enable ⇒ 400 且配置保持原样**（负控用的是"原值 true 不被改成 false"）／disable ⇒ 200 且真写入｜`remove-account` 缺参 ⇒ 400 ＋ 未知 action ⇒ 400。
- 🔴 **刻意不测**：`login-start`（`fetchQRCode()` **真连微信后端**）与 **带账号的 enable**（`syncCccBridge()` 会**真起轮询循环**）—— 同"外向动作先隔离作用域"判据：**没有假微信后端**就不测。
**读数**：`api.ts` **72.81% → 81.69%**（541 → 607 条，**+66**）｜**累计四轮 23.55% → 81.69%（+432）**｜全仓 **93.51% → 93.77%**｜test **1826 → 1830**。，或按 §5.1「更要有语义断言」处理下表 #10 的接线钉。<br>⚠️ **上列百分比是"某次 coverage 跑的实测读数"**（锚定 2026-09-25 ⑤ 开工时那一跑），**不是"当前值"**（每次补测都会变）⇒ 引用时须标时点（§4.2-㉞ 同族）。

✅ **2026-09-25 进展（第 12 件：面 B 的**装配链** —— 登录面 ＋ 反代面，两笔提交）**：此前补的是**纯逻辑**与**接线钉**，而 `gateway.ts` 里"只有真 listener 走到才执行"的那一大段整块零执行（覆盖率报告同批 `fstat-no`：登录 POST 分支 ／ 登出 ／ workspace.create 三态 ／ 跨源拒绝 ／ HTML 注入反代 ／ `readBody`）。**判据同 §5.1：断言取"客户端看到什么"，不复用源码字符串。**
- **第一笔（登录面，`82d0dcf`，+5 用例）**：CSRF 缺失 ⇒ 403 ＋ **失败页回注新 csrf**（`name="csrf" value=<新 token>` = v1.24.9 的意义）｜失败**分档**（首次 401「用户名、密码或验证码错误」→ **第 5 次起**转「尝试过多，账号已锁定」）→ **429 ＋ `retry-after`**，且此时**密码正确也不放行**（锁定前置）｜**TOTP 二选一**（只给 code、密码留空 ⇒ 302，且会话**真能反代**）＋ **同 counter 重放 ⇒ 401**（防重放确有其效）｜🔴 **负控**：`totpEnabled=false` 时同账号同 code ⇒ 401，而**改用密码仍 302**（证明 401 来自"未启用"，不是夹具坏）｜**登出** ⇒ 302 ＋ `Max-Age=0`，且**旧 token 服务端随即不认**（再用它只拿到登录页）。
- **第二笔（反代面，+7 用例）**：**HTML 注入**（明文 ⇒ marker 注入在 `</head>` 前 ＋ `content-length` 与实体字节数一致）｜🔴 **gzip HTML ⇒ 先解压再注入、响应去掉 `content-encoding`**（**v1.28.2 白屏根因的端到端回归钉** —— 此前只有 `transformHtmlForProxy` 的函数级单测）｜**坏 gzip ⇒ 原样透传**（保留 encoding 且**字节逐字不变**："宁可不解，绝不弄坏"）｜**非 200 的 HTML 不注入**｜**workspace.create 三态**（禁建 403 ／ 白名单外 403 ／ **白名单内 200 且上游收到的 body 逐字等长** = `bodyOverride` 重放确实通）｜**PUT /serenity/config 跨源 ⇒ 403**，同夹具换 loopback 主端口 Origin ⇒ 放行（正控）。
**读数（同一 679 语句分母）**：`gateway.ts` **75.69% → 90.86%**（514 → 617 条，**+103**；分支 **39.5% → 70.49%**）｜全仓语句 **93.77% → 94.24%**｜test **1830 → 1835**。
🔴 **仍刻意不测（诚实边界）**：`readBody` 的**超限分支**（> 128 KB 请求体）—— 它 `reject` 之后紧跟 `req.destroy()` ⇒ 客户端大概率见 **ECONNRESET** 而非那个 400（与 `api.ts` 同款的登记待裁项）；在夹具里断言"400"会把假期望固化。

✅ **2026-09-25 进展（第 13 件：**文件发送三步链** —— `weixin-api.ts` 的 `sendFileMessage`）**：该函数在覆盖率报告里**整段 `fstat-no`**（连它私有的 `padTo16` 一起）—— 而它是 **`im-bridge send-file` 的落地实现**（v1.31.0 从 CCC MSM 迁入 ACC）⇒ "让招财发个文件"这条真实链路的最后一公里此前**从未被执行过**。新增 `tests/weixin-file-send.test.ts`（**+1 文件 / 12 用例**，零网络：走模块自带的 `__setWeixinFetchForTest` 注入点）。
- 🔴 **判据一：验算法，不验"函数被调用"** —— CDN 上传体必须是 **AES-128-ECB（无 IV）** 密文：用例用**上传请求自己报出的 `aeskey`** 解密回去，与原文**逐字节比对**；并配 **正控**（拿同一把 key 去解一段**明文**，必须"不相等或抛"）⇒ 否则"解密后相等"可能在 AES 变成恒等变换时**永远绿**。
- **三步链逐字段钉**：`getuploadurl`（`media_type:3` ／ `rawsize` ／ `rawfilemd5`=md5 ／ `filesize`=16 对齐 ／ `no_need_thumb` ／ `filekey` 形状 ／ `aeskey`=32 hex）⇒ **`padTo16` 三态**（5→16 ／ 16→16 ／ 17→32）｜CDN 上传（`application/octet-stream`，密文长度 16 对齐）｜`sendmessage`（BOT/FINISH ／ `item.type=4` FILE ／ `client_id` 形状 ／ `aes_key` = **base64(hex 串)** —— 解码回去应得到那串 hex ／ `md5`/`len`/`file_name` 与上传步骤一致）。
- **两来源优先级**：响应头 `x-encrypted-param` 优先；缺失时回退响应体 JSON 的 `encrypted_query_param`｜**`upload_full_url` 缺失**时用 CDN 基址 ＋ `upload_param`/`filekey` 组装（并**逐个 encode**）。
- 🔴 **判据二：iLink 业务码不算成功** —— HTTP 200 ＋ `{ret:1}` 在 **CDN 与 sendmessage 两处**都必须抛（v1.30.9 语义：否则"发送成功"是假的，回复路径会给一条**从未送达**的消息触发 outgoing 记录）。另钉三条错误路径：响应既无头也无 param（带 HTTP 状态）／`getuploadurl` 响应非 JSON（不把 HTML 错误页当成功）／HTTP 非 2xx（带端点名与状态码）。
- 🔴 **判据三：凭据不外溢** —— 两个业务请求带 `Authorization: Bearer …`，而 **CDN 上传请求不带**（上传走第三方 CDN），且 **token 不出现在任何请求体**里。
- 🔵 **首跑 2 条红 = 我写错了夹具与断言**（校准信号）：① CDN 路由只匹配了 `cdn.example.com`，而构造式 URL 的宿主是 `novac2c.cdn.weixin.qq.com` ⇒ 改按路径 `/upload?` 分派；② 错误文案实测是 `CDN 上传失败: ret=1 errcode=undefined: denied`（`errcode` 未给也照打）⇒ 断言改成只钉"是失败 ＋ 带 ret 与 errmsg"，**不钉那个 `undefined` 的措辞**。
**读数（同一 591 语句分母）**：`weixin-api.ts` **79.86% → 97.63%**（472 → 577 条，**+105**；分支 81.25% → 83.47%；函数 84% → 92%）｜全仓语句 **94.24% → 94.77%**｜test **1842 → 1854**。
🔵 **仍未执行的两条（诚实边界，且它们本就无法在测试里执行）**：`currentFetch` 的**两个默认箭头函数**（`(...args) => fetch(...args)`）—— 测试一律注入替身，**生产**才走它们。⇒ 这不是缺口，是"注入点本身"。

✅ **2026-09-25 进展（第 14 件：`container_git` 的**远程流程 ＋ 失败注入**）**：`git-ops.ts` 当时 **79.68%**，且**没有任何 `fstat-no`** —— 缺口全在"已执行函数体内的分支"里。逐块读 `cstat-no` 后发现未执行的恰好都是**用户真会走到的**：`push` 的**成功路径**（既有测试只覆盖"被拒绝"）／无远程／push 失败；`pull` 的**除"无远程报错"以外整段**（快进成功 ／ 已最新 ／ **分叉被拒**）；`commit` 的两条失败注入；`diff` 的三个旗标；未知 action。新增 `tests/git-ops-remote.test.ts`（**+1 文件／12 用例**，真 `git` ＋ 真 bare 远程，全在临时目录、零网络）。
- 🔴 **判据一：远程流程验"远端真的动了"** —— push 成功断言的是 `git rev-parse` 的**对象 id 相等**（远程 HEAD == 本地 HEAD），不是返回文本；"Pushed to …"这类文本在 v1.18.8 之前**正是误报过**（non-fast-forward 也回它）。
- 🔴 **判据二：拒绝类验"什么都没发生"** —— pull 分叉时断言"本地 HEAD 未动 ＋ 远程独有文件**不在**工作树"（`--ff-only` 的机械保证 = 绝不自动合并）。
- 🔴 **判据三：失败路径用真触发、不用 mock** —— `git add` 失败 = **残留 `.git/index.lock`**（生产真实形态）；`git commit` 失败 = **`pre-commit` 钩子 exit 1**；push 失败 = **origin 指向不存在的路径**。
- 🆕 🔴 **发现 ①（待裁，未固化成期望值）**：**分叉 pull 在中文 locale 下抛错，而非返回 `[REJECTED]` ＋ 建议** —— 判据靠解析 git 的**英文文案**（`Not possible to fast-forward` 等），而本机 git 输出 `fatal: 无法快进，终止。` ⇒ 该友好提示**从未在中文环境生效**。**根因** = `git()` **丢弃 exit code**（只回 `{stdout, stderr}`）⇒ 只能用文案判。修法（改动面小）= `git()` 回传 `err.status` ＋ 以退出码判拒绝 ⇒ **属行为变更，归待裁**。已用 `it.fails` 记为"期望行为"探针（修好即翻红提示清理），另有一条**与文案无关**的安全不变量用例（HEAD 不动 ／ 不合并）常绿。
- 🆕 🔴 **发现 ②（待裁）**：`git()` 在**成功**时**丢弃 stderr** ⇒ `push` 在"本地领先"与"已最新"两种情形返回**同一句** `Pushed to origin/main`（探针实测真值）；而 `git push` 的 "Everything up-to-date" 恰走 stderr ⇒ **工具无法表达"其实没推东西"**。措辞/可观测性问题，非功能缺陷。
- 🆕 🔵 **两条"构造上不可达"（属 ②／④ 的清理候选，不是测试靶）**：① `push` 里 `try { git(fetch) } catch {}` 的 catch —— `git()` 自身全吞异常、**永不抛** ⇒ 该 catch 死代码；② `commit` 里第二条 `'nothing to commit'` 守卫 —— `hasChanges()` 已在前过滤，只有"状态与 add 之间发生竞态"才可能到达。
**读数（同一 192 语句分母）**：`git-ops.ts` **79.68% → 96.35%**（153 → 185 条，**+32**；分支 **44.26% → 77.1%**）｜全仓语句 **94.77% → 94.93%**｜test **1842 → 1866**。
⚠️ **仍未覆盖的两处 + 一条理由**：`git()` 的**超时**分支（常量 `GIT_TIMEOUT_MS = 30_000` ⇒ 真触发要挂 30 秒以上，用 PATH 替身也一样）；`pull` 的 `[REJECTED]` 分支（**被发现 ① 挡住**，修好即由那条 `it.fails` 翻绿覆盖）。

---

#### 3-9b 🔴 全量 `fstat-no` 复扫（四次读数：**44 处 / 23 文件** @19:2x ⇒ **27/20** @19:25 ⇒ **21/14** @19:30 ⇒ **20/13** @19:35）—— 并给出**下一靶的机械依据**

> 🔵 **本块已按自己的纪律更新过三次**：首扫后立的规矩是"**每件收尾顺手重扫**"。⑤ 第 32／33／34 件（§2.7q／§2.7r／§2.7s）做完 ⇒ 各当场复扫，**四次读数全在同一条线上、各自标时点**（㉞：读数不写成"当前值"）。

🔴 **为什么跑这一遍**：⑤ 此前是**一件一挑靶**，挑靶依据多来自"上一块的 ⏭️ 叙述"—— 而这**正是 §2.7i 点名过的坏习惯**（"不许把上一块的叙述当读数"）。⇒ 换成**一次性全量扫描**，让下一靶由**报告本身**推出，不由叙述推出。
🔵 **命令（可重跑）**：对 `coverage/src/**/*.html` grep 字面量 **`fstat-no`**（`fstat-no` = **函数体从未进入**；与 `cstat-no` = 语句未执行**是两件事**，§4.2-㊽）。四次读数 = **44 处 / 23 文件**（19:2x）⇒ **27 / 20**（19:25，第 32 件后）⇒ **21 / 14**（19:30，第 33 件后）⇒ **20 / 13**（19:35，第 34 件后）。

🔵 **聚类（按"形态是否同一"分，不按文件重要性分）**：

| 类 | 文件数 / 处数 | 形态 | 判读 |
|---|---|---|---|
| **A · `tools/*` 的工具面**（render ＋ execute） | **9 文件 / 23 处** ⇒ ✅ **6 / 6** ⇒ ✅ **0 / 0** | render 面：`renderText()` ＋ `output.render`（`(_args, value) => renderText(value)`）**恒缺**；execute 面：`execute` 缺 于 `cc-fs`／`git`／`kit`／`localstore`／`im-bridge`，`parseJobs` 缺于 `handyman` | ✅🔴 **两类已被 §2.7q ＋ §2.7r 全部赎清（0 处）** ⇒ **`src/tools/` 函数面 60/60 = 100%，整个工具面已无"零执行函数"**。🔵 **方法学产出**：这个"9 文件一次触达"的形态，**两件就清完了一整类**（而不是 9 件）—— 挑靶时**先看"形态是否同一"比先看"文件重不重要"划算得多** |
| **B · `readSimpleSettings().enabled` 闭包** | 2 文件 / 2 处 ⇒ ✅ **1 / 1** | `enabled: () => readSimpleSettings().<x>Enabled`（`gateway.ts` ／ `skiff-debug.ts`） | 🔴 **本类被 §2.7s 更正过一次，结论比"形态同一"细**：两处**表面同形、可达性不同**。`skiff-debug` 那处有 spec 构造函数（`skiffDebugSpec`）⇒ 可按 §2.7m 的形态覆盖（**已赎**）；**`gateway` 那处是内联字面量、无 spec 构造函数 ⇒ 构造上不可达** ⇒ **已移出 ⑤ 靶单、移入 §3-8 第 18 行**（② 第 2 批待裁），**不再计为"待赎"**。🔵 **教训形态**：**"形态同一"要连"对象能不能被取到"一起判** —— 同形的两处可能在**可达性**上是两档 |
| **C · 单点杂项** | 12 文件 / 19 处 ⇒ **逐条赎清中（已完成 36/37/38 + 40/41/42 六件）** | 🔴 **本行的"优先子集"已于 2026-09-25 作废** —— 原文写「`seams/guards` 那 4 处皆带 `cstat-no` ⇒ 最可能是真靶」，而**它们早在 §2.7 第 35 件（`54a4c2c`）就被赎清了**（`guards.ts` 报告实测 `fstat-no` **零命中**）⇒ 本表当时**没跟着更新**（陈旧读数）。<br>🔵 **其余同一教训**：`seams/system-prompt` 的 `text` 回调（第 36 件）、`host/storage-domain` 的 `parse`／`safeParse`（第 37 件）、`trajectory-ops` 的 `resolveSessionByTitle`（第 38 件）**也都在本行，且都已赎清**；`today` 则**改判为死代码**（§3-8 第 19 行）。<br>🔴 **本行的教训（写下来）**：**这张"下一靶"表是快照不是不变量**，而它**没有自动更新机制** ⇒ 用它挑靶前**必须先跑一次 §3-9b 复扫**（`grep -c fstat-no coverage/src/**/*.html`），否则会照着**已赎清的旧靶**开工。<br>⏭️ **仍待赎（本行余项，逐条先证可达性）**：`weixin-api.currentFetch` 默认箭头(×2，**注入点本身，不该赎**) ／ `face-host.permanentOnError` ／ `gateway-dsh-auth.end` ／ `skiff-core`（`isResumeFallbackError` ＋ `dispose`，**已判死代码／不可达** ⇒ §3-8 第 20/21 行）／ `msm-ops` 的 Windows bun 路径箭头。<br>✅ **2026-09-25 复扫后新赎三件（第 40/41/42，见 §3-9c）**：`handyman-ops.writeFailedStatus` ／ `web-fetch-provider.lookupAll` ／ `unattended-ops.outboundSendRoots`。🔵 **机械佐证**：复扫 **10 处 / 8 文件 → 6 处 / 5 文件**（开工前 → 收尾后），函数面 **906/912（99.34%）**。 |

🔴 **两条读数纪律（本扫顺带实证）**：
1. **`fstat-no` 与 `cstat-no` 要分开数、分开用** —— 只有前者才回答"**哪个函数从没跑过**"；首扫 44 处 `fstat-no`，其中**多处在报告里同时带 `cstat-no`**（= 整个函数连同语句一起没跑），但**也有只带 `fstat-no` 的**（函数没进，但其所在行被别的东西跑过）。🔵 **§2.7s 是这条最干净的一次实证**：那一件**语句面一字未动**（25014/25815），**只有函数面 +1**。
2. **本表是快照，不是不变量** —— **四次读数各自标了时点**（44/23 @19:2x ／ 27/20 @19:25 ／ 21/14 @19:30 ／ 20/13 @19:35）；**每件收尾顺手重扫**，别引用一个不带时点的数（§2.7e 系列 ＋ ㉞）。
3. 🆕 **"预登记预测 → 实测对账"是本扫最有价值的一步**（**已连续三件命中**）：第 32 件前预登记"44 → 27／A 类 23 → 6／函数面 +17"，第 33 件前"27 → 21／A 类 6 → 0／函数面 +6"，第 34 件前"21 → 20／函数面 +1／2065 用例"——**九项全部逐字命中**。⇒ 若哪天不命中，**差异本身就是线索**（要么靶没真被触达，要么有别的件顺带动了覆盖率）。🔵 **对账用"函数面绝对值"最硬**：`+17`／`+6`／`+1` **各自恰等于当件覆盖的处数**，比百分比更难糊弄。

#### 3-9c ✅ 2026-09-25 晚批：第 40/41/42 件（**"先证可达性"三例，两种性质**）

> 🔵 **本批的挑靶依据 = §3-9b 复扫它自己的产物**（不是上一块的叙述）：复扫（开工前，锚定 **21:5x**）= **10 处 `fstat-no` / 8 文件**，逐条判可达性后**只对其中 3 处动手** —— 另 7 处中 **4 处已判死代码／不可达**（§3-8 第 19~21 行 ＋ `gateway` 的 `enabled` 字面量），**2 处是注入点本身**（`weixin-api.currentFetch` 的默认箭头，**生产才走、测试永远走替身 ⇒ 不该赎**），**1 处是平台门**（`msm-ops` 的 Windows bun 路径，本机 Unix ⇒ 不可达）。

| 件 | 靶 | 可达性取证（**动手前**） | 残余的性质 | 结果 |
|---|---|---|---|---|
| **40** | `handyman-ops.writeFailedStatus` | 🟢 **有活调用点**：`src/tools/handyman.ts` 的保险阀终止分支（`finishReason !== 'done'` ⇒ `max_rounds` ／ `restart_exceeded`） | **失败面**（挑靶四条里最值钱一档） | ✅ 3 用例：无既有进度 ⇒ 文档化兜底（`done=true`／`status=failed`／`round 0`／`model ''`）；**有既有进度 ⇒ 保留 round／model／lastResponse**（不抹掉"做到哪了"）；目录不存在也能落盘 ＋ label 脱敏 |
| **41** | `web-fetch-provider.lookupAll` | 🟢 **主路径**：`resolveAllowedAddresses` 在**非 IP 字面量**时无条件调它 —— 而生产里 `web_fetch` 传的**正是域名** | **真 DNS 路径** ＋ **唯一同时带 `cstat-no` 的残余** | ✅ 8 用例（mock `node:dns/promises`）：映射／私网拒绝／**DNS 重绑定混合集整体拒绝**／fake-ip 放行／空结果／**前置 abort 不发起查询**／解析中 abort 竞速／**abort 后 lookup 才失败不产生 unhandled rejection** |
| **42** | `unattended-ops.outboundSendRoots` | 🟡 **导出且零调用点**，但**自述用途 = 「诊断 / 测试用」** | **活契约占位**（与第 19 行 `today` **不同档**：`today` 零调用 ∧ 无用途声明 ⇒ 死代码；本例**有文档化用途** ⇒ **钉住不删**） | ✅ 1 用例：报出有记录的 CCC；空根不入表（与 `hasOutboundSendSince` 同口径）；**只读视图**（调用它不改变表大小） |

🔴 **本批最有价值的一条判据（由 41 与 42 的对照得出）**：**`fstat-no` 榜上"没跑过"有三种成因** —— ① **没被测试走到**（41：主路径，**该补测**）② **测试期永远走不到**（`weixin-api` 的注入点默认箭头：**测试一律注入替身，生产才走它** ⇒ **不该赎**，硬测反而要改生产语义）③ **零调用**（19/20 死代码 ⇒ **该登记待裁**）／**零调用但有用途声明**（42 ⇒ **该钉住**）。⇒ **挑靶第一步永远不是"看谁没跑"，而是"问它为什么没跑"**。
🔵 **诚实边界**：本批**只动了 3 处**，复扫 **10/8 → 6/5**；剩 6 处的性质**已逐条判定**（见上），其中**没有一处是"该补而未补"** —— 即 ⑤ 在该口径下的**真靶已清空**，后续 ⑤ 的增量应转向**语义深度**（行为断言密度／边界与错误路径），与 §3-9 第 1~3 行的结构性缺口（**客户端半 / 门禁口径 / fake ctx 盲区**）合流。

🔵 **下方这张表是 §3-9 原有的十行"结构性缺口"表** —— 与上面 §3-9b 的**未执行函数快照**是**两种东西**，勿混：本表记的是"整类能力没有测试形态"（客户端半 ／ 门禁口径 ／ fake ctx 盲区），§3-9b 记的是"**报告里某函数体从没进过**"（读数会随每一件而变）。

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
| 10 | 行为测试内夹源码文本断言 | `gateway` L465-499 ／ `trajectory-bound` L307/319/475 ／ `trajectory-skills` L300-328（读 `src/**` 文本）⇒ 属于"接线钉"，不构成行为证据<br>🆕 **2026-09-25：`gateway` 那组已配语义孪生** —— 新增 **v1.22.3 语义化**（真 listener ＋ 真 socket 硬断 RST ＋ 真上游）：**进程不崩 ＋ 中断后网关仍可用**。🔴 **顺带产出一条发现**（见下方"第 6 件"）⇒ `gateway` 的字符串钉**保留**（互补：钉管"实现还在"，语义组管"崩没崩"）<br>🆕 **2026-09-25 复核（⑤ 第 16 件）——三处分档，**其中两处原判已陈旧**：<br>　· `trajectory-bound` **两处**（L307 的"`use` 不再自己发起退休"／L319 的"退休判据在 `appendBound`"）⇒ ✅ **已有语义孪生**：同文件 **D69 组**走**生产路径 `appendBound`** 断言"自己不被退休 ＋ 同轨迹其它条被退休 ＋ 可用绑定恰好只剩自己"（F1 正控）、`rebuild` 换代（F2）、`create`、共用 `at`；而另一半点（`pruneMissingBindings` ＋ `out.prunedBindings` 回报）由 `trajectory-tool.test.ts` 的**真 `use` 路径**两态钉住（悬空 ⇒ 回报 ／ 宿主日志面不可读 ⇒ fail-closed 不剪）。⇒ **本行原判作废**，两枚钉保留（互补：钉管"调用点没被改回去"，语义组管"参数对、结果对"）。<br>　· `trajectory-skills` **一处**（SEP 符号 ＋ 散文残留 = 0）⇒ 🔴 **确实只有源码文本级**（那两枚钉读 `src/**`）—— 而 §7 记录的**真实漏网形态恰在这一层**："符号没了、散文还在"（C1 只钉符号名，面向模型的 toolsBlock 文案里仍留 `session-extension`）。✅ **本件已补语义孪生**：扫**渲染输出**（`serenitySystemPrompt` 的真注入正文 ＋ 注入器**自产**的三条 notice 文案），＋ **读数器自证**（同一词表喂含词样本必须命中）。⚠️ **边界**：只适用**ACC 自产文案**——CCC 自己的 SKILL.md／历史沿革里的合法提及**不在**扫描域（夹具无入口 skill，故正文＝纯 ACC 块）。⇒ 源码钉**保留**（互补：钉管"仓库没人写回去"，语义组管"模型收到的那段字里没有"） |

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
| `bench/verify.sh` | 容器内**只读**验收 **21 条** ＋ 落 `/logs/verify.json` | grep / curl / sha256 / `zstd -dc`（逐条见下） | V0 依赖 `vpush`；V5/V5b/V7b/**V9 家族** 依赖 `turn`；**V8b/V8c** 依赖容器内 chromium（镜像层，见 §2.8c/§2.8d） |
| `bench/v8-client-check.mjs` | V8 客户端交付层探针 | 读 profile 里的 `lib/client.js` ＋ `package.json#dsh.client`，再 `fetch http://127.0.0.1:3080/` | **非真浏览器证据**（作者自述边界） |
| 🆕 `bench/v8b-browser-check.mjs` | V8b **真浏览器面**探针（页面真渲染 ＋ 我方模块真被请求 ＋ 零致命 JS 错误 ＋ 截图） | 容器内 headless chromium `--dump-dom` / `--log-net-log` / `--screenshot`（**禁用 `--virtual-time-budget`**，见 §2.8c） | 镜像含 chromium；宿主已起 |
| 🆕 `bench/v8c-cdp-panel-check.mjs` | V8c **元素级**探针（真点开设置面板 → 我方 section 导航行 → 点它 → `.ss-title` 是 HTML 元素） | 容器内 chromium `--remote-debugging-port` ＋ Node 内建 `WebSocket` 说 CDP；**真输入**（`Input.dispatchMouseEvent`）＋ 命中测试（`elementFromPoint`） | 镜像含 chromium；**每轮唯一 CDP 端口 ＋ 唯一 profile**（否则会连到上一轮遗留实例，见 §2.8d） |
| CCC 侧驱动 `bench-docker`（MSM） | 远端 Docker 全生命周期 | `setsid -w ssh` ＋ `SSH_ASKPASS`；后台脱离 ＋ `*.done`/`*.code` 标记轮询；base64 分块过桥 ＋ sha256 自证；子命令 `probe/sync/build/up/wait/logs/verify/**secretcheck**/vpush/sh/clogs/turn/down/list` | 🔴 **`cmdUp` 已改**：推 patch（`PROFILE_PATCH_REMOTE` → 挂 `/ccc/profile-patch.yml:ro`）＋ `-e PROFILE_PATCH` ＋ **裸 `-e MINIMAX_BENCH_API_KEY`**（docker 语义：不给值 ⇒ 从 CLI 环境取）；🔴 **密钥只走 launch 环境前缀，不写 payload 文件**（旧写法会把密钥**留在远端盘上**）＋ payload 首行**正控**断言该变量非空。⚠️ 仍存：`cmdTurn` 请求体**不带 model**（宿主不从请求读模型） |

**容器内生命周期与落点**：步 0 `dsh --version` → `/logs/host-version.txt`（V1 读数源）｜步 0c 落 profile patch → `/logs/profile-patch.sha256`（**V9d 读数源**）｜步 1 装插件 → `/logs/plugin-install.log`（V2b 读数源）｜步 2 起宿主 → `/logs/dsh-web.log` ＋ `/logs/dsh-web.pid`｜步 3 `sleep infinity`。
**路径**：`DSH_HOME=/root/.dsh` ⇒ profile = `/root/.dsh/profiles/web/`（**宿主设置文档 = `/root/.dsh/profiles/web/cordis.patch.yml`**）；会话日志 = `/root/.dsh/sessions/**/session.v*.jsonl.zstd`；CCC 根 = `/ccc`（含 `.serenity`）。

**判据清单（V0~V9d 共 21 条）**

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
| 🆕 **V8b** | **真浏览器面**：页面在真引擎里**真渲染**（DOM 已挂载）＋ 我方客户端模块**真被浏览器请求**（netlog 命中）＋ 渲染期零致命 JS 错误 | `node v8b-browser-check.mjs`（容器内 headless chromium） | 镜像含 chromium；宿主已起（`/logs/dsh-web.log` 里有 token） |
| 🆕 **V8c** | **元素级渲染**：真点开设置面板 ⇒ **我方 section 的导航行是元素** ⇒ 点它 ⇒ **`.ss-title` 是 HTML 元素且文本含 `Serenity`** | `node v8c-cdp-panel-check.mjs`（容器内 chromium ＋ CDP 真输入） | 镜像含 chromium；宿主已起；**每轮唯一 profile/端口**（见 §2.8d） |
| 🆕 **V9** | **真实轮次正常收束**（`"turn/end" … "kind":"completed"`） | `zstd -dc sessions/**.jsonl.zstd` ＋ grep | **必须先 `turn`** ＋ zstd CLI |
| 🆕 **V9b** | 该轮**用的就是我们指定的路由/模型**（`"provider":"minimax-bench"`） | 同上 | 同上 |
| 🆕 **V9c** | 会话日志里**零**凭据错误（`MISSING_CREDENTIAL` 命中 = 0） | 同上 | 同上 |
| 🆕 **V9d** | profile patch **真落地**（`/logs/profile-patch.sha256` 在 ＋ patch 里路由名命中 > 0） | `cat` sha ＋ grep 路由名 | `up` 时传了 `PROFILE_PATCH` |

> 🔵 **V9 家族为什么必须新增（判据纪律）**：**"缝被走到" ≠ "功能可用"** —— V5/V7b 在**没有任何模型凭据**的容器里**照样全绿**，而那时**每条真实轮次都以 `MISSING_CREDENTIAL` 结束** ⇒ 旧判据集**结构性回答不了** owner 的问题（"装完能不能真的用"）。V9 家族把三件事拆成三档（**收束** / **模型身份** / **零凭据错误**）＋ V9d 补**装配面**旁证。EXPECT 可用 `EXPECT_PROVIDER` / `EXPECT_MODEL` 覆盖（默认 `minimax-bench` / `MiniMax-M3`）。

**192.168.1.4 实测状态（锚定 2026-09-25 16:1x，读数器 = `bench-docker list`）**：**新容器** `dsh-bench-r20260925-1614-4eb2` running（镜像 **`dsh-bench:0.1.7-rc.2`**，1.04 GB —— **第 ⑥ 项实测的载体**，证据见 §2.9 对账表）｜**旧容器** `dsh-bench-mb3` 仍在 running（镜像 `dsh-bench:0.1.7-rc.1`，1.08 GB，起动 **2026-09-24 02:23 +08:00**）｜两镜像并存｜远端磁盘 `/` 489G ／ 已用 360G ／ **可用 109G（77%）**。
（**历史读数**，锚定 2026-09-25 15:31，勿当前值用）：当时只见 `dsh-bench-mb3`（重启 0 次，`ExitCode 0`，≈37h）｜`PortBindings {}`（3080 **仅 EXPOSE**，未发布）｜挂载 `/opt/dsh-bench/dist:/ccc/dist:ro`（⇒ 该容器是 **tarball 模式**起的）｜`RestartPolicy no`。
**🔵 最新读数（锚定 2026-09-25 18:1x，读数器 = `bench-docker list`）**：**containers 段为空**（`mb3` ／ `1614-4eb2` ／ `1704-2565` ／ `1717-71ff` 已全部 `down`，见 §2.8e）｜镜像 `dsh-bench:0.1.7-rc.2`（1.71GB）在｜远端磁盘 **489G ／ 已用 363G ／ 可用 107G（78%）**。⚠️ 上述"两镜像并存"已不成立（rc.1 镜像随 mb3 一起清掉）。

#### 2.8a ✅ 复用性验证（2026-09-25 17:0x，**⑥ 的后续增量之一**）

**目的**：证「这台与**宿主 rc 版本解耦**」—— 即 owner 要的"**能存活多年**"在测试台这一维上的机械证据（否则台只对某一个 rc 有效，宿主一升级就得重建台）。

**做法**（全用现成通道，零新增代码）：`sync` → **`build --dsh-version=0.1.7-rc.1`**（⚠️ 必须重建：旧 rc.1 镜像的 `entrypoint.sh`/`verify.sh` 是**构建期 bake 的快照**，不含今天新增的步 0c 与 V9 家族）→ `up --dsh-version=0.1.7-rc.1 --plugin-tarball` → `wait` → `vpush`（V0 自证）→ `turn` → `verify --acc-version=1.47.3`。

**结果**：🔴 **`PASS=19 FAIL=0`**（容器 `dsh-bench-r20260925-1659-dd9e`，已 `down`）。逐条读数示例：V1 宿主 = **0.1.7-rc.1**｜V4 ACC = **1.47.3**｜V5 身份播种 2 处｜V6b `host contract degraded (4 optional)` **非 BROKEN**｜V8 客户端面 7 项｜**V9 完成轮次 3 ／ V9b 模型命中 7 ／ V9c `MISSING_CREDENTIAL` 0 ／ V9d patch 已落地**。`secretcheck` 三读数同样全过（在场 ∧ 未进镜像层 ∧ 未落盘）。
⇒ **结论：同一台、同一套 19 条判据，在 rc.1 与 rc.2 上都判 PASS**（rc.2 的读数见 §2.9a）。**换 rc 的操作纪律**：**`build` 一次（或至少 `vpush` ＋ 核对 V0）** —— "复用旧镜像" ≠ "复用测试台"（镜像里 bake 的是**构建那一刻**的脚本，㊳ 同族）。

#### 2.8c ✅ 真浏览器面（V8b）—— 判据 19 → **20 条**（2026-09-25 17:1x）

**动机**：V8 是**交付面**（宿主 profile 里有我们的 bundle ＋ 槽位语句在场），作者自述边界＝"**非真浏览器证据**"；而 **A19**（十键未标 `.volatile()` ⇒ 设置页整块消失）在日志上**一条报错都没有**（V6b 全绿）⇒ 只有真渲染才看得见。**判据阶梯**：V6b 契约层 → V6c 功能层 → V8 交付层 → **V8b 真浏览器层**。

**做法**：① `bench/Dockerfile` 装 **chromium**（读数器）② 新增 **`bench/v8b-browser-check.mjs`** ③ `verify.sh` 接 **V8b**（读数器缺失 ⇒ **报 FAIL 不报 PASS**：`"判不了"与"过了"在验收表上不能长得一样`）④ CCC 侧 `bench-docker.ts`：`BENCH_FILES` 加入该探针 ＋ `up` 新增**默认关闭**的 `--publish=<hostPort>`（真浏览器取证备用通道）。

**实测读数（载体容器 `dsh-bench-r20260925-1709-93d9`，宿主 rc.2 ／ 插件 1.47.3，**`PASS=20 / FAIL=0`**）**：**P1** 页面在真引擎启动（DOM **493,591 字节**）｜**P2** 我方客户端模块**真被浏览器请求**（netlog 命中 `dsh-serenity-hooks` **7** 处 ／ `client.js` 455 处）｜**P3** 渲染期零致命 JS 错误｜另落截图 `/logs/v8b-panel.png`（36,935 B）。

🔴 **本节最重要的一条：V8b 首版差点**假绿** —— 判据写法的陷阱（可复用的教训）**
- 首版判据 = `html.includes('sp-brand')`（"DOM 里有我方类名 ⇒ 渲染了"）。
- 实测：**元素级命中 0 ／ 类名文本命中 3** ⇒ 那 3 处来自**注入的 `<style>` 选择器文本** —— **组件一个都没渲染时也会命中**（判据读的是 CSS，不是 DOM 元素）。
- 收紧为"元素形态"`class="… ss-title …"` 后**如实 FAIL**；继查"落地页无会话（截图实证 'No sessions yet'）＋ 设置页非路由可达（`/settings`、`/?view=settings`、`/#/settings`、`/` 四入口元素级命中皆 0）"⇒ **元素级渲染必须靠 CDP 交互**（点开设置面板）。
- ⇒ 最终 V8b 改判「**页面真渲染 ＋ 我方模块真被浏览器请求**」（**严格强于 V8** 的"profile 里有文件"），并把 verify 行的标签同步改名，避免**过度声称**。
- ✅ **V8c 已交付**（2026-09-25 17:4x，见 **§2.8d**）：容器内起 chromium 带 `--remote-debugging-port` ＋ Node 内建 `WebSocket` 说 CDP，**真点开设置面板**后断言元素级渲染 —— 这是"A19 同类缺陷的完整机械守卫"。

🔵 **两条环境读数（同批实测，勿重复踩）**：① **`--virtual-time-budget` 会让 `--dump-dom` 永不返回**（被 60s 超时杀 ⇒ 表现为"chromium 起不来"＝**读数器失败被误读成被测对象失败**）⇒ 改用 chromium 自己的 `--timeout`；② **测试台宿主端口从本机连不上**（实测 `192.168.1.4:80` = 200、临时发布的 `:18080` **被拒**，服务器上也没有浏览器）⇒ 真浏览器取证走**容器内**最稳。

#### 2.8b 🔴 修正：`down` 的磁盘警告曾是**写死的旧读数**（读数器撒谎，已修）

**事实**（2026-09-25 17:0x 实测）：每次 `down` 都打印「⚠️ 192.168.1.4 的 / 只剩 **~18 GB** ⇒ 用完即清是本台的常态」，而**同一时刻**：`bench-docker list` 读 `df` = **108G 可用（77%）**、主机 `docker system df` = images 33.74GB（reclaimable 11.13GB）／build cache 22.36GB（reclaimable 0.8GB）／containers 3.835GB ⇒ **三个独立读数一致，那行警告是假的**。
**根因**：那句是**某次真实读数被写死成字符串**（§4.2-㉞ 家族：把"写下即变"的值当成了常显警告）—— 不是解析错误。
**修正（CCC 侧 `bench-docker.ts` 的 `cmdDown`）**：改为在**同一次 ssh 往返**里取实时 `df -h /`（零额外开销），并把提示改成中性表述。
**验收判据（可重跑）**：`msm("bench-docker", ["down", "<任一容器>", "--keep-image"])` 的输出必须含 `--- disk（清理后实时）` 行且数值与 `list` 一致；**不得**再出现"只剩 ~18 GB"字样。
**实测验收**（2026-09-25 17:0x）：用一个一次性容器做探针 ⇒ 输出 `--- disk（清理后实时）` ＋ `489G 361G 108G 77% /`，随后 `docker ps -a` 复核该容器确已删除。

#### 2.8d ✅ 元素级渲染面（V8c）—— 判据 20 → **21 条**（2026-09-25 17:4x）

**动机**：A19（十键漏标 `.volatile()` ⇒ 设置页整块消失）**在日志上零报错**；V8 只证"bundle 送达"、V8b 只证"模块真被浏览器请求" —— **送达到 ≠ 渲染出来**。V8c 把最后一跳（"那个 section 真的出现在页面上"）机械化了。

**做法**：① `bench/Dockerfile` 加 **chromium** ② 新增 **`bench/v8c-cdp-panel-check.mjs`**（真输入 CDP 点击 ＋ 元素级断言）③ `verify.sh` 接 **V8c**（读数器缺失 ⇒ FAIL 不 PASS）④ CCC 侧 `BENCH_FILES` 收录该探针。

**实测读数（载体容器 `dsh-bench-r20260925-1717-71ff`，宿主 rc.2 ／ 插件 1.47.3，`PASS=21 / FAIL=0`）**：
- **P1** 页面经 CDP 可交互（`#root` 已挂载）｜**P2** 真输入点击触发器 ⇒ **设置模态框真打开**（`[data-shortcut-modal="settings"][role=dialog]`）｜**P3 我方 section 导航行作为元素出现**（面板导航行逐字 = `General / Models / Built-in plugins / Agent presets /` **`Serenity`** `/ Open configuration file / Close / …`）｜**P4** 点我方后 **`.ss-title` 是 `HTMLElement` 且文本 = `Serenity`**，我方 class 元素 **117** 个，面板尾部逐字含「ACP ／ Skiff 问答页 ／ CRO（轨迹自编程唤起）／ 彩蛋模式 ／ 微信桥 ／ 会话清理」（与 `src/client/SettingsSection.tsx` 文案一致）。

**🔴 四条根因（首版三次红/假绿，全部以宿主源码 ＋ 实测取证；后两条属"读数器自己不可信"）**：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 找不到"设置入口"（候选按钮为空） | `Settings` 只是**触发器按钮里的 `<span>`**（`TriggerContent` 只渲染 icon ＋ label span）；真正的可点元素是 `<button aria-label="Settings" aria-haspopup="dialog">` | 选**语义锚**（`aria-*`）＋ **CDP `Input.*` 真输入**点击（`isTrusted`、有 moved/pressed/released 三段） |
| 2 | 点开设置后查 `.ss-title` 恒为 0 | 设置 UI 是 **body-portaled 模态框**，且**默认选中第一节（general）** ⇒ 我方 section 只有**点它自己的导航行**才渲染 | 判据链改为 **开面板 → 我方导航行是元素 → 点它 → `.ss-title` 是元素**（四环，逐环有读数） |
| 3 | 真输入"点了没反应" | 落地页自带**开机提示弹窗**（"Internal Testing Notice"）的 `mask` 铺满全屏 —— 实测 `elementFromPoint(触发器中心)` = `DIV class=_mask_…` | 探针**先关掉挡路弹窗**（点它自己的按钮 ／ Escape）＋ `realClick` 内置**命中测试**（命中点不是目标就如实打印） |
| 4 | 同一份代码**一次绿一次红**（`verify` 里红、单跑绿） | 🔴 **判据连到了上一轮遗留的浏览器上**：① `process.exit()` **不执行 `finally`** ⇒ 每轮留一个 chromium 孤儿；② chromium 对同一 `user-data-dir` 是**单例**（新实例把请求交给旧实例后自己退出）⇒ "新的一轮"其实连在**旧实例**上（页面停在上一轮交互后的状态） | **每轮唯一 profile ＋ 唯一 CDP 端口**（pid 派生）＋ 收摊挂 `process.on('exit')` ＋ 开头**清场并等旧实例真死**（`pkill -9 -f -- '--user-data-dir=/tmp/v8c-profile'` ＋ 轮询） |
| 5 | 🆕 🔴 **V8c 偶发 FAIL（2026-09-25 22:0x 实测）** —— `P2`（模态框没开）连带 `P3/P4` 一起红，而诊断里 `atPoint` = `DIV._mask_17i0t_18` | 🔴 **harness 缺陷：`realClick` 算了命中测试却不用它** —— 它**返回**了 `hit`（命中点是谁），但**从不据此决策**，明知命中点不是自己照样把鼠标发过去 ⇒ 红绿取决于"那个 mask 在不在"，**与被测代码无关**（判据纪律 53）。**次因两条**：① `dismissBlocking` 只在 P1 后调**一次**，而该弹窗可能**晚于 `#root` 挂载才渲染** ⇒ 整个错过；② 它的按钮点击用 `b.click()`（**DOM click，不经命中测试**）。**结构取证**：mask 与 dialog 是**兄弟**节点（`rootChildren=[mask, dialog]`），`maskZ=auto` / `dlgZ=1` ⇒ **对话框按钮本身可命中**（`continueBtnIsHit=true`），mask 压在dialog**下面** | `realClick` 改为**先命中测试 → 不是自己就先清障（真输入点它自己的按钮／Escape）→ 重测 → 仍被挡则如实返回 `occluded` 且**不点****（绝不把失败伪装成"点过了"）；清障最多两轮，不做无限重试。新增 `hitOf()`（命中测试独立）＋ `realClickExpr()`（真输入点任意元素）；`dismissBlocking` 按钮点击改**真输入**，收尾补一刀"确认 mask 真没了"。**验证**：连跑 **4 次 `PASS=21 FAIL=0`**，P4 读数 `via=CDP Input.*`（走的正是修好的命中路径） |

🔵 **行 5 的附带证实（取值于宿主 client bundle，非推测）**：该弹窗文案键 = `welcomeTitle: "Internal Testing Notice"` ／ `welcomeContinue: "Continue"` ／ **`welcomeError: "The acknowledgement could not be saved. Please try again."`** ⇒ **确认"已知晓"状态存在宿主侧**（这解释了实测现象：**全新 browser profile 也看不到该弹窗**）。⚠️ 因此该弹窗**不是每轮必然出现** —— 判据不得依赖"它在不在"，只能依赖**"出现了就处理掉"**（这正是修法所取的口径）。
🔵 **行 5 的沉淀判据（比结论值钱）**：**探针"算了判据"就必须"用它"** ——「计算了命中测试却忽略结果」与「没有命中测试」在**失败形态上完全一样**，但前者**更危险**（它看起来是测过的）。
⚠️ **本行修的是 `bench/`（开发面，不进 npm 包）**：`pack-check` 实测 **118 文件全在 `lib/`** ⇒ **不发版**（D14：无用户可见功能变化，不该为它动版本号）。

**另两条实测陷阱（同批踩到）**：① **`pkill` 的模式会命中自己所在的进程树** —— 写 `pkill -9 -f v8c-profile` 会把**调用它的 shell 自己**杀掉（那条命令的 cmdline 就含该子串）⇒ 整条测试命令 `exit 137`（看起来像"探针崩了"）⇒ 模式必须**带旗标**（`--user-data-dir=…`）；② **"URL 里带 token"不能当身份判据** —— 宿主会把 token 从地址栏抹掉（写进自己的存储后 `replaceState`）⇒ 该判据**恒假**，探针会一直报「CDP 端点未就绪」（像"chromium 起不来"）⇒ 身份靠**每轮唯一端口**保证，靶是谁打进读数。

**稳定性验收（判据纪律"时序/端口改动 ≥5 连跑"）**：`for i in 1..5` 连跑 **5/5 全绿**（每轮 `PASS=4 FAIL=0`），**零遗留 chromium**（`ps -eo args | grep -c [c]hromium` = 0）。

#### 2.8e 🔴 修正：`down` 的"已删"曾是**假成功**（读数器撒谎，已修）—— 与 §2.8b 同族，但**退出码本身也在撒谎**

**事实**（2026-09-25 18:0x 实测）：`down dsh-bench-mb3`（名字多写了一层前缀，容器真名 = `dsh-bench-<run-id>`）打印 **"container removed"**，而**同一时刻** `bench-docker list` 里它**还在跑**。
**两层根因**：① `cmdDown` 原先写 `docker rm -f <name> >/dev/null 2>&1 || true` 紧跟一句**无条件**的 `echo container removed`；② 更麻烦的是 —— **这条命令的退出码本身不可信**：远端 **Docker 29.1.3** 对**不存在的容器** `docker rm -f zzz-definitely-absent` 报 `No such container`（stderr）**却 `exit 0`**（`ssh-connect exec` 复现：`RM-RC=0`）⇒ **"按退出码判断"在这里依然会撒谎**。
**修正（CCC 侧 `bench-docker.ts` 的 `cmdDown`）**：判据改为**读结果状态** ＋ **先判"它到底有没有"**：
- `PRE=$(docker ps -a --filter name=^<name>$ …)` 为空 ⇒ 打印 **「container 不存在（未执行删除）」** ＋ 名字规则提示（把"名字写错"与"删失败"分开报）；
- 否则 `docker rm` 后**再读一次 `ps -a`**：列表已无它 ⇒ `container removed（rm exit=…；ps -a 列表已无它）`；仍在 ⇒ `container NOT removed（…；ps -a 列表里仍在）`＋ 附 stderr。
**验收（三条形态各跑一次，2026-09-25 18:1x 实测）**：① `down zzz-nope-nothing` ⇒ **「container 不存在（未执行删除）」**（修前打印"已删"）② `down mb3 --keep-image` ⇒ **真删**（`container removed … ps -a 列表已无它；image=dsh-bench:0.1.7-rc.1`，随后 `list` 复核确已消失）③ `down r20260925-1717-71ff`（已 `down` 过）⇒ **「container 不存在（未执行删除）」**。
**同批（卫生）**：容器 `r20260925-1614-4eb2` / `r20260925-1704-2565` / `dsh-bench-mb3` / `r20260925-1717-71ff` **全部 down**（各留镜像）⇒ **锚定 2026-09-25 18:1x 实测**：`list` 的 containers 段为空、镜像 `dsh-bench:0.1.7-rc.2` 在、远端磁盘 **107G 可用（78%）**。
⚠️ **仍存（低成本待办）**：`down --keep-image` 保留了**未打 tag 的镜像层**（`ed087861443c` ／ `c3bcebe53501`）—— 清它们需确认无 tag 指向（避免误删 `dsh-bench:0.1.7-rc.2` 的 tag）。

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
| `scripts/` / `bench/`（L5） | ✅ §2.8（集成测试台 ＋ 判据清单 **V0~V9d 共 21 条**）／ **§2.8a 复用性验证** ／ **§2.8b/§2.8e 读数器撒谎修正** ／ **§2.8c 真浏览器面（V8b）** ／ **§2.8d 元素级渲染面（V8c）** ／ §2.9 ＋ **§2.9a（第 ⑥ 项 · 已执行对账）** |

⇒ **六域全部到齐**（2026-09-25）。本文件自此为**完整的现况地图**；后续按 §6.2 与新增/删除同批维护。
