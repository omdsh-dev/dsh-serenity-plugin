# ACC 内部构件关系 —— 现状说明（v1.0）

> **用途**：为 `acc-component-relations-review.md`（v0.1 讨论稿）的候选 **C2 / C4 / C5 / C6** 与 **Q9** 提供**事实底稿**。
> **边界（本文件的纪律）**：**只陈述现状**——有什么、在哪、怎么工作、已经造成什么。**不提建议、不排优先级、不下结论**。取舍与裁决在复审稿与 SESSION S142 中。
> **真相源分工**：候选与裁决 = 复审稿；**事实 = 本文件**；原始取证全文 = 本机 CCC 路径 `AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/references/`（索引见 §7）。
> **取证日期**：2026-09-15｜**方法**：五路**独立只读**子代理（文本命中 + 逐处 `file:line`）。**未跑 build / typecheck / test；未真触发 tick；未发 HTTP 请求**。

---

## §0 三条口径更正（复审稿的估计普遍偏低）

| 复审稿的写法 | 实测 | 出处 |
|---|---|---|
| C2：「**6 套**」根解析 | **`src/` 内 19 处 + 范围外 1 处**；算法真正不同的约 **16 种**，其余为复制/适配/聚合 | `acc-c2-current-state.md` |
| C4：「**4 条**」HTTP 面 | **5 个面** = 4 个插件自起 listener + **第 5 个 = 宿主 DSH 主面 3080**；且 **3081 不是独立路由，是 3080 的代理宿主** | `acc-c4c5-current-state.md` |
| C5：「**4 处**」观察面 | **10 个渲染点**（WebUI 2 + agent 工具 5 + 系统提示词 3） | `acc-c4c5-current-state.md` |

> 三处都属**低估**，方向上不影响候选的存在理由，但影响**改动面估计**。

---

## §1 C2 —— CCC 发现面现状

### 1.1 分层：底层干净，乱在它之上的判断层

| 层 | 含义 | 处数 |
|---|---|---|
| **L0 原语** | `findSerenityRoot`（`ccc.ts:16`） | **1 处，无重复**；**53 个调用点** |
| **L1** | 「**这个会话 / 这个路径属于哪个 CCC**」 | **12 处** |
| **L2** | 「**本机一共有哪些 CCC**」 | **7 处** |
| **L3** | CCC **名**解析 | **2 处** |
| 范围外 | 脚本侧 | **1 处**（独门算法） |

⇒ **L0 是单套**；重复全部发生在 L1/L2/L3。

### 1.2 L1 逐处（12 处）

| # | 处 | 位置 | 输入 | 输出 | 算法 / 用途 |
|---|---|---|---|---|---|
| R1 | `resolveSkiffRoot` | `index.ts:374`（调用 `:307`/`:421`） | live 会话 + `process.cwd` | 单根 \| null | **live 中配 `skiff.roles` 者优先** → 进程 cwd → 任一 live；给 Skiff/ACP 服务绑默认容器 |
| R2 | `resolveAutopilotRoot` | `autopilot-trajectory.ts:593`（唯一调用 `:777`） | `process.cwd` 优先 → 任一 live | 单根 \| null | ⚠️ **优先级与 R1 相反**；面板/诊断代表值 |
| R3 | `resolveWorkspaceCore` / `resolveWorkspace` | `api.ts:147`/`161` | sessionId→cwd / `workspace` 参数 / 首个能上溯的 live cwd / `process.cwd` | 根 | HTTP 面 **8 端点**复用 |
| R4 | `bindingsPathFor` | `trajectory-bound.ts:63` | `session.header.cwd` → 根 | `.bindings.json` 路径 | **绑定持久化的唯一入口** |
| R5 | mdPath → root | `autopilot-trajectory.ts:488`/`559` | **把 `SESSION.md` 的**文件路径**当目录上溯** | 根 | 唤起时限定同 CCC 找 agent |
| R6 | `resolveSerenityRootFor` | `rebuild.ts:493` | 会话/路径 | 根 | **失败时返回假根 `process.cwd()`** |
| **R7** | 工具入口 `agentCwd + findSerenityRoot` | **同一份代码复制 10 份** | — | 根 | `tools/{cc-fs:52, git:38, msm:105, localstore:44, trajectory:374, kit:38, container-admin:102, handyman:395, acc-diag:51, im-bridge:60}` |
| **R8** | seam 层 | **13 文件 24 点** | — | 根 | `context` / `keeper` / `compact` / `guards` / `system-prompt` / `bootstrap` / `env` / `opencode-skills` / `output-guard-seam` / `status` / `gateway` / `skiff-debug` / `api` |
| R9 | `requireCcc` | `api.ts:800` | 入参（**信任**） | 校验 + 上溯 | — |
| R10 | `matchCcc` | `weixin-send-api.ts:112` | 路径 / 目录名 / `.serenity` 名 | 根 | **同名报错不猜** |
| R11 | acp-http 内联 `name → root` | `acp-http.ts:154-224` | 名称串 | 根 | ⚠️ **`:221-223` 未发现时凭输入串直接构造根，不校验 `.serenity`** |
| R12 | `collectCandidates` | `weixin-send-api.ts:143` | `discoverCccs` 投影 | 候选集 | — |

