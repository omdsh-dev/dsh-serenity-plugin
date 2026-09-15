# ACC 内部构件关系复审 —— 以 `container_trajectory` 为视点

- **状态**：讨论稿 v0.1（**未动代码**）
- **日期**：2026-09-15（S142）
- **起因**：用户「重新考虑整个 ACC 内部构件的关系……**以 container_trajectory 审视**，判断是否有可以简化的空间，我来审核」
- **用户给的判据样例**：「过去的 session hook 可以变动为**指定一个 skill**，当 `trajectory use` 被调用时**自动全文注入**——这就用 **harness 的更直接思路**代替了复杂的 hook 编写」

---

## 0. 先把"尺子"定下来（用户样例的抽象）

用户那条样例不只提了一个改动，它给了**一条判据**：

> **能落到 harness 已有原语上（skill / `ctx.skills` / settings / session 事件 / 文件标记），就不要在 ACC 里自造协议 + 脚本管道。**
>
> **病灶形态**（见到即应质疑）：**ACC 定义一套协议 → CCC 必须写一个脚本 → ACC 在某个生命周期点 spawn 它。**
> 三个特征同时出现时，先去找 harness 的等价原语。

这条尺子与既有裁决同向（D23 内容归属判据 / D5 plugin 全局 vs CCC 具体 / D4 零改 DSH），但它更狠：D23 只管"改它要不要发版"，本条管"**这个构件该不该存在**"。

---

## 1. 构件全貌（装配真相）

来源：`src/index.ts` 的 `apply()` 逐行（装配是唯一真相源）+ `mech-registry.json`。

### 1.1 工具面（11，2 个条件可见）

`container_fs` ｜ `container_trajectory` ｜ `dashboard` ｜ `container_git` ｜ `msm` ｜ `praxis` ｜ `handyman` ｜ `localstore` ｜ `container_admin` ｜ `im-bridge`（条件）｜ `acc-diag`（专属）

### 1.2 拦截缝（9）

guards ｜ keeper ｜ context（Induction 注入）｜ system-prompt（入口 skill 全文 section）｜ compact（压缩后重注入）｜ env ｜ opencode-skills（skill provider）｜ lifecycle（销毁清理 + 拆卸）｜ bootstrap（first-anchor）

### 1.3 机制/服务（按装配序，约 30 个模块）

| 组 | 模块 | 干什么 |
|---|---|---|
| 容器本体 | `ccc.ts` / `fs-ops` / `git-ops` / `localstore-ops` / `config-ops` / `settings-section` | 找根、读写、凭据、配置分层、宿主设置面板 |
| 轨迹自身 | `tools/trajectory.ts` / `trajectory-ops.ts` / `trajectory-bound.ts` / `rebuild.ts` / `trajectory-assistant.ts` | 生命周期 + 绑定 + 载体重建 + 注入词汇 |
| 轨迹时间 | `wake-registry.ts` / `wake-scheduler.ts` / `autopilot-trajectory.ts` / `autopilot-script.ts` | **两条时钟**（一次性 / 周期） |
| 知识 | `praxis` / `seams/system-prompt` / `seams/context` / `seams/opencode-skills` / `skills-discovery` / `skills/opencode-scan` | 提示词骨架 + Induction + skill 发现 |
| MSM | `msm-ops.ts` + `tools/msm.ts` + `tools/container-admin.ts`（msm 域） | 注册表 + 执行 + 管理面 |
| 船员 | `skiff-role` / `skiff-registry` / `skiff-core` / `handyman-ops` / `handyman-preset-inherit` | 认知子集角色 + 编排 |
| 外部载体 | `skiff-debug`(3099) / `acp-core`+`acp-http`(3100) / `gateway*`(3081) / `weixin-*`(3082) / `im-bridge`+`im-weixin` | 4 条独立 HTTP 面 + IM 通道 |
| 守卫 | `output-guard` + `output-guard-seam` / `weixin-output-guard` / `seams/guards` | 对外面敏感词 / 手动输出闸门 / 路径与可见性 |
| 观察 | `status.ts` / `api.ts` / `kit-ops`（dashboard health）/ `diag-ops`（`acc-diag`） | **四处观察面** |
| 杂项 | `totp` / `web-fetch-provider` / `opencode-provider` / `agent-idle` / `session-cleanup` / `json` / `constants` / `invariant` | — |

