# DSH 0.1.7-rc.1 对 dsp（dsh-serenity-plugin）的适配方案

> 触发 = owner 2026-09-23 21:2x 逐字：「**算了，npm还没发，github发了。先拉github代码做方案吧**」。
> 体裁对齐先例：`docs/dsh-0.1.5-rc-adaptation-plan.md`（rc.1 轮）、`docs/dsh-0.1.5-rc.3-adaptation-plan.md`（rc.3 轮）。
> 本轮**只出方案 ＋ 取证**：**不安装 / 不 deploy / 不 restart-web / 不发布**（D14；且目标版本**尚未上 npm**）。

## 0. 摘要

| 项 | 结果 |
|---|---|
| 目标版本 | **GitHub tag `dsh-v0.1.7-rc.1`**（sha `46a7f68b`）；**npm 上没有**（npm：`latest`/`next` = `0.1.5-rc.3`、`alpha` = `0.1.7-alpha.2`） |
| 契约面 | **19/19 服务存在**（其中 **2 个 API 变了**）｜**12/14 事件存在**（**2 个被移除**，各有后继）｜**2/2 工具缝完好**，决策类型一致 |
| 🔴 **真断裂** | **3 条**：**B1** `settings.installSection` + `settings.get` 被移除（**静默失效**）｜**B2** 事件 `agent/session-start` 被移除（**我们标 `required:true`** ⇒ ACC 身份播种失效）｜**B3** `@deepseek-ai/dsh-agent-presets` **包改名**（编译期） |
| ✅ **不构成障碍** | **准入闸放行**（见 §4，实测判定）｜**`ToolDefinition.output` 我方 11 个工具全部已声明** ⇒ 该新增必填项**不是断裂**｜**`agentPresets` 服务名与 `composeFrom` 签名不变** ⇒ B3 只改包标识 |
| 🎯 附带 | **观察项 15（PTC / 前缀缓存破点）的预登记触发条件已实现**（`workflow-ptc` 已是包）⇒ 见 §7 |
| 落地 | 建议 **S1→S4 四步**（§8）；**S1 必须先做**，否则类型门禁连跑不起来 |

**一句话**：新线**不是"全绿"**，但也**不是"不能用"**——它移走了两处我们真正在用的接口（设置面板、身份播种事件），其余基本保形；**准入不会拦我们**，但拦的方式是"静默跳过"，这一点必须写进纪律。

## 1. 需求与来源

- **owner 令**（2026-09-23 21:2x，微信原始日志已录）逐字：「**算了，npm还没发，github发了。先拉github代码做方案吧**」
  ⇒ ① 上一轮"新 rc 已发"的读数**本身没错**（npm `0.1.5-rc.3` 确为当时 latest），但**指错了线**；② **rc.3 的三项收口议题就此搁置**；③ 本轮任务 = **拉 GitHub 代码 ＋ 出方案**。
- **独立取证**：GitHub repo `deepseek-ai/deepseek-harness`（**public / MIT / 默认分支 master**），`pushed_at` = **2026-09-23T13:30:24Z ≈ 21:30 本地**；tags 最新 = **`dsh-v0.1.7-rc.1`**。
- **代码已拉到本地**：`AI_LAB/dsh-harness-0.1.7-rc.1/`（用 `git worktree` 从既有 clone `AI_LAB/dsh-harness-public` 派生 → **不重下 215 MB、不动既有工作树**）。仓库规模：**307 个包**，根 `package.json` version = `0.1.7-rc.1`。
- ⚠️ **无 CHANGELOG / release-notes**（实测：`**/*CHANGELOG*` 零命中；docs 无 0.1.6/0.1.7 提及）⇒ 变更理由全在 **`.agents/notes/implemented/**` 的 Agent Notes** 里。

## 2. 范围与边界

**做**：源码级断裂清单 ＋ 迁移动作 ＋ 落地顺序 ＋ 验收判据（= 本文档）。

**不做**：安装 / deploy / `restart-web` / 发布（**D14**；且目标版本未上 npm）。

**本轮未跑门禁**：插件仓**零改动**（截至本文档）。

## 3. 取证方法与正控

1. **代码源** = GitHub 检出（权威，对应 rc.1）。
2. **类型对撞的替身**：rc.1 未上 npm ⇒ 用 npm 上有的 **`0.1.7-alpha.2`** 解包（35 包，含补抓 `@deepseek-ai/cordis@4.0.4` / `@deepseek-ai/schemastery@3.18.4`）。
   🔴 **替身的边界已实测**：`git log -6 dsh-v0.1.7-alpha.2..dsh-v0.1.7-rc.1` ⇒ **其间仍有实质提交**（含 `fix(plugins): deny incompatible bundles…(#5061)`）⇒ **alpha.2 ≠ rc.1，凡基于它的结论都必须带作用域**。