### 1.3 L2 逐处（7 处）

| # | 处 | 位置 | 说明 |
|---|---|---|---|
| E1 | `discoverCccs` | `skiff-debug.ts:81` | `workspaceRegistry` → `sessionPersistence` → live，**三层短路回退** + `defaultRoot` unshift |
| E2 | `listLiveSessions` | `:695` | live 会话清单 |
| E3 | `collectLiveCccs` | `:744` | live 会话 cwd 反推（**无 live ⇒ `[]`**，无配置过滤） |
| E4 | `collectAutopilotCccs` | `:719` | 同上，但**要求该 CCC 配了 `trajectory.autopilot`** |
| E5 | weixin `syncFromLive` | `weixin-bridge.ts:610-621` | **第三份同语义去重**（内联 `Set`） |
| E6 | `hostSessionCwds` | `host/access.ts:135` | 返回 **cwd 而非根**；**仓内无调用方** |
| E7 | `diagLive.panelResolved` | `:773-777` | 面板代表值解析 |

> **📌 E1 的两点补充（2026-09-15 补，读码实测）**
> 1. **E1 是三处里唯一"不依赖 live 会话"的**：其 ① `workspaceRegistry`（注释原文：持久化——**所有工作目录即使无 live 会话**）② `sessionPersistence`（注释原文：**覆盖所有历史会话工作目录**）。出处写在注释里：**所有者 2026-08-29 的要求**。该函数已接到 `/serenity/cccs`（`api.ts:362-379`）并被**设置面板 CCC 选择器**消费（`SettingsSection.tsx:627-652`）。
> 2. ⚠️ **但三层是"短路"而非"并集"**：`:100` 与 `:109` 均为 `if (roots.length === 0)` ⇒ **第一层给出任意一条，后两层整个不跑** ⇒ **该函数返回的名单可能不全**。任何"把它当权威集合"的用法都受影响。
> 3. **现场可复现的证据**：`acc-diag` 实测 autopilot CCC = **3 个**（live 派生），而脚本侧（扫 `/home/yh` 两层）能列出 **`sh-serenity`** ⇒ 同一件事两套来源给出**不同集合**。实测本机共 **4 个 CCC**：`/home/yh/home/home-serenity`、`/home/yh/zy/pangu-serenity`、`/home/yh/zy/tiangong-serenity`、`/home/yh/shgroup/sh-serenity`（**分属三个不同父目录**；最后一个未配 autopilot）。

### 1.4 L3：CCC 名解析（2 处，含一处**潜在静默分歧**）

| 处 | 位置 | 行为 |
|---|---|---|
| N1 | `readCccName` | `ccc.ts:87` | **跳过 `#` 注释与空行** |
| N2 | `skills-discovery.ts` 版 | `skills-discovery.ts:76` | **整文件 `trim`**（不跳注释） |