---

## 2. 以 `container_trajectory` 审视：一条轨迹"自己"这一轴上有几套机制

把轨迹的**自身构成**摊成八格，看每格上挂了几个构件：

| 格 | 轨迹需要什么 | 现挂构件 | 套数 |
|---|---|---|---|
| **身份** | 这个会话属于哪条轨迹 | `.bindings.json` 反查（`trajectory-bound`）+ 会话标题 + 内存激活表 | **3 个来源**（有明确优先级，属设计） |
| **身体** | SESSION.md | `trajectory-ops` | 1 |
| **载体** | dsh 会话（可弃） | `tools/trajectory.ts`（create/use）+ `rebuild.ts`（turn hook 排队执行） | **2 段**（声明在一处、执行在另一处） |
| **时间** | 何时被唤起 | `wake-scheduler` + `autopilot-trajectory` | **2 条 tick** |
| **自我调节** | 别飘走 / 别撑爆 | `seams/keeper.ts`（计分 + LIMIT + COMPACTION + rebuild 提醒） | 1（`trajectory-assistant` 只是**词汇真相源**，不是第二个调节器——**读码纠正了我的初判**） |
| **扩展** | CCC 想给轨迹加东西 | **`session-tool` MSM 脚本钩子（SEP）**：`create-transform` + 自定义子命令 | **1 套协议 + spawn 通道** |
| **诊断** | 我为什么没被唤起 | `acc-diag` + `diag-ops` | 1 |
| **知识路由** | 该加载什么 | 入口 skill 全文 section + Induction 四块 + skill 目录 + `praxis` | **4 条注入路径** |

**审视结论（一句话）**：**轨迹自身的八格里，只有三格是"一套机制"；其余四格各挂 2~4 套**——而其中**最不必要的一套是"扩展"格**（用户点名的那个），**代价最大的一格是"知识路由 × 根解析"**（见 C2）。

---

## 3. 简化候选（按 价值 ÷ 风险 排序）

### C1 ⭐⭐⭐ 扩展格：SEP（`session-tool` MSM 脚本钩子）→ **轨迹声明 skill，激活时全文注入**（用户提案）

**现状（读码）**

- CCC 注册一个 `session-tool` MSM，其 `flags` 里用 **description 文本**声明支持的钩子名（如 `create-transform`）与自定义子命令；
- `container_trajectory` 每次执行都 `loadMsmEntries` 找它、解析 description 字符串（`discoverCccHooks` / `discoverCccSubcommands`）；
- `create` 成功后 spawn：`msm session-tool --hook=create-transform --session-dir=<path>`，取 stdout 拼进工具返回；
- 另加 `buildSepGuide()`（~60 行指南文本）挂在 `container_admin msm guide`。

**证据（adoption）**

- **本 CCC 的 `mech-registry.json` 里没有 `session-tool` 条目** ⇒ 这套机制在**我们自己身上零使用**。
- 诚实边界：pangu/tiangong 两个 CCC 的 registry 在本容器**路径之外**（P3 边界），本轮**未能核实**；若它们也没用，此机制即"零用户"。

**用户提案的形态（我读作两条，可分开裁）**

| | 内容 | 落到哪个 harness 原语 |
|---|---|---|
| **a1** | 轨迹**声明**要挂的 skill；`use`/`create` 时把该 skill **全文**注入本轮 | 工具返回文本（一次性） |
| **a2** | 同上，但注入为**该会话的 system-prompt section**（只要会话绑着这条轨迹就一直在） | `systemPrompt.section`（**ACC 已在用**：入口 skill 全文就是这么注入的，`registerEntrySkillSectionGlobal`） |