3. **fail-closed 正控**：`typecheck-host` 在解包不全时**拒绝出结论**（首次报 11 条缺失目录），不是静默假绿。
4. **审计侧自纠（读数器不瞎的证明）**：① 查询形式 `declare module 'cordis'` **0 命中** vs 正确形式 `'@deepseek-ai/cordis'` **159 命中** ⇒ 前者是**查询形式的假阴性**；② 成员检索用 `  create\(` 误报 `agents.create` 缺失，改模式后命中 `async create(options)` ⇒ **两条都当场自纠并登记**。
5. ⚠️ **诚实边界**：容器内**无完整 0.1.5 树** ⇒ 全树 delta 只能按 **0.1.2 → 0.1.7** 计；0.1.5→0.1.7 的精确比对仅覆盖已解包的 47 包。

## 4. 准入判定（**结论：不阻断**；但有一条静默风险）

| 项 | 事实（含坐标） |
|---|---|
| 我方形态 | **bundle**（`package.json` `dsh.bundle.patch = ./cordis.patch.yml`）—— 与"plugin row"不同 |
| 闸在哪 | `plugin-compatibility.ts:61-88` `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`；读 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer（`:75`） |
| 判据 | `!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`（`:77`）⇒ **走 `semver` 包的真 SemVer 数值比较**，**不是字典序** |
| 我方范围 vs 新宿主 | `^0.1.5-rc.2` vs `0.1.7-rc.1` ⇒ **准入（无拒载、无告警、无需豁免）**。理由：caret on `0.x` = `>=0.1.5-rc.2 <0.2.0`，`0.1.7` 落在其中，`includePrerelease:true` 放宽预发布匹配 |
| 🔴 **风险形态** | **plugin row 不兼容 = 硬拒**（`ManagementFailure('incompatible-version')`）；但 **bundle 在启动时不兼容 = 静默 `skip` ＋ 一行 stderr**（`profile.ts:660-668`）⇒ **若将来把范围收窄（如 `~0.1.5`），整个补丁层会无声消失** |
| 豁免通道（本方案不依赖） | profile 级 `compatibility.json`；`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <exact> --accept-risk`；或 `plugin_manager` 工具的 `set_version_exemption` |
| ⚠️ 未验证 | bundle 分支**是否由 #5061 引入**（无 git diff 通道）；但可证该闸**后于**我方声明的 floor —— **0.1.5-rc.3 的 `dsh-app-boot` 完全没有这套闸**（正控：同包内 `loadProfileDirectory` 等 17 命中 ⇒ 读者不瞎） |

**⇒ 纪律（新增，写进 §6 判据面）**：**bundle 的版本不兼容是静默的** ⇒ ① 我方 peer 范围**不得收窄**到会把新线排除的程度；② 每次宿主升级后，除看门禁外还要**确认补丁层真的生效**（判据 = 我们的行/禁用项在组合后的配置里出现）。

## 5. 断裂清单（逐条：证据 → 我方落点 → 影响档 → 迁移）

### B1 🔴 `settings.installSection` ＋ `settings.get` **被移除**（`SettingsProvider` → `SettingsForms`）

- **证据**：0.1.5 有 `dsh-settings/lib/types/index.d.ts:228`；0.1.7 的 `packages/settings/settings/src/index.ts:38-43` 声明 `settings: SettingsForms`，其类只有 `configure(:266)` / `prepareDocument(:296)` / `describe(:302)` / `update(:347)` / `replace(:357)` / `mutate(:367)` —— **`installSection` / `get` / `register` 全无**。
- **我方落点**：`src/settings-section.ts`（`:7/:22/:166/:170/:172/:197/:201-202`，含历史"`this` 绑定"修复）｜`src/host/contract.ts:91`｜`src/host/type-contract.ts:107`｜`src/host/access.ts:83`。
- **影响档**：**静默失效（功能消失，不崩）** —— 我们的设置面板（含「无人值守」总闸所在的那一页）在 0.1.7 上**不再出现**。
- **迁移**：**无 drop-in 替代**。新模型 = *Config schema 投影成表单*（`configure({auto})` 定每实例页面策略）。⇒ **待 owner 裁的路线问题**（这是本方案唯一需要方向决策的点）：
  - (a) **移植到新表单模型**（工作量最大，但保住"在原生面板里开关"的体验）；
  - (b) **降级**：面板不动，改由 CCC 侧配置面（`localstore` / `.opencode/serenity.json`）承担开关 ⇒ **零宿主依赖**，但失去 UI。