⇒ 本 CCC 的 `.serenity` 标记是**单行**，故**当前二者一致**；**一旦标记文件里出现注释，N2 会静默失配**（无报错路径）。

### 1.5 范围外 1 处（独门算法）

`experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts`：`:77 findRoot`（`SERENITY_ROOT` 优先 → cwd 上溯）+ **`:496 collectCccs` 递归扫描 `/home/yh` 两层找 `.serenity`**——**全仓独此一份算法**；另有 `--ccc` 手工指定。

### 1.6 补偿点：**根缺失 ⇒ 代码多做了什么**（全部有留档）

| # | 补偿 | 位置 | 规模 / 后果 |
|---|---|---|---|
| C1 | **Skiff 退避重试 + 并发守卫** | `index.ts:271-363` | **≈93 行**：5 次退避 1s/3s/8s/20s/40s + `agent/session-start` 与 `session/created` **双事件再试** + `starting` 防双启 + 耗尽才 warn；**对照：同文件 ACP 装配 `:415-441` 无此补偿** |
| C2 | **wake 调度器武装门** | `wake-scheduler.ts:277-295` | 旧门（"有 live CCC 才武装"）⇒ **实测 6.6h 零 tick**；F 段改为"全局闸开即武装" |
| C3 | autopilot 时钟同修 | `autopilot-trajectory.ts:424-439`（门控 `:392-396`） | 同 C2 |
| C4 | **HTTP 面静默降级** | `api.ts:194-198` / `375` / `466-469` / `495-498` | 返回空 / 404 / `status:null` ⇒ **前端无法区分"没有"与"没解析到"** |
| C5 | `discoverCccs` 三层回退 | `skiff-debug.ts:81` | 回退本身即补偿 |
| C6 | 绑定落盘 | `trajectory-bound.ts:198` | 根缺失 ⇒ **返回 false 不重试** ⇒ 冷唤醒报"无绑定会话记录"（`wake-scheduler.ts:177`） |
| C7 | 工具/seam 回落 | 各处 | `?? process.cwd()`（副作用见 `handyman.ts:387-393`，靠调换检查顺序规避） |
| C8 | rebuild 诊断 | `rebuild.ts` | 落进 `process.cwd()` |
| C9 | 脚本层 | 脚本 | `SERENITY_ROOT` 环境注入 + `--ccc` **人肉指定** |

### 1.7 依赖的数据面

| 数据 | 读/写点数量 | 备注 |
|---|---|---|
| `.serenity` 标记 | **存在性 53 点 / 内容仅 2 点** | 内容读取只有 N1 / N2 两处 |
| `AGENT_SESSIONS/.bindings.json` | **16 处** | `trajectory-bound`、`context:172/193`、`keeper:212`、`rebuild:200/316`、`skiff-core:192/204/221`、`autopilot:504/572`、`tools/trajectory:72/414/471/472/522`、`wake-scheduler:157` |
| `AGENT_SESSIONS/wake-registry.json` | — | 唤醒条目 |
| 宿主存储 | — | `workspaceRegistry` / `sessionPersistence` / `sessions.list()` |
| `process.cwd()` | — | 多处兜底 |
| `.opencode`/`.dsh` `serenity.json` | — | 用于筛选项 |

### 1.8 已明确**排除**（防把清单报大）

`session-cleanup.sessionsRootDir`（**DSH 会话根 ≠ CCC 根**）｜`findGitRoot`｜`readCccName` 的委托导出（`msm-ops:53` / `kit-ops:33`）｜所有**接受 root 参数**的 ops 模块（`kit-ops` / `handyman-ops` / `msm-ops` / `fs-ops` / `git-ops` / `trajectory-ops` / `wake-registry` / `skiff-core` / `weixin-hook` / `runImBridge`）｜`client/*.tsx`（消费 `/serenity/cccs`）｜`config-ops knownWorkspaces`｜`getLastActiveSessionInfo`（**轨迹非根**）。

### 1.9 范围边界（诚实）