**我的建议：取 a2 为形态、a1 为语义**——理由：

1. **一次性注入会被压缩吃掉**：`use` 之后若发生 compaction，工具返回里的长文会先被压掉；而 system-prompt section 由 `seams/compact.ts` 的既有保留通道续命（这正是它存在的理由）。
2. **零新协议**：`ctx.skills.registerProvider`（`seams/opencode-skills.ts`）**已经**把 CCC 的 `.opencode/skills/*` 注册进 harness 的 skill API，且 `get()` 就返回 `content`（全文）。⇒ 我们只需要**按名字取全文并塞进 section**，不需要任何新通道。
3. **声明放哪（关键设计点）**：建议放 **SESSION.md 的 YAML frontmatter**（如 `skills: [home-rhetoric, ...]`）——
   - 它是**CCC 自己的数据**（D23：内容归 CCC），随 `AGENT_SESSIONS/` 走、随 git 走；
   - **per-trajectory**（不是 CCC 全局），符合"一条轨迹需要什么知识"的语义；
   - **跨 rebuild 存活**（SESSION.md 原位不动 = Ship of Theseus 的身体），换载体后知识自动跟过来；
   - **零新配置面**（不碰 `serenity.json`、不碰 harness settings）。
   备选：`.bindings.json`（ACC 运行时态，人不可读）｜`serenity.json`（CCC 全局，**丢掉 per-trajectory** ⇒ 否）。

**会失去什么（诚实）**

- `create-transform` 今天能做**副作用**（往新会话目录里脚手架化文件）。skill 全文注入**不做副作用**——代价是"确定性"：改成"skill 里写明要做什么，由 agent 去做"。这正是用户说的"更直接"：**把 spawn 脚本换成让 agent 按 skill 执行**。
- 自定义子命令（`msm session-tool <subcmd>`）能力消失 ⇒ 但那个能力**本来就是 `msm` 的**（CCC 直接注册自己的 MSM 即可），无需借道 `session-tool`。

**删除面（若采纳）**：`discoverCccHooks` / `discoverCccSubcommands` / `buildExtHint` 的钩子分支 / `create-transform` 的 spawn 调用与错误分支 / `buildSepGuide()` 及其手册挂点 / SEP 章节。**净删约 120~150 行 + 一整套协议说明**。

**顺带的好处（可复用性）**：`SESSION.md frontmatter 声明 skill` 这条**对所有 CCC 通用**，且**不需要读 SEP 文档**——发现路径从"你得知道有个扩展协议"变成"在轨迹身体里写一行"。

---

### C2 ⭐⭐⭐ CCC 发现面归一：一个"CCC 注册表"取代 6 套各写各的根解析

**证据（实测计数）**

- `findSerenityRoot(` 出现 **40+ 次**，分布在 **~30 个文件**；
- 更贵的不是调用次数，而是**"哪些 CCC 存在 / 这个会话归哪个根"这层判断被独立实现了至少 6 遍**：

| 实现处 | 启发式 |
|---|---|
| `index.ts: resolveSkiffRoot` | ① 含 `skiff.roles` 的 live CCC ② 进程 cwd ③ 任一 live CCC +（**5 段退避重试 + waiting 标志 + 并发守卫 + 两个事件订阅**，~90 行） |
| `autopilot-trajectory.ts: collectLiveCccs` | live 会话 cwd 反推（**无 live ⇒ `[]`**） |
| `acp-http.ts: discoverCccs(ctx, defaultRoot)` | 又一套（且要传兜底根） |
| `weixin-bridge.ts:615` | 自己 dedupe cwd → roots |
| `api.ts` | workspace → root（8 处） |
| `autopilot-trajectory.ts` | mdPath → root、cwd → root（6 处） |