### B2 🔴 事件 `agent/session-start` **被移除**（后继 = `agent/created`）

- **证据**：0.1.5 `dsh-agent/lib/types/runtime-types.d.ts:298`；0.1.7 无该名（源码与 `EVENT_API` 皆无）。后继 `packages/core/agent/src/runtime-types.ts:261`：`'agent/created'(this: Scoped<Agent>, payload: { agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>` —— 🔴 **`@mode` 由 `emit` 变 `serial`**。
- **我方落点（5 处订阅 ＋ 2 处声明）**：`src/seams/context.ts:235`（**ACC 身份播种**）｜`src/gateway.ts:645`｜`src/cro-turns.ts:159`（CRO「在跑」标记）｜`src/index.ts:412`（反应式再触发名单）｜`src/output-guard.ts:38`（事件名单）｜声明：`contract.ts:254/276`（**`required: true`**）、`type-contract.ts:210`。
- **影响档**：**高** —— 身份播种失效 = 我们最在意的"我是谁"注入不再发生；CRO 在跑标记与输出守卫的事件面同时踩空。
- **迁移**：改订 `agent/created` ＋ **回归三件事**：① **`emit → serial` 的时序变化**（serial 会等待返回值 ⇒ 我方处理函数若慢会**阻塞创建**）；② 新增 `signal`（须判是否需要响应取消）；③ 载荷字段名核对（`source` 仍在）。

### B3 🟡 `@deepseek-ai/dsh-agent-presets` **包改名**（→ `@deepseek-ai/dsh-agent-preset-registry`）

- **证据**：0.1.7 无此包目录（正控：旧名**只**以 npm tarball URL 形式残留在 `scripts/dependency-catalog/package-lock.json:814`）；新声明 `packages/preset/agent-preset-registry/src/index.ts:24-27`。
- **✅ 关键澄清**：**服务名仍叫 `agentPresets`**，且 **`composeFrom(ctx, parent)` 签名不变**（新 `:275-291` vs 旧 `dsh-agent-presets/lib/types/index.d.ts:231`，仅参数名不同）⇒ **调用点零改动**。
- **我方落点**：`src/tools/handyman.ts:30`（纯类型 import）｜`package.json:59`（peer）`:88`（optional meta）`:102`（devDep）｜`tsconfig.json:30`（paths）｜`pnpm-workspace.yaml:9`。
- **影响档**：**编译期 `module-not-found`**（这正是 `typecheck-host` fail-closed 报的那 **1 条缺失路径**）；运行期为降级（两处调用都是 `ctx.get(...)` 可选读取 ＋ 显式回退 ⇒ 症状是**丢掉 preset 继承**，不崩）。
- **迁移**：**只改包标识**（import / peer / devDep / paths / workspace 五处同批），`ctx.agentPresets` 与 `composeFrom` 调用**一行不动**。

## 6. 需复核的 API 形状变化（未定性为断裂，但落地前必须逐条过）

| # | 项 | 现状 | 动作 |
|---|---|---|---|
| 1 | `webServer.register(route)` | 存在但**签名已变**（`register(route: WebRoute): () => void`，`:90`） | 核我方是否有调用点（网关 3081 相关） |
| 2 | `sessionController.resolveAgent` | **由同步改为 `Promise<ApiSessionAgentResult>`**（`:1799`） | 核我方同步调用点（冷载入路径）⇒ 类型＋行为双改 |
| 3 | `ToolDefinition.output` | **新增必填**（`src/index.ts:223`） | ✅ **我方 11 个 `defineTool` 全部已声明 `output`（逐个数过 11/11）⇒ 不是断裂** |
| 4 | 其余 17 个服务/成员 | 逐条比对**未变**（`sessions.create/get/list`、`agents.create/get/list`、`subagents.start`、`systemPrompt.section`、`tokenMeter.estimateMessage`、`sessionTitle.rename`、`storageDomain.open`、`web.registerFetchProvider`、`sessionProjections.snapshot`、`workspaceRegistry.list`、`sessionPersistence.list`） | 无需动作 |
| 5 | 工具缝 | `tools/pre-execute` / `tools/post-execute` **完好**，`PreToolDecision` / `PostToolDecision` 形状一致 | 无需动作；🔵 **新缝 4 条**（`tools/execute`、`tools/result`、`tools/change`、`tools/ptc-dispatch-log`）我方只挂 2 条，是否新增按需求定 |

## 7. 🎯 PTC 与观察项 15（**触发条件已实现**）