**宿主侧实现在本仓之外**：`host/access.ts` 按字符串取 `workspaceRegistry` / `sessionPersistence` / `sessions` / `sessionController`。**宿主内是否还有根判断，本仓无法回答**（要覆盖"全部"须把 `@deepseek-ai/dsh-*` 纳入范围）。
其余：纯静态；`tests/` 只查证 2 个文件；8 个 `.tsx` 只做关键字命中；动态 `await import()` 分支是否走到**不可静态判定**。

---

## §2 C4 —— HTTP 面现状（5 个面）

| 面 | 端口 | 谁起的 | 监听地址 | 默认 | 认证 | 用途 |
|---|---|---|---|---|---|---|
| **A** | **3080** | **宿主 DSH** | **本仓不可判** | — | 写操作要 `x-serenity-ui` 头；GET 多无守卫 | 主面；插件在其上挂 **11 条** `/serenity/*` 路由（`api.ts:179` 注册；`:183/209/241/270/318/364/390/444/517/657/728`） |
| **B** | **3081** | 插件 | **`0.0.0.0`**（`gateway.ts:528`；默认见 `config-ops.ts:103-112`） | **关** | 登录 + **TOTP** + CSRF + Origin + **工作区白名单** | **网关：已登录后全量反代到 3080**（含 `/serenity/*`）⇒ **是 A 的代理宿主，不是另一套路由** |
| **C** | **3082** | 插件 | `127.0.0.1`（`weixin-send-api.ts:273`） | **开** | **仅 loopback 校验、无密钥** | 微信主动发送：`POST /send`、`GET /health`；调用者是**容器外非 agent 进程**（agent 走 `im-bridge`） |
| **D** | **3099** | 插件 | `127.0.0.1`（`skiff-debug.ts:453`） | 关 | **无任何认证**（只靠 bind loopback） | Skiff 调试页：`GET /`、`POST /ask`；**返回全量 trajectory** |
| **E** | **3100** | 插件 | `127.0.0.1`（`acp-http.ts:83`） | 关（`acpEnabled \|\| publicAskEnabled` 任一开即起） | `POST /` JSON-RPC **无认证**；问答端点有 **key + IP 锁 + 容器白名单** | ACP + 问答页：`POST /`、`GET /`、`GET /c/<name>`、`POST /c/<name>/ask`、`POST /ask` |

**C 面为何不挂 3080**（设计理由，写在 `weixin-send-api.ts:4-7`）：挂上去会让**已登录的外部账号冒充 bot**。

**共享关系**：B 是 A 的代理宿主｜**D 与 E 共用会话核心，但各自独立 listener + 独立 HTML**。

### 2.1 重复形态（同类东西各写各的）

| 形态 | 份数 |
|---|---|
| 请求体读取 | **5** |
| JSON 响应 | **4** |
| HTML 模板族 | **3 处** |
| **CCC-workspace 解析白名单** | **7 套** |
| `x-serenity-ui` 检查 | **9 处，无 helper** |
| 配置源 | **2 套**（settings vs `~/.dsh/serenity-hooks.json`） |

> ⚠️ 「workspace 白名单 7 套」与 C2 的「根解析」**口径不同**（一个是**准入判断**、一个是**定位判断**）——**两个数不可混用**。

### 2.2 安全相关事实（仅陈述，不评价）

- **D（3099）无任何认证**，仅靠 `127.0.0.1`；**返回全量 trajectory**。**默认关**。
- **C（3082）默认开**，仅 loopback、**无密钥**；有意不挂主面。
- **E（3100）** JSON-RPC 端点**无认证**；问答端点有 key + IP 锁 + 容器白名单。
- **B（3081）** 默认绑 `0.0.0.0`（**默认关**），认证面最厚（登录 + TOTP + CSRF + Origin + 白名单）。

---

## §3 C5 —— 观察面现状（10 个渲染点）

