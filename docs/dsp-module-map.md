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
| 测试 | **108 文件 / 1700 用例**（`dsh-develop test` 读数） |
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

### 2.7 测试面（108 文件 / 1700 用例）

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

- **读数**：对宿主包的直接 import **146 处**，**远不止** `src/host/` ＋ `src/seams/`。
- **分布（已见）**：`tools/*` 取 `defineTool` / `ContentBlock`（工具 API 面，**必要接触**）；`rebuild.ts` / `wake-scheduler.ts` / `skiff-core.ts` / `unattended-seam.ts` / `cro-turns.ts` / `agent-idle.ts` / `acp-core.ts` / `output-guard-seam.ts` 等直接吃 `dsh-session` / `dsh-agent` / `dsh-llm` 的**类型**（**可收敛接触**）。
- **处置方向（待④细化）**：把 I2 写成**分级约束**（必要接触走白名单；可收敛接触迁到 L0 的中立类型），并给出**逐文件的收敛清单**。

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

- `seams/lifecycle.ts:sessionIdOf` **导出了**，但 `cro-turns.ts` / `weixin-output-guard.ts` / `unattended-seam.ts` **各自另写私有同名副本**，未 import 该导出。⇒ 语义漂移风险（四处各改各的）。

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
| 6 | **注释层残留** | `trajectory-ops.ts` 文件头仍列 `logbook/close/archive/health/qa`（代码已删）｜`clock-runtime.ts` 文件头仍提 `wakeSchedulerEnabled` 闸（2026-09-21 已砍） |

### 3-8. 工具面的死代码候选

| # | 对象 | 读数 |
|---|---|---|
| 1 | `msm-ops.ts:MsmEntry`（export interface） | `src/**` 仅自身 8 处、`tests/**` **0 处** ⇒ 无外部消费者（纯类型） |
| 2 | `tools/praxis.ts:PRAXIS_INDEX` | `src/**` 除本文件 2 处外 0；**只被 tests 用** |
| 3 | `tools/trajectory.ts` 的 `sanitizeSessionSummary` / `renameDshSessionOnUse` / `activeInfoFromCreate` / `renameDshSessionForActive` | 包内自用，对外**只被 `session-title.test.ts` 引用** |
| 4 | ⚠️ 形状问题：`msm-ops.ts:MsmArgs` **未导出**，却被 `runMsm`/`runMsmAsync` 的**公开签名**引用 | 外部调用方只能传结构等价字面量（类型不可见 = 契约不完整） |

### 3-9. 🔴 测试面缺口（**第 ⑤ 项的输入**）

| # | 缺口 | 证据 / 读数 |
|---|---|---|
| 1 | **客户端半零行为测试** | 8 个 `.tsx` ＋ 4 个 `.css` **无任何行为/渲染测试**；根因可判定 = 两份 vitest 配置 `environment: 'node'` 且 `devDependencies` **无 jsdom** ⇒ 客户端半在测试面上**不可执行** |
| 2 | **客户端半不在覆盖率门禁内** | `hooks/vitest.config.ts` 的 `coverage.exclude` 含 `src/client/**`（阈值 statements 60 / branches 55 / functions 55 / lines 60） |
| 3 | **槽位装配无门禁看护** | `client/index.ts` 的 3 次 `slots.register` ＋ `configForms.whileServed` 无测试；且 `coverage-gate.test.ts` 的过滤条件 `.filter(rel => !rel.includes('client/'))` 把整个 `client/` 排除 |
| 4 | **白名单残留项** | `coverage-gate` 的 `INDIRECT_COVERED` 含 **`autopilot-trajectory.ts`** —— 该文件在 `src/tools/` 下**已不存在**（目录实测 15 文件，无此名） |
| 5 | 🔴 **缺口形态 = "未被真正执行"，不是"未被提及"** | `coverage-gate.test.ts` 用正则 `['"][^'"]*\/mod\.js['"]` 在**测试源码文本**里匹配 import 字符串 ⇒ **"提到即算覆盖"**。本仓**不存在门禁意义上裸奔的模块**（这一区别决定第 ⑤ 项该怎么补） |
| 6 | **只有 3 个测试走生产入口** | `register` / `config-volatile` / `skiff-startup-retry` 才 `import { apply } from '../src/index.ts'` |
| 7 | 🔴 **fake ctx 的已知盲区（有真实先例）** | 真宿主 cordis 的 `Context` 是 **Proxy**：访问**未在 `inject` 声明**的服务名会**抛错**，而普通对象 ctx 只返回 `undefined` ⇒ v1.31.3 handyman foreground **真机报** `cannot get property "subagents" without inject`，而"**全部 fake ctx 单测都是绿的**"（证据 = 同仓 `host/cordis-access.test.ts` 注释） |
| 8 | **唯一的真宿主访问层测试可整体 skip** | `host/cordis-access.test.ts` 用宿主真实 cordis（peer-only，本仓不安装）；"一个都找不到时（CI runner 未装 DSH 宿主）**整体 skip**" |
| 9 | **行为证据指向不存在的落点** | `client-popover-clip-guard.test.ts` 注释指向 `ui-probe/`（CDP 真机行为证据目录）—— **该目录在本仓不存在**（全仓 grep 仅该注释一处命中） |
| 10 | 行为测试内夹源码文本断言 | `gateway` L465-499 ／ `trajectory-bound` L307/319/475 ／ `trajectory-skills` L300-328（读 `src/**` 文本）⇒ 属于"接线钉"，不构成行为证据 |

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
| `scripts/` / `bench/`（L5） | ⏳ 侦察中 |