**它已经造成的三笔账（都不是假设，都有留档）**

1. **完全冷掉的 CCC 不能自唤醒自己**（发布版已知边界；`collectLiveCccs` 只认 live 会话）；
2. **Skiff 调试服务的 ~90 行退避重试/守卫**（v1.30.13/14 的两次打补丁：重试定时器、并发启动守卫、`informedRoot`、两个事件订阅）——根因就是"apply 时刻无法解析根"；
3. **F 段的"武装门"缺口**（时钟不武装，因为"有 live CCC"被用作前置门；后改为"全局闸开即武装"把不确定性挪进 tick）——**这是把结构问题就地打补丁**。

**提案形态**：新增一个**单一 CCC 注册表**模块（概念上就是 `ccc.ts` 升级为一个服务），它独占三件事：

| 职责 | 现在散在哪 |
|---|---|
| **已知 CCC 根集合**（持久化：插件全局配置 `~/.dsh/serenity-hooks.json`——**机器级事实归 plugin 全局**，与 D5 一致；ACC 代码里不出现任何具体路径） | 无（每次都靠 live 会话反推） |
| `roots()`：本机所有已知 CCC（供两条时钟 / panel / 面扫描） | `collectLiveCccs` / `discoverCccs` / weixin dedupe |
| `rootFor(session \| cwd)`：这个会话/目录归哪个根（触发时**登记**） | `resolveSkiffRoot` / api 的 workspace→root / 各处 findSerenityRoot 包裹 |

**收益**：① 删掉上表 6 处启发式与 Skiff 的 ~90 行重试（改为"注册表就绪即启动"）② **顺手修掉"冷 CCC 不能自唤醒"这条已知边界**（注册表不依赖 live 会话）③ `acc-diag` 的"面板解析"和"为什么没被唤起"从此有**单一权威答案**。

**风险**：注册表是**新增的持久状态**，要处理"CCC 被删/改名/迁移"的失效标记（否则长期累积脏根）。**备选（成本更低但收益也小）**：只做 `roots()` 的持久化补丁（= 已记在案的候选改进），保留各处理根逻辑不动——**不推荐**，因为 6 处启发式的分歧本身才是风险源。

---

### C3 ⭐⭐ 死件清理（有实证，零风险）

**已实证的两处**（生产代码零调用者，**仅被自己的测试引用**——正是历次 review 点过的"测试在给死代码发证"）：

| 死件 | 证据 | 处置 |
|---|---|---|
| `onSettlement`（`trajectory-assistant.ts:96`） | 自述 "OP-1，无调用者"；全仓只有 `tests/trajectory-assistant.test.ts` 引用 | **删**（结算仪式未落地，留着只会让人以为它存在） |
| `styledToken` + `TrajectoryStyle` + `METAPHOR_PREFIX` | 生产代码零引用，只有测试；且 `METAPHOR_PREFIX` 与 `EVENT_LABEL` **只有 `limit` 一项不同** ⇒ 一个几乎恒等的映射 | **删**（要星舰措辞时直接改 `EVENT_LABEL` 即可，不需要门面） |

**建议追加一次机械检出**：对 `src/` 每个导出符号做"生产引用计数"，一次性列出全部零引用导出（本轮只抽验了这两处，**不声称穷尽**）。

---

### C4 ⭐⭐ 外部载体：4 条独立 HTTP 面 → 一个宿主 + N 张面

**现状**：`skiff-debug`(3099，自起 node:http + HTML)｜`acp-http`(3100，JSON-RPC + 问答页)｜`gateway`(3081，登录 + TOTP + 反代)｜`weixin-send-api`(3082，loopback)。**各自**有：启停逻辑、settings 开关同步、`registerDisposer` 拆卸、错误日志、根解析兜底。