| # | 渲染点 | 位置 | 渲染什么 | 数据从哪来 |
|---|---|---|---|---|
| 1 | 会话头部胶囊 | `client/SafeModePanel.tsx` | 安全模式 | — |
| 2 | 设置面板（+4 个编辑器） | `client/SettingsSection.tsx` | 开关 / 白名单 / 唤醒注册表（**含 message**） | `/serenity/*` |
| 3 | `acc-diag` | `diag-ops.ts:78/107` | 四段全报告（含**两钟时钟态**、注册表**含 pending 计数 + 补跑窗口**） | 进程内 + `wake-registry.json` + 脚本 |
| 4 | `dashboard health` | `kit-ops.ts:138` | CCC 三原则 + registry + hostContract | 进程内 |
| 5 | `container_admin msm check` | `msm-ops.ts:617` | **DC-M1~M4** registry 完整性 | `mech-registry.json` |
| 6 | `container_admin autopilot status` | **脚本 `all()`** | autopilot 背景/就绪/状态/下一步 | 脚本自算 |
| 7 | `container_trajectory list` | `trajectory-ops.ts:169` | 轨迹清单 + 统计 + 异常标注 | 目录扫描 |
| 8 | 身份行 + CCC root | `seams/context.ts:60` | 身份 + 根 | 进程内 |
| 9 | safe-mode / localstore 块 | `seams/system-prompt.ts:346/380` | 开关状态 | 配置 |
| 10 | keeper 压力与体积行 | `seams/keeper.ts:353/364/383` | SESSION.md 体积 / 计分 | 文件 |

### 3.1 重叠矩阵 —— 最显著的三组

1. **时钟状态**（`armed` / 全局闸 / `ticks` / 上次跳过原因）：**只有 `acc-diag` 渲染，WebUI 完全看不到**——而它正是"**这轮为什么没被唤起**"的第一手判据。
2. **唤醒注册表**：**设置面板**（`SettingsSection.tsx:808-826`，**含 message**）与 **`acc-diag`**（`diag-ops.ts:150-153`，**无 message**、有 pending 计数 + 补跑窗口）**各渲染一遍、字段集不一致**；两者都调 `listWakes()`。
3. **autopilot 目标 / 可唤起**：**四处**渲染（面板 `596-613` / `acc-diag` ① 与 ④ / 脚本 `all()`）｜**hostContract 算两次**（`index.ts:135` / `kit-ops.ts:194`）｜**registry 两套判据**（结构检查 `kit-ops:64` vs `DC-M1~M4` `msm-ops:617`）。

### 3.2 一条独立交叉验证

**C4/C5 那一路完全不知道 C6 那一路在查什么**，却独立得出与 §4 相同的结论（时钟状态只有 `acc-diag` 可见）⇒ 该结论有**两路互不知情的独立证据**。

---

## §4 C6 —— 时钟现状

### 4.1 两条时钟

| | **唤醒调度器** | **autopilot 周期自唤醒** |
|---|---|---|
| 文件 | `wake-scheduler.ts`（316 行；装配 `248-316`） | `autopilot-trajectory.ts`（799 行；时钟 `377-469`） |
| 周期 | 5 min（`TICK_MS`） | 5 min（同一 `TICK_MS`） |
| 每 tick | 扫**所有 live CCC** 的 `wake-registry.json`；到点条目**一次性**投递 | 扫 **live + enabled** CCC；对每 CCC **唯一** `--auto` 目标按「mtime 超间隔 **+ 非北京 8–18 点**」评估；跑该 CCC 的 bias 脚本后注入 |
| 全局闸 | `wakeSchedulerEnabled`（**缺省开**） | `autopilotWakeEnabled ?? autopilotEnabled ?? false`（**缺省关**） |
| 投递 | `followup`（冷会话经 `sessionController.resolveAgent`） | `steer`（**只能唤起 live 会话**） |
| 数据 | `AGENT_SESSIONS/wake-registry.json` | **无状态**（靠 `SESSION.md` mtime + `serenity.json` 推导） |
| 装配 | `index.ts:213/218`（相邻装配，**互不传参**） | 同左 |

### 4.2 共享与重复