- **事实**：`packages/workflow/workflow-ptc/` 已是独立包（`@deepseek-ai/dsh-workflow-ptc`，"Workflow orchestration in the shared sandboxed Node PTC runtime"）；`ctx.ptcRuntime` 存在（`ptc-runtime/src/index.ts:93`）；**旧的 `codeRuntime` 改名为 `ptcRuntime`**；`tools/ptc-dispatch-log` 缝存在。
- **但要降一档说**：🔵 **PTC 不是新东西** —— `tools/ptc-dispatch-log` 在 **0.1.2 就有**。⇒ owner 2026-09-20 说的"下个大版本要动这个模式"**方向上成立，但"PTC 首次出现"不成立**（别把更名读成诞生）。
- **对前缀缓存（观察项 15 的第二问）**：目录策略文档 `docs/tool-catalog.md:36,47` 明说**provider 选择留在服务层 ⇒ 模型可见 schema 保持稳定**；agent-loop 另有"装配后的工具 schema 是否与已记录请求头不同"的跟踪（`runtime-context.ts:46`）⇒ **暂未见"每轮目录翻转"的反例**。
- **⇒ 该怎么动**：观察项 15 的**"复查"现在可以做**（只读）；但其预登记的**实测判据（一次真实会话的逐轮 `cacheReadTokens`）需要真实运行态** ⇒ **归到 `host-upgrade` 那一步之后**。⚠️ 仍守原纪律：**触发前不要实测 PTC、不要改 `bootstrap.ts`**。

## 8. 落地顺序（建议）

| 步 | 内容 | 为什么在这个位置 |
|---|---|---|
| **S1** | **声明面与身份**：B3 包改名（5 处同批）＋ 依赖 pin 跟到 `cordis ~4.0.4` / `schemastery ~3.18.4`（peer `^4.0.2`/`^3.18.2` 已兼容，devDep 精确 pin 须跟） | 🔴 **必须先做** —— 否则 `typecheck-host` 因缺失路径 fail-closed，**后面几步连验都验不了** |
| **S2** | **事件迁移**：B2（`agent/session-start → agent/created`，含 `emit→serial` 时序回归）＋ B3 的 `settings/updated → settings/document-updated` | 影响最大（身份播种），且改完才能真实回归 |
| **S3** | **设置面板**：B1 —— **先定路线 (a) 移植 / (b) 降级**，再动手 | 工作量最大且需方向决策 ⇒ 单列 |
| **S4** | **形状复核**：§6-1 `webServer.register`、§6-2 `resolveAgent` 异步化 | 低风险，可并行 |
| **S5** | **门禁与验收**：`typecheck`（本机 rc.2）＋ `typecheck-host <新线>` ＋ `test` ＋ `build`；⚠️ **`host-upgrade` 属另一决策（D14），须 owner 具名** | — |

## 9. 验收判据

| # | 判据 |
|---|---|
| **V1** | 完成 S1 后，`typecheck-host <新线>` **不再报缺失派生路径**（当前报 1 条 = `dsh-agent-presets`） |
| **V2** | 完成 S2 后，**ACC 身份播种在真实会话回归通过**（判据 = 注入文本实际出现，且**创建路径未被 serial 化处理阻塞**） |
| **V3** | B1 有**明确结论**：要么新线面板可见，要么**显式声明降级**并写清替代开关面 |
| **V4** | 门禁四件全绿：`typecheck` 双面 / `test` / `build` / coverage |
| **V5** | 本轮**不发布、不 deploy、不 restart-web、不安装**（D14；且目标版本未上 npm） |
| **V6** | 发布时才回填：维护 skill §9 ＋ 插件仓 `CHANGELOG.md`（**发布细节单一真相源仍是 CHANGELOG**） |

## 10. 未验证边界（诚实声明）

1. **无完整 0.1.5 源码树** ⇒ 全树 delta 按 **0.1.2→0.1.7** 计；0.1.5→0.1.7 的精确结论仅覆盖已解包的 47 个包。
2. **rc.1 未上 npm** ⇒ 类型对撞走 **`0.1.7-alpha.2` 替身**，且**已实测二者不等价**（其间含 #5061 等实质提交）⇒ **凡"typecheck 绿"都不等于"rc.1 绿"**。
3. **准入判定是"按 semver 语义推理"，不是执行验证** —— safe mode 下无 `node`/`git diff` 执行通道 ⇒ 🔴 **若要"确凿"，须在新线运行态下实测一次**（这正是 §8-S5 之后的事）。
4. **bundle 分支是否由 #5061 引入未证**（可证的是：该闸**后于**我方声明的 floor）。
5. **§6-1 / §6-2 的我方调用点尚未核**。
6. **未做机会面取舍**：新服务/事件（§4 类目）与 4 条新缝**是否要接**，取决于需求，本文档只登记。