**提案**：一个**「面宿主」**（一个模块负责"监听器生命周期 + 开关同步 + 拆卸"），每张面只提供 `{port, handler, enabled(), resolveRoot()}`。⇒ 4 套启停样板 → 1 套；Skiff 那 90 行退避重试**同时**被 C2 与 C4 消除（根解析归 C2、启停样板归 C4）。

**风险**：动 4 个**在用的**对外入口 ⇒ 需要每个面各自的端到端冒烟（已有：`tunnel-doctor` / 问答页 / 微信双账号）。**建议排在 C1/C2 之后**。

---

### C5 ⭐ 观察面：4 处 → 1 个"容器状态"模型 + 薄渲染

`status.ts`（版本/端口）｜`api.ts`（WebUI 停靠栏 HTTP）｜`kit-ops`（`dashboard health`）｜`diag-ops`（`acc-diag`）——四处各自读"CCC 根 / host 契约 / 端口 / live 会话"。

**提案**：抽出**一个** `containerStatus()` 数据模型，四处只做**渲染**（WebUI 面板 / 工具返回 / 诊断报告）。**收益中等、风险低**，但要注意 `acc-diag` 是**专属工具**（权限面不同），数据可共用、渲染必须分开。

---

### C6 ⚠️ 时钟与 autopilot 归属（**与你既有裁决冲突，只列不下结论**）

- **事实**：两条 tick 共用 `TICK_MS`、目标解析、投递路径、per-CCC 串行、disposer、热启动事件；差异在**策略层**（intervalHours / avoidWakeHours / topPrompt / bias / `--auto` 门）。
- **D59 的原判据**：「autopilot 只允许一个 ⇒ 与"任意多条并行"的注册表不同构」。
- **情形是否变了（我的观察，供你判）**：D62 之后我们确立了「**一次唤醒 = 一个未来时刻 + 一条 message**」；@autopilot 恰好是「同一条 message **按其自己的节奏重复**」⇒ **周期是策略、不是机制**。若如此，`autopilot` 可建模为**轨迹上的一条周期策略**，"只允许一个"由**策略校验**保证（而非由两套引擎保证）。
- **潜在收益**：1 个 ticker、1 套状态探针、1 套守卫、`acc-diag` ①b 一行搞定；`container_admin autopilot` 面是否也该回到 `container_trajectory`（**v1.33 你已裁决归机务舱**，此处只是提出"以轨迹透镜看它属于轨迹"）。
- **风险**：autopilot 是**在跑的关键业务**（S151 管家）；重构它 = 拿运转中的时钟做实验。
- **我的建议**：**本轮不动**，仅记录；若要做，先做"两条 tick 的**可观测面**归一（共享状态探针）"这一无风险半步。

---

### C7 审视后判定**不动**（透镜没找到该改的——同样是要记录的结果）

| 构件 | 为什么不改 |
|---|---|
| `praxis`（eap/neat/cce） | 三个 section = 三种知识，主语不是容器也不是轨迹；无重复 |
| `container_admin` 的 `role` / `msm` / `config` | 主语是**容器**（机务），与轨迹正交，D23 归属正确 |
| `session-cleanup` | **主语是 DSH 会话（载体）而非轨迹**——D61 已据此判定它的文件名不动；它属"载体轴"，薄且无重复 |
| `trajectory-bound` / `trajectory-ops` / `wake-registry` 三文件分离 | 分别是"绑定 / 轨迹库 / 唤醒条目"三种数据，**同一主语 ≠ 同一份数据**；合并只会让单一文件承担三件事（P2-6 目录化是**文件摆放**问题，不是构件关系问题） |
| 载体"声明在一处、执行在另一处"（`use` 排队 → `turn-stopping` 执行） | 这是**宿主约束**下的必然：清空当前会话只能在轮结束时做；不是自造复杂度 |
| `mismatch：8 格里 3 格已是单套` | 身份（3 来源有明确优先级）、身体、自我调节、诊断 —— 均为设计使然 |

---