- **编译期单向**：`wake-scheduler.ts:36` 从 autopilot 模块 import `TICK_MS` + `collectLiveCccs`；**反向 0 命中**。
- **最显著重复 ≈ 220~230 行同形状代码**：进程态结构 + 快照 + 测试复位 ~67 行｜tick 外壳 ~60｜`startTimer` ~37｜事件接线 ~27｜`disposer` ~18｜`PLUGIN_SOURCE` 同名同值两份 2｜闸函数外壳 ~15。
- **目标 → agent 解析两套**（`acquireWakeAgent` `151-178` vs `resolveTargetAgent` `484-527` + `diagnoseTargetUnavailable` `555-590`，**~108 行**）——**重复但不可直接合并**：**冷会话唤醒只有 wake 有**。
- **测试面 ~330 行高度相似用例**（`tests/wake-registry.test.ts:273-396` vs `tests/autopilot-trajectory.test.ts:971-1178`）。

### 4.3 相遇面：**只有一处**

- **运行时完全分离、零接触**：不共享注册表｜不共享投递｜**`wake-later` 与 autopilot 在代码路径上零接触**。
- **唯一相遇面 = 诊断层**：`diag-ops.ts:85-88` 一次读出**两钟进程态**，并由同一 `renderClock`（`28-39`）在 `:136-137` **并排渲染两行**；两个 `state()` 形状同规格（`wake-scheduler.ts:89-92` / `autopilot-trajectory.ts:348-351`）。
- **历史**：两钟曾共用一闸，**v1.34.0（S-1）已切断**，两侧各有**回归钉测试**。

### 4.4 🔴 脚本侧是**第三份**"该不该唤起"判断

`experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts` 的 `diagCcc`（`:392-474`）**自算一套独立条件链**；插件侧另有 tick 路径与面板 `getAutopilotStatus`。

**逐条件**（13 项口径）：**一致 5 项**（配置存在、`enabled`、`session` 已配置、`--auto`、北京窗口）｜**不一致 8 项**——脚本**缺判据 4**（**全局闸** `:319-326/386-390`、live 会话、**agent 可解析** `:288-292`、**重入守卫** `:401`）、**表达式不同 4**（目标会话选择：脚本首个 `includes` `:165` vs 插件 `findSession` 补零/去大小写/多命中抛错 `trajectory-ops.ts:143-164`｜间隔下界：`Math.max(1,·)` `:442` vs `Math.max(0.01,·)` `:126`｜bias 运行参数｜结论口径）。

**🔴 用户可见缺陷**：判决行 `bad = blocks.filter(b => b.startsWith('✗'))`（`:466`）**把 `⏸` 排除在阻断点之外**（间隔未到 `:444` / 高峰避开 `:450`）⇒ 仍打印「**✅ 唤起条件全部满足——等待下一个 10min tick 自动唤起**」（`:468`）。
⇒ **每天北京 8–18 点（10 小时）`container_admin autopilot status` 都报"满足"，而插件实际不唤起。**
同文件 `status()`（`:273-274`）反而算对 `wakeable` ⇒ **脚本内部就有两份判断**。
同类分歧另 4 类：**全局闸关（缺省值）仍报 ✅**（`diag-ops.ts:45-49` 已自认并另加 `clocks` 段补偿）｜`intervalHours < 1` 时脚本**假阴性**｜仅存旧名 bias 脚本时脚本**假阴性**｜目标会话未打开时**假阳性**。

**归属**：`status` / `init` / `generate-bias` **逻辑全在脚本侧**（`:373-389` / `:303-361` / `:364-370`）；插件侧 `autopilot-script.ts:58-78` 只定位 + spawn，`tools/container-admin.ts:62-66/150-159` 只做映射 + 透传，**无自有判断**。⚠️ 但 `status → all`（`:63`）而 `all` 内部调用 `check` + `status`（`:375-376`）⇒ **这份重复判断在主工具路径上**，不只在开发面。

**测试覆盖**：**零** —— 脚本在测试中**从未执行**（`tests/container-admin.test.ts:24-27`、`tests/acc-diag.test.ts:20-23` 两处皆 mock）；唯一的真实测试是插件侧 `findExpScript` 的路径定位（`tests/autopilot-trajectory.test.ts:107-120`）；`vitest.config.ts:15` 的 `include: ['src/**/*.ts']` 使其**按构造不在覆盖率度量内**。**而它随 npm `files` 分发**（`package.json:34-35`）⇒ **装机即跑的未测路径**。

### 4.5 三条实现路径（**在"autopilot 每 CCC 唯一"前提下**；此处只列取舍面，不排序）

| 路径 | 做什么 | 消掉多少 | 它**不**消掉什么 | 风险 | 可回退 |
|---|---|---|---|---|---|
| **P1 合并 tick 循环** | 新模块持唯一 `setInterval` + 事件 + disposer；两策略各自保留闸/目标集/内部串行域 | ~180 行（删两个 `register*` + 进程态） | 目标→agent 两套（不可合） | **中**：`armed` 须拆成"宿主 armed + 每策略 gate"（**两闸缺省相反**）；`runningByRoot`（autopilot 60s bias 阻塞）与 `chain` **不能并成一个链** | 中 |
| **P2 时钟运行时工厂** | `makeClock({gate, collect, run})` ~80-100 行；两钟**各自仍持独立 setInterval** | ~160 行 | **不是"一个 tick"**，只是同一份代码；差异须做成参数（`ticks += 1` 时机：wake 在 await 后 `:267` / autopilot 在 await 前 `:399`；`lastTickLog` 仅 wake 有 `:75`） | 低–中 | **高**（加法式） |
| **P3 只读视图 / 探针** | 不动逻辑，仅把两钟状态接到面板出口 | **0 行**行为重复 | **不达成 C6 目标** | 极低 | 极高 |
| P4（高风险） | autopilot 降为注册表"周期条目" | — | — | ⚠️ **违反 `wake-registry.ts:11` 的"一次性"不变量**；该文件**随 CCC git 提交供人审计** ⇒ 周期条目产生 churn；投递通道分歧仍未消 | — |

### 4.6 「无风险半步」的现状：**已经存在**

`acc-diag` 的 `runAccDiag` **已经**返回 `clocks: {wake, autopilot}`（`diag-ops.ts:85-88`）并并排渲染。
⇒ 该半步**不是待建项，而是待接线项**：**缺口只在 HTTP 面板**——`/serenity/trajectory`（`api.ts:489-503`）只返回 `getAutopilotStatus` + `listWakes`，**不含任何时钟状态**；补 **~6 行（api）+ ~20 行（client）** 即可，**零行为改动**。
（注：`acc-diag` 是**条件可见的专属工具**，`index.ts:160-162`，需 CCC 在 `exclusiveTools` 声明。）

---

## §5 Q9 —— 零引用导出扫描现状

产物：`references/acc-dead-export-scan.md`（84 KB）。规模：**95 文件 / 810 导出行**（去重后 ≈775 符号）。

| 判定 | 条数 | 含义 |
|---|---|---|
| ALIVE | **390** | 生产有引用 |
| **TEST-ONLY** | **202** | **只有测试引用**（"测试给死代码发证"） |
| **DEAD** | **216** | 零引用 ⇒ 但见下 |
| EXTERNAL-ENTRY | **2** | **宿主契约面（`index.ts` 的 `name/inject/Config/apply`）——勿按死代码删** |

**⚠️ 解读纪律**：216 条 DEAD 中 **~190 条是"自用型"**（只在定义文件内自用）⇒ **只该删 `export` 关键字；删声明会编译失败**。**真孤儿仅 20 条**。

**候选前提被修正**：`METAPHOR_PREFIX` **不是导出**（模块私有 const）｜`onSettlement`、`styledToken` = **TEST-ONLY**（各有测试引用）｜`TrajectoryStyle` = **DEAD**。