## 4. 分层建议（Neat 顺序，供你裁）

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **① 接口层先定** | C1 的**声明位置**（SESSION.md frontmatter？）+ **注入形态**（a1 一次性 / a2 section） | 它决定"轨迹身体里多一个字段"，属于**数据契约**，必须先定；定了才能谈删除面 |
| **② 零风险清理** | C3 死件 + 机械检出零引用导出 | 不依赖任何裁决，随时可做，先做先把噪声降下来 |
| **③ 结构归一** | C2 CCC 注册表（含修"冷 CCC 不自唤醒"） | 它是 C4 的前置（面宿主也需要根解析）；且修一条**已发布的已知边界** |
| **④ 样板归一** | C4 面宿主 ⇒ 顺带吃掉 Skiff 重试 | 需要每面端到端验证，故排后 |
| **⑤ 数据归一** | C5 容器状态模型 | 低风险收尾 |
| **⑥ 观察半步** | C6 的"两时钟共享状态探针" | 无风险半步；**引擎合并另案** |

**发版影响**：①③④⑤ 都改机制面 ⇒ **要发版**（D14 待你令）；② 死件清理可随任一次**补丁**顺带走。

---

## 5. 待裁清单（请逐条拍）

| # | 问题 | 我的建议 | 备选 |
|---|---|---|---|
| **Q1** | 用户样例抽象出的那条判据（"能落 harness 原语就不自造协议"）**是否升为 CCC/ACC 的明面判据**？ | 建议升（它是可机械套用的筛子） | 只作本轮一次性尺子 |
| **Q2** | C1：**废除 SEP**（`session-tool` 脚本钩子）？ | 建议废（本 CCC 零 adoption；发现路径更笨） | 保留 + 只加 skill 通道（两套并存）⇒ 不推荐 |
| **Q3** | C1：注入形态取 **a1（use 时一次性）** 还是 **a2（绑定期间 system-prompt section）**？ | **a2**（抗压缩、已被 compact 通道保留） | a1（更贴你的原话，但会被压缩吃掉） |
| **Q4** | C1：声明放 **SESSION.md frontmatter**？ | 建议放（CCC 数据 / per-trajectory / 跨 rebuild 存活 / 零新配置面） | `.bindings.json`（不可读）｜`serenity.json`（丢 per-trajectory） |
| **Q5** | C2：做**完整 CCC 注册表**还是只补根持久化？ | **完整注册表**（6 处启发式的分歧才是风险源） | 只补 `roots()` 持久化（成本低、修不掉分歧） |
| **Q6** | C2 的注册表落点 | **插件全局** `~/.dsh/serenity-hooks.json`（机器级事实） | 每 CCC 自述文件 + 扫描（需约定扫描域） |
| **Q7** | C4/C5 是否本轮一起做？ | 建议**分轮**（C4 动在用对外面，风险高于收益紧迫度） | 一起做（一轮到位但回归面大） |
| **Q8** | C6：是否需要"autopilot 归属再判"？ | 建议**只做无风险半步**（共享状态探针），引擎与归属另案 | 本轮就统一成一条时钟 |
| **Q9** | 是否要一次**机械零引用导出扫描**（C3 的穷尽版）？ | 建议做（一次性，产出清单供下一轮删） | 只删本轮实证的两处 |

---

## 6. 本轮**未**做的事（诚实边界）

- **未动任何代码**（本文件是讨论稿）。
- **未核实** pangu / tiangong 两个 CCC 是否使用 SEP（它们在**本容器路径之外**，P3 边界；`session-tool` 的 adoption 只在本 CCC 实测为零）。
- **未穷尽**零引用导出（只抽验了两处，已注明）。
- **未评估** `handyman-preset-inherit` / `agent-idle` / `skills-discovery` 等模块的去留（需要 §C3 的机械扫描结论再谈）。
- **未改**任何既有裁决（D58/D59/D60/D61 均按原文引用；C6 只提出"情形是否变了"，不下结论）。