**最尖锐发现**：`seams/*` 共 **87 导出**而生产面**只用 21 个**；`system-prompt.ts` 的 13 个 block 构造与 `keeper.ts` 的 13 个 tracker **只被测试引用**；**`tools/{cce,eap,neat}Tool` 三个工具对象只被测试引用、生产从未注册**。
> ⚠️ **2026-09-15 复核更正（进 C3 前实查）**：`tools/{cce,eap,neat}.ts` **三个文件本身是活的**——`praxis.ts:16-18` 从它们 import 知识常量 `EAP_CONTENT` / `NEAT_CONTENT` / `CCE_CONTENT`。**死的只是三个工具对象**（`eapTool` / `cceTool` / `neatTool`，v1.30 三合一成 `praxis` 后遗留）。⇒ **照扫描结论直接删文件会把 `praxis` 弄坏**（这条更正即"动手前必须复核"的实例）。

**盲区（诚实）**：**动态 `await import()` 是静态图盲区**——`session-cleanup` 一度被误判为死模块，被 `api.ts:745` 的 `await import()` 纠正 ⇒ 工具化方案（如 knip）须先处理，否则误报 5+ 模块。

---

## §6 诚实边界（逐路）

| 路 | 未做 / 不确定 |
|---|---|
| **C2** | 纯静态；**宿主侧实现不在本仓**（宿主内是否还有根判断**无法回答**）；`tests/` 只查证 2 个文件；8 个 `.tsx` 只关键字命中；动态 import 分支是否走到不可静态判定 |
| **C4/C5** | 3080 的**绑定地址属宿主**（本仓无事实）｜C 面"默认开"来自源码默认值，**未核实本机配置是否覆盖**｜`/serenity/status` 的 `restrict` 字段在 client wire 类型未声明（**可能未展示**）｜E 面公网暴露**只有旁证**（本仓无隧道配置）｜未读 `tests/` 与 `lib/` |
| **C6** | 未跑测试、**未真触发 tick**；行数为含注释近似；**脚本从未被执行**（S1 的"✅"是**按代码逻辑推演**，非实跑）；`findSession` 多命中 throw 后是否逃出 `setInterval` 回调属**推断**；`SKILL.md` 仅 grep 级取样（其 `:84` 只列 5 条条件、`:76` 的"10min"与 `TICK_MS=5min` 矛盾 ⇒ **文档侧构成第三份过期描述**） |
| **Q9** | 仅文本命中，未跑 build/typecheck/test；运行时字符串引用（`mech-registry` / `dsh.plugin.json` / `cordis.patch.yml`）**未覆盖**；批次自报总数与其逐符号表有 ±（**单条判定不受影响**，DEAD 只依赖"零"）；同名不同符号 11 组已用 import 证据解决 |

**跨路一致性说明**：C6 的脚本侧分析由**两路独立子代理**分别完成，结论一致但**条件计数略有出入**（12 vs 13 条件、4 vs 5 一致）⇒ 以 `references/acc-c6-script-side.md` 为准。

---

## §7 原始取证产物索引

全部位于本机 CCC：`AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/references/`

| 文件 | 内容 | 规模 |
|---|---|---|
| `acc-c2-current-state.md` | C2：CCC 发现面（19+1 处逐处 file:line、补偿点、数据面、排除项） | — |
| `acc-c4c5-current-state.md` | C4 五面 + C5 十渲染点 + 重叠矩阵 | — |
| `acc-c6-current-state.md` | C6：两钟逐项对照 + 共享/重复清单 + 三条路径 + 半步评估 | 37.9 KB |
| `acc-c6-script-side.md` | C6 补：**脚本侧第三份判断** + 逐条件对照 + 分歧场景 + 零测试覆盖 | 18.9 KB |
| `acc-dead-export-scan.md` | Q9：零引用导出机械扫描（含方法局限与批次修正说明） | 84 KB |

> **上游**：候选与裁决见 `acc-component-relations-review.md`（v0.1）｜**会话账**：S142 SESSION.md §38（本轮）与 `references/SESSION-archive-2026-09-15.md`（全量沿革）。
