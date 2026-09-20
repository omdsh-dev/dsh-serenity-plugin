## v1.45.0 — 2026-09-21（**开关层调整**：「唤醒调度器」那道闸砍掉 ＋ 新增「CRO」总闸）

**来源**：owner 2026-09-21 两条令——
① 「现在CRO机制已经很良好的运行，ACC的开关我需要做调整；**1.send-later的开关不再重要了，砍掉 2.需要上CRO的开关**；请注意**我说的只是开关**」；
② 「**发布吧还有本地安装**」（发版令 ⇒ 本版）。

---

### 一、白话：这次动的是「两台闸」

| # | 闸 | 动法 | 它用来干什么（去掉技术名词） |
|---|---|---|---|
| 1 | 面板「**唤醒调度器**」（副标题自己就写着"条目来源：send-later"） | **砍掉** | 过去它**能被关掉**，一关就**没人按时送消息**（`send-later` 全哑）。现在**没有这个开关了，恒开** |
| 2 | 面板「**CRO（轨迹自编程唤起）**」 | **新增**（`croEnabled`，缺省**开**） | CRO = 让一条轨迹**自己带一段程序**判断"我现在该不该被叫醒"（不是死等钟点）。这台闸**只停这一件事** |

### 二、判据（R↓：理由与备选都写在这）

| 项 | 取值 | 理由 / 被否的备选 |
|---|---|---|
| **砍的是哪一台** | `wakeSchedulerEnabled` | 它是**闸**（`gate`），不是节拍 ⇒ 删键 + `gate`/`gateOffReason` 改**可选**（缺省 = 无条件武装、`enabled` 恒 `true`）。**被否**：留键改语义（那会多一个"看起来还能关"的**假旋钮**） |
| **新增的是哪一台** | `croEnabled`，**缺省 `true`** | ① 已在生产稳跑（S151 / S185 两条 CRO 程序）② **无程序的轨迹本就不参与**（逐条判据仍是"文件在"）⇒ **缺省关 = 把一条正在工作的链路静默回退**。**被否**：缺省关（"实验功能默认关"是既有纪律，但 **CRO 已不是实验**） |
| **层级** | **plugin 全局**（与被砍的那台**同面板、同层**） | owner 动的是"面板上那座闸"这个**位置**；擅自改层级 = 变成另一件事（**D72**：方向授权推不出实现变更权） |
| **关掉时的可观测性** | 跳过时往 **tick log 写一行理由** | 关闸后「**程序没被调用**」与「**程序判了不叫**」**现象完全相同**（都没被叫醒）⇒ 不记一行，事后**无法分辨** |
| **兼容** | 残留 `wakeSchedulerEnabled` ⇒ **静默忽略** | 老配置不必改；**有回归钉**：旧键写 `false` 残留在配置里也**照样武装** |
| **边界** | **机制一行未动**（tick 粒度 / 投递通路 / CRO 判定 / 唤醒注册表） | owner 明示「**我说的只是开关**」⇒ **越界一步就是抗令** |

### 三、实现（5 处）

| 模块 | 内容 |
|---|---|
| `src/settings-section.ts` | 删 `wakeSchedulerEnabled`（类型 / schema / entryDefaults / default **四处**）＋ 增 `croEnabled`（**四处**，缺省 `true`） |
| `src/clock-runtime.ts` | `gate` / `gateOffReason` 改**可选**（缺省 = 无闸：恒武装、永不因闸跳过、`enabled` 恒 `true`；三处判据同步） |
| `src/wake-scheduler.ts` | 删闸函数 + 两处传参 + 注释改写为「**为何砍**」；**`runCroPhase` 入口加门**（关掉只停 CRO 阶段，并记跳过理由） |
| `src/diag-ops.ts` | ①b：`全局闸=` → **`CRO 闸=`**（读 `croEnabled`）；`wakeSchedulerState().enabled` 保留但恒 `true`（注释标"不再是闸值"） |
| `src/client/SettingsSection.tsx` | 面板换块：「唤醒调度器」→「**CRO（轨迹自编程唤起）**」（详情文案含"关掉只停 CRO 阶段"） |

### 四、契约面（同批 5 处）

> 🔴 **为什么连文档一起改**：同一句「**文件在 = 启用**」被写在**三处**，新增总闸后它会被读成
> 「文件在 ⇒ **一定会跑**」——而**总闸关掉时程序根本不被调用**。**一句会让人推错的话，就是缺陷。**

| 落点 | 改动 |
|---|---|
| `src/cro-guide.ts` | §2 新增**总闸段**（点明 `croEnabled`、缺省开、关掉只停 CRO 阶段、`send-later`/`send-now`/唤醒表**照常工作**；并写明 tick log 记理由的**目的 = 分辨「总闸关着没跑」vs「程序判了不叫」**）；§8.1「没有开关」→「**没有逐条开关**」 |
| `src/templates/acc-session/SKILL.md` | 补一句总闸（**随包分发、进 agent 上下文 ⇒ 属契约面**；判据先例 = `docs/cro-design.md` §12-2 逐字列此二者为契约面，且 `package.json` 的 `files` 含 `src/templates`） |
| `src/templates/acc-serenity/SKILL.md` | 同上 |
| `docs/cro-design.md` | §2.1 补注（「文件在」是**逐条**判据、**不是全局**判据）＋ **新增 §12-5**（砍/增两座闸的裁定、理由与备选、改动面枚举） |
| `README.md`（根）＋ 包内 `README.md` | CRO 的「开关」行补总闸（包内那份由 `readme-sync` 从根**派生**，不手改） |

### 五、测试

- **删 3 条主语消失的旧钉**（「闸显式关→不武装」「S-1 两条解耦钉」）——它们断言的那座闸**已不存在**。
- **新增 3 条**：① 🔴 旧键 `wakeSchedulerEnabled:false` 残留在配置里**也照样武装**；② **无闸 ⇒ 恒武装**（`enabled` 恒 `true`）；③ CRO 指南**必须**点名 `croEnabled` + 「总闸」。
- 四个测试文件的陈旧字面量已清（`gate` / `container-status` / `settings-section` / `wake-registry`）。

### 门禁（本版自己重跑）

typecheck 双面 ✅ ｜ **102 files / 1587 tests** ✅ ｜ coverage ✅（阈值 statements 60 / branches 55 / functions 55 / lines 60 全过）｜ build ✅（**200152 B**）｜ pack-check ✅（116 文件）。

### 「本次未覆盖 / 已知残留」

1. **面板换块的视觉效果未真机确认**——`SettingsSection.tsx` 已随本版重编进 client bundle（build 200080 → 200152 B），
   但"面板长什么样"要**人在 UI 里看一眼**（自动化只覆盖到构建完成）。
2. **指南"印"的刷新仍归安装器**（同 v1.44.0 第 3 条）：模板已更新，但各 CCC 的 `.dsh/skills/` 是**盖印副本**
   ⇒ 需跑 `install --skills all`。⚠️ **本容器那份至今仍是 2026-09-17 旧印**。
   📌 判据教训照旧：**"改了模板" ≠ "改了指南"——源与印之间有一段无人看守的距离。**
3. **两条绑定缺陷本版未修**（① `use` 之后该轨迹**零可用绑定** ⇒ 唤醒/`send-now` 全部报"无绑定会话记录"；
   ② `rebuild` 换代**从不退休旧绑定**）。**仍在等 owner 具名令**；修法已备（把"只留一条"收进 `appendBound` **单一入口**）。
4. CRO 设计 §9 的剩余待裁项（`runningTurns` 门限 / 与 `send-later` 同时为真的防抖 / 声明面 / `reason` 是否强制 / 输入字段边界）**状态不变**。

---

## v1.44.0 — 2026-09-20（**CCC 级 skill 供给**：一处声明、本容器每条轨迹都带；＋ CRO 唤醒流水）

**来源**：owner 2026-09-20 三令——
① 「我要求的 acc 的 session 注入能力到底有没有」⇒ 澄清为「**CCC 指定某个 skill ⇒ 任何 trajectory 在被使用时都注入**」；
② 「**要求实现我的诉求**，注入是**动态注入**就行；**create 先不触发**吧；**skiff 也支持**」（实现令）；
③ 「**同意，发新的小版本，然后本地装好**」（发版令）。
同批另含：**CRO 唤醒流水**（owner「**失败成功都记录**……**结构化记录都应当程序写**」）＋ 轨迹 skill 指南补齐与安装器 `--skills`。

---

### 一、CCC 级 skill 供给（`trajectory.skills`）—— 本版主线

**这东西解决什么（白话）**：轨迹可以"随身带一本工作手册"（某个领域的做事方法）。
此前**每条轨迹得在自己档案第一页抄一遍**；现在**容器里写一次**，**该容器每条被启用的轨迹自动带上**，不必重复抄。

**此前为什么没有（不是漏做）**：v1.34.1/C1 把 skill 供给做成了**逐轨迹自声明**（`SESSION.md` frontmatter），
而"CCC 全局"这一版在设计档 `docs/acc-component-relations-review.md:108` **被显式否决**过——
理由：**会丢掉 per-trajectory**。
⇒ 本版以**并集**实现容器级诉求，**同时不丢逐轨迹能力**：**当初那条否决理由随之消解**。

**形态（R↓，每条都有判据）**：

| 项 | 取值 | 判据 |
|---|---|---|
| 落点 | `.opencode/serenity.json` 的 **`trajectory.skills`**（JSON 数组） | 与 `trajectory.autopilot` 同居 trajectory 族；归属 **D23**（机制在 ACC、声明在 CCC） |
| 与轨迹级的关系 | **并集**：**CCC 级在前**（底座）＋ **轨迹级追加**（额外），同名去重取首次位置 | 容器给底座、单条轨迹仍可加自己的（**不二选一**） |
| 触发门 | **存在绑定** ∧（CCC 级非空 ∨ 轨迹级非空） | owner「**create 先不触发**」⇒ **不动 U6**（create 刻意不夺绑定） |
| 动态性 | 🔴 **每请求重读**配置与 frontmatter、**不缓存** | owner「**动态注入**就行」⇒ 改配置/改 frontmatter **即时生效**，无需重新 `use`、无需重启 |
| 覆盖对象 | ✅ **含 skiff 角色会话** | owner「**skiff 也支持**」；判据：旁路掉的是 **ACC 身份与纪律**，skill 是**工作资料** ⇒ 照给 |
| 长度守卫 | **合并之后**统一 **32 KB** 截断 | 两条来源共享一份上限（不是各给一份，否则上限随来源数翻倍） |
| 失败语义 | 未配置 / 字段缺失 / **配置损坏** ⇒ 空数组（**轨迹级照旧生效**） | 配置损坏另有 `loadSerenityConfig` **响亮告警**（不静默） |
| 名字安全 | 仍**只在装配层**过 `isSafeSkillName` 后拼路径 | 安全判定**只有一个地方做**（配置读取层只做规范化） |

**实现（5 处）**：

| 模块 | 内容 |
|---|---|
| `src/ccc.ts` | `trajectory.skills` 类型 + **`readTrajectorySkills`**（取字符串/去空白/丢非字符串/保序；失败 ⇒ `[]`） |
| `src/trajectory-skills.ts` | **`mergeSkillNames`**（并集/去重/CCC 在前）＋ 装配层合并；🔴 **缺失提示不被吞**（CCC 有声明时，SESSION.md 缺失的响亮提示仍在前） |
| `src/seams/system-prompt.ts` | 注册门放宽为「绑定 ∧（CCC ∨ 轨迹）」；`text: () => …` **每请求重读**（动态、不缓存） |
| `src/skiff-core.ts` | skiff 会话**复用同一个** `registerTrajectorySkillSection`（不另写一套）；`agent?.session` 守卫防噪音 |
| `src/msm-ops.ts` | **ccc-config 手册**同步（第 7 节 `trajectory.skills` + ⑥ 索引行）——手册不说 = 假陈述 |

**契约面（同批 6 处）**：契约档 `docs/trajectory-skill-injection.md` 升 **v1.1**（新增 **§2.3** ＋ §3 两行 ＋ §6 追加 5 条验收 ＋ §7 skiff 行）｜ccc-config 手册｜`acc-session` 技能指南改「**两种写法**」｜`acc-serenity` 技能指南（轨迹追踪段 + 路由表）｜中英 README｜包内 README（`readme-sync`）。

**验收（单测 +13）**：`trajectory-skills.test.ts` **+12**（读取器 / 损坏不抛 / 并集与顺序 / 只有 CCC 级也注入 / 缺失提示在前 / 合并后统一截断 / 注册门三条 / **动态注入改配置即跟随** / `create` 不触发语义钉 等）｜`skiff-core.test.ts` **+1**（skiff 会话真拿到该 section——不装本次代码即红）。

---

### 二、CRO 唤醒流水（**每轨迹固定名档 + 2 日程序化轮转**）

**来源**：owner 2026-09-20「S151 和 S185 的验证都说明，trajectory 倾向于自己做个结构化记录来记录自身 CRO 的执行情况……**我们 ACC 有必要进行 CRO 唤醒的日志记录**，当 CRO 存在时，每次**成功唤醒**写相关信息，但是**保留数量要少，只保留仅两日**的记录即可，**这个时间是程序化的**」＋「**这个日志写结构化文件到 trajectory 目录，文件名固定即可**」＋「**同意；失败成功都记录**。未来 CCC 会砍掉他们的 `state.json` 的；**哪有 LLM 天天写 JSON 的，结构化记录都应当程序写**」。

**形态**：`<CCC 根>/AGENT_SESSIONS/<轨迹目录>/cro-wake-log.json`（**固定名**，与程序自己的 `cro-state.json` 并排）
＋ 原子写（tmp+rename）＋ **写入时按 2 日常量窗裁剪**（**无配置键、无人工清理**，清理与写入**同笔**）。

**🔴 最重要的一条论证（为什么它不是第二个真相源）**：落点在轨迹目录 ⇒ **分工在结构上一眼可见**：
**程序写 `cro-state.json`**（「**我判了什么**」，含"没叫"的判定）｜**ACC 写 `cro-wake-log.json`**（「**我把什么送出去了、送成没有**」）。
内容**不重叠**：ACC 不复制判定细节；程序**不可能**知道投递结果（fire-and-forget）。

**🔴 接线期发现的既有不变量**：**`notReady`（环境未就绪）≠ 投递失败 ⇒ 不记流水**——
照直记就成了"假失败"。**这是本轮最值钱的一处发现**：写代码时回读被改函数的不变量，挡住了一次语义污染。

**实现**：`src/cro-log.ts`（+ 镜像测试 **20 例**：轮转边界 / 坏档不抛 / 30 天防无界增长 / **分工边界断言**）｜`wake-scheduler.runCroPhase` 接线｜`wake-registry.test.ts` **+4 例真 tick**（成功落盘 / **失败落盘** / `notReady` 不记 / 不唤起不建档）。

---

### 三、同批补齐：轨迹 skill 指南 ＋ 安装器 `--skills`

- 🔴 **指南缺口**：`README` 有这条能力，而**随包分发的技能指南通篇没写**（`acc-session`/`acc-serenity` 模板）⇒ 已补「**两种写法**」整章 + 入口可发现性，
  并**同批核正两处过期陈述**（`acc-session` 绑定持久化那句双处过期；契约档四处行号漂移 + 一处"私有待导出"的状态过期）。
- `README.en.md` **整条缺失**该能力 ⇒ 补齐（英文面此前比中文面少一条）。
- **安装器 `src/index.ts` 补 `--skills <csv|all>`**：`install-skill.ts` 的注释**一直声称**支持它、**代码里没有**——
  而 CCC 存量有 9 份指南、默认集只覆盖 3 份 ⇒ 这条 flag 是"刷新存量 CCC"的**必要通道**。

---

### 门禁（本版自己重跑）

typecheck 双面 ✅ ｜ **102 files / 1588 tests** ✅ ｜ coverage ✅ ｜ build ✅（200080 B）｜ pack-check ✅（116 文件）。

### 「本次未覆盖 / 已知残留」

1. **skiff 真机路径未验证**——单测用的是**替身 ctx**；真机验证要一次真实 skiff 会话。
2. **本 CCC 尚未配置** `trajectory.skills`（发布后按需配即可，配置即时生效、无需重启）。
3. **指南"印"的刷新归安装器**：模板已更新，但各 CCC 的 `.dsh/skills/` 是**盖印副本**
   （本容器实测那份停在 **2026-09-17**）⇒ 需跑 `install --skills all` 才把"源"落到"印"。
   📌 **这是一条新记的判据教训**：**"改了模板" ≠ "改了指南"**——**源与印之间有一段无人看守的距离**。
4. CRO 设计 §9 的剩余待裁项（`runningTurns` 门限 / 与 `send-later` 同时为真的防抖 / 声明面 / `reason` 是否强制 / 输入字段边界）**状态不变**。

---

## v1.43.0 — 2026-09-20（**CRO（Continuous Re-Occurrence）**：让一条轨迹**自己判断"什么时候该被叫醒"**）

**来源**：owner 2026-09-19 令「**审核通过，在 dsp 做一版实现**」＋ 2026-09-20「**这个砍掉吧，反正 cro 程序自己也能记录**」＋「**搞定了发一版我来验证**」。
设计档 = `docs/cro-design.md`（v0.1，owner 已审核；本轮把两处裁定回写进 §3.1/§9 + 新增 §12）。

### 问题（这东西解决什么）

**今天叫醒一条轨迹的方式是"几点几分叫我"。但该不该醒，往往不是时间说了算**：
某条轨迹应该在「天亮 + 家里有人 + 非高峰」才醒；**已经在干活就不该再叫一次**；日志快满了，
下次叫它时该**要求它先整理**。

**⇒ CRO 让一条轨迹自己带一段程序**，由 ACC 在每次检查时跑它，
**由这段程序决定「现在该不该叫我、叫我的时候说什么」**。

**一个类比**：今天像**闹钟**（到点就响）；CRO 像**一个值守的人**（看着情况，该叫才叫，叫的时候还说清楚要干什么）。

### 归属（owner 裁定：**机制属 ACC，CCC 是用户**）

| 面 | 归谁 | 内容 |
|---|---|---|
| **机制** | 🔴 ACC | 契约 / 调度 / 执行 / 状态暴露 / 容错 / **编写指南** |
| **程序** | 🔴 CCC（用户） | 那段判定的 TS 代码，放**轨迹自己的目录**里 |

与既有机制同构：**`send-later` 是 ACC 的工具，用它在 CCC**——CRO 是 ACC 的机制，写 CRO 程序的是 CCC。

### 形态（R↓，每条都有判据）

| 项 | 取值 | 判据 |
|---|---|---|
| 位置 | `<CCC 根>/AGENT_SESSIONS/<轨迹目录>/continuous-re-occurrence.ts`（**全写，不许缩写**） | 放轨迹目录 ⇒ 跟随轨迹跨载体存活 + 天然进 git |
| 开关 | 🔴 **文件在 = 启用，文件不在 = 禁用**（无 enabled 字段、无注册表、无开关文件） | 少一处会漂的状态 |
| 语言/契约 | **TS**；ACC **只 spawn，从不 import** | 进程边界同时挡掉"ACC 依赖 CCC 源码路径"（两个真相源）与"用户程序语法错放倒整个容器" |
| 输入 | **轨迹状态快照**（JSON，stdin）：identity / time / body（SESSION.md 体积与 mtime、`references/`）/ binding（bound、live、🔴 **running**）/ scheduling（在办唤醒、调度器状态） | owner「信息尽量多」 |
| 输出 | **一行 JSON**（stdout）：`{"wake":true,"prompt":"…","reason":"…"}` / `{"wake":false}` | owner「是否唤起 + 唤起的提示词」 |
| 执行者 | **ACC 唤醒调度器的既有 5min tick**（**不新增时钟**） | owner 明示 |
| 容错 | 半成品**报错即可**：报错 / 超时（60s 硬超时→kill）/ 输出非法 ⇒ 记一行 + **跳过本轮** | owner「文件是半成品报错就好了」 |
| 指南 | **ACC 内置**，走 guide 老套路 | owner 明示 |

### 实现（三块 + 一处**唯一新增状态**）

| 模块 | 内容 |
|---|---|
| `src/cro.ts` | 路径约定 / **纯函数**快照装配（可穷举测试，不碰 fs）/ 输出解析（**全边界**）/ spawn 执行（bun → node 回退、超时 kill、输出截断、**永不抛**）/ 四态编排 / `listCroTrajectories` 扫描面 |
| `src/cro-turns.ts` | 🔴 **本机制唯一新增的状态** = 「**这条轨迹是否正在跑轮次**」。今天判不出——调度器只掌握**会话 live 与否**，而 **`live ≠ 在跑`**（一条会话可以 live 而空闲）。用**既有的两个契约事件**夹出来：`agent/session-start` + `agent/status` 标记、`agent/turn-stopping` 清除，**外加 dispose 与 TTL 三层清理** |
| `src/cro-guide.ts` | 编写指南（**ACC 内置**）。🔴 **样例快照由装配器实时生成** ⇒ **schema 一变样例自动跟着变**，不存在"文档里的样例过期"这一失效模式 |
| `wake-scheduler.ts` | 接线：每 tick 对每条**启用了 CRO 的轨迹**跑它自带的程序，`wake` ⇒ 投递（复用既有取用通路；**不落唤醒表**） |
| `index.ts` | 装配 turn 追踪（**必须在调度器之前**——后者会立刻跑首拍 tick，而快照的 `running` 唯一数据源就是那张表） |

### 🔴 铁律：CRO 的任何失败，绝不影响既有机制

`send-later` / `send-now` / 唤醒表的投递**照常工作**。先例 = `weixin-hook.ts` 的**旁路容忍**。
**判据（可机械验）**：**把 CRO 写成故意报错的程序，跑一遍，既有投递链路必须一切正常** ⇒ **已做实测用例**。

### 🔴 一处"够不到的代码"被本轮修掉（发布前的自检收获）

`cro-guide.ts` 写完后，**没有任何工具输出它** ⇒ 对用户而言**它还不存在**，而「指南 ACC 内置」是 owner **明示要求**。
⇒ 定案挂点 = **`container_trajectory` 新增第 8 个动作 `cro-guide`**（判据：CRO 程序放**轨迹目录**里 ⇒ 这是**逐轨迹**的知识，
而管轨迹的人正是用本工具的人；**动作 ≠ 域** ⇒ 符合设计 §9-5「既有 guide 位置，不新增域」）。
**契约面同批更新**（`grep` 全仓穷举）：动作集合 / 工具本体 / **系统提示注入** / **ACC catalog** /
**两份随包分发并进 agent 上下文的 skill 模板**（`acc-session`、`acc-serenity`）。

### 🔵 一处设计**收缩**（owner 裁定，不是遗漏）

`lastWakeAt` / `lastWakeResult`（设计 §3.1 字段 5）**砍掉**——owner：「**反正 cro 程序自己也能记录**」。
这**正是设计 §3.3 已写死的边界**（程序自己的状态物理上给不了 ⇒ 归它自己写在轨迹目录里）。
⇒ 连带改判：**"防抖"完全归程序自负**（`pendingWakes` 只含 `send-later` 条目、不含 CRO 自己的唤起史）。
⇒ 收益：**ACC 侧新增状态归零**（只剩 `cro-turns` 那张**带三层清理**的表）。

### 门禁

typecheck（node + client）✅ ｜ **101 files / 1551 tests** ✅ ｜ coverage ✅ ｜ build ✅ ｜ pack-check ✅

**新增用例 71 条**（`tests/cro.test.ts` 43 / `tests/cro-turns.test.ts` 38 之一部 / `tests/cro-guide.test.ts` 29 / `tests/wake-registry.test.ts` +4）：
指南镜像测试（**"指南不许说谎"**：样例与装配器逐字相等、正文嵌同一份、声称覆盖的档位逐条断言、
骨架点名的字段路径真取得到值）；turn 追踪（**清理真的发生了**——TTL 后断言表变小；**订阅的 5 个事件名与 `HOST_EVENTS` 逐个比对**）；
**真 tick 集成**（故意报错的 CRO ⇒ 既有投递一切正常 / 判定为真 ⇒ 投递且**不写唤醒表** / 快照经 stdin 真到达程序 / `wake:false` 不打扰）。

**方法论（本轮两条，均已在别处栽过）**：
1. 🔴 **别信"只有 X 缺测试"的自述**——`coverage-gate` 实测抓出 `cro-turns.ts` **也**裸奔（交接笔记漏了它）；
2. 🔴 **tick 类用例读 `lastTickLog` 必须等 tick「收尾」**，不能只等"副作用出现了"——投递发生在 body **中途**，
   而日志是 body **跑完**才写回 ⇒ 实测**假红一次**（与 v1.42.0 那条"tick 类用例必须先让 CCC 可被发现"同族：**都是脚手架同步问题**）。

## v1.42.0 — 2026-09-19（§0Q：**唤醒记录投递后直接删** —— 注册表只保留"在办项"）

**来源**：owner 2026-09-19 令 ——
「1.这个东西不清理吗，**应当唤醒后就清理**的」（S142 §12c）＋ 追加裁决「**直接删**」（§12c-0 甲案）。

### 问题（这东西解决什么）

唤醒注册表 `AGENT_SESSIONS/wake-registry.json` 的状态机是
`pending → delivered｜missed｜cancelled`，**但三个终态条目一条都不移除**——
`updateWake` 只改 `state`、从不删行 ⇒ **文件只增**。

**实测代价**（2026-09-19 发布前）：**174 条 / 2093 行**，其中**在办仅 2 条** ⇒ **172 条已结案记录长期占位**。
本模块注释**早已承诺**「*审计由 SESSION.md 与工具输出承担——注册表只保留在办项*」，
但该承诺**从未兑现**（`removeWake` 有注释、无人调用）⇒ 本版**把承诺做实**。

### 实现（两个新原语 + 四处接线）

| 原语 | 语义 |
|---|---|
| `finalizeWake(root, id, terminal, result)` | 🔴 **写终态 + 同一笔事务移除** —— 读一次·删一次·写一次（**单次原子落盘**）。终态仅留在**返回值**上供调用方打印/写 SESSION.md；**表里不留行** |
| `purgeFinalizedWakes(root)` | 清除**存量**终态条目（**幂等**：无终态时空转不写盘） |

| 时刻 | 处 | 动作 |
|---|---|---|
| 投递成功 | `wake-scheduler.ts:421` | `finalizeWake(…,'delivered',…)` ⇒ **删除** |
| 超窗 missed | `:401` | `finalizeWake(…,'missed',…)` ⇒ **删除** |
| 取消 | `removeWake` | 已是物理删除（不变） |
| 🔴 **失败重试** | `:425` `updateWake(state:'pending')` | **刻意保留行**（**仍在办**；删了等于静默丢唤醒） |
| 存量清理 | `:388`（**每 tick 开头**） | `purgeFinalizedWakes` ⇒ **天然自愈**，不依赖"跑一次迁移" |

🔴 **为什么两个动作必须同一次写盘**：若先 `updateWake(delivered)` 再 `removeWake`，
中间被打断会留下一条"已终结但没删"的条目 ⇒ **又回到只增**。故合并为一个原子事务。

### 配套：`acc-diag` ③ 段语义变更（**不静默改**）

`delivered`/`missed` 即时删 ⇒ 该段**从"历史全量"变为"只在办"**。
`diag-ops.ts:146` 段标题**显式改写**为：
`── ③ 唤醒注册表（在办项；已结案条目即时清除，历史见 SESSION.md）──`
⇒ 读起来**不会像"记录丢了"**。

### 审计（D60 "可审计"如何继续满足）

审计**改由 SESSION.md 与工具输出承担**（`removeWake` 既有注释的原话）。
D60 的"可审计"软约束**对象转移、未失效**——注册表从"台账"缩为"待办清单"，
而**唤醒史记在发起方与其目标的 SESSION.md 里**（本容器一贯的做法）。

### 门禁

typecheck（node + client）✅ ｜ **98 files / 1449 tests** ✅ ｜ coverage ✅ ｜ build ✅ ｜ pack-check ✅

**新增用例**（`tests/wake-registry.test.ts`）：
1. 到期条目被真投递 → **投递后条目被清除**（同时钉住"消息正文确实送达"）；
2. 超窗条目 → 置 missed 后**同样被清除**（**终态一律不留行**）；
3. `purgeFinalizedWakes` **幂等**（无终态时空转不写盘）；
4. 🔴 **失败重试路径保留行**（防"删过头"——这是本版最危险的回归方向）。

**方法论（本轮）**：首跑一条**假红**——超窗用例报"没清除"，真因是我的 fake ctx **没给 `sessions.list`**
⇒ CCC 不可被发现 ⇒ tick 空转。**这是测试脚手架缺陷，不是功能缺陷**（与 §0M-4 / §0x-9h 同族，**第 3 次**）。
⇒ 判据强化：**"tick 类"用例必须先让被测 CCC"可被发现"**，否则测的是"没扫到"而非"扫到了没做对"。



## v1.41.0 — 2026-09-19（§0x-9：**DeepSeek 多模态临时补丁** —— 模型名含 deepseek 即补 `image` 声明）

**来源**：owner 2026-09-19 令 ——
「**临时的我允许，还是要 patch**，帮我做个逻辑，**如果发现任何 deepseek 模型，都直接 patch 支持多模态**；
以后 dsh 做的更完善了我们这个功能再下掉，暂时的就 patch」（S142 §26 §0x-9e）。

### 问题（这东西解决什么）

DSH 里「某个模型能不能收图」**不是自动识别的**，而是靠**声明**。声明链
（`dsh-llm-pi-ai/lib/index.js:682`）：

```
input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

- 少数模型在**内置目录**里声明了 `["text","image"]`（如 `deepseek-v4-flash-vision-exp`）⇒ 已能收图；
- 🔴 而**不在目录里**的模型走最后一段兜底，`DEFAULT_INPUT = ["text"]`（`:906`）
  ⇒ **明明支持图片的模型被当成"只能收文字"**（图片被丢/报错）。
  **当前默认模型 `opencode-go-responses/deepseek-v4.1-flash` 正是这种**（§0x-7a 实测解析出 `["text"]`）。

### 实现

新增 `src/deepseek-vision-patch.ts`，**照 `src/opencode-provider.ts` 同款形态**
（纯函数出计划 + `settings.update` 执行 + 永不抛错），三段：

| 段 | 函数 | 职责 |
|---|---|---|
| 纯函数 | `planDeepseekVisionPatch({resolved, enabled})` | 出 `{patch, actions}`，**不读文件不碰 ctx** ⇒ 可穷举测试 |
| 执行 | `applyDeepseekVisionPatchOnce(ctx, enabled)` | 走官方通道 `ctx.settings.update('llm-pi-ai', patch)`；**任何失败都不抛**（apply 抛错 = 整个 dsh 启动失败） |
| 装配 | `registerDeepseekVisionPatch(ctx, enabled)` | ① apply 立即试 ② 命名空间竞态退避重试（1s~40s）③ `settings/updated` 热改自愈 |

**判据（每条可机械执行）**：

| # | 判据 | 取值 |
|---|---|---|
| J1 | **触发** | 模型 `id` 含 `deepseek`（**大小写不敏感**） |
| J2 | **范围** | **所有 provider / 所有 route**（owner："任何 deepseek 模型"） |
| J3 | **补什么** | `input` 补 `image`；**已含 ⇒ 跳过**（幂等） |
| J4 | **不动什么** | 已显式声明且含 image 的 ⇒ 一字不改；**非 deepseek 模型 ⇒ 一字不改** |
| J5 | **写哪** | `llm-pi-ai.providers.<route>.models[i].input` |

### 🔴 两处关键实现约束（本版最易错处）

1. **models 数组「读-改-整写」**：
   宿主 `mergeLayers` 的语义是「**数组整体替换**」（`dsh-settings/lib/index.js:203-216` 逐字：
   *"every other value (arrays included) replaces the lower layer wholesale"*）
   ⇒ **只发"想改的那一个元素"会静默冲掉该 route 上其它所有模型**。
   ⇒ 必须**读出现有 `models` 全量 → 内存里改目标元素 → 整个数组回写**（元素用 `{...原对象}` 保字段）。
2. **绝不新建 `models`**：`models` 与 `modelOverrides` **互斥**（`dsh-llm-pi-ai:643`）
   ⇒ 某 route 没有 `models` 时**直接跳过**，为它造一个会让该 route 当场校验失败。

### 开关与撤除（**临时性 ⇒ 必须易撤**）

- 开关 `config.visionPatch.enabled`（**缺省开**）；
- 撤除三层：① 关开关（停止再补）② 删本文件 + `index.ts` 一行装配 ③ 手动清理已写入的值；
- 🔴 **刻意不做"回滚已写入的值"**：我们写的是**事实**（"该模型支持图片"），不是**偏好**——
  停掉插件后它依然是事实。做回滚需要一份"哪些是我们写的"的**写入台账**，
  那是第二真相源，属本仓已多次识别过的"只增不清"病族，**不值得为它引入**。

### 取证（**先探针后代码**）

**V-1 探针** `tests/host/deepseek-vision-probe.test.ts`（真实 `dsh-settings` + 真实 cordis，同 §0L 手法）：

| 点 | 判据 | 结果 |
|---|---|---|
| W-0 正控 | 注册命名空间 + `update` 普通对象 patch 能写成功 | ✅ |
| **W-1 🔴 核心** | 发单元素 `models` 数组 ⇒ **原有模型全被冲掉**（2 → 1） | ✅ **实测证实数组整体替换** |
| W-3 读-改-整写 | 整写 `models` 保住非目标模型 + `contextWindow` 等字段 | ✅ |

⚠️ **诚实边界**：探针验的是 **`dsh-settings` 通道**，**不含 `llm-pi-ai` 自己的 `validate` /
`assertServiceable`**（需装载真 pi-ai 包）⇒ **"通道通 ≠ 被 pi-ai 接受"**；
该层由发布后的**真机实测验收**覆盖（判据 = 那个解析出 `["text"]` 的模型**真能收图**）。

**探针自身两处缺陷（已记，方法论）**：
① 脚手架三处（`register` 是三参 / `schema` 必须是函数 / `writable` 由子类定义）
—— 均属「**先分诊脚手架失败还是被测对象失败**」的适用面；
② 🔴 **时序**：W-3 首跑红，真因是 **W-1 已把 models 冲成残局**（状态污染），非方案缺陷
⇒ **新判据：同探针内验"正确做法"前必须先重置初始态**（与"探针先做正控"同族）。

### 边界（诚实标注，不可外推）

🔴 **本版只作用于 `llm-pi-ai` 面**。`dsh-llm-deepseek` 有自己的 `DEFAULT_MODELS` +
`inputModalities` 字段（`dsh-llm-deepseek/lib/index.js:1841-1884`），**是另一条声明链**。
⇒ 若某 deepseek 模型仍收不了图，**第一步应判定它走哪条链**，而非断定本 patch 失效。

### 验收

- 新增镜像测试 `tests/deepseek-vision-patch.test.ts`（**38 用例**：穷举设计 §4.2 的 6 种 `input` 现状 /
  数组整写不丢模型与字段 / 绝不新建 models / 幂等 / 执行层永不抛错 / 装配自愈与拆卸）；
- `register.test.ts` 的 disposer 标签数 **3 → 4**（新增 `deepseek vision patch retry timer`，**有意登记**）；
- 门禁：`typecheck` 双面 ✅ ｜ **97 files / 1445 tests** ✅（本轮 +2 files / +41 tests）
  ｜ `coverage` ✅ ｜ `build` ✅ ｜ `pack-check` ✅（112 文件）；
- 设计档：`docs/deepseek-multimodal-patch-design.md`（v1.0）。

---

## v1.40.1 — 2026-09-19（§0L 迁移修正：**发布后实测**暴露的 cwd 缺陷）

**来源**：v1.40.0 发布重启后的**实测验收**（S142）。

### 🔴 缺陷（实测，非推断）

v1.40.0 上线后 `~/.dsh/storages/` 里**没有**出现 `serenity_bindings.json` ——
即"绑定迁入宿主存储域"这一功能**实际没有生效**。

**根因**：装载期那次迁移用 `process.cwd()` 当 CCC 根。而 dsh **服务进程的 cwd 是 `/home/yh`**，
**不是 CCC 根**（`acc-diag` 实测：`进程 cwd: /home/yh ｜ 进程 CCC: （无）`）
⇒ 迁移读的是一个**不存在的文件**，**静默迁移 0 条**。

### 修复

迁移从「装载期按 `process.cwd()`」改为「**惰性按 CCC 触发**」：

| 改动 | 说明 |
|---|---|
| 新增 `ensureBindingsMigrated(root)` | 幂等（只灌域里还没有的）+ 进程内去重（省 IO） |
| 挂点 = `bindingsPathFor` | **每次绑定读写都会经过的收口点**，也是本模块唯一稳定拿得到 CCC 根的地方 |
| `index.ts` 装载期 | 只保留「开域 + 注入句柄」，不再猜测 CCC 根 |

⇒ 无论服务从哪个 cwd 启动，**只要那条 CCC 有会话活动，它的历史绑定就会被补灌进域**。

### 🔴 为什么这个缺陷没被测试抓到（方法论，值得记）

单测里调用方**总是传对 cwd**，而真实服务的 cwd 由**宿主**决定。
⇒ **教训**：**"参数从哪来"本身是一条需要独立验证的契约**。
凡依赖 `process.cwd()` 的启动期逻辑，都必须用**真实运行态**的 cwd 复核 ——
"单测全绿"证明不了"启动路径上那个值是对的"。

### 验收

- 新增 3 条测试：读路径即触发迁移 / `bindingsPathFor` 本身即触发 / 域不可用仍是 no-op（零回归）
- 门禁：`typecheck` ✅ ｜ **95 files / 1404 tests** ✅

---

## v1.40.0 — 2026-09-19（§0L：轨迹绑定载体迁入**宿主存储域** + D69「只留一条」）

**来源**：所有者 2026-09-19 令（S142 §0G~§0L，经多轮对齐）：
> 「**放 CCC 不合适**」→「**不存、实时找**」→「相当于**存 dsh 全局**去了，可行性如何，调研下」
> →「**同意，开工吧，注意向前兼容**」→「**开工**」

### 核心变更：绑定的载体从 CCC 内文件 → **宿主自己的存储域**

原先「会话 ↔ 轨迹」的绑定存在 **CCC 内** `AGENT_SESSIONS/.bindings.json`。
所有者指出该位置不合适（CCC 是 git 管的、会话 id 是**本地机器**的 → 跨机错配）。

现改为存**宿主自己的存储域**（`~/.dsh/storages/`）——
这正是宿主自己存放「工作区 → 有哪些会话」（`workspace.json`）的**同一个位置、同一类结构**。

| 面 | 改动 |
|---|---|
| 新增 `src/host/storage-domain.ts` | `openBindingDomain(ctx)` / `BindingStore` / `bindingDomainSpec()` |
| `src/trajectory-bound.ts` | 读写改 **域优先 / 文件兜底 / 双写**（**导出签名一个未改**） |
| `src/index.ts` | 装载期开域接线 + 一次性迁移（fire-and-forget，永不抛错） |
| `src/host/contract.ts` | `HOST_SERVICES` 登记 `storageDomain`（lazy / `open`）——依赖可被 `dashboard health` 探到 |

🔴 **域名 = `serenity_bindings`（下划线）**。宿主约束 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
⇒ 连字符形如 `serenity-bindings` **非法**（会在 `defineDomain` 模块加载期抛错）。

🔴 **取服务必须走 `hostService(ctx,'storageDomain')`（= `ctx.get`）**，**不可**属性直读
——dsp 的 `inject` 列表不含它，属性直读在真实 cordis 下抛
`cannot get property "storageDomain" without inject`（同 v1.31.4 的 `subagents` 陷阱）。

### 向前兼容（所有者硬约束：「注意向前兼容」）

| 保证 | 实现 |
|---|---|
| 旧数据不丢 | **一次性迁移**：旧 `.bindings.json` 全量灌入域（**幂等**：只写域里还没有的） |
| 旧行为不破 | **域不可用 ⇒ 行为与升级前逐字一致**（读回落到旧文件，三级回退仍保留） |
| 迁移不丢绑定 | 逐条迁移；单条失败不影响其余；**不删旧文件**（第二道保险完好） |
| 可回退 | 旧文件**永久保留**且持续双写 ⇒ 关掉域即可完全退回旧形态 |

🔴 **技术前提（决定实现形态）**：域句柄的**读是同步的**（`get`/`entries`/`keys`/`size` 走内存），
**写才异步**。⇒ 启动时 `open` 一次、握住 handle，**10 个既有调用点的同步签名可原样保留**
（system-prompt 每轮求值 / keeper / rebuild / skiff / trajectory / wake-scheduler **零改动**）。

### D69「只留一条」（所有者 2026-09-19 裁：「2.只留一条」）

同一轨迹的**多条会话**：新会话绑上时，**旧载体自动退休**——
**不删**（记录保留，正向 `readLastBound` 仍可查到"曾属于哪条轨迹"、可审计 `supersededAt`），
只**退出唤醒候选**（`listBoundSessionIds` 过滤）。实测 S142 曾同时挂 **4** 个载体 → 收敛为 1。

🔴 **本轮实施抓到并修复一个真 bug**（由新的 D69 域路径用例发现）：
`supersedeOtherBindings` / `pruneMissingBindings` 的**返回值**只在**文件循环**里收集，
而记录已搬进域 ⇒ 两者**都返回 `[]`**：
- 调用方（`container_trajectory use`）靠返回值决定是否回报 `supersededBindings`/`prunedBindings`；
- 且 `marked.length === 0` 会**短路跳过写盘**。

⇒ 症状 = **「只留一条」静默不生效**（记录没被标记，返回也看不出异常）。
**修复**：两个函数改为取 **域 ∪ 文件的并集**；判定与施加分离；写盘失败不再清空返回值。

### 验收

- **既有 `trajectory-bound.test.ts` 27 条断言逐字未改且全绿**（向前兼容的机械证明）
- 新增测试：域优先/兜底/双写/迁移幂等/D69 域路径/pruneMissingBindings 域侧回归钉
- 门禁：`typecheck`（node + client）✅ ｜ **95 files / 1401 tests** ✅
- 前置可行性探针三点实测全绿（`tests/host/storage-domain.test.ts`）：
  ① 服务可见（`DomainFacility`）② 域往返可落盘（关闭重开仍在）③ 域名约束

---

## v1.39.3 — 2026-09-18（dsh 内存崩溃的 (b)(c) 两项机制 + 两处既有欠账收尾）

**来源**：所有者 2026-09-18 令（S142 §0y，经 S185 / S172 转达）：
> 「我重启了 dsh…核心是**旧会话累积的内容太多了导致 dsh 内存崩溃**，所以我需要开新的」

**裁决原话**：「**a 没必要**，我更想解决的是上下文已经通过 rebuild 机制几乎无限续航了，
最大的会话累计输入达到了 **2550m+**，但累计过大导致了新的风险，**b 很合理，这是个很好的保障措施，
c 也算个兜底**。」⇒ **不上 (a)，做 (b) + (c)**。

### ① (b) 同一 trajectory 多 live 会话 —— **机械守卫**

背景（实测，非推断）：`.bindings.json` **只增不清** —— 本机实测 S142 名下挂 **4 代**、S185 挂 **2 代**
（全部 `action: "rebuild"`）。而 `acquireWakeAgent` 的选人语义是
「**遍历该轨迹的全部绑定 id，任一条 live 就用它**」⇒ 同一 trajectory 的**两条 live 会话都能被唤醒选中**：
各自持一份完整上下文（**内存翻倍**），且**都在写同一批文件**（双写者）。

| 改动 | 说明 |
|---|---|
| `SessionBoundRecord` + `supersededAt` | 新增"已被取代"标记 |
| `listBoundSessionIds` **过滤**已取代项 | 被取代的绑定**不再进入唤醒候选** |
| 新增 **`supersedeOtherBindings(root, dirName, keepIds)`** | 把同轨迹的**其它**绑定标记为已取代 |
| 接线：`container_trajectory use` | 在 `appendBound` 之后调用；结果经 **`supersededBindings`** 如实回报 |

🔴 **关键设计取舍（R↓）**：**保留记录、只切断候选** ——
记录留着，所以"这条会话曾属于哪条轨迹"的**沿革不丢**（正向 `readLastBound(session)` 不受影响），
被解绑的会话**仍可被人工使用**；变的只有"唤醒还会不会找到它"。

### ② (c) 悬空绑定清理（**兜底**）

| 改动 | 说明 |
|---|---|
| 新增 **`pruneMissingBindings(root, isMissing)`** | 删除指向**已不存在**的 dsh 会话的绑定记录（反向索引不被悬空 id 污染） |
| 新增 `sessionLogBytesById` / `hasSessionLogById` | 会话日志体积 + 存在性判据 |
| 接线：同上，经 **`prunedBindings`** 回报 | |

🔴 **安全判据必须 fail-closed**：`hasSessionLogById` 在 **sessions root 本身不存在时一律返回 true（当作"在"）**——
否则换 `DSH_HOME` / 换机器会让"全部绑定看起来都悬空"，进而**误清整张绑定表**。
`pruneMissingBindings` 另外规定"**判据自身抛错 ⇒ 保留该条**"。

### ③ 顺带（先于本轮，`372658e`）：启动窗口**不再伪造"失败的投递"**

`restart-web` 后新进程的**首拍 tick** 早于宿主懒服务（`sessionController`）就绪 ⇒
任何此刻到点的条目**必然**被判失败（现象 = 注册表里一堆 `attempts=1` + 误导性 `lastResult`；
本机实测每次重启**必然复现**，是**假告警发生器**）。
修法：`WakeDeliveryResult` 新增 **`notReady`**，该分支**不改条目任何字段**（state / attempts / lastResult 全不动），
只记一行"下个 tick 再试；不计失败"；并把**猜错成因**的文案（`（headless profile？）`）改成说真话。
⚠️ **零丢失**：真正超窗的条目仍由**时间**判据落 `missed`——与"试过几次"无关（已正控实测自愈）。

### ④ 顺带（先于本轮，`84ec674`）：`send-now` 回执残留旧词

回执文案仍写「已入队」——而 v1.39.2 起忙路径已是 `steer`（当场注入当前轮），该词已不成立 ⇒
改为「**已注入 / 已起轮**」，与工具描述 / acc-session skill 模板 / README 对齐。

### ⑤ 🔴 否决留痕：(a) 的候选「自动 rebuild」**经复核不成立**

原方案 A2（超限即自动 `rebuild`，设想为"机械版的开新会话"）**动手前回源码复核，发现它做不成那件事**：
`rebuild` 只做 **surface replace**（`session.append('compaction/prune')` + `session.append('user/message')`），
**同一个 dsh 会话 id 与同一份日志文件都保留**（`src/rebuild.ts:313-314` 原注释即「同一 dsh 会话 id 日志保留」）。
⇒ 它重置的是**模型上下文**，**不是会话日志**，对内存问题**零效果**。
**故未实施，且今后不应再提 A2。**（所有者"a 没必要"与我方复核两条独立判断同向。）

### 门禁（发布链实跑）

| 项 | 结果 |
|---|---|
| `typecheck`（node + client） | ✓ |
| `test` | **93 files / 1362 tests** ✓（较 1.39.2 **+15**：`trajectory-bound.test.ts` +8 含**接线钉**、`session-cleanup.test.ts` +7 含 fail-closed 断言） |
| `coverage` | ✓（阈值门禁通过） |
| `build` | ✓ |
| `pack-check` | ✓（见发布记录） |

---

## v1.39.2 — 2026-09-17（三条所有者令：`send-now` **不排队**即时注入 + 注入带**当地时间** + 全 ACC 时间统一**当地时区**）

**来源**：所有者 2026-09-17 令（S142 §0r）：

1. 「希望 send message 时**不排队**，可以直接作为**提示词即时注入**进去」
2. 「注入时除了内容，**再带上当前时间**」
3. 「**统一 ACC 所有使用时间的地方使用当地时区**」

---

### ① `send-now` 语义变更：排队 → **不排队即时注入**（D66）

旧实现一律 `agent.followup`（宿主注释：*Queue an ordinary follow-up turn*）⇒ 目标**正在跑轮次**时，
消息排在**轮次边界**。现按宿主 `agent.status` 分流（**判据取宿主现成状态，不自建"忙碌集合"**）：

| 目标状态 | 动作 | 效果 |
|---|---|---|
| `idle` | `followup` | 宿主**同步**置 running ⇒ **立即起轮**（本就不排队） |
| **在跑** | **`steer`** | **当场注入当前轮**——这才是"不排队"的关键路径 |
| `steer` 抛错 | **退回 `followup`** | **fail-safe：宁可排队，不可静默丢消息**（回执文案写明） |

- **只改 `send-now`**：`send-later`（`deliverWake`）**一行未动**——预约的本职是"到点唤起"，
  且在跑时排队不打断当前轮是它被实证验收过的行为，不顺手动它。
- 🔴 **这反转了 v1.32 起验收过的"不打断当前轮"** ⇒ 旧表述散在**六处描述面**，
  **全部同批改掉**（任一漏改就是**向 agent 注入假陈述**，比没有更坏——目标会误判自己看到它的时机）：
  工具描述（LLM 读的那条）/ 注入正文 / 结果输出文案 / `acc-session` skill 模板（随包分发）/
  README（中英 + 包内副本）/ `msm catalog` ⑤。
- ⚠️ **承诺边界不变**：回执只到「**已注入 / 已起轮**」，**不表示**目标已执行或已答复；
  判"目标真的动了"仍须看它自己的 `SESSION.md`（**不得凭回执结案**）。
- 📌 **描述面穷举 ≠ 一律照改**：`docs/trajectory-wake-registry-design.md` 也写"排队不打断当前轮"，
  但它讲的是 `send-later`/`deliverWake`（**未改**）⇒ **不动**；`trajectory-send-message-design.md`
  作为设计沿革**加「部分被取代」横幅**，不重写历史（R↓）。

### ② 注入正文带**当前时间**

`buildSendText`（即时投递）与 `buildWakeText`（到点唤醒）均加一行
`当前时间：2026-09-17 21:05:00 +08:00（当地时区）`——**人读钟面 + 显式偏移**，两者都不丢。
并**删掉** `buildSendText` 里"消息已进入你的队列…本轮结束后生效"那句**已变假**的陈述。

### ③ 全 ACC 时间统一**当地时区**（D67）——新增 `src/time.ts` 为「呈现」的单一真相源

**判据：把"时刻"与"呈现"分开**

- **时刻**（`Date.now()` / epoch）——**与时区无关**。比较 / 差值 / TTL / 调度 / TOTP **一律照旧**，
  **不得"本地化"**：把时刻换成当地钟面会让它**不可比**（跨偏移、跨夏令时都错）。
- **呈现**（给人看、或存给人看的字符串）——**一律当地时区 + 显式偏移**（`…T21:05:00.123+08:00`）。
  ⚠️ **偏移不可省**（本模块最容易被"简化"掉的一点）：省了就丢掉"这是哪一刻"，
  且**跨格式的字符串排序会错**——`…T09:00:00Z` 与 `…T17:00:00+08:00` 是**同一刻**，字典序却相反。
- **当地 = 运行机器的本地时区**（**不硬编码** `Asia/Shanghai`，否则换机器/换地区就错）；
  偏移**按被格式化的那个时刻求**（`getTimezoneOffset` 随夏令时变化）。
  这也**回归了原设计意图**：`parseWakeAt` 的文档示例本来就是 `+08:00`，此前的 `Z` 只是实现的顺带结果。

**落地**

- **新增 `src/time.ts`**（8 个助手：`tzOffset` / `isoLocal` / `localDate` / `localDateTime` /
  `localDateTimeMinutes` / `localHuman` / `localFileStamp` / `localIdStamp`）
  ＋ **`tests/time.test.ts`（12 例）**：偏移形状｜偏移**由传入时刻**决定｜**字典序 = 时间序**｜
  **往返 `Date.parse` 不丢信息**｜各形态一致性。
- **sweep 23 处 `.toISOString()`**（跨 **12 个文件**）→ time 助手；`wake-registry` 条目 id 构造；
  5 处「UTC RFC3339」类型注释（改后**已成假陈述**，同批改掉）。
- `handyman-ops.ts` 进度列表排序：**字符串比较 → `Date.parse` epoch 比较**（同上理由）。
- 🔴 **唯一测试红，且修法有讲究**：`newWakeId` 断言把期望值**硬编码成 UTC 戳**
  （`/^w-20260913-1234-/`）⇒ `+08:00` 机器**必红**。
  **修法是重推，不是改数字**（改数字只会得到"只在本机时区对"的断言）：
  ① 断言**形态** ② 期望值由**当地钟面独立重推**（**不经 `localIdStamp`**——调它就是自证）
  ③ 非 UTC 机器补**负向断言**钉死"已改"（UTC 机器上同样通过）。

### ④ 顺带（先于本轮，`eb92e6c`）：MSM 扫描的「入口判据」

`scanSkillScripts` 显式排除**目录** + 新增 `hasCliEntry()`：
**入口 ⟺ 有 shebang（`^#!`） ∨ 声明了 `function main(`**——`process.argv` **单独不算**
（反例：`home-desk/scripts/lib/desk-dispatch.ts` 有 5 处 argv，实为库）。
⚠️ **现网行为零变化**（DC-M3 报的 9 条全部 `main=1`）⇒ 本项是**未来防误报**，
**不是修线上缺陷**（勿记成 bugfix）。配 9 例钉测试。

### 门禁（发布链实跑）

| 项 | 结果 |
|---|---|
| `typecheck`（node + client） | ✓ |
| `test` | **93 files / 1346 tests** ✓（+1 文件 / +12 断言，均为 `time.test.ts`） |
| `build` | ✓（`lib/index.js` + `lib/client.js` **200080 B**） |
| `pack-check` | ✓ **110 文件**（较 1.39.1 **+1**：新增 `lib/time.d.ts`） |

---

## v1.39.1 — 2026-09-17（修复：会话头状态胶囊的展开卡片**左边缘被祖先裁切**）

**来源**：所有者转发反馈「**下拉 dialog / 弹窗内容过宽后，会被左侧元素遮挡**」（经 S172 转达）。

### 🔴 根因（真机 CDP 取证，非推断）：祖先 `overflow:hidden` **裁切**，不是 z-index 也不是宽度不够

胶囊展开卡片 `.sp-pop` 原为 `position:absolute; right:0`，锚在会话头右端的**状态胶囊**上。
真机实测（1280/1600/1920 三档一致）：

| 量 | 值 |
|---|---|
| 胶囊右端 | `x = 954.2`（**与会口宽度无关**——会话头是定宽列） |
| 卡片宽度 | `680`（v1.36.1 加宽） |
| ⇒ 卡片左边界 | `954.2 − 680 = 274.2` |
| 祖先 `pI_x6G_centerCol` / `wSkVaW_root` | `overflow: hidden`，**左边界 = 280** |
| ⇒ **左边缘被裁** | **5.8px**（左边框线与圆角消失） |

**这是 v1.36.1 的回归**：加宽前卡片 340px，左边界 614.2 远在 280 右侧，不越界。
`right:0` 对齐意味着**加宽只会向左长**——跨过 280 那条裁剪线就出事。
⇒ 所有者描述的"内容**过宽后**"精确对应这次加宽。

**已排除的另两个假设**：② 层叠上下文被困（`z-index:2000` 失效被兄弟盖住）——真机 `covered = 0`，
且祖先链**全无** `transform/filter/contain/will-change`；③ header 插槽宽度不足——绝对定位元素不参与槽宽裁切。

### 修法：改 `position: fixed` + JS 算坐标并夹取进视口

- `position: fixed` 的子元素**不受祖先 `overflow` 裁切**；坐标由 `SafeModePanel` 用
  `getBoundingClientRect()` 从胶囊算出（右端对齐，等价旧 `right:0`）＋ **视口夹取**（窄视口不溢出）。
- 用 `useLayoutEffect` 在**浏览器绘制前**量尺寸落位（否则会闪一帧）；落位前渲染在屏外常量坐标。
- 窗口 `resize` / 内部滚动容器 `scroll`（capture）时重算——锚点会随侧栏开合移动。
- **为什么不用 `createPortal`**：本仓 client 侧**无 `react-dom` 依赖**（只有 `react`）⇒ 不可用；`fixed` 是等效且更轻的出路。
- 宽度、窄屏断点、两栏布局、外点/Escape 关闭行为**均未改**（外点关闭走 `rootRef.contains()` = DOM 树判定，与定位方式无关）。

### 验证（**三档宽度真机实测**）

| 视口宽度 | 修前（absolute） | 修后（fixed） |
|---|---|---|
| 820（窄，跨 860 断点） | `clipDepth 0` · OK | `clipDepth 0` · OK |
| 1280（中） | **`clipDepth 4` · CLIPPED** | **`clipDepth 0` · OK** |
| 1920（宽） | **`clipDepth 4` · CLIPPED** | **`clipDepth 0` · OK** |

- **判据 = hit-test**（`elementsFromPoint` 沿卡片左边界逐档取点，看栈顶是否为卡片本身）——
  它**裁切感知**：修前左边界 275→278px 命中 **0/4**、280px 起 **4/4**（跃变点正好 = 裁剪祖先左边界）。
- 三档均 `outOfViewport = false`；像素级旁证：左边缘窄条 PNG 字节数 168 → 280。
- **反例 mock**（脱离本应用的隔离证明）：`overflow:hidden` 祖先 + 卡片，
  `absolute` 变体 CLIPPED、`fixed` 变体 OK ⇒ **机制与修法双向成立**。
- **回归守卫**：新增 `tests/client-popover-clip-guard.test.ts`（5 断言）——`.sp-pop` 一旦退回 absolute 立即红。

⚠️ 记录一条**判据教训**（本轮踩过）：首版判据用"卡片 rect 超出裁剪祖先内容盒多少 px"，
它把**修好后同样超界但正常绘制**的 `fixed` 版本误判为 CLIPPED（假阴性，一度以为修法无效）。
**几何超界 ≠ 被裁**；判据必须是"有没有真画出来"。

### 验证门禁

`typecheck`（node + client）✓｜`test` **91 files / 1325**（+1 文件 / +5 断言）✓｜`build` ✓｜`pack-check` ✓｜`coverage` 阈值 ✓

---

## v1.39.0 — 2026-09-17（`container_trajectory` 两个投递动作**更名**：`wake-later` → **`send-later`**、`send-message` → **`send-now`**）

**来源**：所有者提问「wake-later 和 send message 之间的关系很近，帮我想个好名字」→ 命名专题（S142 §0n：ontology 诊断 + 判据 + 三案）→「**那就A吧，改个名字**」→「发版」。

### 🔴 命名判据（R↓）：两者是**一条投递通路的两端**，轴应当取「时刻」

**诊断**：两个动作**共享**取用机制（`acquireWakeAgent`：live 优先 → 冷载入）、**共享**载荷形态（一条 message）、**共享**落点语义（轮次边界生效、不打断当前轮）；真正的分界只有一条 —— **时刻**（现在 / 未来）。而**回执**（有/无）、**落注册表**、**不可回收**三项**皆由"未来"推出**，属**派生**差异。
⇒ 旧名把**共享属性**（唤醒）写进了**其中一个**名字（`wake-later`），而 `send-message` 对冷目标**同样要唤醒**（非 live 走冷载入＝等效直接 wake）——**名字选错了轴**，这才是"两个名字关系很近却别扭"的真因。

| | 案 | 判 |
|---|---|---|
| ✅ **取** | **`send-now` / `send-later`** | 共享词干 `send-`；轴 `-now`/`-later` **同构**（S↑）；`send` 的承诺等级恰为「**发出**」而非「送达」——与实际只到「已入队」吻合 |
| ❌ | `deliver-now` / `deliver-later` | `deliver` 承诺「**送达**」> 实际能力 ⇒ 会**加剧**"以为已送达"的误读 |
| ❌ | `send-now` / `send-at` | `-at` 呼应参数名与 `at(1)`、"预约"味足，但与 `-now` **不同构**（副词 vs 介词） |
| ❌ | `wake-now` / `wake-later` | 把**共享属性**升格为族名；且 `wake-now` 暗示"立刻打断"，与"**不打断当前轮**"矛盾 |

### 改名范围（**硬切无别名**，D46/D61 先例）

- **改 = 13 文件**：`src/` **7**（`trajectory-ops` / `tools/trajectory` / `wake-scheduler` / `seams/system-prompt` / `msm-ops` / `index` / `client/SettingsSection`）+ `tests/` **1** + **包内模板 2**（会随包分发**且被注入 agent 上下文** ⇒ 属契约面）+ README×3（含 `readme-sync` 同步的包内副本）。
- 🔴 **一律不动（分层命名）**：**机制层词汇** —— `wake-registry.json` / entry id 前缀 `w-*` / `WakeEntry` / `addWake` / `deliverWake` / 调度器名 / 配置键 `wakeSchedulerEnabled`。理由：那些词汇描述的是**机制**、与**动作**本就是两层；且改动会波及 86 条历史条目与 id 前缀。
- **历史零改写**：`docs/` 设计档（含 `trajectory-send-message-design.md` 的**文件名**）、CHANGELOG 历史条目、各轨迹历史记录。
- **注释处理纪律**：**当前态陈述 → 改名；带日期的历史陈述 → 保留原名**，另加 2026-09-17 命名条目说明更名 ⇒ **既不留散文级旧名残留，也不伪造历史**。

### 验证

- **四门禁**：`typecheck`（node + client）✓｜`test` **90 files / 1320**（与 v1.38.0 **同数**）✓｜`build` ✓｜`pack-check` **109 文件** ✓
- 🔴 **产物复核（D64 式）**：`lib/*.js` 中旧名共 9 处命中，**逐条看上下文 = 全为 JSDoc 注释行**（历史条目 / "（原 X）"括注 / 设计稿文件名）⇒ **运行时字符串零残留** ✓
- 🔴 **验收判据自伤（留档）**：首版验收 grep 写了 `{src,tests}` 花括号，在 `sh` 下**未展开**且错误只进 stderr ⇒ 该段**静默少扫两个目录**（靠另一段全仓扫描才补上覆盖）。**教训**：多路径判据要么**逐条列路径**，要么**先验一次"我实际扫到几个文件"**。

### ⚠️ 升级提示（硬切）

老文档 / 老会话里的 `wake-later` / `send-message`，**即今日的 `send-later` / `send-now`**。**CCC 侧消费方**（如 `msm autopilot-round` 内联的命令、各轨迹的协议段）须与运行态**同刻**改到新名，否则表现为 `Unknown action` —— **响亮报错，不静默错投**。

---

## v1.38.0 — 2026-09-16（`container_trajectory` 新增第 7 个动作 **`send-message`（即时投递）**）

**来源**：所有者令「trajectory 除了 wake later，还要支持一个 **send message 用于实时使用提示词注入来回应**，如果会话不活跃，则**等效于直接 wake**。设计下」→ 设计稿 `docs/trajectory-send-message-design.md`（v0.2 定稿，三个决策点已裁）→「**同意，开工**」。

### 新增：`send-message`（即时投递）

| | `wake-later`（原有） | **`send-message`（新）** |
|---|---|---|
| 时刻 | **未来**（`addWake` 硬拒 `at ≤ now`） | **现在** |
| 语义 | 预约（fire-and-forget） | 递话（**同步回执**） |
| 回执 | **无**（D58 明示接受） | **有** |
| 落点 | `AGENT_SESSIONS/wake-registry.json` | **不落注册表** |

**取用通路与唤醒完全共用**：live 命中 → 立即 `followup` 注入；非 live → `sessionController.resolveAgent` **冷载入**后投递（**这就是"等效于直接 wake"**，但**不等 5 分钟 tick**）。

### 🔴 两条设计地基（R↓）

1. **为什么冷路径不落注册表**：`addWake` 显式拒绝 `at ≤ now`（"时刻必须在未来"——那是**预约**语义的地基）。即时投递**不能**靠一条 `at=now` 的条目实现：既会撞上该不变量，又会让调度器把一次性即时投递当 `pending` **每 tick 重试**。⇒ 直接复用 `acquireWakeAgent`，**同步**投递。
2. **为什么用"新原语"而不是给 `wake-later` 打补丁**：S142 §12.B 曾提"给 wake 加投递后确认"并标注"⚠️ 触及 D58 ⇒ 须裁"。本次取**加一条独立原语**：**D58 一个字不改**（预约仍无回执），要回执的人改用 `send-message` ⇒ **两个动作各自语义干净**（打补丁会让同一动作有两种语义）。

### ⚠️ 能力边界（写进工具描述，避免被误当成"发出去就已经发生"）

- 回执只到「**已入队**」——**不表示**目标已执行/已答复。
- 目标正在跑轮次 ⇒ 消息在**轮次边界**生效（**不打断当前轮**）。
- 冷载入本身有延迟（历史实测投递→起轮 **6~31s**）。
- 要判"目标真的动了" ⇒ 必须用**文件级判据**（它自己的 `SESSION.md`）。

### 实现落点

- `src/wake-scheduler.ts`：**新增** `buildSendText()` + `sendToTrajectory()`（**纯新增，`deliverWake` 一行为未动**——v1.35.0 硬约束①仍守）。归属理由："怎么把一句话送到一条轨迹"是**调度器的知识**，不是工具的知识。
- `src/tools/trajectory.ts` + `src/trajectory-ops.ts`：第 7 个动作（enum / 描述 / 参数 / 分支）。
- `src/seams/system-prompt.ts` 的 `toolsBlock`、`src/msm-ops.ts` 的 `ACC_CATALOG`、包内模板 `acc-serenity/SKILL.md` + `acc-session/SKILL.md`（**会随包分发并被注入 agent 上下文 ⇒ 属契约面**）。
- 顺手订正模板里一处**失效陈述**：`acc-session/SKILL.md` 仍在指 `container_admin autopilot`（该域 **v1.35.0 已整段退场**）。

### 测试（`tests/wake-registry.test.ts`，27 → **35**）

live 命中（正文含 `[即时消息]`/sender/message，且**不含唤醒头**）｜非 live 冷载入｜`sessionController` 缺席 ⇒ 响亮报错｜无绑定｜目标未命中｜`followup` 抛错 ⇒ 留原因｜🔴 **不落注册表**（裁 (A) 的回归钉）｜🔴 **`addWake` 仍拒 `at ≤ now`**（防有人为了 send 顺手放宽它）。

> 🔴 **本轮实测踩到并订正的一条判据形态**：首版断言写 `expect(sent[0]).not.toContain('到点')`，被自己正文里那句"（**不是**到点唤醒）"**判成违规**（**假阳性**）。⇒ 判据改用**精确判别符**（唤醒头 `[trajectory 唤醒]` / `登记于`）。**教训**：`not.toContain` 一类否定判据要**先想想自己的解释性措辞会不会撞上它**。

### 兼容性

- **纯新增**（新动作 + 新导出函数）；**既有 6 动作行为零变化**，`wake-later` 链路**一行为未动**（`deliverWake` 原样，`wake-registry.test.ts` 原有用例**未改断言**即全绿）。
- 注册表 **schema 未变**（不写 send 条目 ⇒ 无需 `kind` 字段、无需"永不 pending"特例）。

---

## v1.37.0 — 2026-09-16（提示词注入整理 **C / G**：指引修正 + 不再注入 handyman 模型名）

**来源**：所有者令「整理下我们 dsp 做的所有提示词注入，找到可以砍掉的候选（口径是 **没有必要 / 冗余 / 对 LLM 造成了干扰**），我来审核」（S142 §0e）。审计稿 = `docs/injection-audit.md`；本版落地其中**两条已裁决**的候选 + 两处残留清理。

### 改了什么

| # | 面 | 旧 | 新 | 判据（所有者口径） |
|---|---|---|---|---|
| **C** | `identityBlock` 末行（`system-prompt.ts:86`） | `call msm("<name>") to execute or discover them (see the "Serenity Tools" heading below)` | `call msm() with no arguments to list them, or msm("<name>") to execute one.` | **干扰**：原句把 **MSM**（CCC 注册的那一层）指到 `"Serenity Tools"` 标题下，而那里列的是 **ACC 内置工具**——把一个东西指到另一个东西的名字下 |
| **G** | `accIdentityText()`（`context.ts`，对话消息流侧身份锚点） | 注入 `- handyman default model: <model>` | **删该行**（连带删只为它存在的 `defaultModel` 读取） | **没有必要**：模型名对 LLM **不构成可执行动作**——调 `handyman` 时不由它选模型（`handyman.ts:213/461` 自己读配置），拿到名字也无法据此决策 ⇒ 纯噪音。所有者：「这个 LLM 不关注的」 |

**G 的边界（重要）**：删的**只是注入**。**机制与面板都保留** —— `handyman.ts` 仍按配置选模型、`status.ts:85` 仍把 `handymanModel` 喂给 WebUI 面板（那是**给人看**的）。⇒ **零功能影响**。

### 回归钉（都钉在"不得回来"，不是删断言）

- `system-prompt.test.ts` / `osp-alignment.test.ts`：`not.toContain('(see the "Serenity Tools" heading below)')` + `toContain('call msm() with no arguments to list them')`。
- `context.test.ts`：原「应包含 `mock-model`」**反转为**「不得包含」（`not.toContain('mock-model')`）——夹具仍写入 `localstore/serenity.json` 的 `handyman.defaultModel`，确保钉的是"读了也不注入"。

### 顺手清理（发布前复验时发现的两处 G 残留）

1. `context.ts` 删已成**死导入**的 `readHandymanConfig`（穷举 grep 确认全文件无第二处使用；该函数在另外 7 个消费者里活着，**导出不动**）。
2. 订正 `context.ts` 的文档注释中仍写着「+ handyman 模型」的旧状描述。

> 两处都是**同一类病**：改注入时只覆盖了「标识符」，漏了「散文/尸体」——与 S142 §12.23 记的两条漏网同源。
> ⚠️ **登记一个门禁缺口**：本仓未开 `noUnusedLocals`，所以"删掉某标识符的最后一次使用"留下的死 import **没有任何机械门在守**，typecheck 抓不到。

### 兼容性

- **无 API/工具面/配置面变化**（工具面仍 11；配置键未增删）；纯文案与死代码。
- 门禁：`typecheck` 双面 ✓ ｜ `test` **90 files / 1312 tests** ✓ ｜ `build` ✓ ｜ `pack-check` **109 文件** ✓。

### 同批（**不发版**，CCC 侧内容）

`home-serenity/SKILL.md` 削减（所有者裁决 F1/B/F2/F3/F4/F6）：**476 行 / 47 790 B → 405 行 / 40 555 B**（−71 行 / −7 235 B）。含删 `## 相关技能`（与技能清单表重复）、删「四层的关系」表（架构图的重述）、删 SSH 主机别名静态表（改为指向 `ssh-connect list`）、合并路由表重复行、删两处过期数字。

---

## v1.36.1 — 2026-09-16（CCC 卡片改**双栏**：左信息 / 右动画）

**来源**：所有者（2026-09-16，v1.36.0 刚发布后）：「这个飞船有点问题，那个点击出来的卡片做成**双倍宽，左侧是信息，右侧是动画**吧」。

### 改了什么

| 面 | 旧（v1.36.0） | 新（v1.36.1） |
|---|---|---|
| 卡片宽 | `340px` | **`min(680px, calc(100vw - 24px))`**（双倍；胶囊右对齐 ⇒ 加宽只向左长，再兜住窄视口） |
| 动画位置 | **背景层**（`position:absolute; inset:0`，垫在正文底下） | **右栏**（flex 第二列，`order:2`） |
| 正文 | 浮在动画之上（需重压暗才读得清） | **左栏**固定 340px（`order:1`） ⇒ 与动画不再争同一片像素 |
| 卡片底色 | `rgba(6,11,14,0.75)`（重压暗，为让正文可读） | **`0.9`**（分段后不必再压） |
| iframe 模糊 | `blur(1.2px)` | **`blur(0.6px)`**（不再垫在字下 ⇒ 磨砂可收轻，飞船细节更清楚） |
| 窄屏 | — | **`@media (max-width:860px)` 退回单栏**：信息在上、动画在下（DOM 顺序即如此，**无重复元素**） |

### 🔴 这次改动解开了 v1.36.0 的取舍死结（R↓）

v1.36.0 记的「0.75 是不透明度与可读性之间的**真实取舍**，不是可以调没的参数」——那个取舍的**根因是布局**：动画垫在正文底下，只能靠压暗换可读性。**分段之后两者不再共享像素**，于是动画可以亮、正文可以干净。⇒ 该取舍**随布局改版而消解**，不是被更高的不透明度"解决"的。

### 验证（**离线复现观感**，未重启 web）

造 `card-mock-2col.html`（**与 `SafeModePanel.css` 逐值一致**；改 CSS 必须同批改它，否则 mock 会骗人），headless Chrome 出图 + `vlm-describe` 回读：

- **宽屏（1000px）**：两栏成立；文字清晰无遮挡；飞船居中完整、未被边缘切掉；无布局故障。
- **窄屏（700px）**：正确退回**单栏**（信息在上、动画在下）；动画独立矩形且渲染出飞船；文字完整无溢出。
- 🔴 **一处自我更正**：首轮 mock **漏了 `@media` 段**，导致 700px 那次渲染的其实是"680px 卡片塞进 700px 窗口"的假象 ⇒ 补上媒体查询后重测才成立。**mock 不忠 = 自欺**，已写进 mock 头注。
- ⚠️ **仍非"亲眼"**：以上均为 VLM 转述（本机模型不读图）。交付图 `preview-card-2col.png`（宽）/ `preview-card-2col-narrow.png`（窄）已备好供所有者过目。

### 兼容性

- **纯 client 面**（`lib/client.js` 195940 → 197300 B；`lib/index.js` 未变）；工具面/服务端/配置均未动。
- 浏览器可能吃旧 client 缓存 ⇒ 用 `?v=<accVersion>` 打点，换版本即失效。

---

## v1.36.0 — 2026-09-16（航行动画接进 ACC 作 CCC 卡片背景 + **注入位置不再向 LLM 透露上下文消耗**）

**来源**：所有者两次裁决合批发布——① 航行动画**做到 ACC 层 / 作 CCC 卡片展开背景**（§12.43/§12.44，接线已实施、只卡一句"发布"）；② 「**我们作为 ACC 不得在任何注入位置透露给 LLM**」（2026-09-16，D64）。

### 新增：Serenity 航行动画（ACC 层资产 + 卡片背景层）

| 面 | 内容 |
|---|---|
| 资产 | `assets/serenity-voyage.html`（831 018 B，自包含单文件，three r180 内联）+ `assets/serenity-voyage-preview.png` + `assets/README.md`（来历 / 重建法 / 版本口径） |
| 路由 | 新 `src/voyage-page.ts` → `GET /serenity/voyage`（exact；静态 HTML，懒加载、零 client bundle 增长） |
| 客户端 | `SafeModePanel.tsx` + `.css`：`sp-pop`（340px CCC 卡片）内加背景层 `<iframe>`（**仅展开时挂载** ⇒ 关闭即卸载、WebGL 上下文随之销毁）；卡片半透明 0.75 + iframe `blur(1.2px)` |
| 出包 | `package.json` → `files` 加三项；`dsh-develop pack-check` → `required` 加资产硬断言（防"漏资产"复发，同 v1.26.15 事故形态） |
| 内容判据 | `tests/voyage-page.test.ts` 10 例，把"**不得含外来容器内容**"钉进 CI（**大小写不敏感**——上一轮人工 grep 正是因大小写漏掉全大写 `TIANGONG`） |
| 门禁 | typecheck ✓ / test **90 files 1311** ✓ / build ✓ / pack-check **109 文件** ✓ |

⚠️ **观感取舍（非可调没的参数）**：340px 卡片 + 密排小字的双约束下，"动画看得清"与"文字全干净"互相挤压；取 0.75 + blur 1.2px 为中值。两个旋钮 = 卡片底不透明度、iframe blur；改则 `SafeModePanel.css` 与 `card-mock.html` **必须同批改**。
⚠️ **踩坑留档**：`backdrop-filter` 对 iframe 内容**无效**（跨文档不采样 backdrop）⇒ 模糊只能加在 **iframe 自己**身上。

### 修复：注入位置静默（D64 — **不再向 LLM 透露上下文消耗与限制**）

**清理面**（`src/seams/keeper.ts` 三处，`grep` 穷举确认无第四处）：

| # | 旧注入文本 | 新注入文本 |
|---|---|---|
| ① | `Score threshold reached (150)` | `Score threshold reached.`（计分是 ACC 内部账目，不回显） |
| ② | `Context usage at 412K (threshold 400K)` | `Context usage has reached the configured rebuild threshold.` |
| ③ | escalated 版同款数值 | 同款处理 |

- 🔴 **判定语义与提醒行为一字未改**：仍读 `projectedTokens`、仍与 `thresholdK` 比对、仍连续超阈值升级催。**只是数值参数整条移出注入文本**（`rebuildReminderText()` 的两个数值参数已移除）。
- **范围裁定（所有者当场拍板）**：① **清**；④ `SESSION.md is N KB (limit 200 KB)` **保留**——那是 SESSION.md **文件体积**，非上下文窗口消耗。
- **与 v1.28.0 需求① 的关系**：需求① 是「**判定**」从窗口比例改为绝对 K；"显示 K 数值"只是当时顺带的**文案影响面**，**不是**所有者要求的展示 ⇒ 本项不推翻任何既有裁决。
- **测试**：改为**钉住禁令**（`not.toContain('412K')` / `'(threshold'` / `/Context usage at/`）而非删除断言；构建产物 `lib/*.js` 复核旧数值形态 **0 命中**。
- ⚠️ **判据边界（写测时踩过，留痕）**：禁令对象是"**数值**"，不是"**词**"——新文案自身用了 "configured rebuild threshold" 一词；word "threshold" 不透露任何量，保留。初版断言 `not.toContain('threshold')` 因此**失败**，是**测试写错**而非实现错。

### 兼容性

- **非破坏性**（minor）：工具面不变（仍 11）、配置键不变、`/serenity/*` 只**新增**一条路由。
- 客户端新增背景层 iframe ⇒ **浏览器可能吃旧 client 缓存**（client 用 `?v=<accVersion>` 打缓存点，换版本即失效）。

### 留档（本次不做）

- ④「**为什么这轮没唤起**」诊断缺口（v1.35.0 已登记）：ACC 自管理链仍无病因查询，须**新**条件链，不得以"保留 ④"方式带回。
- `clock-runtime.ts` 的 `ClockOptions` 存量项（`begin`/`bodyCountsTick`/`logFrom`/…）在 autopilot 退场后是否收敛——留作资产清理候选。

---

## v1.35.0 — 2026-09-15（ACC 侧 autopilot **整段退场**：轨迹调度只剩 `wake-later` 一条路）

**来源**：所有者裁决（2026-09-15）：CCC 自管理巡航已**端到端验证**（冷会话唤醒 ✅ + 链式自排 ✅），而 ACC 侧那套"周期自唤醒"在**行为层早已停用**（`autopilotWakeEnabled` 缺省关、时钟从未武装、**tick 次数 0**）⇒ 所有者选 **(a) 整段删除**并显式下令发布（D14）。
**实施基线**：`docs/acc-autopilot-retirement.md`（范围界定 / 二阶裁定 / 寄居者清单 / 涟漪地图 / 硬约束 / S1~S9 分段）。

### 删了什么（src 1503 行 + 测试 1926 行）

| 面 | 内容 |
|---|---|
| src | `autopilot-core.ts` / `autopilot-chain.ts` / `autopilot-ops.ts` / `autopilot-trajectory.ts` |
| 工具面 | `container_admin` 的 **`autopilot` 域**（status / init / generate-bias）⇒ domain enum 收为 `role` / `msm` / `config` |
| 面板面 | 设置面板「Autopilot Trajectory」区块 + 「周期自唤醒」开关（`autopilotWakeEnabled` 与其旧键 `autopilotEnabled`） |
| HTTP | `/serenity/trajectory` 端点**整体退场**（含 POST `action:'wake'` 手动立即唤起） |
| 配置闸 | 全局闸由**两个收为一个**：只剩 `wakeSchedulerEnabled`（缺省**开**） |
| 测试 | 4 份 autopilot 测试（`autopilot-{core,chain,ops,trajectory}.test.ts`） |

### 活下来了什么（**寄居者先救后删**）

| 符号 | 为什么必须活 | 去向 |
|---|---|---|
| `listLiveSessions` / `readSessionTitle` / **精简版** `diagLive` | `acc-diag` ① 段的**独有取数**——"独立进程看不到运行时"正是该工具存在的理由 | 新模块 `src/live-sessions.ts` |
| `TICK_MS` | 其**唯一**消费者是唤醒调度器，与 autopilot 无关 | 内联进 `clock-runtime.ts` |
| `containerClocks().wake` / 唤醒注册表全套 | `wake-later` 链路的基座 | **未动** |

### 🔴 `acc-diag` 段数四→三（二阶裁定 + **缺口登记**）

- **删**：原 ② 面板解析（主语 = 已删的 autopilot 面板区块）、原 ④ 唤起条件链（整段都是 ACC autopilot 的唤起条件）、① 段里 autopilot CCC 的渲染。
- **留**：① live 运行态（原样）/ ①b 唤醒时钟 / ③ 唤醒注册表。
- **已知缺口（登记，本次不补）**：④「**为什么这轮没唤起**」的诊断在 **CCC 自管理链**上**归零**——新链的失败形态（"漏了自排下一轮" / 调度器闸关 / 未 tick）**无可视化病因查询**。一句话可补，代价 = 一条**新**条件链（调度器 armed / 闸 / tick 在跑 / 条目到期 / 补跑窗口 / 目标可解析 / CCC 闸）。

### 硬约束（本次遵守，留作再犯判据）

1. **`wake-later` 链路一行为不动** —— `wake-scheduler.ts` 的改动 = **纯注释**（且把失效引用改指同文件真实存在的 `acquireWakeAgent`）
2. **`trajectory.autopilot` 配置段与 `AutopilotTrajectorySettings` 保留**（`src/ccc.ts` 未改）——工作区侧自管理巡航仍在读它
3. **不留"第二份条件链"**、不留半死的手写版
4. **不改既有断言** —— 反而**加强**：`container-admin.test.ts` 新增两条"已删域不得复活"回归钉；`register.test.ts` 的拆卸登记断言由 `toContain('autopilot')` 改为 **`not.toContain('autopilot')`**

### 兼容性（**破坏性**，但影响面窄）

- **工具面**：`container_admin` 少一个 domain（传 `autopilot` 会被**明确拒绝**，报错列出合法值）
- **设置面板**：「周期自唤醒」开关消失；旧装机存过的 `autopilotWakeEnabled` 被 schema 忽略（无副作用）
- **HTTP**：`/serenity/trajectory` 不再存在（面板区块是它**唯一**消费方，已同批删除）
- **不受影响**：`container_trajectory` 全部 6 动作（尤其 **`wake-later`**）、唤醒注册表、`wakeSchedulerEnabled` 闸、工作区配置段 `trajectory.autopilot`

### 门禁与验收

`typecheck` 双面 ✓ ｜ `test` **89 files / 1301 tests** ✓（基线 92/1419；−3 文件 = 删 4 + 增 1 镜像测试 `live-sessions.test.ts`）｜ `build` ✓ ｜ `pack-check` **105 文件**（基线 111，**−6 可解释**：d.ts 89→86 = −4 删模块 +1 新增；js chunk 18→15）

**部署后验收（2026-09-15，`deploy` + `restart-web` 后实测）**

| 判据 | 结果 |
|---|---|
| ACC 横幅版本 | （待填） |
| `container_admin` **无** `autopilot` 域 | （待填） |
| `acc-diag` 段数（四→三）且不报错 | （待填） |
| `dashboard health` `hostContract` | （待填——判据是 **`issues: []`**，`checked` 数**下降是预期**） |
| 🔴 `container_trajectory wake-later` **实调一次**（基座未被误伤） | （待填） |

---

## v1.34.2 — 2026-09-15（🔧 修 v1.34.1 引入的 `hostContract` 假阴性：**装载时快照 → 每次现探**）

**来源**：v1.34.1 发布后的**运行态验收**抓到（发布纪律 D14：所有者「开始！要发布」⇒ 发布 ⇒ 验收发现 ⇒ 所有者「今晚就发 v1.34.2」）。

### 缺陷：诊断报告把"装载瞬间的观测"冒充成"运行态事实"

- **现象**：`dashboard health` 的 `hostContract` 段由发布前 `checked 40 / issues []` 变成 **`checked 36` + 3 条"服务不可用"**，其中 `sessionController` 那条的后果写着"**冷会话唤醒不可用（只能唤醒已加载的 live 会话）**"。
- **判决性探针（实测，非推理）**：**同一时刻** `GET /serenity/cccs` **正常返回 4 个工作区**（含 3 个**无 live 会话**的冷 CCC）⇒ 被报"不可用"的 `workspaceRegistry` 明明是好的 ⇒ **报告是假阴性**。
- **真因**：v1.34.1 的 C5 把宿主契约探针改成**装载时快照**，而 `apply()` 跑在装载**早期**，表中 `access:'lazy'` 的服务**尚未实例化**（`ctx.get` 返回 `undefined`）⇒ 探针如实记下"此刻看不到"，而快照把这一瞬间**冻结**成了永久结论。
- **被实测证伪的原设计前提**：C5 的理由是"两者对**同一个已装载的宿主**问同一个问题，第二次计算的答案**不可能不同**"。实测给出 36/3 与 40/0 **两个不同答案** ⇒ **它问的是两个时刻**，不是同一问题的重复计算。

### 修法

| # | 变更 |
|---|---|
| 1 | `hostContractReport(ctx, hostVersion)` **退回每次现探**（删除模块级 `snapshot` 与测试用 `__resetHostContractForTest`）——`ctx` 决定"问谁"，**不缓存"答案"** |
| 2 | `index.ts` 的 apply 注释同步纠正（不再是"唯一计算点/读快照"） |
| 3 | 测试：把"钉住快照"的旧用例改写为**"钉住现探"**；**新增缺陷回归钉**——桩中某 lazy 服务"首次取用 undefined、其后可用"，断言**第二次报告必须反映当前可用性**（快照实现下该断言必红） |
| 4 | 保留 C5 的正确部分：**取数口唯一**（`container-status` / `kit-ops` 只问这一个函数），将来要"筛掉装载期噪声"只改这一处 |

### 留档判据（可复用）

> **观察类报告不得缓存"装载瞬间"的观测。** 判据 = **两次取样问的是不是同一个时刻**——若是同一时刻，缓存是省成本；若是两个时刻，缓存就是**把一次观测冒充成事实**。
> 与之配套的探测纪律：**报告的可信度要用"另一个独立通道的实测"来判**（本例 = `/serenity/cccs`，与 health 无关的通道），不要用"代码看起来应该对"来判。

### 门禁与验收

`typecheck` 双面 ✓ ｜ `test` **92 files / 1419 tests** ✓（+1 = 新回归钉）｜ `build` ✓ ｜ `pack-check` ✓（111 文件）。
**部署后验收（2026-09-15 20:5x，`deploy` + `restart-web` 后实测）**：

| 判据 | 结果 |
|---|---|
| ACC 横幅 | ✅ `dsh-serenity-hooks v1.34.2` |
| 🔴 **本版核心判据** | ✅ `dashboard health` 的 `hostContract` = **`checked 40` / `issues []`**（v1.34.1 实测为 `checked 36` + 3 条假阴性）⇒ **假阴性已消除，与本版预期判据逐字相符** |
| `status` | ✅ `healthy`（P1/P2/P3 全过；registry `ok:true issues:[]`） |

### 已知边界（诚实记录，未修）

1. **`apply()` 时的启动告警仍会把 lazy 服务记为缺失**（既有行为，v1.30.7 起）：装载早期的 `console.warn` 里会出现那 3 条 `not available (lazy)`。本轮只修了"它不该外溢到运行态报告"，**未动启动探针的判据**（改它需要引入"未实例化 ≠ 缺失"的中间态，属独立设计）。需要时可按同样方式复探。
2. 缺陷**只在运行态验收阶段被抓到**——`test` 全绿也没能发现它，因为旧用例**恰好把错误语义钉成了期望**（"不再触发探针"）。⇒ 教训：**测试钉住的可能是设计者的假设，而不是事实**；跨过发布链、到真实运行态取一次证，仍不可省。

---

## v1.34.1 — 2026-09-15（🔍 构件关系复审七步：废 SEP · 发现面归一 · 对外面宿主 · autopilot 脚本退场 · 时钟引擎 P2）

**Scope:** 用户给的一把尺子 —— 「**能落 harness 已有原语（skill / `ctx.skills` / settings / session 事件 / 文件标记）就不要自造协议 + 脚本管道**」，病灶形态 =「ACC 定义协议 → CCC 写脚本 → ACC 在生命周期点 spawn 它」。照它把 ACC 内部构件关系复审一遍（讨论稿 `docs/acc-component-relations-review.md`；现状说明 `docs/acc-component-relations-current-state.md`），九条裁决（Q1~Q9）后实施七步。**性质以"收敛与修复"为主**，唯一新增能力 = 轨迹声明 skill（①）。

> **判据升为明面判据（Q1）**：**能落 harness 已有原语 ⇔ 不自造协议**。发布纪律 D14（用户显式下令）+ 时序条件（用户「**等回家再发布**」——发布链含 deploy/restart-web，会打断在跑会话）。

### ① 废除 SEP ⇒ 轨迹在 `SESSION.md` 里声明 skill（C1）

**旧机制（整体废除）**：SEP（session-extension protocol）——ACC 定义一套「`session-tool` 脚本钩子」协议，CCC 写脚本，ACC 在会话生命周期点 `spawn`。本机**实测零采用**，形态正是尺子点名的病灶。

**新机制**：轨迹在 `SESSION.md` 顶部 frontmatter 声明

```yaml
skills: [some-skill, another-skill]
```

⇒ 该轨迹**被绑定期间**，每个请求按 **section** 注入其 `SKILL.md` 全文（**a2 形态**：内容**每轮重读绑定**，不是一次性灌入）。

**契约（真相源 `docs/trajectory-skill-injection.md`）**：

| 约束 | 内容 |
|---|---|
| 取路径 | **只用 `readLastBound(session).mdPath`**；**禁止**用显示 label 反查（那是模糊匹配） |
| 🔒 安全 | skill 名来自 **CCC 数据** ⇒ **必须先过 `isSafeSkillName(name)`**（**路径穿越守卫**）；不安全 ⇒ 按缺失处理且**不发生任何以该名拼出的 fs 访问**（测试用强断言：`h.fs` 为空） |
| 长度 | `TRAJECTORY_SKILLS_MAX_CHARS = 32 KB`（**复用**既有 `truncateContent`，不自造） |
| 查找顺序 | `.dsh/skills` 优先 → `.opencode/skills`（解析失败**不静默**：响亮提示 + `[缺失]` 锚点） |
| Skiff | 角色**不注入**（两处注册点均在 skiff 早退之后） |

**keeper 护栏**：两条 compaction 提醒文案（普通 / escalated）均加「**保留文件顶部 YAML frontmatter 原样**」——把"compaction 重写 SESSION.md 抹掉 frontmatter"的风险，从**纯纪律依赖**变为"在**唯一会重写该文件的时刻**提醒"。

**回归钉（两类都钉）**：**符号级**（`discoverCccHooks` / `buildExtHint` / `buildSepGuide` / `create-transform` / `findFlagByName` / `sessionExtension` 全 **0 命中**）＋ **散文级**（`session-extension` 在 `src/**` 命中 **0**）。⇒ 教训入册：**符号级回归钉挡不住散文级残留**（本轮抓到两处：**面向模型的 toolsBlock 文案**仍写"dev manual also carries the session-extension protocol"、客户端注释里的过期函数名）。

### ② CCC 发现面归一（C2）

现状：**src/ 内 19 处 + 范围外 1 处**各自解析"会话归哪个 CCC"，算法真正不同的约 **16 种**；`agentCwd + findSerenityRoot` 同一份代码**复制 10 份**（10 个工具入口）。

- **新模块 `src/ccc-roots.ts`** = `listCccs(ctx, {defaultRoot, withRoles})`（**并集**语义）+ `agentCwdFor` + `cccRootForExec` + `cccRootForCwd`；**L0 原语 `findSerenityRoot` 留在 `ccc.ts` 不动**（它本来就只有一处、53 个调用点）。
- 🔴 **短路 → 并集**：旧 `discoverCccs` 三层（`workspaceRegistry` → `sessionPersistence` → live）以 `if (roots.length === 0)` **短路** ⇒ 第一层给出任意一条则后两层不跑 ⇒ **名单可能不全**。改为**三层都跑、按 root 去重保序**。
- **修掉 v1.34.0 记录在案的边界 #1**：「**完全冷掉的 CCC 不能自唤醒自己**」——枚举源改用 **DSH 已有的持久来源**（不新增名单、不扫盘、不写路径假设），**关着浏览器也能到点执行**。
- **删除 Skiff 的 ~93 行退避重试**（`SKIFF_ROOT_RETRY` / `scheduleRootRetry` / 定时器）——根能直接问到，就不必重试；**保住**反应式再触发（`agent/session-start` / `session/created` / `settings-changed`）与 **EADDRINUSE 不变量**（`starting = true` 置于首个 `await` 之前）。
- **武装门不回退**：`startTimer` 仍**只判全局闸**（"闸开即武装"），"无 CCC 可扫"下沉为 tick 内廉价判定并写 `lastSkipReason`（可观测）。
- 顺带：`readCccName` 的两个同名不同算法版本（一处跳注释、一处整文件 trim，**含注释时静默失配**）收口。

### ③ 对外面归一（C4）+ 观察面归一（C5）

**C4 —— 5 个对外面 → 1 个"面宿主"**：新增 `src/face-host.ts`（`startFace` / `faceEnabled` / `stopFace` / `stopAllFaces` / `faceActive` / `facePort`）+ `src/ports.ts`（集中端口表，**`MECHANISM_PORTS` 由端口表机械派生**）。

- 🔴 **顺带修一个真实缺陷**：输出守卫的机制端口词表**漏了 3082**（微信发送面）⇒ 派生后"**新增面即自动进词表**"，漂移面消失。
- **A↔C 解耦显式保留**（`weixin-send-api.ts` 头注记明：3081 会原样反代含请求头 ⇒ 若把 3082 挂到 A 上，已登录的家庭成员号可冒充 bot）⇒ **面宿主只共享生命周期，绝不合并路由 / 监听器 / 鉴权**。
- **拆卸归一**：删 `gateway.ts` / `weixin-send-api.ts` 两处自带 disposer ⇒ 只剩 `seams/lifecycle.ts` **一个挂点**（`stopAllFaces()`）。
- **`unref` 逐字恢复**：C4 曾丢掉 3082 listener 的 `server.unref()`（未 unref 的 listener 会让宿主以一次性命令运行时**进程挂住不退出**）⇒ `FaceSpec` 加**可选** `unref?: boolean`，**仅微信发送面传 `true`**（其余三面 C4 前本就没有，属越界变更，**不改**）。
- `api.ts` 9 处 `x-serenity-ui` 内联检查归一为 `requireWebUi`。

**C5 —— 10 个渲染点 → 1 个容器状态模型 + 薄渲染**：新增 `src/container-status.ts` 作为**取数唯一出口**。

- 复核修正：11 行重叠矩阵里 **1 行真重复**（`probeHostContract` ×2）+ **1 行已被 C2 消掉**，其余 9 行是"**同一判据的多个渲染点**"（判据层本就单源）⇒ **不为凑数制造改动**。
- **`dashboard health` 的 wire 输出逐字不变**（逐行比对字段名/取值/出现条件/三条 detail 文案）；**两条 registry 判据仍各自具名、不合并**（结构完整性 ≠ DC-M1~M4 质量）。
- ⚠️ **一处真实语义变更（显式接受）**：`probeHostContract` 两算收敛为一算 ⇒ health 段读 **apply 时捕获的快照**，不再每次现探 ⇒ **宿主在 apply 之后才补挂的服务，health 不再察觉**（判据：那些是宿主核心服务、在插件装载前注册；需要当场真探时该函数仍可调）。
  - 🔴 **本版发布后实测推翻该判断**：实际危害不止"察觉不到新服务"，而是**把装载瞬间尚未实例化的 `lazy` 服务记成"缺失"** ⇒ health 渲染出**假阴性**（`workspaceRegistry` 被报不可用，而同一时刻 `/serenity/cccs` 正常返回 4 个工作区）。**已在 v1.34.2 回退为"每次现探"**——完整诊断与判据见 v1.34.2 条目。

### ④ autopilot 脚本退场（C6a）

**病根诊断**（用户一问定案：「它是给我们自己的工具，还是发给 CCC 的机制」）：那个独立脚本 `experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts` **两面都挂**——`container_admin autopilot` 的 `status`/`init`/`generate-bias` **三动作逻辑全在它里面**（插件只转发）且**随 npm 包分发**，却**住在 `experiments/`、零测试、不在门禁内**。⇒ **一个被当作机制使用、却没按机制维护的东西**，正是"报告印假 ✅"的土壤。

**处置（拆两半，退掉独立脚本）**：

| 半 | 内容 | 去处 |
|---|---|---|
| 机制那半 | 写配置 / 状态报告 / 跑偏见脚本 | **进插件进程**（`src/autopilot-core.ts` 零 DSH 判据层 + `src/autopilot-chain.ts` 条件链唯一实现 + `src/autopilot-ops.ts` 三动作） |
| 我们那半 | 完整条件链 / 深层诊断 | **留开发面**（`dsh-develop diag`），**判据只写一份**——它**动态 import 插件 src 的同一份 `autopilot-chain`**，不另写"文件读取版" |

- **8 项结构性分歧一次全消**（缺判据 4：**全局闸** / **live 会话** / **agent 可解析性** / **重入守卫**；表达式不同 4：目标会话选择 / 间隔下界（统一 `MIN_INTERVAL_HOURS = 0.01` = tick 同源）/ bias 运行参数 / 结论口径）。
- **额外收益**：`status` 首次把**进程态**（全局闸 / 时钟是否武装 / tick 次数 / 上次 tick / 上次跳过原因）带进 CCC 工具面——"时钟没武装时条件再全绿也不唤起"这层此前不可见。
- **删除**：`src/autopilot-script.ts`（转发层，79 行）+ `experiments/.../scripts/autopilot-trajectory.ts`（588 行）；`package.json` `files` 相应去两行；`SKILL.md` 改为纯文档形态。

### ⑤ 时钟引擎 P2（C6b）

两条时钟抽出**一份共用运行时** `src/clock-runtime.ts`（**各持自己的定时器**）——**选 P2 不选 P1** 的理由：autopilot 每轮要跑 CCC 偏见脚本、**可能阻塞数十秒**，共用"排队执行链"会让另一条一起卡住。

- 🔴 **硬约束写进代码**：**每实例私有**的执行链（`InstanceState.chain`）——"若把 chain 提到模块级省一次分配，**隔离即刻失效——不许**"；武装门**只判全局闸**；**两条闸必须继续分开传**（两闸解耦语义与既有回归钉不动）；可观测字段一个不丢（`acc-diag` ①b / `containerClocks` 照读）。
- 🔴 **顺带修掉一个既有缺陷（可直接感知）**：旧实现把**事件接线**放在 `startTimer` **末尾**，而 autopilot 闸**缺省关**（= 当前配置）⇒ 启动时走不到那步 ⇒ **事件从未挂上** ⇒ **面板把闸打开后，不重启不生效**。工厂把接线提到**闸判定之前**（只挂一次，`reset()` 复位），理由写进源码：「事件是唤醒这条钟的**唯一入口**，它的存在不该依赖某一刻的闸值」。
- **诚实记录**：净行数 **−99**（约 62%），**未达估算的 −160**——P2 的估值按"两钟样板全删"算，实际必须留下工厂真实逻辑 ~167 行 + 每条语义差的**显式表达**（`begin`/`bodyCountsTick`/`logFrom`/`events`/`startLog`/`onDispose`/`onReset`）。**当初"省 ~160 行"这个决策输入是乐观的**，记此以免未来用同一估值做决策。

### ⑥ 死件清理（C3）

机械"零引用导出"扫描（95 文件 / 810 导出行 ⇒ ALIVE 390｜TEST-ONLY 202｜DEAD 216｜EXTERNAL-ENTRY 2）后**分类处置**：

- **真孤儿 20 条**：删声明（含 `__resetBrokenConfigWarningsForTest` / `HANDYMAN_MAX_ROUNDS` / `isReadTool` / `JsonRpcNotification` / `skiffSessionActiveFor` / `PraxisSection` / `TrajectoryStyle` 等）。
- **自用型 ~190 条**：**只删 `export` 关键字**（删声明会编译失败——它们只在定义文件内自用）。
- **三个死工具对象**：`tools/{cce,eap,neat}Tool`（v1.30 三合一成 `praxis` 时的遗留）⇒ **删对象、留内容模块**（`praxis.ts` 仍在 import 它们的 `*_CONTENT`——**内容模块是活的**）。
- ⚠️ **方法局限（留档）**：动态 `await import()` 是静态图盲区（`session-cleanup` 一度被误判为死模块）⇒ 任何"零引用即删"的工具化方案（knip 等）**须先处理该盲区**。

### ⑦ 顺带修复与清理

- 🔴 **`autopilot status` 假满足缺陷**：判决行只统计 `✗`，把 `⏸`（间隔未到 / 高峰避开）排除在阻断外 ⇒ **每天北京 8–18 点（10 小时）都印「✅ 唤起条件全部满足」而插件实际不唤起**。修法 = 抽出 `judgeWake()` 单一判据（`diagCcc` 与 `status` 共用）＋**判决三类分档**：`✗`（需人改）/ `⏸`（等待中）/ **`?`（不可知——新增）**，**只有三者皆空才印 ✅** ⇒ 离线通道**按构造不可能印假 ✅**（结构消灭，非措辞修补）。文案纠错 `10min` → **`5min`**（对齐 `TICK_MS`）。
- **`.gitignore` 无锚点误伤**：第 18 行 `scripts/`（原意 = 仓库根的开发工具目录）**连带藏住了一个随包分发的机制实现**（同一条规则命中 `hooks/.../experiments/autopilot-trajectory/scripts/`）⇒ 锚定为 **`/scripts/`**，**双向实测**（随包脚本不再被忽略、仓库根 `scripts/` 仍被忽略）。
- **旧机制措辞残留**：`skiff-admin.ts` 的 SEP 类比改写为直述三动作分工；`SkiffCccEntry` 别名删除（"一个类型两个名字"与 C2"收成一个出口"相悖）；客户端注释里的过期函数名改为 `listCccs`。
- `experiments/autopilot-trajectory/scripts/` **退化为空目录** ⇒ 清理。

### 门禁与验收

`typecheck` 双面 ✓ ｜ `test` **92 files / 1418 tests** ✓（**并发/端口类改动 5 连跑全绿**，零 EADDRINUSE）｜ `build` ✓ ｜ `pack-check` ✓（**111 文件**，js 18 / d.ts 89）｜ `readme-sync` ✓（发布链内）。

### 实测验收（部署后，2026-09-15 20:13~20:45 本机真实 web 进程）

| 项 | 结果 |
|---|---|
| ACC 横幅 | ✅ `dsh-serenity-hooks v1.34.1`（判据取**工具名与提示串**，不取 version 字段） |
| `container_trajectory list` | ✅ 可调，且**末尾 SEP 提示已消失**（① 的废除在运行态可见） |
| `acc-diag` | ✅ 四段齐 + ①b 两时钟态（调度器 armed=true / autopilot armed=false） |
| `container_admin autopilot status` | ✅ **走进程内**——出现「**进程态（本插件进程）**：全局闸 / 时钟已武装 / tick 次数 / 上次 tick / 本轮唤起进行中」（**旧独立脚本按构造看不到这层**）；判决三类分档、无假 ✅（④） |
| **C2 并集语义（端到端）** | ✅ `GET /serenity/cccs` 返回 **4 个 CCC**，含 **3 个无 live 会话的冷 CCC**——旧 live-only 枚举给不出（② 的目标达成） |
| `dashboard health` | 🟡 `healthy`，但 `hostContract` 出现**假阴性** ⇒ 已定位，**v1.34.2 修**（见下条） |
| ❌ **未验** | ① 的**注入端到端**（需某条轨迹真的声明 `skills:`，本机未声明）；⑤ 四面**未做端到端冒烟**；`acc-diag` ① 的 autopilot CCC 列表仍 live-only（既有开放项，非本版回归） |

### 已知边界（诚实记录，未修）

1. **本版"新旧等价"是"既有回归钉全绿 + 逐行阅读"，不是端到端差分**：无新旧输出对照测试；C2/C4/C5 的 HTTP 面等价性在部署后按冒烟补验（见本次发布的验收记录）。
2. **`AutopilotClockRuntime` 保留为 `type = ClockRuntime` 且零外部引用** ⇒ 留待后续死件清理裁决（本轮 C3 扫描在 C6b **之前**跑，故未覆盖它）。
3. **仓库根 `scripts/` 目录仍未版本化**（`/scripts/` 规则原意）；本轮只修了"无锚点误伤"，**开发面工具本身是否入库仍待裁**。
4. **`container_admin autopilot` 的间隔下界取 `0.01`**（= tick 同源）；开发面 `diag` 与进程内共用同一判据，故不再有分歧。
5. **`probeHostContract` 语义变更**（见 ③）——health 读 apply 时快照。→ **已在 v1.34.2 修复并回退为每次现探**。
6. **3082 面被占用时仍会晚 ~10s 才告警**（缺省重试 10×1s）：失败形态只是**告警延迟**、无数据损失 ⇒ 在**实测到危害前不调参**。

---

## v1.34.0 — 2026-09-15（🧩 工具面收敛与更名：`logbook` 并入 **`container_trajectory`** + 专属工具 `acc-diag` + 时钟可观测面 + 两闸解耦）

**Scope:** 三条独立裁决合批发布（发布纪律 D14；用户 2026-09-15「同意，发布」）：

- **§32 工具面合并**（用户「我觉得 logbook 应该和 trajectory 合并了，顺手讨论下方案吧」+ 四轮逐条拍板）：**`logbook` 一词废止**，动作 **23 → 6**；
- **§33/§34 时钟静默事件**（用户「是因为我把 auto-trajectory 关了调度器不工作吗？」⇒ 真因**就是全局闸被关**，非重启、非 live 为空）：新增**时钟可观测面** + 收窄武装门 + **两闸解耦**（S-1）；
- **§35 H 段更名**（用户「**名称改称 `trajectory` 是准确性调整**——它是我们容器内的机制……**specs 也在本 trajectory 改**；**osp 不管**」）：工具名与实现文件名硬切为 **`container_trajectory`**。

### ① 工具面合并：`logbook` + `trajectory` → 单一 **`trajectory`**（动作 23 → 6）

两个工具本是**同一主语的两个侧面**（载体生命周期 vs 时间轴），且**事实上已耦合**（`logbook use` 写 `.bindings.json`，而唤醒定位正是读它）。合并后由**同一 owner** 显式承担。工具面 **11 → 10**（沿 D46「工具面越小执行越好」），**硬切无别名**。

| 保留（6） | 说明 |
|---|---|
| `list` | 轨迹清单 **+ 统计 + 异常标注**（原 `summary` 并入） |
| `show` | 读**单条** SESSION.md 正文 |
| `create` | 新建轨迹（`--desc` / `--issue` 二选一 + `--summary`） |
| `use` | 激活 + **内联完整性检查**（目标存在？SESSION.md 在？长期无活动？——**通过静默、不通过提示，不阻断**） |
| `rebuild` | 原地清空重建（Ship of Theseus；**keeper 依赖它**） |
| `wake-later` | 未来时刻 + 一条 message（可唤醒任一轨迹，含自己）；fire-and-forget |

**淘汰/并入**：`close`·`archive` 删（`completed` 本就从 SESSION.md 的 `[x]` 推导；归档能力由 `container_fs mv → _archived/` 承担）｜`health`·`qa` → `use`（**判据升级**：`qa` 拿旧六节模板当判据、`health` 数勾选框完成率与关键词频次——其判据已被 ACC 层的 **EAP** 取代，属**双重标准**，故淘汰；只把**不依赖模板**的"空壳 / 长期无活动"并入 `use`）｜`summary` → `list`｜`hook-develop-guide` → **`container_admin msm guide`**（SEP 的本质就是"注册一个 `session-tool` MSM"）｜`wake-add`/`wake-list`/`wake-rm` → **`wake-later`**（**不可回收、不做面板**，用户明示接受）

**⚠️ 代价（显式接受）**：删 `wake-rm` ⇒ D60 的三条替代控制只剩「可审计（文件随 CCC git 可读）」+「不打断在跑轮次」，**写入即不可撤回**。

### ② autopilot 面归机务舱：`container_admin autopilot`

`status`（原 `trajectory all` 一站式报告）｜`init` ｜`generate-bias`（原 `random`）——**周期自唤醒是"容器运维"，主语是容器不是轨迹**。原 `doc`/`check`/`status`/`guide` 四个"给我看文档"的动作并入 `status`；`diag`/`diag-live` 下沉为**开发面**能力（`dsh-develop diag`）+ **运行态专属工具**（见 ③）。

### ③ 专属工具 `acc-diag` + **`exclusiveTools`** 机制（新，通用）

- **机制**：ACC 注册该工具但**默认对所有 CCC 隐藏**；只有在自己 `.opencode/serenity.json` 的 `exclusiveTools` 里**逐字点名**的 CCC 可见。复用既有**条件可见**通道（`tools.restrict` 按工具名从 **schema 移除**，不是"看得到但被拒"）。**归属判据（D23）**：机制通用在 ACC、声明具体在 CCC——**ACC 代码里不出现任何具体 CCC 的名字**。
- **失败方向 fail-closed**：未配置 / 字段缺失 / JSON 损坏 ⇒ 一律按"未声明"处理（保持隐藏）。与 `im-bridge` **相反**——隐藏一个**已在使用**的通道才会静默损害能力，而专属工具的默认态本就是隐藏。
- **内容（一次调用即全报告，无动作参数）**：① live 运行态（live 会话清单 + autopilot 目标定位与诊断）**＋ ①b 两个时钟态**（见 ④）｜② 面板解析落在哪个 CCC｜③ 唤醒注册表条目与补跑窗口｜④ 唤起条件链（"为什么这轮没被唤起"逐条件 + 阻断点 + 修复建议）。
- **为何必须是独立工具**（不能做成 `container_admin` 的一个域）：`tools.restrict` 是**工具级** deny，无域级粒度——做成域就只能连 `role`/`msm`/`config` 一起隐藏。

### ④ 时钟可观测面 + 武装门收窄（**⚠️ 措辞纪律见下**）

**背景（真因，含一次公开的归因更正）**：用户报"时钟静默 6.6 小时"时，我**先**把零 tick 归因为"武装闩锁"，**没有先读一次闸值**就写下了根因；用户提问"是因为我把 auto-trajectory 关了吗"后实测才确证——**全局闸 = false、armed = false、tick = 0（从未）**。⇒ 纪律强化「**探针必须先做正控**」（现象与机制之间必须有一次实测，不得用机制解释替代实证）。

- **新增可观测面**：`wakeSchedulerState()` / `autopilotClockState()` → `acc-diag` **①b 两行**（armed / armedAt / 全局闸 / tick 次数 / 上次 tick / **上次跳过原因**）。它一眼分开"闸关"与"未武装"——**这两者过去在报告里同形**，正是误判的土壤。
- **武装门收窄**：原 `startTimer()` 有两道门（全局闸 + 「至少一个 live CCC」），而 CCC 根**只能**从 live 会话 cwd 反推 ⇒ **宿主刚重启时 live 必为空 ⇒ 时钟根本不武装**；且 `session/created` **不覆盖"浏览器恢复旧会话"**，靠事件补挂有洞。⇒ 改为「**全局闸开即武装**」，"有无 live CCC"降级为 **tick 内的廉价判定**（代价 = 一个 unref 的 5min 空检查）。
- **🔴 措辞纪律（诚实记录）**：本轮**并未观测到**武装闩锁的真实触发实例（证据等级 = **仅静态**：代码路径 + 事件语义）。**本条不得写成"修复了一次线上故障"**；事实是 ① 新增了当时缺失的可观测面 ② 把静态发现的缺口一并收窄。

### ⑤ 两闸解耦与更名（S-1，用户「只关闭 auto-trajectory 唤醒 + 名字也改合适」）

原 `wakeSchedulerEnabled()` 的判据是 `trajectoryEnabled === true || autopilotEnabled === true` ⇒ **关掉周期自唤醒会连带关掉一次性唤醒**（"跨轨迹预约未来时刻"与"周期自唤醒"绑在同一开关上）。解耦：

| 旧名 | 新名 | 语义 |
|---|---|---|
| `autopilotEnabled` | **`autopilotWakeEnabled`** | **周期**自唤醒闸（**缺省关**）；迁移期 `?? autopilotEnabled`（**`??` 不是 `\|\|`**——新键显式 `false` 必须能覆盖旧键 `true`） |
| `trajectoryEnabled` | **`wakeSchedulerEnabled`** | 唤醒**调度器**闸（**缺省开**，**无** autopilot 回退）——达到"关周期自唤醒不再连带关 wake-later" |

面板拆两行（「周期自唤醒（autopilot）」/「唤醒调度器（wake-later）」），详情写明**互不连带**。（踩坑留档：schemastery **没有 `.optional()`**，表达"未设"用 `.required(false)`。）

### ⑥ 工具名与实现文件名硬切：`trajectory` → **`container_trajectory`**（H 段 / D61）

**性质 = 准确性调整**（不是"改名让它更像一等公民"）：`container_` 前缀表**作用域（在本容器内）**，**不表**"与容器平级"——**D58「trajectory 是一等概念」地位不变**。⇒ 由此得到**可复用命名判据**：

> **`container_<X>` = 掌管本容器自身之 X 的工具**（`container_fs` / `container_git` / `container_trajectory` / `container_admin`）。
> 出处（一手，早于本次）：specs `docs/acc-story.md:222`「命名继承背景：`cc_xx` → `container_xx`」。

同一批清**内部实现文件名的债**（形态 B）：`tools/session.ts` → `tools/trajectory.ts`｜`session-ops.ts` → `trajectory-ops.ts`｜`session-bound.ts` → `trajectory-bound.ts`（⚠️ `session-cleanup.ts` **不动**——它的主语是 DSH 会话，不是轨迹）。**三层名字只改后两层**：概念词（trajectory / The Ship's Log / Ship of Theseus）**不动**。

**🔴 同批硬约束（不同批 = 静默失效）**：`tools.restrict` 按**工具名字符串**匹配 ⇒ CCC 侧 skiff 角色白名单（`.opencode/serenity.json` + 角色提示词）**必须与 ACC 同批改**，否则角色**静默失去该工具**（不留任何报错）。过渡窗口内可双列新旧名；部署验证通过后须删旧名。

### ⑦ 顺带修复

- **`dsh.plugin.json` 声明面失真**：`contributes.tools` 列了 **12** 项且 `trajectory` **重复两次**；`package.json` 描述清单含**已废除的 `logbook`** 且**缺 `acc-diag`**——而两处 description 都自称"11 个工具"。⇒ 按真实 11 项与 `REGISTERED_TOOLS` **同序**改写（三处一致）。
- **README 对照表左列笔误**：osp/dsp 双运行时对照表的**左列（osp）**写着 `trajectory`（osp 契约面是 `logbook`）⇒ 改为 `logbook`。
- **`logbook` 残留扫尾**：非历史表述改净（含 keeper 函数名 `logbookCompactionReminderText` → `trajectoryCompactionReminderText`、两条运行时 console 文案、LLM 可见的 SEP 提示串）；**13 处显式历史陈述有意保留**（带版本归属的沿革句）。

### 门禁与验收

`typecheck` 双面 ✓ ｜ `test` **83 files / 1250 tests** ✓ ｜ `build` ✓（lib 204658 B）｜ `pack-check` ✓（**101 文件**）｜ `readme-sync` ✓。
**实测验收（本机真实 web 进程，dev 部署后）**：

- **工具名生效**：`container_trajectory show S142` 调用成功（旧名已不注册）——**判据取"能否调用"，不取版本号**（`accVersion` 在发布前必然滞后）；
- **`acc-diag` 四段齐** + **①b 两个时钟态**：唤醒调度器 `armed=true`（**缺省开、零 live 会话也武装**——重启瞬间即 armed，首次 tick 留痕"无 live 会话 ⇒ 无 CCC 可扫"）｜autopilot 时钟 `armed=false`（所有者关着）⇒ **两线各归各**；
- `dashboard health` = healthy；registry `ok:true issues:[]`；`hostContract` **checked:40 / ok:true / issues:[]**；
- **唤醒注册表端到端**（v1.32.0 已验、本版沿用）：**热路径** `live(bound …)` ✓｜**冷路径** `cold-resume(…)` ✓（冷会话经 `sessionController.resolveAgent` 载入并投递）。

### 已知边界（诚实记录，未修）

1. **完全冷掉的 CCC 不能自唤醒自己**（v1.32.0 起记录，本版**只收窄了武装门、未修发现面**）：调度器仍只遍历**至少有一个 live 会话**的 CCC（CCC 根由 live 会话 cwd 反推）⇒ 整机无人打开任何会话时，到期条目停在 `pending`（超 2h 补跑窗后置 `missed`）。候选改进 = 持久化"已知 CCC 根"。
2. **唤醒不可回收**：`wake-rm` 已删（见 ① 代价）；目前只能等它到期，或人工改 `wake-registry.json`。
3. **闸关期间滞留条目**：终局由"是否超 2h 补跑窗"决定（`delivered` / `missed`）；是否要为闸关引入 `paused` 态**待裁决**。
4. **`use` 的内联检查只做"可用性/完整性"三项**，**不做格式合规检查**——格式归 EAP 与 skill，**不归工具**（这是 ① 淘汰 `qa` 的同一判据）。

---

## v1.32.0 — 2026-09-14（⏰ trajectory 升为一等概念：`autopilot-trajectory` → `trajectory` + **唤醒注册中心**）

**Scope:** 用户需求「dsp 需要一个**定时唤醒某个会话自动继续**的机制，应当是个**唤醒注册中心**，只支持按未来时刻唤醒，精度不需要很高；用于支撑 **trajectory 在时间的轴上自由地安排自己**」（S142 §30）。侦察后按三条裁决落地：**D58**（trajectory 是本体、autopilot 只是"周期自唤醒"的特例）｜**D59**（autopilot 保持独立单例循环，不进注册表）｜**D60**（注册表不设资格栅）。**协作边界（用户原话的推论）**：所有 trajectory 互相可见，但唤醒**只能是"可预期的未来时刻 + 一条信息"**——**无阻塞、无等待、无回执**（fire-and-forget）。

### ① 工具更名：`autopilot-trajectory` → **`trajectory`**（硬切，无别名）

概念层级修正——**trajectory 是一等概念**（`CCC 内允许多个 trajectory 任意形态并行`），autopilot 降为它的一个特例。随 v1.30 工具面重构的同一原则（D46 ⑨）：**硬切无别名**，旧名不再注册。内部文件名（`src/autopilot-trajectory.ts`）按既有原则**不改**。

### ② 唤醒注册中心（新增能力）

- **落点**：CCC 内 `AGENT_SESSIONS/wake-registry.json`（随 CCC git，人可读可审计；与 `.bindings.json` 同居）
- **条目 = 未来时刻 + 一条 message**：可对自己预约，也可**唤醒别的 trajectory**（任一 CCC）
- **工具动作**：`trajectory wake-add --target <S###|目录名> --at <RFC3339|+30m|+2h> --message <正文>` / `wake-list` / `wake-rm <id>`
- **中心调度器**：5min tick，扫各 CCC 注册表 → 到期投递；**同 tick 串行**、**同全局闸**
- **时间轴语义**：5min 精度｜**≤2h 补跑窗口**（停机期间到期且迟到未超窗 → 补投；超窗 → `missed` 留痕）｜一次性（投递即终结，不重投）｜**维持 live**（人类可介入）｜**不打断在跑轮次**（`followup` 排队，跑着的在下一步边界消化）

### ③ 冷唤醒：`ctx.sessionController.resolveAgent`（宿主正门，不自行复刻 preset 恢复）

投递路径：target → 目录名 + SESSION.md →（`.bindings.json` 值侧反查）dsh 会话 id（**live 优先** `agents.get`）→ 未加载则 `sessionController.resolveAgent(id)`（宿主实现：live 优先 + resume 去重 + 由会话元数据恢复 preset）→ `followup(message)` 投递。**`sessionController` 缺席（headless profile）⇒ 降级为「仅 live 投递」并响亮诊断——不得静默**。契约登记 `hostContract` **38 → 40 项**（一条 `HOST_SERVICES` 条目 = 1 个服务存在性检查 + 1 个成员检查，`required=false`）。

### ④ 配置与端点更名（旧键保留回退读）

CCC 键 `autopilotTrajectory` → **`trajectory.autopilot`**（旧键 `autopilotTrajectory` / `autotrajectory` 逐级回退）｜插件全局开关 `autopilotEnabled` → **`trajectoryEnabled`**（旧键回退，**改动才发版**的全局面）｜状态端点 `/serenity/autopilot-trajectory` → **`/serenity/trajectory`**（GET 响应新增 `wakes`，面板只读块展示在办/总数）。

### ⑤ 审计字段缺陷修复（^ 本轮实测发现）

`wake-add` 的 `createdBy` 原取**全局** `lastActive` 指针（= 进程内最近被激活的 trajectory），与调用者无关 ⇒ 实测 **S142 登记被误记为 `S060`**（那是**另一个 CCC** pangu-serenity 的 autopilot 轨迹）——**误归因跨了 CCC 边界**。D60 用「可审计」替代入口栅 ⇒ 审计失真即替代控制失效。**修复**：`session-bound.ts` 新增 `resolveSessionTrajectoryLabel(session, scope)`——**持久 bound（权威）→ 本会话内存激活 → 全局指针仅兜底**；5 条回归用例钉住"以调用方自己为准"。

### 门禁与验收

`typecheck` 双面 ✓ ｜ `test` **82 files / 1218 tests** ✓ ｜ `build` ✓ ｜ `pack-check` ✓（98 文件，含 `wake-registry.d.ts` / `wake-scheduler.d.ts`）｜`dashboard health` hostContract `checked:40 / ok:true / issues:[]`。
**实测验收（本机真实 web 进程）**：**④** `sessionController` 可达 ✓｜**⑥ 热路径** 自唤醒条目 `w-20260913-1616-1c06` → `delivered` + `lastResult = live(bound session-b98276fe…)` + **唤醒正文确实开启了一轮** ✓。

### 已知边界（诚实记录，未修）

调度器**只扫「该 CCC 至少有一个 live 会话」的 CCC**（`collectLiveCccs` 由 live 会话 cwd 反推 CCC 根）⇒ **完全冷掉的 CCC 不能自唤醒自己**（宿主重启后无人打开任何会话时，到期条目停在 `pending`）。与"未打开 WebUI 也能到点自续"有张力。候选改进：持久化"已知 CCC 根"，使扫描不依赖 live 会话。

---

## v1.31.13 — 2026-09-11（🔴 会话打不开真因修复：`rebuild` 写坏 `user/message` + `findSessionLog` 不认世代文件）

**Scope:** 用户报「DSH 升级 session 机制后**会话老是损坏**」并要求"查明是否 dsp 实现有问题"（S142 §24~§26）。调查结论：**确有两条 dsp 缺陷**——其一足以让会话**永久打不开**。本版修复两条 + 交付常备诊断工具。

### ① 头号缺陷（🔴 数据可用性）：`rebuild` 写入的 `user/message` 不是完整消息

**宿主规则**（`dsh-session/lib/types/index.js:229-259` `assertMessageEventShape`）：四种消息事件
（`system/message` / `user/message` / `assistant/message` / `tool/result`）的 payload 必须是**完整消息**——
`data.id` 非空字符串（否则 `"<subject> lacks an identified message"`）+ `data.role` 等于该事件的固定角色。
**`user/message` 的 message 就是 `data` 本身**（不是 `data.message`）。

**旧实现**（`src/rebuild.ts`）：`session.append('user/message', { content, source } as never, …)` —— **缺 `id` 与 `role`**。

**后果链（为何"下次打开才坏"）**：`append` 路径**不跑**含 shape 校验的 `validateStoredEvents`
⇒ 事件**当场落盘成功**；等**下一次打开该会话**才整份校验 → 抛 `SessionPersistenceCorruptionError`
→ **该会话永久打不开**。这解释了"重建后用着没事、重启/再进入就损坏"的时序。

**实证**（真实日志，非推理）：会话 `session-a6cbf9c4-…`（v3，7333 事件）在宿主读取路径下报
`session event at seq 5066 lacks an identified message`；解压原日志取 seq 5066 得
`{"type":"user/message",…,"data":{"content":[…],"source":{"kind":"user"}}}`（**无 id/role**），
而**同一日志内**由本插件 `bootstrap` 路径写入的消息 seq 15/26 形状完整（`{id, role:'user', content, source}`）
⇒ 对照成立：**bootstrap 写对了，rebuild 写漏了**（形状照 `seams/bootstrap.ts` 抄即可）。

**修复**：payload 补 `id`（每轮唯一）+ `role: 'user'`；`tests/rebuild.test.ts` 新增回归用例，把宿主规则的
**字面要求**（id 非空串 / role='user' / source.kind / content 为数组 + id 唯一性）钉在 dsp 产物上。

> **`as never` 是共同病灶**：本缺陷与 v1.31.8 的 `surfaceOp: {start,end}` → `{startSeq,endSeq}` 同属
> "**`as never` 让编译器失明**"一类。纪律：**写 session 事件的 payload 一律给完整形状**，并用宿主规则
> 的字面要求写回归断言。

### ② `findSessionLog()` 不认世代文件（清理静默失效）

宿主自 0.1.5 起**按世代写文件**（`session.v3.jsonl.zstd`），且迁移**保留 v0 源文件** ⇒ 同一会话常见
两代并存。旧 `findSessionLog()` 只认 `session.jsonl` / `session.jsonl.zstd` ⇒ 新格式会话对
"旧会话清理"**完全不可见**（静默 no-op：清理永不生效、磁盘只涨；**非数据损坏**）。

**修复**：新增 `sessionLogArtifacts()` 统一枚举世代（`/^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/`，按代递增，
同代内 `.jsonl` 在前、`.zstd` 在后）；`findSessionLog()` 返回**最高世代**（= 宿主 `findLog` 语义；
对单文件目录行为与旧实现完全一致）；`collectEligibleSessions` 的 `lastActive` 改取
**全部世代的最大 mtime**（保守：任一世代被写过就不算旧，避免误删仍在写入的会话）。

### ③ 诊断工具（让这类问题不再靠猜）

- **`dsh-develop session-doctor`**：会话日志体检（**只读**）。默认**静态分诊**（判据 **version-first**：
  `header.version > 支持` → `refused-version`；`< 支持` → **`needs-migration`** 早停不扫正文；
  仅当前世代进词表门，并先剔除**存储行类型** `PACKED_TAGS`（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`——
  它们不是事件，旧判据把它们误报为"未知事件"，实测 3/3 全假阳性））。
- **`--probe`**：走**宿主真实读取路径**判定（`scripts/session-probe.mjs` 实例化宿主真实的
  `JsonlSessionPersistence`）。**关键分层**：`readStoredLog(path,id)` 是**存储层**读（**不走迁移**，
  对历史世代报 `no upgrade path` 是**正常现象**）；**`open(id,'read')` 才是应用面**（走迁移分支，
  迁移可能成功也可能在内容层被拒）⇒ **两条都测**，否则结论过强。
- **`--summary`** / **`--sessions <id,...>`** / 批量探针（一次进程判定 N 个会话，全量跑不刷屏）。

**全量实测（本机 302 会话）**：可打开 **238** / 打不开 **64**
= 宿主侧 **57**（`subagent/descriptor` 版本不受支持 ⇒ 宿主 v0 迁移目录缺该记录的前向转换，**与本插件无关**）
+ **本插件 7**（① 的消息缺 id/role）。`list()` 返回 **302** ⇒ **打不开的会话照样出现在列表里**，点开才报错
——与用户"会话老是损坏"的主观描述吻合。

### ④ 测试

`80 files / **1186** tests`（v1.31.12 为 1180；+6 = rebuild 回归 1 + session-cleanup 5）。
另跑 `typecheck`（node + client）双面。**未改任何声明面/契约面**（本版纯缺陷修复）。

### ⑤ 待用户

- **已知不影响本版**：7 份存量受损会话经用户裁决**不救援（只止损）**；57 份 v0 迁移拒绝属**宿主侧**，
  可向 DSH 上游反馈。

## v1.31.12 — 2026-09-11（宿主基线抬到 DSH 0.1.5-rc.2 + 新增 `host-upgrade` 维护通道）

**Scope:** 本机 DSH 从 `0.1.5-rc.1` 升到 `0.1.5-rc.2`（用户 2026-09-11 裁决：**范围 C** = 主机升级 + 基准同步 + 发布；**通道 b** = 由 ACC 侧 MSM 自行执行全局安装）。dsp **零代码适配**——rc.2 对契约面无实质改动；本版只做**声明面基准同步**与**执行通道补齐**。

### ① 为什么不需要适配（先证据，后改动）

| 证据 | 结果 |
|------|------|
| 对称 diff（rc.1 vs rc.2，46 包） | **仅 1 处实质改动**：`dsh-client-ui-primitives` 抽出 `code-file-icon-artwork`（美术数据模块，导出面未变）；其余全是版本齐步 |
| `typecheck-host 0.1.5-rc.2`（改前） | ✅ node 半 **115 文件** / client 半 **103 文件**，paths 36+14 全命中，**两半零类型错误**（文件数与 rc.1 一致 = 基准等价） |
| rc.2 的 `@deepseek-ai/dsh` 依赖声明 | `@deepseek-ai/cordis ^4.0.2` / `@deepseek-ai/schemastery ^3.18.2` **未变**；只有 `dsh-*` 齐步 `^0.1.5-rc.2` |

⇒ 结论：**代码零改动**，要动的只是"我们相信自己跑在哪个宿主上"的声明面。

### ② 新增 `host-upgrade`（`dsh-develop` 子命令，D53）

**为什么需要**：本机运行态 = 全局 npm 安装（`node ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web`）。
宿主要升级时，ACC 侧**没有执行通道**——safe-mode 下 agent 无 bash，`sys` 子命令白名单（ps/ss/curl/lsof/date/ls/git…）不含 npm。

**边界收紧（这是本子命令的安全前提，勿放宽）**：

- 包名**硬编码** `@deepseek-ai/dsh` ⇒ 不构成通用安装面
- 参数必须匹配 `latest|next|alpha|x.y.z[-pre]` 白名单正则
- 默认官方源 `https://registry.npmjs.org/`（预发布版 + 内网 Nexus packument TTL 双重风险，D51 先例），`--registry` 可覆盖
- `--dry-run` 只预览；先 `npm view` 解析目标版本（失败信息比 `npm install` 直白），安装后**读回 package.json 核验**并打印 `before → after`

`dsh-develop host-upgrade 0.1.5-rc.2` 实测：`0.1.5-rc.1 → 0.1.5-rc.2`（523 包变更，59s，官方源）。

### ③ 基准同步（3 处声明面 + 2 处闸门）

| # | 位置 | 改动 |
|---|------|------|
| 1 | `hooks/package.json` | peer **15** 项 `^0.1.5-rc.1` → `^0.1.5-rc.2`；devDependencies **30** 项 `0.1.5-rc.1` → `0.1.5-rc.2`（精确钉版）；description 同步 |
| 2 | `hooks/dsh.plugin.json` | `engines.dsh` → `>=0.1.5-rc.2` + description 同步 |
| 3 | `src/host/contract.ts` | `REQUIRED_HOST_RANGE` → `^0.1.5-rc.2`（floor 从其派生，见 v1.31.6） |
| 4 | `tests/compliance.test.ts` | **F6c** 字面量 → `^0.1.5-rc.2` |
| 5 | `tests/host-manifest.test.ts` | 全 peer 值形状正则 → `^\^0\.1\.5-rc\.2$` |
| — | `tsconfig.json` | 头注释中的基准版本 → `0.1.5-rc.2` |
| — | `pnpm-lock.yaml` / `pnpm-workspace.yaml` | `lockfile` 重算（`minimumReleaseAgeExclude` 追加 `|| 0.1.5-rc.2`；`allowBuilds: esbuild` 存活） |

**未改动（有意）**：`v1.31.6 适配 0.1.5-rc.1` 一类注释是**历史叙述**（记录"何时为何改"），不是基准声明——批量改名会把历史读成现状。

**过程中被门禁抓到的遗漏（值得留档）**：第 5 处（`host-manifest.test.ts:78`）是**跑 `test` 才红的**——说明基准字面量虽散落多处，但每处都在闸门下**fail-loud**（漏改必红，不会静默漂移）。可选后续：让该正则从 `REQUIRED_HOST_RANGE` 派生以消除第三份副本（本版不做，不在发布路径上改测试语义）。

### ④ 验证（全绿）

| 门禁 | 结果 |
|------|------|
| `lockfile` | ✅ 双步（重算 + `--frozen-lockfile` 自检 = CI `Install (hooks)` 同款判定，亦即 `publish` 前置） |
| `typecheck`（仓库内基准 rc.2） | ✅ node + client 一次通过 |
| `typecheck-host 0.1.5-rc.2` | ✅ node 115 / client 103 文件、paths 36+14 全命中、零错误 |
| `test` | ✅ **80 files / 1180 tests**（首轮 1 红 = 上述第 5 处基准字面量，修正后全绿） |
| `build` | ✅ lib/index.js + lib/client.js **201951 B**（与 v1.31.10/v1.31.11 逐字节同尺寸——只动常量字面量） |
| `pack-check` | ✅ 96 文件 / lib 90 项 |

### ⑤ 诚实边界

- **rc.2 仍是 npm `next`（未升 `latest`）** ⇒ 本机主动跑在预发布线上（用户明示要升）；`latest` 升版后无需再做任何 dsp 动作。
- **升级完成后运行进程仍持 rc.1 内存态**，直到 `restart-web`（本版发布链末步）——`dashboard health` 的 `dshVersion` 以重启后为准。
- **CI 已不自动跑（v1.31.11 D52）** ⇒ 宿主漂移不再有自动检查，只能**手动** `host-fetch <ver>` + `typecheck-host <ver>`（本版正是这条纪律的第一次执行）。
- `host-upgrade` 是**维护者通道**（`scripts/`，不进公开 npm 包），不改变 ACC 工具面（仍 11 工具）。

---

## v1.31.11 — 2026-09-10（CI typecheck 恢复为**真门**：宿主类型基准从机器耦合改为仓库内 devDependencies）

**Scope:** CI 的两个 typecheck 步长期是 `continue-on-error` 的"信息性噪声"——注解里二十多条
TS 错误没人当回事。本版把根因（**机器耦合的 paths** + **cordis 双实例**）消除，使 typecheck
在任何克隆/CI 上都能真实回答"宿主接口漂移有没有打断 dsp"。**只落代码态，不发布。**

### ① 问题：那道门其实早就不是门

- CI 注解里两个 typecheck 步各报一批 TS 错误（多次 run 稳定复现），但因为 `continue-on-error` 从不阻塞
- **实测根因形态**：把 paths 清空（= CI 的实际处境）→ node 半 **94 条错误**
- 后果不是"少一道门"这么简单：它让**唯一能自动发现宿主漂移的手段**失效——而宿主漂移恰好是
  dsp 最容易静默中招的形态（§13 的三次静默失效、v1.31.8 的 DRIFT-1/2 都出自这个盲区）

### ② 根因（两条，均实测）

| # | 根因 | 证据 |
|---|------|------|
| 1 | **paths 机器耦合**：两份 tsconfig 硬编码 `../../../../../../.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`（对仓库相对家目录的**深度**敏感）；client 半另有两处指向 **`~/.dsh/source/current/packages/client/ui-{slots,primitives}`**（DSH **源码检出**，比 .npm-global 更脆） | runner/克隆机上这些目录全不存在 → tsc 静默回落 node_modules → 94 条错误 |
| 2 | **cordis 双实例**：`cordis` 与 `@deepseek-ai/cordis` 是两个包（宿主用自注入 shim 提供裸 `cordis`，上游无 `cordis@4.0.2`，见 v1.31.10 ②） | 两个 `Context` 声明不合并 → 94 条错误的主要成分 |

### ③ 方案选型（保留备选，R↓）

| 方案 | 做法 | 取舍 | 结论 |
|------|------|------|------|
| **A** | 宿主包进 **devDependencies**（精确 `0.1.5-rc.1`）；paths 改仓库内 `node_modules/@deepseek-ai/<pkg>`；`cordis` 双映射同指一实体 | 基准**单一真实源**、任何克隆可 typecheck、CI 装得上；代价 +32 devDep / 锁文件变大 | **采用** |
| B | CI 里跑 `host-fetch <ver>` + `typecheck-host <ver>`（复用既有旁路） | 零新依赖；但版本字面量落进 ci.yml（第二真相源），committed tsconfig 仍是机器耦合（克隆即 94 错）→ 治标 | 备选 |
| C | 保持现状（typecheck 恒为信息性） | 零成本；等于放弃这道门 | 否 |

**判据**：换宿主版本时要改哪几处 —— A 改 `package.json` 一处（+ 锁文件）；B 还要改 ci.yml，且本地仍不对。

### ④ 改动清单

- `package.json`：devDependencies **+32**（30 × `@deepseek-ai/dsh-*` + `@deepseek-ai/cordis@4.0.2` + `@deepseek-ai/schemastery@3.18.2`，**全部精确钉版**——prerelease 用 `^` 范围会静默解析到 rc.2，与本机运行宿主 rc.1 不一致）
- `tsconfig.json`（node 半，36 条 paths）/ `client/tsconfig.json`（14 条）：值改为仓库内相对；client 半两处 **DSH 源码检出**改为 npm 包（已实证 npm 包自带 `lib/types/`）；`react`/`@types/react` 一并显式化
- `tsconfig.json` 内新增**两条纪律注释**：① 新增 paths 条目必须同时进 devDependencies ② `cordis` 双映射必须同实体
- `tsconfig.prepare.json`：仅更新 `// purpose` 注释（原文"repo tsconfig 靠 sibling harness checkout"已过时）——**仍不带 paths**（消费机从 git 安装无 devDeps，这是有意设计）
- `pnpm-lock.yaml` + `pnpm-workspace.yaml`：锁文件重算（`minimumReleaseAgeExclude` +29 条）

### ⑤ 新增机械闸门 `compliance.test.ts` F7（4 用例）

把上面两条纪律变成机械事实（否则下一次"加了 paths 忘了 devDep"还是静默假绿）：

| 用例 | 断言 |
|------|------|
| F7a | 两份 tsconfig 无任何 `.npm-global` / `.dsh/source` 残留 |
| F7b | 每条 paths 值的包名必须存在于 devDependencies（**缺一条 = tsc 静默回落**） |
| F7c | `cordis` 与 `@deepseek-ai/cordis` 指向**同一实体**（声明合并前提） |
| F7d | 宿主 devDep 版本 == peer 范围的基准版本（**关系式断言，不锁字面量**——改一处忘另一处当场红） |

**负控制（证明通电）**：临时注入一条 `@deepseek-ai/dsh-negative-control` path →
F7b **精确红在注入行**（`@deepseek-ai/dsh-negative-control 缺少 devDependency（node 半 …）`）；注入已删。

### ⑥ 验证（本地全绿）

| 门禁 | 结果 |
|------|------|
| `typecheck` | ✅ **一次通过**（node + client）——仓库内基准首次即绿 |
| `typecheck-host 0.1.5-rc.1` | ✅ node **115** / client **103** 文件，paths 36+14 全命中（与改造前计数一致 = 基准等价） |
| `lockfile` | ✅ 双步通过（`--frozen-lockfile` 自检 = CI Install (hooks) 同款判定） |
| `test` | ✅ **80 files / 1180 tests**（含 F7 四条 + 负控制复跑） |
| `build` | ✅ lib/index.js + lib/client.js **201951 B**（与 v1.31.10 逐字节同尺寸 → 产物零变化，只动开发配置） |
| `pack-check` | ✅ 96 文件 / lib 90 项（同改造前） |

### ⑦ 诚实边界与待办（**不发布**）

- **CI 侧已实证**（run #39，2026-09-10 15:44:35→15:45:16）：`Install (hooks)` ✓、`Typecheck (node half)` ✓、
  `Typecheck (client half)` ✓；**check-run 注解 21 条 → 1 条**（唯一剩余 = `Node.js 20 is deprecated`）——
  即"两个 typecheck 步在 runner 上零错误"的机械证据
- 新增 32 devDep 会被 CI 安装：`--ignore-scripts` 下这些包自带 `lib/`、无需构建 → 只增下载量（实测 hooks 安装 3 秒）
- devDeps 精确钉版 = 宿主升级需显式抬（与本机运行宿主一致）；新宿主探测仍由 `typecheck-host <ver>` 负责

### ⑧ 用户裁决（D52）：检查归发布机制，CI 不再自动介入

- **原话**：「我对 github ci 持反对态度，如果有什么是需要检查的，请在我们发布机制里检查」
- **落地**：
  - `ci.yml` 触发从 `push`/`pull_request` → **仅 `workflow_dispatch`**（手动）⇒ push 不再产生 run，
    **邮件路径彻底消失**；各步 `continue-on-error` 保留（手动跑时 = 一次性诊断，不阻塞、不发信）
  - **质量门归发布链** `dsh-develop publish`：**新增 `verifyLockfile()` 前置**（锁文件与 `package.json`
    一致性判定，**只判定不改**）→ `cmdTest()` → `cmdBuild()`（内含 **typecheck 双面**）→ README 同步 →
    tarball 核对。即 v1.31.10 由 CI 兜住的"锁文件漂移"、以及本轮修好的 typecheck，**都改在发布前拦下**
  - `verifyLockfile()` 与 `lockfile` 命令的第 ② 步**共用同一函数**（单一真相源）⇒ 跑 `dsh-develop lockfile`
    就是在验证发布链的同一段代码
  - 恢复自动触发的方法写在 ci.yml 文件头（一行注释指引，可逆）
- **诚实边界（E↑）**：本改动**没有 CI 实证**——触发已改手动，push 不再产生 run；能验证的是
  "发布链前置函数本地可用"（`dsh-develop lockfile` 跑通同一函数 ✓）。typecheck 修复的 CI 实证仍是 run #39（21→1）

---

## v1.31.10 — 2026-09-11（CI 恢复有效：锁文件漂移 + 上游 cordis 无 4.0.2 + 一条环境依赖断言）

**Scope:** CI 自 v1.31.6 起**每次 push 都红**，且红法是"测试根本没跑"（`Install (hooks)` 即失败 →
`Test` 整步 skipped）。本版把 CI 修回绿（**自 v1.31.5 以来第一次**），并新增开发通道子命令
`lockfile`，让"依赖改了但锁文件没重跑"这类漂移**一条命令自检**。

### ① 根因一：hooks 锁文件漂移（漂移闸门的**真阳性**）
- **现象**：CI run #31（v1.31.9 推送）`Install (hooks)` failure → `Test` 与两个 typecheck 全 skipped，
  20 秒结束；免认证注解原文 `vitest-digest: no vitest log captured (Test step failed before vitest ran)`
  —— **不是测试红，是测试没跑**（阻塞门静默失效，比红更危险）
- **根因**：`hooks/dsh-serenity-hooks/pnpm-lock.yaml` 自 v1.30.16（`6751fd0`）后再没重生成，
  18 项宿主 peer 仍写 `^0.1.2-rc.1`，而 v1.31.6 已抬到 `^0.1.5-rc.1` →
  `pnpm install --frozen-lockfile` 判定"锁文件与 package.json 不一致" → **拒绝安装**
- **定性**：闸门**按设计工作**（ci.yml 文件头 v1.30.16 已写明"改依赖必须重跑 pnpm install 并提交锁文件"）
  → 修法是**补齐锁文件**，不是关掉闸门

### ② 根因二：`cordis` peer 范围上游不可满足（v1.31.6 的过度外推）
- 重生成锁文件当场报 `ERR_PNPM_NO_MATCHING_VERSION: cordis@^4.0.2`
- **取证三条**：`registry.npmjs.org/cordis/4.0.2` = **404**（上游 cordis 最高只到 `4.0.0-rc.10`）；
  宿主 profile 实际提供的 bare `cordis` 是 dsh 注入的私有 shim **`4.0.0-rc.7`**（`"private": true`）；
  43 个 DSH 0.1.5-rc.1 宿主包**无一 peer bare `cordis`**（全部 peer `@deepseek-ai/cordis@^4.0.2`）
- **修复**：`cordis` peer `^4.0.2` → **`^4.0.0-rc.7`**；`@deepseek-ai/cordis` 保持 `^4.0.2`
- **判据（写入断言注释）**：peer 范围 = "**registry 能否解析** + **运行时实际提供什么**"，两者都要实测，
  不能由一个包的存在推及另一个同名包

### ③ 根因三：一条把"构建产物在场"写进断言的用例（CI 首次真正跑到测试后才暴露）
- CI 修好后 vitest 首次真正执行（run #32：79/80 files、1165/1166 tests）→ 唯一红点
  `host-manifest.test.ts:56`「`exports["./client"]` 目标文件在场」：CI 用 `--ignore-scripts` 装
  （`prepare` 依赖本机硬编码 paths，runner 上跑不了构建）→ runner 没有 `lib/` → `existsSync` 必 false
- 该文件 v1.31.9 才写，而 CI 自 v1.31.6 起从未跑到 vitest → **这条断言从未被 CI 检验过**
- **改法**：只断**声明自洽**（`./lib/*.js` 形态 + 被 `files[]` 白名单覆盖）；
  产物完整性归发布链 `pack-check`（构建之后跑），不压在测试上

### ④ 新增 `dsh-develop lockfile`
- `pnpm install --lockfile-only`（只重算锁文件，**不动 node_modules**）+ 紧跟
  `--frozen-lockfile --lockfile-only` **自检** = CI 的 `Install (hooks)` 同款判定
  → 本地一条命令确认"CI 这一步必过"
- 纪律：**改完 `package.json` 依赖后必须跑它并提交锁文件**
- 副作用登记：pnpm 11 在 `hooks/dsh-serenity-hooks/pnpm-workspace.yaml` 写入
  `minimumReleaseAgeExclude`（34 个 `0.1.5-rc.1` 包绕开最小发布年龄门），随本版入仓

### ⑤ 验证
- 门禁：**80 files / 1176 tests** 全绿 + typecheck 双面 + build + pack-check
- **CI run #33 = success** —— 自 v1.31.5（run #26）以来第一次绿，阻塞门（`pnpm test`）恢复有效
- 断言更新：`compliance.test.ts` F6b（双映射改断"各自可解析"而非"同串"）+ `host-manifest.test.ts` peer 正则

## v1.31.9 — 2026-09-10（rebuild 第二条阻断规则修复 + 事件 payload 闸门补全 + 域 C 收口：rebuild 全链真机跑通）

**Scope:** v1.31.8 修好 `SurfaceOp` 字段名后，rebuild **走得更远但撞上第二条宿主规则**（同一诊断通道给出的第二份原文）。
本版收口那条规则 + 把「事件 payload 无人看守」这一格补齐，并以**真机跑通**为验收；
另把 v1.31.8 遗留的**域 C（宿主 manifest 读取端）"不可取证"盲区**用 `host-fetch` 追加包名打通并落成机械闸门。

### ① rebuild 第二条阻断规则：surface node 0 是受保护的系统提示节点
- **现象**：`logbook rebuild` 仍 failed，diag 原文
  `surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`
  （宿主 `dsh-session/lib/types/surface.js` → `assertSystemHeadRewrite`）
- **含义**：0.1.5 起 **surface node 0 = 系统提示节点且被宿主保护**——replace 只要覆盖到它，
  就必须由 `system/message` 且**精确只改它一个节点**。而重建的语义恰恰是"**保留系统提示、只清对话历史**"，
  故旧实现整体替换 `nodes[0..last]` 在 0.1.5 上**必被拒**
- **修复（`src/rebuild.ts` `performRebuild`）**：替换范围 `nodes` → **`targets = nodes.slice(1)`**；
  只剩系统提示 → 返回 `false`（无历史可清，不做 replace）；
  `shadowedRange` / `shadowedSeqs` / `tokenCount` / `sourceEventSeqs` **全部同步为 targets**
  （否则 prune 定价与 replace 范围不一致，shadow-price 协议被破坏）

### ② 事件 payload 闸门补全（`src/host/type-contract.ts` ⑥b，4 条）
v1.31.8 的 ⑥ 节锁了 8 条 payload，**域 B 审计点名的 4 条漏网**——它们的共同点是
"读一个可选字段再早退"，字段消失不抛错，只让某条链路**从此不再执行**（与 DRIFT-1 的 `?? []` 恒空同构）：
- `agent/pre-step`：读 `payload.agent`（CCC 路由 + 每步同步 safe-mode/im-bridge 可见性）+ `payload.messages`
  （bootstrap 剥离注入消息 / 首进 CCC 前置身份消息）
- `agent/turn-stopping`：读 `payload.agent` / `payload.turn`（rebuild 真正执行、输出守卫、微信打回）
- `session/event`：**位置参数**（非 payload）——`session.header.cwd` + `session.id`，
  以及 `event.type === 'compaction/end'` 与 `event.data.error`（**旧写法直接 `event.data.error`，字段没了只是 `undefined`**）
- `system-prompt/assemble`：**位置参数**——`context.agent` 由 `dsh-agent` 的 `declare module` 合并进来
  （**不在 dsh-system-prompt 自己的 `AssembleContext` 里**）→ 合并链断则 `context.agent` 恒 `undefined`，目录窄化静默失效

**闸门通电证据（逐条变异控制，写入文件末尾"闸门自证"块）**：给 `_EvPreStep` 目标加一个不存在的必填字段 →
`type-contract.ts(275,34) TS2344`；把 `_EvCompactionEndError` 目标改成 `{error?: number}` → 同批 `(276,34) TS2344`
——**两条各自报在自己的断言行**（证明是活闸门，不是被前一条遮蔽的死代码）。控制插入物已删除。

### ③ 真机验证（本轮验收）
- **rebuild 全链跑通**：`AGENT_SESSIONS/.rebuild-diag.json` = `lastEvent:"rebuilt" / rebuiltCount:1 / failedCount:0`
  （前两次分别是 `failed` × 2，两次失败各自产出一份**精确到规则的错误原文**）；本次会话本身即 rebuild 产物
- **图片落盘兜底（DRIFT-1/2 修复）**：
  - 产物层：仓库 `lib/client.js` 含 `attachmentIds` / `removeAttachment`，**零** `imageIds` / `removeImage`；
    已部署 profile 的 `lib/*.js` 与本仓构建**字节数一致**（201951 / 497582 B，同 mtime）→ 运行中的插件就是这份构建
  - 服务端半程真机：`POST /serenity/image-upload`（`x-serenity-ui: 1`）→ 200 + 落盘
    `_tmp/images_from_user/<ISO>-<rand>.png`（70 B 实测）→ **链路的服务端一端在 0.1.5-rc.1 下活着**
  - ⚠️ **诚实边界**：客户端触发端（模型不支持图片 → `session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES` →
    自动落盘 + 文本重发）需真实 WebUI 场景（切非视觉模型 + 粘贴图片），**本轮无法自动构造**，
    由 `src/client/host-type-contract.ts` 的两个 API 名从类型层机械看守

### 测试（80 files / 1176 tests，+5）
- 新增 `tests/host-manifest.test.ts`（5 用例）——域 C 收口产物，把"宿主真正消费的 manifest 字段"变成会红的闸门（见 ④）
- ① 的断言同步在 v1.31.8 已入账；② 是类型层闸门，其"测试"就是 `typecheck` 本身的红/绿
- **补跑验证**：v1.31.8 遗留的 coverage-gate 镜像门禁红已消除（`tests/host/type-contract.test.ts` 生效）

### 门禁
`typecheck`（node+client）✅ ｜ `typecheck-host 0.1.5-rc.1` ✅（node 115 / client 103 文件，paths 36+14 全命中）
｜ `test` ✅ 80/1176 ｜ `build` ✅（lib/client.js 201951 B）｜ 版本三处一致 1.31.9

### 待用户（D14）
发布链（publish + 三推 + specs/根仓 push + deploy + restart-web）**未执行**。
⚠️ **npm `latest` 目前是 1.31.8，其中不含 ① 的 node-0 修复**（本机运行态已由 `deploy` 通道带上该修复，故 rebuild 已可用）；
下一次发版会自然补上。

## v1.31.8 — 2026-09-10（宿主接口全量 review：2 条 client 静默失效 + rebuild 阻断修复 + 类型契约新防线）

**Scope:** 用户「很可能dsh有接口变动我们不知道，全量review这类case进行检查」——按"升级 0.1.5-rc.1 后靠人读源码才发现 C3/C4"的历史教训，把**成员签名/返回形状/事件 payload/client 半**这些类型检查看不见的接触面全量审计一遍，并把这类问题变成**机械可检**。

### ① 抓到并修复 2 条真实静默失效（client 半，域 A 审计）
- **DRIFT-1** `src/client/ImageFallbackDock.tsx`：读 `input.imageIds` → 宿主 `InputState.attachmentIds`（0.1.5-rc.1 全仓 `imageIds` 零匹配）→ **图片自动落盘兜底整条链从不触发**（`?? []` 恒空 → 早退；不报错、用户无感。同批修：`attachmentIds` 直接传 `DraftAttachmentId`，不再 `String()`）
- **DRIFT-2** 同文件：`inputActions.removeImage` → 宿主 `removeAttachment`（被 DRIFT-1 掩盖，**必须同批修**否则修好前者立即暴露降级路径）
- 顺带：`image-fallback-api.ts` 删未用 `DraftAttachmentId` 死导入 + 注释 `draftImages`→`resolveDraftAttachments`（改名残留）

### ② 修复 logbook rebuild 在 0.1.5-rc.1 下失败（阻断性，S142 自己撞上）
- **现象**：`logbook rebuild` queued 但未执行；diag（`AGENT_SESSIONS/.rebuild-diag.json`）= `session event "user/message" carries an invalid replace surfaceOp`
- **根因**：0.1.5-rc.1 `SurfaceOp` 的 replace 字段名 `start/end` → **`startSeq/endSeq`**（`dsh-session/lib/types/types.d.ts:429-432`；`replacementRange` 读 `op.startSeq`）；`rebuild.ts` 传旧名 + `as never` 断言（编译器失明）→ append 被拒 → executeRebuild 崩溃
- **修复**：`rebuild.ts` `surfaceOp: {op:'replace', startSeq, endSeq}` + 测试断言同步

### ③ 新防线：宿主**类型契约**（把这一类变成编译期闸门）
- **`src/host/type-contract.ts`（新，type-only）**：`import type {}` 拉入 17 个宿主包 Context 增强，`Expect<Extends<宿主真相, dsp 形状假设>>` 逐条断言——17 服务签名 + Session.header 字段 + append 两处 `as never` 现场 + Agent(steer/inbox/status/ctx.systemPrompt) + 8 事件 payload；**宿主改名/改形状 → `typecheck` / `typecheck-host <ver>` 当场红**
- **`src/client/host-type-contract.ts`（新）**：锁 `InputState.attachmentIds` / `InputActions.removeAttachment(setDraft/submit)` / `InputZone.{session,input}` / `SessionStandardProps.sessionId` / promptError 层级（`RemoteFailure` 是 owner 可合并的 code 判别联合 → 只锁顶层，防误报）
- **闸门自证**：负控制实测（假断言 → `TS2344` 报在断言行）；历史回归反证（C4 旧形状 → 编译失败）
- **基线解析盲区修复**：`@deepseek-ai/dsh-session-projection/types` 是 10+ 包共同增强的子路径模块 id → tsconfig 补映射（`typecheck-host` 解包宿主无 node_modules 解析不到）
- **镜像门禁**：`tests/host/type-contract.test.ts` 锁"两文件留在 src/（typecheck include）"前提（tests/ 不参与 typecheck 是机制盲区根源）

### ④ 事件名编译期守卫 10 → 13（域 B 审计补）
- `agent/disposed`、`session/disposed`、`settings/updated` 三个 dsp 实际订阅事件补进 `HOST_EVENT_NAMES`（`satisfies keyof Events`）+ `HOST_EVENTS` 表 + payload 断言

### ⑤ 审计结论（域 A/B/C，勿重查）
- **A 区 10 事件 payload 全部 OK**；**B 区 settings 面全部对上**（installSection 5 位置参 / get(ns) / update 深合并+先校验后落盘 / llm-pi-ai headers 一次性求值 / 唯一保留名 user-agent）
- **C 区 manifest（app-boot 读取端）在 CCC 外不可取证** → `dsh.bundle.patch`/`engines.dsh`/`contributes.tools` 的 0.1.5-rc.1 消费语义未复核（0.1.2 实证 + dsp 内部自洽；contributes.tools 有 invariant 测试锁）

### ④ 域 C 收口：宿主 **manifest 消费面**从"不可取证"变成"实证 + 机械闸门"
- **取证突破口**：宿主**应用本体**此前不在 CCC 内 → 用 `host-fetch <ver> <pkg>` 追加抓取
  `@deepseek-ai/dsh`（CLI app）、`@deepseek-ai/dsh-app-boot`（manifest 读取端）、
  `@deepseek-ai/dsh-cordis-client-runner`（浏览器半发现）、`@deepseek-ai/dsh-plugin-package-inventory-deepseek`
  → 45 个宿主包全在 CCC 内可 read/grep（`host-fetch` 本就支持追加包名，此前未用）
- **穷举结论（`\.dsh\?\.` 全树扫描）——宿主真正消费的 manifest 字段只有四个**：

| 字段 | 读取方 | 缺失后果 |
|------|--------|---------|
| `dsh.profile.bundles` / `patchReload` | `dsh-app-boot/lib/index.js` | profile 未列出本包 = 不被装载 |
| **`dsh.bundle.patch`**（bundle 包**自己的** package.json） | app-boot + `dsh/lib/plugin-*.js` `isBundle()` | **响亮失败** `profile bundle "X" declares no dsh.bundle in its package.json`；`dsh plugin add` 路径则**降级为普通依赖**（warning: "installed as a plain dependency, not a profile layer"） |
| `dsh.moduleFallback.targets` | app-boot | 非插件作者面（dsh 自写） |
| `dsh.client` + `exports["./client"]` | `dsh-cordis-client-runner`（"the browser half ships through exports[\"./client\"], discovered from the package.json dshClient declaration"） | 浏览器半不被发现 → 面板/输入区 dock 整体消失 |

- **两条旧结论在 0.1.5-rc.1 实物上复核**（此前只在 alpha.1 公开源码上验证过）：
  - **`dsh.plugin.json` 非宿主识别格式**——45 个宿主包内**连字符串都零命中**；`contributes.tools` 概念不存在（工具走 `ctx.tools.register`）。它是本包**自维护元数据**（供 `invariant.ts` / `invariant.test.ts` 自检）
  - **`engines.dsh` 无宿主强制**——全树 `engines` 只在无关注释里出现；**真正的版本门 = `peerDependencies` 解析 + 本包 `REQUIRED_HOST_RANGE`**
- **dsp 声明面逐条对上**：`dsh.bundle.patch: './cordis.patch.yml'` ✓（文件在场）｜`files[]` 含 `cordis.patch.yml` + `dsh.plugin.json` ✓｜`exports["./client"]` ✓（目标在场）｜`dsh.client.platform: 'web'` ✓｜peerDeps 17 项 ✓
- **新机械闸门 `tests/host-manifest.test.ts`（5 用例）**：把上表变成会红的测试（patch 声明+文件在场 / files 白名单 / exports["./client"] / dsh.client.platform / peerDeps 非空且范围统一）——否则这次"不可取证 → 可取证"的成果又是一次性人工发现
- ⚠️ 仍属**域外**（不在本次接口检查范围，见 SESSION §7）：`dsh.plugin.json` 是否该并入 package.json `dsh` 段（历史遗留的"自维护元数据"身份仅靠注释标注）

### 测试（80 files / 1176 tests，+5）
- 新增 `tests/host-manifest.test.ts`（5 用例，见 ④）
- 新增 `tests/host/type-contract.test.ts`（2 用例：src 归属 + 可装载）——v1.31.8 已入账
- `tests/rebuild.test.ts` 2 用例断言字段名同步 `start/end` → `startSeq/endSeq`

### 待办（下一轮）
- type-contract ⑥ 节补剩余 4 事件 payload（agent/pre-step、turn-stopping、session/event、system-prompt/assemble 的 context.agent）
  → **✅ v1.31.9 已完成**（见 v1.31.9 ②）
- ImageFallbackDock 修复的真机验证（需真实"模型不支持图片"场景）
  → **部分完成（v1.31.9 ③）**：产物层 + 服务端半程已验；客户端触发端仍需真实 GUI 场景
- C 区 app-boot 复核需可访问 DSH 应用本体的环境（**仍待办**）
  → **✅ v1.31.9 ④ 已完成**：`host-fetch` 追加包名即可取证，已穷举消费面并落机械闸门

## v1.31.7 — 2026-09-10（opencode 路由头自动配置：装好即用，用户不必手抄请求头）

**Scope:** 用户需求「我是想 1，但是我们 dsp 能不能安装好自动就配上去，省的我们用户配」
（1 = 走**付费** `opencode.ai/zen/go` 面）；`L1+L2 默认都开`为用户的显式裁决。
**本轮不发布**（D14：用户未显式要求发版）。

### ① 问题：DSH 调 opencode 网关缺请求头，而这一串头没人愿意抄
- **症状**：`/zen/go` 按**请求头**做会话亲和路由，缺 `x-opencode-session` 时**直接 400**
  `Request is missing x-opencode-session and cannot be routed efficiently`
- **根因**：DSH 用的 `@earendil-works/pi-ai@0.85.1` **库本身不发这些头**
  （全库 `x-opencode` 零命中）；pi 的 CLI 是在**应用层**
  （`packages/coding-agent/src/core/sdk.ts`）自己加的 → 直接用库的 DSH 天然缺头。
  dsp 侧无法经插件缝补齐（`PiAiAdapter` 是宿主内部，不暴露 `transformHeaders`）
- **证据**：[pi #4847](https://github.com/earendil-works/pi/issues/4847)（维护者回复 + 官方认可的
  workaround 与本实现同构）、[Trae 的 Go 面代理](https://github.com/LIMTCYT/opencode-go-proxy-for-trae)
  （Go 面 400 原文 + 头清单，README 明列"dsh 亲测有效"）、hermes #106495（免费档头指纹 429 对照实验）

### ② 新模块 `src/opencode-provider.ts`（两条规则，装好即生效）
- **L1 补头**：**已有** opencode 路由（路由名 ∈ `opencode`/`opencode-go`，或 `baseURL` 主机名等于
  或后缀于 `.opencode.ai`——后缀匹配防误伤 `opencode.ai.evil.com`）→ **只补缺失的键**；
  头名按 HTTP 语义**大小写不敏感**比较；**用户已写的值一律不覆盖**
- **L2 建路由**：一个 opencode 路由都**没有** **且** 环境有 `OPENCODE_API_KEY` → 建 `opencode-go` + 全头。
  「有 key」是用户意图的最强证据；没有 key 的人**零影响**（不会平白多出一组模型）。
  **不写 `apiKeyEnv`**——依赖 pi-ai 目录 provider 自带的 `envApiKeyAuth(['OPENCODE_API_KEY'])` 环境发现，
  显式再声明一次反而多一层无法验证的凭据缝
- **会话标识的两个头名是同一逻辑值的别名**：`x-opencode-session`（Go 面 400 点名的名字）与
  `X-Session-ID`（OpenCode 自家客户端用的名字）。判定顺序是**先定值再补名**——
  用户任写其一 → 用**他的值**补齐另一个；都没写才用本插件常量。**绝不出现两个互相矛盾的 id**
- **会话标识是静态常量 `dsh-serenity`**（**有意为之**，非偷懒）：DSH 的 provider `headers` 在路由解析时
  **一次性求值**（无 per-request 模板缝），随机值等于每次进程启动换一个亲和键 → 缓存永不命中。
  常量让「同一安装 → 同一亲和键」成立（对提示词缓存是利好；对"按会话分区"是语义偏差，
  pi #4847 报告者亦点出该 workaround 的固有缺陷）

### ③ 注入通道：`ctx.settings.update('llm-pi-ai', patch)`（唯一可用且是官方面）
- `dsh-settings` 的官方写入面：**深合并**（`mergeLayers` 逐层递归）→ 不冲掉用户别的路由；
  **先校验后落盘**（pi-ai 注册时给的 `validate`）→ 坏补丁被拒且不持久化；
  写入用户 settings 文档（0600，用户可读可删）
- **被否的备选**：① 本插件 `cordis.patch.yml` 直接改 `llm-pi-ai` 的 config——宿主 patch 语义是
  **整体替换 config（非深合并）**，会冲掉部署方在该条目上配的其它 provider，且无法按条件启用
  ② 让用户手抄——本次要消灭的正是这一步

### ④ 诚实边界：只注入"会话族"，**不冒充 OpenCode 客户端**
- **注入**：`x-opencode-session` / `X-Session-ID` / `x-opencode-client: dsh` / `x-opencode-project: global`
- **不注入** `X-Title: opencode` 与 `HTTP-Referer: https://opencode.ai/`——那是**冒充** OpenCode 客户端，
  只在**免费档的滥用判别**中起作用。冒充他人客户端绕限额不是本插件该做的事
  （用户选的是付费面，本就不需要这两个头）
- **不注入** `User-Agent`——它是 `@deepseek-ai/dsh-llm` 的 attribution 保留名（`APP_IDENTITY` 无配置缝），
  宿主层面就不可覆盖
- **不注入** `x-opencode-request`——其语义是"会话内递增"（`msg_1`/`msg_2`…），本模块只能给静态值，
  写个假的递增 id 比不写更糟

### ⑤ 装配与失败语义
- **三层触发**（照 skiff 先例，单点触发在同装载竞态下必然漏）：① apply 立即试一次
  ② 命名空间未注册 → 退避重试 1s/3s/8s/20s/40s（`llm-pi-ai` 与 dsp 都依赖 settings，**装载无先后保证**）
  ③ `settings/updated` 且 `ns === 'llm-pi-ai'` → 复评（用户热改 settings.yaml 时自愈；
  自身写入触发的复评是幂等空转）
- **失败语义（F-08/F-07 纪律）**：**任何失败都不抛给宿主**——apply 抛错 = **整个 dsh 启动失败**。
  一律 try/catch + 响亮告警 + 指引手抄，最坏情况退回"用户手抄头"；
  重试定时器随卸载/HMR **拆卸**（`registerDisposer`）
- 幂等核心：无事可做时**不写**（避免无谓触发 `settings/updated`）

### ⑥ 声明面
- `src/index.ts`：`Config.opencodeProvider?: { autoConfigure?: boolean }`，schema **缺省 true**
  （用户裁决 L1+L2 默认都开）
- `src/host/contract.ts`：`settings` 服务成员增 `get` + `update`（检查数 **36 → 38**），impact 文案同步

### 测试（78 files / 1169 tests，+30）
- 新增 `tests/opencode-provider.test.ts`（30 用例）：纯函数穷举（路由判定含 **4 条误伤反向用例** /
  别名双向 / 大小写不敏感 / 幂等 skip / 多路由互不影响 / 容错不抛）+ settings 面执行
  （写入形状 / **this 绑定** / 无事不写 / 写被拒告警 / 读抛错告警 / 服务缺失告警）+ 装配订阅
- `tests/register.test.ts`：拆卸标签 **5 → 6**（新增 opencode 重试定时器）
- **收到的红**（前一载体遗留 2 个，本轮处置）：
  ① 期望写错——`X-Session-ID` 与 `x-opencode-session` 是**两个头名**，用户只写后者时前者确实该补；
  改为断言**补出的值 == 用户写的值**，并补反向别名用例
  ② 代码死分支——`nothing-to-do` **不可达**（路由循环后必已推入 fill/skip 或末段 no-route/create-route，
  动作列表从不空）→ 删除该分支与联合类型成员；**同属死代码的 `'no-env-key'` 一并删除**
  （"没有 key" 路径实际发 `no-route`），无 key 用例的 `as never` cast 随之消掉

### 待用户（D14）
发布链（publish + 三推 + specs/根仓 push + deploy + restart-web）**未执行**。
真机生效还需把 `OPENCODE_API_KEY` 放进环境（本机 `llm-pi-ai` 当前 `config:` 为空）。

## v1.31.6 — 2026-09-10（宿主硬切 DSH 0.1.5-rc.1：6 条真实突破 + 新宿主类型基线工具）

**Scope:** 用户裁决「peer 改 `^0.1.5-rc.1`，只验新宿主，不做 0.1.2-rc.1 双基线」。
方案全文见 [`docs/dsh-0.1.5-rc-adaptation-plan.md`](docs/dsh-0.1.5-rc-adaptation-plan.md)。
**本轮不发布**（用户明示：他回家后自行安装 0.1.5-rc.1 再做运行时验证）。

### ① 适配轮工具（`scripts/`，内部运维脚本不进公开仓）
- **`host-fetch` 新增 `pkg@version` 逐包钉版本**——`cordis` / `schemastery` 不跟宿主版本号走
  （实测 0.1.5-rc.1 已升 cordis `^4.0.2`、schemastery `^3.18.2`）
- **新增 `typecheck-host <version>`**：用 `_tmp/host-<ver>/` 解包宿主做**类型对账**，不需要安装新宿主。
  派生一次性 tsconfig（仅覆写 `paths`，编译选项逐字继承基准）；**自带假阳性防护**——
  改写过的 paths 逐条存在性检查 + `tsc --listFiles` 统计命中解包宿主文件数，0 即 fail。
  开发中真实踩到该陷阱（首版 `indexOf` 切错 `node_modules`，28 条 paths 全指向不存在的目录而 tsc 仍"绿"）
- **实证**：node 半载入解包宿主 78 文件 / client 半 103 文件，paths 29+14 条全命中

### ② 契约表对账：17 服务 + 10 事件**全部存活**（零改动）
`src/host/contract.ts` 逐条核对 `_tmp/host-0.1.5-rc.1/`：`tools`/`sessions`/`agents`/`webServer`/
`settings`/`web`/`systemPrompt`/`sessionProjections`/`skills`/`shellEnv`/`agentLoop`/`subagents`/
`sessionTitle`/`tokenMeter`/`workspaceRegistry`/`sessionPersistence`/`connection` 的成员签名全兼容；
10 个事件名经 `satisfies readonly (keyof Events)[]` **编译期**通过（这是 dsp 侧唯一的自动化契约断言）。

### ③ 类型面突破（4 条，全在 client 半）— 根因是**隐式传递可达性断裂**
- **现象**：`props.sessionId`（FileFallbackDock / ImageFallbackDock / SafeModePanel）与
  `ctx.sessions`（image-fallback-api）在新宿主下编译失败
- **根因（R↓，勿误判为"新包"）**：`SessionStandardProps.sessionId` 的声明源一直是
  `@deepseek-ai/dsh-client-ui-session`（**0.1.2 就已存在**，非新包）；dsp 此前靠
  `ui-conversation` 的**类型传递可达性**间接拿到它，而 0.1.5-rc.1 的
  `ui-conversation` 不再合并 session 标准套件（`ui-slots` 的三个 StandardProps 接口本体为空，
  注释明示声明权在 ui-session）→ 传递链断掉
- **修复**：`src/client/index.ts` 增 `import type {} from '@deepseek-ai/dsh-client-ui-session'`
  （空类型导入，只为显式化声明可达性）+ 两处 tsconfig `paths` 补映射（含
  `@deepseek-ai/dsh-api-session-controller/client`——不映射则 `Context.sessions` 的合并进不了 program）
- **净收益（超出预期）**：修复**双向兼容**——`dsh-develop typecheck`（本机 0.1.2-rc.1）与
  `dsh-develop typecheck-host 0.1.5-rc.1` **同时通过**。隐式依赖改显式依赖在类型面没有硬切代价

### ④ 静默运行时突破（2 条）——类型检查**看不见**，只能读宿主源码发现
- **`src/client/image-fallback-api.ts`**：宿主 `IConversation.draftImages(ids)` **已改名**
  `resolveDraftAttachments(ids)`（同语义同返回）。调用点用结构化断言隔离宿主（零宿主 import 策略），
  旧名消失 → 运行时 `=== undefined` → 静默返回 `[]` → **图片落盘兜底悄悄失效**
- **`src/skiff-debug.ts`**：`sessionPersistence.list()` 返回形状变更——
  0.1.2 `SessionHeader[]`（`h.cwd`）→ 0.1.5-rc.1 `SessionPersistenceSnapshot[]`（`h.header.cwd`）。
  形状由 dsp 自写断言决定，宿主改形在类型面不可见 → 通道 ② 静默失效 →
  **工作区注册表为空时的 CCC 自动发现**拿不到候选（该通道正是为此兜底而存在）
- **代价边界（已实测确认）**：这两条是**单向**的——0.1.2-rc.1 下会退化；类型面（③）则双向兼容

### ⑤ 声明面硬切
- `hooks/package.json`：17 项 peer → `^0.1.5-rc.1`；`cordis`·`@deepseek-ai/cordis` → `^4.0.2`；
  `@deepseek-ai/schemastery` → `^3.18.2`；description 同步
- `hooks/dsh.plugin.json`：`engines.dsh` → `>=0.1.5-rc.1`；description 同步
- `src/host/contract.ts`：`REQUIRED_HOST_RANGE` → `^0.1.5-rc.1`，且 **floor 改为从该常量派生**
  （此前 floor 是独立硬编码字面量——"常量说一个、判定用另一个"的双真相源；ceiling 因 caret 语义
  无法机械派生，保留显式常量并注理由）
- `.gitignore`：补 `_tmp/`（host-fetch 产物此前未被忽略）与 `tsconfig.host-*.local.json`

### ⑥ 明确不改的（避免过度适配）
面板 API `main`/`main.conversation` 是**新增**（dsp 用的槽位全存活）｜persona 前缀/后缀指宿主
`dsh-persona`（dsp 的 persona 是 CCC 自有配置，同名不同物，section 名无碰撞）｜
`HttpFetchProvider` 构造签名与 `HttpFetchResolver` 契约未变（fake-ip 接管仍成立）｜
Session 格式 V3（dsp 不读原始日志）｜`agentLoop.create()` 异步化与 session 锁（dsp 不直接调）｜
移除 `ctx.agent`（dsp 用事件 payload 与 `exec.agent`）｜Inbox 接口化（`prepend` 保留，未用私有成员）

### 测试（77 files / 1139 tests，+6）
- 首轮 6 红全部为硬切预期，逐条修正并**补反向用例**（锁死契约方向）：
  - `compliance.test.ts`：schemastery 断言同步 + **F6b**（cordis 双映射必须同版本范围）+ **F6c**（dsh-* 不得混版）
  - `host-contract.test.ts`：版本字面量**改为从 `REQUIRED_HOST_RANGE` 派生**（此前写死旧下限 →
    换宿主版本时测试红的原因变成"测试写死"而非"契约坏了"，真假报警无法区分）+ 硬切判据用例 +
    floor 派生判据（常量与 floor 脱钩即失败）
  - `image-fallback.test.ts`：+「只提供旧名 `draftImages` → 视为未装配」（旧名不得静默走通）
  - `skiff-debug.test.ts`：原用例改用 `{header:{cwd}}` 新形状 + 「0.1.2 顶层 cwd 不再被采用」反向用例

### 待用户（D14）
发布链（publish + 三推 + specs/根仓 push + deploy + restart-web）**未执行**；
运行时验证需用户先在本机安装 DSH 0.1.5-rc.1。

## v1.31.5 — 2026-09-10（CI 转绿：失败原文可读 + 两处机器耦合用例修复 + handyman 错误优先级）

**Scope:** 用户报告「github ci 报错了」。CI 自 v1.31.2（run #22）起连续三轮红，而**失败原文读不到**：
job log 需 admin 权限（匿名 403），check-run annotations 只有一句
`Process completed with exit code 1`。本轮先修**可观测性**，再修**两个机器耦合缺陷**。

### ① 可观测性：CI 失败原文进注解（免 admin 即可读）
- `.github/workflows/ci.yml`：Test 步骤改为 `set -o pipefail; pnpm test 2>&1 | tee "$RUNNER_TEMP/vitest.log"`
  —— **`pipefail` 是阻塞门的前提**（否则管道退出码取自 `tee`，vitest 红而 step 绿，门禁静默失效）
- 新增 `Test failure digest (annotations)` 步骤（`if: failure()`）：把 vitest 的 `Failed Tests` 段与末尾
  汇总转成 `::error` 注解（换行转义 `%0A`）→ 排查者无需仓库权限即可看到**失败用例名 + 断言差异**
- 实证价值：本版本的两个缺陷正是**首次运行该步骤即定位**（此前三轮只能看到 "exit code 1"）

### ② `handyman` foreground 错误优先级（生产代码）
- `src/tools/handyman.ts`：把「前台委派必须有发起方」的校验**前移到 CCC 解析之前**
  （`runForegroundJob` 内的重复校验删除——单一真相源，前置条件写进其 JSDoc）
- **为什么**（R↓，CI 实证）：`agentCwd()` 在无 `exec.agent` 时回落 `process.cwd()`，而该 cwd 未必在
  任何 CCC 内（CI runner 的 cwd = 仓库根，祖先链无 `.serenity`）→ 原顺序先抛 `No CCC found`，
  **把真正的错误原因盖掉**；调用形态错误优先于环境错误是更准确的语义
- 附带收益：该用例不再依赖"运行目录恰好在某个 CCC 里"（原用例在本机靠 CCC 祖先目录**偶然通过**）

### ③ 两处机器耦合用例（可移植性）
- `tests/ops.test.ts`：MSM `exec` 直跑 `.ts` 需要 TS 运行时；无 bun 时 ACC 回落 `npx tsx`，而脚本位于
  `mkdtemp` 临时 CCC 目录 → npx 只能**联网拉取 tsx** → CI 偶发 exit 1
  （实证：run #22 `ops.test.ts:166 expected 1 to be +0`，同代码 run #25 通过）。
  改为 `HAS_BUN` 守卫（只在 bun 在场时断言执行；注册表扫描断言恒执行），
  对齐 `scripts/dsh-develop.test.ts` 的既有先例
- `tests/host/cordis-access.test.ts`（v1.31.4）：真实 cordis 用例在 CI runner（无 DSH 宿主）整体 skip，
  末尾保留"本机必须能解析到 cordis"的失败提醒

### 测试（77 files / 1133 tests，本地全绿；CI 侧 1122 passed + 11 skipped + 0 failed）
- 无新增用例（本轮修的是 CI 与用例可移植性）；`handyman-foreground.test.ts` 10 用例语义不变且**环境无关**

## v1.31.4 — 2026-09-09（修复：handyman foreground 在真实 cordis 下取不到 `ctx.subagents`）

**Scope:** v1.31.3 真机首测缺陷——`handyman(mode="foreground", …)` 报
`Error: cannot get property "subagents" without inject`。**background 不受影响**（走 `ctx.agents`）。

### 根因（源码级定论，R↓）
cordis 的 Context 是 Proxy：`ReflectService.handler.get` 对**未经 `inject` 声明**的服务名会沿
fiber 链查找，找不到时**抛错**（`if (!fiber.runtime) throw error`），而**不是**返回 `undefined`。
dsp 的 `hostInjected()` 此前先做**无保护的直接属性读** `ctx?.[name]`，异常直接逃逸——
`hostService` 的 try/catch 被绕过，回落分支永不执行。

`subagents` 是 **lazy** 服务（不在 `src/index.ts` 的 `inject` 列表——把它加进 inject 会让整个插件
在宿主缺少该服务时无法装载，不可接受），其**正确读法是 `ctx.get`**（cordis docstring：
*Read a service from the store without the inject requirement*），与 `host/contract.ts`
的 `access:'lazy' → hostService` 一致。

**关键佐证**：真机 `dashboard health` 的 host-contract **36 项全过、`issues:[]`**——该探针读
`subagents` 走的正是 `ctx.get`，说明**宿主确实提供了该服务**。故这是 ACC 访问层缺陷，
**不是** host↔ACC 集成缺口（外部诊断"宿主未注入"被其自身证据反驳）。

**复现条件（拓扑）**：服务须由**兄弟 fiber** 提供（真机 = dsh-subagent 插件自己的 fiber）。
若由祖先 fiber 提供，代理的 fiber 链查找会命中 `fiber.store` 直接返回——这正是误判"服务缺失"的成因。

### 修复
- `src/host/access.ts`：`hostInjected` 的直接属性读包 try/catch → 失败回落 `hostService`
  （遵守本模块契约：服务不可用一律 `undefined`，**不抛错**——宿主对插件 apply 抛错 = 整个 dsh 启动失败）
- `src/tools/handyman.ts`：foreground 服务缺失分支改为**可行动报错**（指引 `dashboard health`
  的 host-contract 段与 `mode="background"` 仍可用）

### 测试（76 files / 1120 → **77 files / 1133**）
- 新 `tests/host/cordis-access.test.ts`（**真实 cordis**，11 用例）：按"离运行时最近"探测宿主实例
  （profile-runtime `cordis@4.0.0-rc.7` + host-install `@deepseek-ai/cordis@4.0.2`），逐实例钉死
  ① 兄弟拓扑下未声明 inject 的直接属性读**确实抛错**（回归成因，前提断言）
  ② `hostSubagents` / `hostInjected` 回落 `ctx.get` 取到服务（修复结论）
  ③ 服务注销 → `undefined` 且不抛 ④ 声明 inject 的路径照旧可用（injected 面未被削弱）
  ⑤ `probeHostContract` 与访问面一致；末尾可用性自检（本机解析不到 cordis 即失败提醒补路径）
- `tests/host/access.test.ts` +2：CI 可跑的"属性读抛错"代理替身回归（真实 cordis 用例在 CI 上 skip）
- **教训**：宿主访问层**必须有真实 cordis 用例**——fake ctx 是普通对象，属性读只返回 undefined，
  永远复现不了这类缺陷（v1.31.3 的 10 个 foreground 用例全绿，却挡不住真机报错）

## v1.31.3 — 2026-09-09（handyman 双模式：foreground 缺省 = 一次前台串行委派；background = 既有循环校验）

**Scope:** 用户需求——「ACC subagent 工具支持按角色指定模型」，落地裁决链（R↓）：
① 「dsh 有配置但没放开估计是有原因的，我们要在 ACC 层去自动实现才行；所以我主要考虑 B 面」→ **不走宿主
未放开的 `subagent-model-selection` 设置**；
② 「具体的 CCC 总是会指定低成本模型，所以只要有个 subagent 机制可以使用低成本模型就好」→ 目标收窄为
**一个能用 CCC 配置的低成本模型的委派机制**；
③ 「名字上我们都叫 handyman 吧，分为 background 和非 background 两种，前者是旧的自带循环校验的实现，
后者是我们本次所需的简单实现」→ **不新增工具，`handyman` 加 `mode` 维度**（工具面 11 不变）。

### 形态
| 模式 | 实现 | 语义 |
|------|------|------|
| **foreground（缺省，v1.31.3 新）** | 宿主委派正门 `ctx.subagents.start('spawn', {parent, prompt, signal, agentOptions:{provider,model}, toolFilter:{deny:['handyman']}})` → `await run.result` → `dispose()` | 一次前台串行委派，返回子 agent 最终文本；**不循环、不校验完成码、不写进度文件** |
| **background** | 既有实现（`ctx.agents.create` + 内部 while 硬循环 + 随机完成码唯一判据 + 轮次上限 + 异常自动重启 + 进度文件 + `jobs` 并行） | **一行未改**；长任务/无人值守/抗提前收工 |

### ⚠️ 行为变更（缺省模式）
- **不传 `mode` 的调用从 background 变为 foreground**（用户拍板"缺省换成 foreground"）。
  需要旧的循环校验语义 → **显式传 `mode: "background"`**。
- 两种模式**共用** CCC 的 `handyman.models` 白名单与 `handyman.defaultModel`（**零新增配置**）。
- foreground 传 `jobs` 会被拒绝（jobs 属 background）；`task` 在 foreground 必须自包含（子 agent 不共享本会话上下文）。

### 实现
- `src/tools/handyman.ts`：新增 `mode` 参数 + `runForegroundJob()`（模型解析复用 `splitModel` /
  `requireWhitelistedModel`；结果映射 `stopReason==='completed'` → done，其余 → errored 结果 +
  `diagnostic` + 部分产出，**不静默假装成功**；`dispose()` 必调）；description 重写为两模式 + 选择判据
- `src/host/access.ts`：新增 `hostSubagents()`（形状收口，`ctx.subagents.start`）
- `src/host/contract.ts`：服务表新增 `subagents`（lazy / `required: false` / 成员 `start`）→ hostContract 检查 34 → 35
- `src/handyman-ops.ts`：`HANDYMAN_GUIDE` 增"两模式"对照表 + 选择判据 + 白名单指向低成本模型的说明
- `src/seams/system-prompt.ts`：toolsBlock 的 handyman 行同步两模式

### 机制依据（源码级实证，安装版 0.1.2-rc.1）
- `SubagentStartRequest.agentOptions`（"in-process providers merge them over the parent Agent's options"）
- `dsh-subagent-spawn-in-process`：`capabilities = { agentOptions: true, toolFilter: true, … }`
- `SubagentRun.result` / `dispose()`；`SubagentResult.{output, diagnostic, stopReason}`
- **不依赖** `subagent-model-selection` 设置（该路径与 `agentOptions` 无关）——故本方案无需改动宿主配置

### 测试（75 files / 1110 → **76 files / 1120**）
- 新 `tests/handyman-foreground.test.ts`（10 用例）：缺省走 foreground / 委派请求形状
  （`agentOptions`·`parent`·`signal`·`toolFilter.deny=['handyman']`）/ 结果映射与 `dispose` /
  非 completed → done=false + diagnostic / 白名单拒绝 / 服务缺失响亮报错 / foreground+jobs 拒绝 /
  缺 task 与非法 mode 拒绝 / 无 `exec.agent` 拒绝 / guide 不建 agent
- `handyman-ops.test.ts`：guide 断言同步两模式（含"default = foreground"与 `ctx.subagents.start("spawn")`）

### 文档
- README 中英双版工具表 handyman 行（两模式 + 缺省）；`msm-ops` CCC_CONFIG_REFERENCE §1 增"Modes"段
- 维护 skill 同步；方案全文 `docs/handyman-dual-mode-design.md` v0.3

## v1.31.2 — 2026-09-09（SESSION.md 体积上限缺省 100 → 200 KB）

**Scope:** 用户指令——「SESSION.md的默认阈值设定在200kb吧」。v1.31.1 引入的 LOGBOOK COMPACTION 提醒
缺省 100 KB，实测对**长期维护会话**偏紧：本 CCC 的 S142 日志达 292 KB，100 KB 阈值导致**每轮都催**
（提醒疲劳），而重写本身是一次大工程；200 KB 仍能把"无界增长"挡在门外，又给维护类会话留出一次
完整的重写周期。

### 变更
- `src/seams/keeper.ts`：`DEFAULT_SESSION_MD_MAX_KB` **100 → 200**（含理由与备选注释）
- 同步面：`src/ccc.ts` 字段注释 / `msm-ops.ts` CCC_CONFIG_REFERENCE §2（含示例 JSON）/ README 中英双版
  机械约束表 / 维护 skill / specs §3.1 + §5.11
- `tests/keeper.test.ts`：阈值用例补**缺省值硬断言**（`DEFAULT_SESSION_MD_MAX_KB === 200`）——
  缺省值是可被静默漂移的事实，用断言钉住（同 v1.31.1 声明面教训）

### 行为影响（向后兼容）
- **未显式配置** `sessionKeeper.sessionMdMaxKB` 的 CCC：提醒阈值从 100 KB 变为 200 KB（提醒更少）
- 显式配置（含 `0` = 关闭）的 CCC：**行为不变**——CCC 级配置始终优先于缺省值
- 提醒文案、四条原则、连续 3 轮升级、回限内自愈等机制均不变

### 决策（R↓）
- 备选：保持 100 KB（催得勤但疲劳）/ 只改本 CCC 配置（新容器默认仍无指引，且用户明说"默认阈值"）→ 取"改 ACC 缺省值"

## v1.31.1 — 2026-09-09（trajectory-assistant 增强：SESSION.md 体积超限重写提醒 + rebuild 交接协议）

**Scope（用户两条需求，同批发布）：**

**需求①（SESSION.md 体积超限）**——「当 SESSION.md 文件大小超过 100KB 的时候，提示 trajectory 暂停工作加载 eap 进行
SESSION.md 重写，重写的原则是保留 eap 分层骨架、内容可以单独写入 reference 文件、允许整合不重要事项、
自主裁量权被充分允许」。动机实证：本 CCC 的 S142 会话日志已达 **285 KB**——轨迹身体（SESSION.md）
只增不减，认知读取成本（H_op）随轮次上升，而现有 rebuild 机制只换载体（会话），
**不会让 SESSION.md 变小**。

**需求②（rebuild 交接）**——「在 rebuild 提示机制中，要求 LLM 将当前手头事项写在 SESSION.md 尾部，
并要求 rebuild 后去读并处理」。动机：rebuild 只换载体、轨迹身体不动，但**手头正在做的事**
（卡在哪一步 / 尚未完成什么 / 下一步动作）此前只存在于被丢弃的会话里——重建后的自己从 SESSION.md
重建上下文，却不知道上一个自己被打断在哪里。**写侧**要求把 in-flight 事项写到 SESSION.md 末尾的固定标题下；
**读侧**在重建锚点里要求去读那一段并逐项处理（区块缺失则从最新进度条目推断）。

### 新增提醒 `[TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]`
- **触发**：活跃 SESSION.md 字节数 > 上限（缺省 **100 KB**）——在 `seams/keeper.ts` 的
  `tools/post-execute` 里检查（与 CHECKPOINT 计分提醒、LIMIT 上下文压力提醒同族，**独立判定**）
- **动作**：提示暂停当前工作 → 加载 eap（`praxis eap`）→ 按 EAP 分层骨架重写 SESSION.md
- **四条原则（用户原话逐条落成可执行判据）**：① 保留 EAP 分层骨架（不压成时间流水账）
  ② 内容可外移到 references 文件（`AGENT_SESSIONS/<会话>/references/*.md`，SESSION.md 留链接）
  ③ 允许整合/删除不重要事项（被取代的决策、已解决问题、中间态）
  ④ 自主裁量权充分允许（唯一硬要求 = 骨架 + 未决项/决策理由/下一步仍可重建）
- **节奏**：超限每轮提醒；连续 3 轮未重写 → 升级强制语气（mandatory + STOP）；
  文件回到限内 → **自动停止**（自愈，无需额外状态复位）
- **不机械阻断**：与 LIMIT 提醒同族（提示 + 可观测），不做事 turn-stopping 打回——
  重写是大工程，强行打断会破坏正在进行的任务

### 配置（CCC 级，用户拍板"默认 100KB + CCC 可覆盖"）
- `sessionKeeper.sessionMdMaxKB`（缺省 100；**0 = 关闭**）——与既有 `sessionKeeper.threshold` 同段；
  理由（R↓）：不同 CCC 的 SESSION.md 规模差异大，硬编码会把小容器逼成无效提醒

### 归属（D23 + 用户拍板 Q1）
- **ACC 内嵌机制事实 + 4 条原则**（而非"ACC 只给机制、原则放 CCC 入口 skill"）：这 4 条是
  **认知质量规范**（与 EAP 同层，不是会随角色迭代的措辞），且任何未写该纪律的 CCC 装上即生效。
  备选（原则放 CCC）代价：逐 CCC 配置 + 新容器默认无指引

### rebuild 交接协议（需求②：in-flight 区块，写侧 + 读侧共用同一常量）
- **单一真相源 `IN_FLIGHT_HEADING = '## In-flight (rebuild handover)'`**（`trajectory-assistant.ts`）：
  写侧与读侧引用**同一个常量**——标题一旦漂移，读侧就找不到写侧写的区块。形态为用户拍板
  **固定英文标题行**（非 HTML 注释锚）：人读友好；ACC 写死英文，因为 SESSION.md 正文语言归 CCC，
  但两侧的**机械锚点**必须逐字一致
- **写侧**（`seams/keeper.ts` `rebuildReminderText`）：两条文案（普通 + escalated）都插入 handover 句——
  要求把当前 in-flight 事项（正卡在哪一步 / 尚未完成什么 / 下一步动作）写在 **SESSION.md 最末尾**、
  标题之下。**只在 rebuild 提醒（LIMIT）里要求**（用户拍板 Q3）——不占每轮注入
- **读侧**（`rebuild.ts` `buildRebuildAnchor`）：在 "Read that SESSION.md first…" 之后新增一行——
  要求读文末的 in-flight 区块并逐项处理（上一个自己在任务中途暂停并交接）；
  **区块缺失 → 从最新进度条目推断**（存量 SESSION.md 无该区块，不能空转）
- **读侧取"软指令"而非机械摘取**（用户拍板 Q1）：锚点只给一句指令，由重建后的自己读 SESSION.md
  取内容——机械摘取会把区块内容复制进锚点，制造第二真相源

### 实现
- `src/trajectory-assistant.ts`：词汇表新增 `compaction: 'LOGBOOK COMPACTION'`（D8 自然词，
  无游戏黑话）+ metaphor 变体同名 + 新导出 `IN_FLIGHT_HEADING`
- `src/ccc.ts`：`SerenityConfig.sessionKeeper` 扩为 `{ threshold?, sessionMdMaxKB? }`
- `src/seams/keeper.ts`：新 `DEFAULT_SESSION_MD_MAX_KB` / `resolveActiveSessionMdPath`（**短候选链**：
  活跃会话信息 → `.bindings.json` 权威绑定；**不猜别的轨迹**——对齐 v1.30.13 D4 教训）/
  `readFileSize` / `readSessionMdMaxKB` / `logbookCompactionReminderText`（纯函数）/
  `forgetLogbookCompactionState` / `compactionStateSnapshot`；路径与阈值各带 60s TTL 缓存
  （每个工具调用都要跑，贵候选不划算；`statSync` 每次做，很便宜）；`rebuildReminderText` 加 handover 句
- `src/rebuild.ts`：`buildRebuildAnchor` 新增 in-flight 读侧指令行
- `src/seams/lifecycle.ts`：会话销毁清理路径缓存与超限计数（review F-08 同族，防 Map 无界增长）

### 声明面修复（顺带发现——v1.31.0 遗留的工具面三处未同步）
- **现象**：v1.31.0 新增 `im-bridge`（工具面 10 → 11）时只改了 `src/tools/*` 注册与 README/skill，
  **漏改 `src/invariant.ts` REGISTERED_TOOLS 与 `dsh.plugin.json` contributes.tools**——两侧同错 →
  `verifyToolConsistency` 报零问题（**陈旧的双侧一致 = 静默通过**），而代码实际注册 11 个；
  两个包的 `description` 也仍写「10 个工具」且不含 im-bridge（npm 页面 / 插件清单展示面陈旧）
- **修复**：REGISTERED_TOOLS + `contributes.tools` 补 `im-bridge`（11）；`package.json` /
  `dsh.plugin.json` 描述 10 → 11 且列出 im-bridge；`tests/invariant.test.ts` 补**真实清单断言**
  （用 `import.meta.url` 定位 `dsh.plugin.json`，不依赖 cwd）——把"双侧陈旧"变成会红的测试
- **教训（写进 invariant 注释）**：工具面变更必须同时改三处（`tools/*.ts` 注册 / REGISTERED_TOOLS /
  `dsh.plugin.json`），否则不变量本身变成漂移的一部分

### 测试（75 files / 1096 → **75 files / 1110**）
- 集成 6 用例：超限注入（token/体积/阈值/路径/4 原则齐备）/ 未超限零注入 + 重写后自动停止 /
  连续 3 轮升级 / `sessionMdMaxKB: 0` 关闭 / 未绑定或文件缺失不提醒不抛错 / skiff 角色
  `trajectory.session` 关闭时不提醒
- 纯逻辑 5 用例：文案两态 / 阈值四态（缺省、配置、0、坏值回落）/ 路径解析（优先 + 缓存 + 清理）/
  文件字节数 / 状态快照与清理
- 交接协议 4 用例：`keeper.test.ts` 两条 `rebuildReminderText` 断言（普通版 + 升级版：标题常量 /
  `at the very end of SESSION.md`）+ `rebuild.test.ts` 两条 `buildRebuildAnchor` 断言
  （**读侧**：标题常量 / 末尾语义 / 缺失兜底句 / 位于 "Read that SESSION.md first" 之后；
  无激活会话名的分支同样带该指令）
- 声明面 3 用例：`invariant.test.ts` 11 工具一致性 + REGISTERED_TOOLS 含 im-bridge +
  **真实 `dsh.plugin.json` 与常量一致**（防双侧陈旧再次静默通过）

### 文档
- `msm-ops.ts` CCC_CONFIG_REFERENCE §2：`sessionKeeper` 段补 `sessionMdMaxKB`（含四原则摘要）
- README 中英双版：机械约束表新增「工作日志体积提醒」行
- 维护 skill：Layer 2 keeper 行 + 版本主线 v1.31.x + 变更日志 v1.20
- specs v1.5.2：§5 Induction / §4 契约面同步（LOGBOOK COMPACTION 事件 + `sessionMdMaxKB` 配置 +
  in-flight 交接协议）

## v1.31.0 — 2026-09-09（IM 发送能力归 ACC：新工具 `im-bridge`，条件可见，S142 用户洞察）

**Scope:** 用户原话——「既然微信桥是我们 ACC 提供的，那么 weixin-send 应该是我们 ACC 提供的能力，
当用户配置了微信桥则可用，不配置则不可见，按照这个思路出个方案」。此前该能力**分裂在两处**：
ACC 侧有发送机制（`sendProactiveText` + outgoing hook），CCC 侧又有一份 492 行 MSM 重复持有协议、
凭据、账号选择与 `send-file` 的 CDN 上传（且它不经桥时还要自己补记事件）——机制层与内容层的归属错位。
本版把发送能力**收归 ACC 并做成一个工具**，CCC 只保留「何时发 / 发什么 / 怎么写」。

### 用户三决策（R↓）
| # | 决策 | 理由 / 备选 |
|---|------|------------|
| D1 | 工具名 = **`im-bridge`**（`channel` 维度留其他 IM 扩展空间） | 家族式多层工具；连字符与既有 `autopilot-trajectory` 同例。备选：`weixin`（无扩展空间）/ `weixin_send`（下划线风格不一致） |
| D2 | 范围 = **P1 一次做完并删 CCC MSM** | 避免"两套通道并存"的长期熵（旧通道一旦留下就会被复制）。备选：P1 兼容 → P2 吸收 send-file → P3 退役（周期长、双真相源） |
| D3 | **取消 `ccc` 参数**（工具只能操作本会话 CCC） | 防误发他容器（R4）。代价：跨 CCC 主动发送不再支持——确有需要者走 3082 HTTP 入口 |

### 新增工具 `im-bridge`（工具面 10 → 11）
- **参数**：`channel`（通道 id，目前 `weixin`）/ `action`（`send` / `send-file` / `users` / `status`）/
  `user`（别名或通道内 id）/ `text` / `file` / `caption` / `account`
- **条件可见**（用户原话"不配置则不可见"）：本 CCC 未启用任何 IM 通道 → 由 `seams/guards.syncImBridgeVisibility`
  调 `agent.ctx.tools.restrict({ deny: ['im-bridge'] })` 把工具**从 schema 移除**（不是"看得到但被拒"），
  与 safe-mode 同一机制（每步同步 → CCC 配置热更新即时生效）；会话销毁时 `forgetImBridgeVisibility` 清理状态
- **进程内直调**：工具 → `im-bridge`（能力层）→ `im-weixin`（通道）→ `sendProactiveText` / `sendFileMessage`，
  零 HTTP 一跳（3082 入口保留给**非 agent 调用者**）
- **稳定错误码**：`CHANNEL_REQUIRED` / `CHANNEL_UNKNOWN` / `CHANNEL_NOT_CONFIGURED` / `ACTION_UNKNOWN` /
  `ACTION_UNSUPPORTED` / `USER_REQUIRED` / `ALIAS_UNKNOWN` / `TEXT_REQUIRED` / `TEXT_TOO_LONG` /
  `FILE_REQUIRED` / `FILE_ESCAPE` / `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `SEND_FAILED`（每条带可行动提示）

### 分层（E↑）
| 文件 | 职责 | 边界 |
|------|------|------|
| `src/tools/im-bridge.ts` | 工具面：参数 → 从 agent cwd 解析**本会话 CCC** → 渲染结果 | 不接受目标 CCC |
| `src/im-bridge.ts` | 能力层：通道注册表 / 可见性判据 / 动作分发 / 错误码翻译 / CCC 内文件读取 | **零宿主依赖**（可独立单测）；不认识"微信" |
| `src/im-weixin.ts` | 微信通道：判据 / 别名解析 / 发送 / 记录 | 协议与记录复用桥，不重写 |

### 实现
- `src/im-weixin.ts`（新）：`isEnabled` = `weixin.enabled`；`resolveUser` / `listUsers`（`WEIXIN_USER_YH/DANICA/XIAOWANG`，
  与旧 MSM 逐字一致 → 迁移零认知成本）；`send` → `sendProactiveText`；`sendFile` → `resolveWeixinAccount` +
  `sendFileMessage` + caption 文本 + 同一 outgoing hook（`source: 'proactive'` + `file` 元数据）；`status` 显式映射
  JSON 安全形状（`undefined` 字段用条件展开剔除）
- `src/weixin-api.ts`：新增 `sendFileMessage()`（getuploadurl → CDN AES-128-ECB 上传 → sendmessage FILE item，
  逐行移植旧 CCC MSM 语义）——`send-file` 从"CCC 自己实现"变为 ACC 能力
- `src/weixin-bridge.ts`：新 `resolveWeixinAccount(root, accountId?)`（**账号选择单一真相源**，`sendProactiveText`
  改为复用它）；`weixinManualOutputMarker` 改输出 `im-bridge(...)` 形态（**不再含 `--ccc`**）
- `src/weixin-hook.ts`：outgoing 事件/入参加 `file?: { name, size, caption? }` + 构造透传
- `src/weixin-output-guard.ts`：成功判定同时认 `im-bridge`（channel=weixin + action ∈ {send, send-file}）与
  兼容形态 `msm("weixin-send", …)`；打回文案改为 `im-bridge(...)` 命令
- `src/index.ts`：`registerImChannel(weixinChannel)` **在工具装配之前**（description 读通道枚举）+
  `ctx.tools.register(createImBridgeTool())`
- `src/seams/context.ts`：`seed` 与 `pre-step` 两处调用 `syncImBridgeVisibility`（与 safe-mode 同点）

### 退役 CCC 侧 MSM（P1 迁移）
- 删除 `.opencode/skills/home-serenity/scripts/weixin-send.ts`（492 行）+ `container_admin msm deregister weixin-send`
- CCC 配置：`skiff.roles.zhaocai.tools` + `im-bridge`、`msms` − `weixin-send`；autopilot `topPrompt` 改工具形态
- CCC 提示词与指南：`.opencode/skiff/zhaocai.md` 全量改 `im-bridge` 形态（含"无 ccc 参数、只能操作本会话 CCC"）；
  `weixin-doctor guide` §7 重写（工具形态 / 可见性 / 错误码 / 旧通道退役说明）

### 测试（73 files / 1050 → **75 files / 1096**）
- 新 `tests/im-bridge.test.ts` **22 用例**：通道注册表 / 可见性判据（含单通道抛错不影响其他）/
  `runImBridge` 全矩阵（14 个错误码 + 成功路径）/ 文件三类拒绝 / 结果 JSON 可往返
- 新 `tests/im-weixin.test.ts` **20 用例**：判据 / 别名解析（大小写、缺凭据、裸 id）/ `status` 三态与 undefined 剔除 /
  `send` 三态 / `sendFile` 六态（未启用 / 账号失败 / caption / 记录 / 无 hook / hook 失败旁路容忍）
- `tests/guards.test.ts` **+6**：隐藏幂等 / 配置热更新跟随 / restrict 抛错不阻断 / 会话清理 / 会话隔离
- `tests/weixin-output-guard.test.ts`：成功判定矩阵改双形态（im-bridge 正负例 + 兼容形态）；标记断言同步
- `tests/register.test.ts`：工具数 10 → 11；`tests/weixin.test.ts`：标记断言同步（末尾 `})`）

### 文档
- README（中英双版）：工具表 10 → 11（含"条件可见"说明）+ 微信桥章节改写 + 入口表 3082 定位澄清 + 基线刷新
- `msm-ops.ts` CCC_CONFIG_REFERENCE §8：主动发送段重写（工具形态 / 可见性 / 旧通道退役）+ `source` 说明
- `src/templates/acc-serenity/SKILL.md` + CCC `.dsh/skills/acc-serenity/SKILL.md`：11 工具 + 条件可见机制行

## v1.30.17 — 2026-09-09（手动模式兜底：不让消息丢掉，S142 用户拍板"鲁棒修法"）

**Scope:** v1.30.16 的机械闸门（打回 ≤2 次）在真实模型上失效——用户实测某模型在**寒暄类消息**（「你好」）上
连续 4 轮（turn 186/191/192/193）、跨 **3 版 CCC 提示词**（v0/v1/v2：v2 已写明"第一个输出必须是 weixin-send 工具调用"
并把可照抄的完整命令递到消息末尾）仍**零工具调用** → 闸门打回用尽后**用户什么都收不到**。
实证链：request/header 确认 v2 内容已在系统提示词中、`"type":"tool/call"` 在 turn 193 命中 0 条、
同一模型在**任务类**消息（turn 190）下正常调工具并发送成功 → 提示词与闸门均已排除，属模型遵循度问题。
用户拍板：**ACC 侧兜底（三态配置）**。

### 新增 `weixin.fallbackOnNoSend`（缺省 false = 严格静默，向后兼容）
- **语义**：仅在 `autoReplyWithLastMessage: false` 时生效。`true` → 一轮结束时若 agent **一次都没成功**
  调用 `weixin-send`（闸门打回用尽），桥把该轮最终文本转发给用户（记录 `source: "reply-fallback"`，
  日志留 `⚠ weixin 输出兜底` 告警）；agent 自己发过 → **不兜底**（输出权仍在 agent）
- **三态**：① `autoReplyWithLastMessage: true`（缺省）= 桥总是回发；② `=false` + `fallbackOnNoSend: true`
  = agent 优先、桥兜底（**推荐**）；③ 两者皆 false（缺省）= 严格静默（v1.30.10 语义）
- **代价（显式写入配置注释）**：角色失去"故意静默"能力（它总会产出一段最终文本）→ 需要严格静默的角色保持缺省
- **前置条件**：兜底只在**闸门装配成功**时生效（`isWeixinOutputGuardActive()`）——未装配则无法判定
  "是否发送过" → 宁可静默也不冒重复发送风险

### 实现（决策放桥、判定放闸门——R↓）
- `src/ccc.ts`：`WeixinSettings.fallbackOnNoSend?: boolean`（头注写全理由/代价/实证链）
- `src/weixin-route.ts`：`readWeixinSettings` 归一（只有显式 `true` 才启用）
- `src/weixin-hook.ts`：新 `WeixinOutgoingSource = 'reply' | 'proactive' | 'reply-fallback'`；
  `buildOutgoingHookEvent` 改为**透传非 `reply` 来源**（原实现只认 `proactive`，其余来源会被静默丢弃）
- `src/weixin-output-guard.ts`：新增 `clearSentThisTurn`（**桥在每轮开始清空**——turn 边界归桥）+
  `isWeixinOutputGuardActive`；**turn-stopping 不再清空标记**（否则桥读不到本轮结果、无法兜底）
- `src/weixin-bridge.ts`：新纯函数 **`manualOutputFallbackNeeded`**（四条件矩阵：开关 / 闸门装配 / 未发送 /
  有文本——把决策从装配里抽出来，可独立测试）+ `askSkiff` 后用**既有回复通道**（含 `context_token`）
  转发最终文本 + `source: "reply-fallback"` 记录 + 响亮告警
- **为什么兜底放桥而不是闸门（R↓）**：桥手里已有 `answer`（最终文本）与 `context_token`（正常回复通道），
  无需从会话事件里反查文本、复用既有记录路径；闸门只负责"本轮是否发过"的判定

### 文档同步
- dsp `msm-ops.ts` CCC_CONFIG_REFERENCE §8：新增 `weixin.fallbackOnNoSend` 段（三态速查 + 前置条件 + 实证）
  + outgoing 事件 schema 的 `source` 补 `reply-fallback`
- CCC `weixin-doctor guide` §5/§7：事件 `source` 三值 + 新增「兜底：不让消息丢掉（v1.30.17）」段
- CCC 侧 `.opencode/serenity.json`：home-serenity 开 `fallbackOnNoSend: true`（招财用）

### 验证
- 新 `manualOutputFallbackNeeded` 矩阵 **6 断言**（开启+未发送 → 兜底；已发送 → 不重复；缺省/显式 false → 静默；
  闸门未装配 → 不兜底；空文本 → 不兜底）
- 新集成用例 **2 个**：① `fallbackOnNoSend: true` + 闸门装配 + 本轮未发送 → 转发最终文本（`context_token` 回带）
  + hook `source: "reply-fallback"`；② 缺省 → 只有系统类「新对话」通知（严格静默）
- 闸门用例更新：标记保留到桥读取（turn-stopping 不再清空）+ `isWeixinOutputGuardActive` 两态 + 打回计数清零用例
  改为"桥在轮开始清空"语义
- **73 files / 1050 tests 全绿**（1045 → 1050）+ typecheck 双面 ✓ + build ✓

## v1.30.16 — 2026-09-08（手动输出纪律：措辞归 CCC + 机械闸门，S142 用户两条指令）

**Scope:** 用户两条指令——① "这句词哪里配置的：── Reply Output (manual mode) ── … 用 EAP 重写，约束不够，LLM 不听" ② "**这个词不能让 ACC 定义，要让 CCC 定义**"。即 v1.30.10 手动输出模式（`weixin.autoReplyWithLastMessage: false`）的注入文案既**软**（全陈述/举例/许可，无祈使硬约束，实测 LLM 不遵守）又**归属错误**（纪律措辞属内容，归 CCC）。

### 归属修正：ACC 只给机制与数据，措辞归 CCC
- `weixinManualOutputLine()` → **`weixinManualOutputMarker(root, accountId, userId)`**（`weixin-bridge.ts`）：只输出两行——标记 `[serenity:weixin-manual-output]` + **已填好参数的完整命令**（ccc/account/user），**零纪律措辞**
- 注入位置：用户正文**之前** → **消息末尾**（recency；旧位置被用户正文压过，实测约束失效）
- CCC 侧措辞写进**角色提示词文件**（如 `.opencode/skiff/<role>.md`）——可随时改，v1.30.15 起**热重载**（改文件即生效，无需 ACC 发版）
- 边界原则（沉淀）：**ACC 管机制与数据，CCC 管措辞与纪律**——提示词文案迭代不应需要插件发版

### 机械闸门（软约束失效 → 机械兜底）
新 `src/weixin-output-guard.ts`：
- ① `noteManualOutputSession`：桥每轮登记手动模式会话（root / account / user / role）
- ② `tools/post-execute` 观察**成功的** `msm` + `weixin-send`（`isSuccessfulWeixinSend`——失败调用不算已送达）
- ③ `agent/turn-stopping` 本轮结束仍未发送 → `agent.steer` 打回（`WEIXIN_OUTPUT_REBUKE_MAX = 2`）；提示内容 = 标记 + 事实（"本轮未发送，用户什么都没收到"）+ 已填命令，**不含措辞**
- 达上限放弃并**响亮告警**（用户确实什么都收不到，必须可观测）；成功发送清零计数；会话销毁经 `seams/lifecycle.ts` 的 `forgetManualOutputSession` 清理（防 per-会话 Map 无界增长）
- 只对**已登记的手动模式会话**生效——主舱 / 其他 skiff / ACP 临时会话零干预；事件通道缺失 → 响亮降级，不阻断装配（apply 不可成为启动单点）

### 文档同步
- dsp `msm-ops.ts` CCC_CONFIG_REFERENCE §8：`weixin.autoReplyWithLastMessage` 段改写（标记形态 + 措辞归属 + 闸门语义）
- CCC `weixin-doctor guide`：「关闭桥的自动输出」段同步（标记 + 闸门 + 措辞归 CCC）

### 验证
- 新 `tests/weixin-output-guard.test.ts` **19 用例**：成功判定矩阵（失败 / 非 msm / 形状异常）/ 登记注销幂等 / 打回文案含标记与已填命令且**不含纪律措辞** / 成功不打回且本轮结算清空 / 失败仍打回 / 其它 MSM 不计入 / 达上限响亮告警 / 成功清零计数 / 未登记会话零干预 / agent 缺失零干预 / 事件通道缺失降级
- `weixin.test.ts` 手动模式用例改写：断言新标记 + 已填参数命令 + **不含 `Reply Output` / `no fallback` / `will NOT`** + 标记位于用户正文**之后**（末尾）；对照用例改断言不含新标记；afterEach 清闸门模块级状态
- **73 files / 1045 tests 全绿**（1026 → 1045）+ typecheck 双面 ✓ + build ✓

### 发布后修复（2026-09-08，用户"dsp 的 github 我看到有 ci 失败 研究下原因"）

- **根因（三层实证）**：CI 旧版用 `npm install`，13 次运行全红（失败在**依赖解析**阶段，6 秒）——
  `npm install --dry-run` 报 `Cannot read properties of null (reading 'edgesOut')`；逐包二分锁定
  **`tsdown@^0.22.14`**；上游 = **npm/cli issue #9787**（arborist `#loadPeerSet` 未判空的 null 解引用，
  触发形态 = "自引用同版本 + 通配符"的可选 peer 集合，tsdown 正是此形态）；CI 的 Node 22 自带 npm 10.x。
- **CI 改 pnpm + 锁文件**（本仓本就是 pnpm 项目：hooks 自带 `pnpm-lock.yaml`、根 `packageManager`）：
  `pnpm/action-setup`（版本单一真相源 = `packageManager: pnpm@11.20.0`，两处版本会报 "Multiple versions"）
  → 根 + hooks 各自 `pnpm install --frozen-lockfile --ignore-scripts` → `pnpm test`（根 vitest 配置覆盖
  根 tests/ + hooks tests + scripts tests）→ typecheck 设为 `continue-on-error`（信息性：宿主类型基准是
  本机硬编码 paths，见 ci.yml 头注）。
  - `--ignore-scripts` 的两个理由（各一实证）：① pnpm 10+ 对未批准构建脚本**硬失败**
    （`ERR_PNPM_IGNORED_BUILDS: esbuild`）；② hooks 的 `prepare`（tsdown + tsc）依赖本机 paths。
  - **顺带修复过期锁文件**：`hooks/dsh-serenity-hooks/pnpm-lock.yaml` 与 package.json 不一致
    （18 个 peer 只在 package.json）→ `pnpm install --lockfile-only` 重新生成（68 KB → 122 KB）。
- **测试可移植性修复**：`weixin-send-api.test.ts` 的 `matchCcc` 用例写死开发机 CCC 路径
  （`/home/yh/home/home-serenity`）→ CI 上 `no CCC found from path` 失败；改为**自建临时 CCC**
  （`mkdtemp` + `.serenity` + afterEach 清理），任何机器/CI 都可复现。
- **防重复收集**：根 `vitest.config.ts` 加 `exclude`（`.pnpm-store` 在 hooks 目录内，其 projects
  缓存带一份项目文件副本 → `hooks/**/tests/**` 会把同一测试收集两次，实证固定端口 3182 假 EADDRINUSE）。
- 验证：**73 files / 1045 tests 全绿**（本机）+ CI run 见 Actions。

## v1.30.15 — 2026-09-08（Skiff 类型二分 + 角色提示词热更新，S142 用户拍板）

**Scope:** 用户提出设计问题——"skiff 应该区分的类型是**临时和长期**，临时的不绑定会话、提示词注入一次；长期的绑定 trajectory（SESSION.md）、提示词每次用户消息都注入"。设计底座落盘 `docs/skiff-type-and-injection-design.md`（现状实证 / 目标-手段分离 / 成本实证 / 三方案 / 决策点），用户拍板：**方案 A**（长期型提示词段动态重读）+ **显式字段 + 隐式兜底**。

### 方案 A：角色提示词热更新（长期型）
- **新 `createRolePromptReader(root, role)`**（`skiff-role.ts`）——返回**读取函数**而非字符串：`systemPromptFile` 按 **mtime + size** 缓存重读（命中零 IO），**改文件即生效、无需重启**；变更时打一行 `↻ skiff 角色提示词已热重载`（可观测）；读取失败**沿用上次成功内容**（绝不返回空——空提示词会让角色失去人格与纪律）并告警一次；路径逃逸 → 空读取器 + 告警（不阻断装配）
- **`createSkiffAgent`**：角色段改为动态 `text: () => [基础段, rolePrompt()]`——persistent 型每次组装重读文件；temporary 型保留**创建时快照**（用户："临时的不绑定会话，提示词注入一次"）
- **为什么不是"每轮注入用户消息"（R↓）**：zhaocai.md 原 18.2 KB（≈6k–9k tokens）→ 每消息注入 = 一天 50 条约 300k–450k tokens；而"改文件即生效 + 每轮在场"用**动态系统提示词段**即可达成（系统提示词本就每轮发送，零额外消息 token）。用户确认采纳方案 A。

### 类型二分（显式 + 隐式兜底）
- `SkiffRoleConfig.kind?: 'temporary' | 'persistent'`（`ccc.ts`）+ `resolveSkiffKind(role, hasStableId)`（`skiff-role.ts`）：**显式优先**，缺省按"调用方是否传稳定 sessionId"推断（微信桥传固定 id → persistent；ACP/调试页随机 id → temporary）→ 存量配置零迁移；非法值回落推断
- `ensureSkiffSession(..., kind === 'persistent')`：工作台创建/恢复改由 kind 驱动（显式 `temporary` 即使传了稳定 id 也不建工作台）
- `readSkiffRoles` 解析 `kind`（合法透传，非法丢弃）

### 验证
- `skiff-role.test.ts` +12：kind 优先级矩阵 / 非法值回落 / 配置解析 / 热重载（改文件生效、缓存命中、BOM、内嵌静态、逃逸降级、文件删除沿用上次内容、日志只在变更时打）
- `skiff-core.test.ts` +4：persistent 改文件即生效 / temporary 快照不随文件变 / 显式 temporary 覆盖（不建工作台）/ 显式 persistent 覆盖（建工作台 + 热更）
- **72 files / 1026 tests 全绿**（1011 → 1026）+ typecheck 双面 ✓ + build ✓



## v1.30.14 — 2026-09-08（Skiff 调试页并发启动守卫 + 首次未定位降级为信息级，S142）

**Scope:** v1.30.13 发布并 restart-web 后，**运行日志实证** D1 修复生效，同时暴露两处需要收敛的细节。

### 实证（v1.30.13 重启日志 `/tmp/dsh-web-restart-v1.30.13.log`）
```
[serenity-hooks] ✗ Skiff 调试服务未启动：无法定位 CCC root（…）——已排入退避重试
[serenity-hooks] ✓ Skiff 调试问答页: http://127.0.0.1:3099（默认 CCC: /home/yh/home/home-serenity，WebUI: 3080）
[serenity-hooks] ✓ Skiff 调试服务已启动（重试 1 次后定位到 CCC root: /home/yh/home/home-serenity）
[serenity-hooks] ✗ Skiff 调试服务启动失败: listen EADDRINUSE: address already in use 127.0.0.1:3099   ← 本次修复
```
→ **D1 修复确认有效**（3099 起得来，退避重试路径实证）；但**重试定时器与"会话就绪"事件几乎同时到达** → 两次 `sync()` 都看到 `started === false` → 发起两次启动（第一次绑定成功、第二次 `EADDRINUSE` 刷错误日志）。

### 修复
- **并发启动守卫**：新增 `starting`（在飞）标志——启动 Promise settle 前不再重复发起；`scheduleRootRetry` 同样跳过在飞状态。语义 = 「同一时刻只允许一次启动尝试」，与 `started`（已就绪）互补
- **首次未定位降级为信息级**：apply 阶段无 live 会话是**常态而非失败** → `console.log('Skiff 调试服务等待 CCC root（…）')`；**失败语义只留给"退避重试耗尽"**（`console.warn`）——日志里不再出现误导性的 `✗ … 未启动`，可观测性语义与真实状态一致（E↑）

### 验证
- `tests/skiff-startup-retry.test.ts` 扩到 **6 用例**：信息级日志且不刷屏 / 重试耗尽才响亮告警 / **并发触发只启动一次**（延迟结算的 start Promise 制造在飞窗口，断言无"启动失败"日志）/ 退避成功 / 就绪事件即启 / 关开关清重试
- **72 files / 1011 tests 全绿**（1009 → 1011）+ typecheck 双面 ✓ + build ✓

## v1.30.13 — 2026-09-08（会话锚定准确性 D1/D4/D5 + 微信桥注入去重，S142）

**Scope:** 用户要求"**我主要是要求微信桥 + skiff 的会话锚定要准确**"——诊断出 D1~D6 六项（全实证，见 S142 §8），本轮修复其中三项（D4/D5/D1）+ 用户当轮新增需求"微信桥注入与 skiff 注入重复，注入内容直接取 skiff 的"。D2（zhaocai 轨迹归属）待用户拍板，D3/D6 随 D4 一并收口。

### D4 会话锚定（核心）：`resolveSessionMdPath` 加权威绑定候选 + 去掉跨轨迹兜底
- **候选链改为**：① 内存活跃（本进程 `logbook use`）→ ② events 的 `[SESSION CONTEXT]`（重启后恢复）→ **②b `readLastBound(session).mdPath`（`AGENT_SESSIONS/.bindings.json` 权威绑定，新增）** → ③ surface 首条重建锚点
- **删除原 ④ `findLatestActiveSessionMd`（AGENT_SESSIONS 全局最新未完成会话）**。理由（R↓）：④ 是**跨轨迹猜测**——①②③全空时会把 rebuild 静默接到另一个会话（临时 skiff 会话 persistent=false、重启后首条消息前、Danica 新会话都命中该形态），"接错轨迹"比"重建失败"危险得多（错误轨迹被继续写入 + 正确轨迹静默丢失）。备选（④ 仅在"确无绑定"时兜底）同样会接错，不采纳
- **失败即响亮**：全部候选失败 → 返回 null → `queueRebuild` 抛错并**逐项列出已查过的四个面** + 引导 `logbook use <S###> --summary <…>`

### D5 注入纪律与能力面一致：`workspaceTrajectoryLine` 不再点名 `write/edit`
- 旧文案 "Record … INTO this SESSION.md **with write/edit**"——而 zhaocai 角色白名单已移除 write/edit（写能力收归 CCC 的 `session-write` MSM）→ 指令指向它没有的工具
- 现文案：`using the write channel your role is actually granted … never assume a specific write tool exists; if none is granted, report that instead of pretending to write`
- **不写任何 CCC MSM 名**（ACC 源码不绑定某个 CCC 的注册表——归属二分；具体通道由 CCC 角色配置与角色提示词决定）

### D1 Skiff 调试页 3099 启动重试：CCC root 定位失败不再"一锤子"
- **根因（实证）**：`registerSkiff` 只在 `apply` 时同步一次 `resolveSkiffRoot`——此刻通常无 live 会话、进程 cwd 也不在 CCC 内 → null → 一行警告后**永不重试**（重启日志 `✗ Skiff 调试服务未启动：无法定位 CCC root`，`ss -ltn` 无 3099；同批 ACP 因容忍 `root ?? undefined` 而正常）
- **三层触发**：① 启动同步 ② **退避重试**（1s/3s/8s/20s/40s，共 5 次，定时器 `unref()` 不阻进程退出）③ `agent/session-start` / `session/created`（live 会话就绪 = CCC root 现在可解析的最强信号）立即再试
- **可观测**：首次失败告警一次（不刷屏）→ 重试成功 `info` 报告"重试 N 次后定位到 CCC root" → 耗尽则响亮告警；开关关闭时清掉待执行重试；定时器经 `registerDisposer` 随插件卸载拆卸

### 微信桥注入去重（用户当轮需求）：工作台纪律单一注入点
- **用户原话**："微信桥的注入机制，每个用户消息都会注入，skiff 本身也会注入，这样就重复，能否微信桥情况下，注入内容直接取 skiff 的，这样不用配两遍"
- **改前**：`createSkiffAgent` 把工作台纪律塞进基础段 `serenity-skiff`（创建时一次快照）+ 微信桥**每条消息**把同一文本拼进 question（v1.30.4 为覆盖 live/existing 快路径而加）→ 新建 agent 首轮起即重复，且每轮重复付 token
- **现形态**：新增 **`ensureWorkspacePromptSection(agent, scope)`**（`src/skiff-core.ts`）——工作台纪律**只**经此函数挂独立系统提示词段 `serenity-skiff-workspace`（order -55），`text()` **动态**按 scope 读当前活跃 mdPath（绑定变化自动跟随，无需重挂）；幂等（WeakSet，同 agent 只注册一次）
  - `createSkiffAgent` 基础段不再含工作台行，改调该函数
  - 微信桥不再拼 question，改为对 `ref.agent` 调该函数
  - **降级**：该 agent 挂不上系统提示词段（返回 false）→ 回退 question 前缀注入，保证约束仍在场

### 验证
- 新测试 `tests/skiff-startup-retry.test.ts` **4 用例**（无 root 告警一次 / 退避重试成功 / 就绪事件立即重试且不重复启动 / 关开关清重试）；`rebuild.test.ts` +2（②b 绑定候选命中 / ④ 不再兜底返回 null）+ 夹具改 `bindSession()`（镜像"会话此前绑过、重启后内存空"的真实形态）；`skiff-core.test.ts` / `weixin.test.ts` 断言同步到单一注入点语义（含降级用例）
- **72 files / 1009 tests 全绿**（1002 → 1009）+ typecheck 双面 ✓
- 测试夹具要点：D1 用例需控 `findSerenityRoot`（开发机 cwd 恰是真实 CCC → 假阴性；vitest worker 禁 `process.chdir` → `importOriginal` 局部替换该纯函数）



**Scope:** 用户报告 `web_fetch` 恒失败（"被 dsh 安全机制拦截，我需要关了它，看看能从哪个层面想办法"）→ 分层实证后拍板 **L3：ACC 注册自己的 provider**，并要求"**屏蔽掉 dsh 自身注册的**"。设计全文见 `docs/web-fetch-fakeip-design.md`。

### 根因（代码级实证，非 DSH 误判）
- 拦截点 `@deepseek-ai/dsh-web-fetch-http/lib/index.js:69`：`if (!isPublicIpAddress(entry.address)) throw new WebError(..., 'WEB_BLOCKED_URL')`——**无条件 throw，该包 Config 无开关**（只有 5 个配额字段）
- 判据 = `ipaddr.js` 的 `range() === 'unicast'`；本机 DNS 走 Clash fake-ip → `cdn.jsdelivr.net` 解析为 **198.18.1.85**（`198.18.0.0/15` 被 ipaddr.js 归为 reserved）→ 恒拒

### 新增 `src/web-fetch-provider.ts`
- **复用宿主实现**：`HttpFetchProvider`（已导出）+ 注入自定义 `resolveAddresses` → 重定向策略/字节字符配额/字符集解码/连接固定全部继承
- **最小放宽判据**：`公网单播 ∪ fake-ip 段(198.18.0.0/15)`；loopback / link-local（含 `169.254.169.254`）/ RFC1918 / CGNAT / 保留段 / 组播 / IPv6 ULA·link-local 依旧拒绝；IPv6 仅放行 `2000::/3`，`::ffff:a.b.c.d` 按内嵌 IPv4 判定；**任一地址不合法即整体拒绝**（与宿主同口径，防 DNS 重绑定）
- **注册同 id `http`**（`LOCAL_FETCH_PROVIDER_ID`）→ 宿主 `web` 的既有配置 `fetchProvider: http` 无需改动（避免 patch 整体替换 web 配置对象时连 `searchProvider` 一起覆盖）
- **失败策略**：后端包动态 import（宿主无该包 → 只告警，绝不让整机启动失败）；错误对象本地构造（`dsh-tool-web` 只渲染 `message`，不判 `instanceof`）

### 屏蔽宿主内置（用户要求）
- `cordis.patch.yml`（bundle patch 层）新增：`- id: web-fetch-http` + `name` + `disabled: true`
- 依据：宿主 `applyEntryPatches` 把**所有 bundle 的 patch 与本 profile 的 cordis.patch.yml 展平为一个列表**按序应用，本包在 bundles 末尾 → patch 在所有宿主 bundle 之后生效；**未命中的 patch 只告警跳过** → 修复随插件交付，不改机器配置，宿主换版本不炸
- 两者不能并存（同 id 会 `WEB_DUPLICATE_PROVIDER`）——刻意的响亮信号；回滚见设计文档 §5

### 配套
- `index.ts`：`inject` 增 `'web'`；新配置 `webFetch.enabled`（默认 true）；`apply` 末尾装配
- `host/access.ts` 增 `HostWeb` / `hostWeb`；`host/contract.ts` 增 `web` 服务契约条目（optional）
- `package.json`：peerDependencies + `@deepseek-ai/dsh-web` / `@deepseek-ai/dsh-web-fetch-http`（后者 optional）；tsconfig paths 同步
- `dsh-develop` 新子命令 **`dump-config [pattern]`**：跑宿主 `dsh --dump-config`（与 boot 同一 patch 合成实现）核对 profile 条目树，±1 行上下文过滤

### 验证
- 新测试 `tests/web-fetch-provider.test.ts` **9 用例**（地址判据 13 个拒绝样本 / IPv6 分类 / mapped 语义 / resolver 整体拒绝 / 注册 id / 降级不抛错）
- **71 files / 1002 tests 全绿**（993 → 1002）+ typecheck 双面 ✓ + build ✓
- **patch 合成实证**：`dsh-develop dump-config web-fetch-http` → `# == @deepseek-ai/dsh-base, patched by @shgroup/dsh-serenity-hooks` / `- id: web-fetch-http … disabled: true` ✓
- `deploy` ✓（staging 双锚 + profile 双目标 + preflight 注入面含 `web`）
- **⏸ 运行时验证待 restart-web**：重启后 `web_fetch` 应能抓取 fake-ip 网络下的公网站点（本方案生效点）

### 发布链（2026-09-08，用户"现在就发布" = D14 显式触发）
- `version` 三处一致 1.30.12 ✓ → `publish` ✓（test **71 files / 1002 tests** → typecheck 双面 → build → readme-sync → pack-check **90 文件**；lib 84 项 = js 13 / d.ts 71，含新 `web-fetch-provider.d.ts`）→ npm `@shgroup/dsh-serenity-hooks@1.30.12` → `push` origin ✓ → `github-push` github + omdsh ✓（三推全成）
- `deploy` ✓ 于发布前完成（staging 双锚 + profile 双目标 + preflight 注入面含 `web`）——本机 profile 已是 v1.30.12
- **⏸ restart-web**：用户授权后执行（执行即断当前会话，重建后接续实测 `web_fetch`）

## v1.30.11 — 2026-09-08（README 完整重写：人话版 + 声明面校准，S142）

**Scope:** 用户"帮我把 dsp 的 README 完整重写吧，之前写的内容都正确，就是不太说人话"。原则：**信息一条不丢，只换说法**——所有能力/端口/配置/用例/FAQ 保留，术语首次出现给一句白话解释，长名词堆叠改成人话短句。

### README.md 重写
- **开头先讲"解决什么问题"**：四个真实麻烦（忘了在干什么 / 乱翻乱改文件 / 出门用不了 / 家人想用微信问）→ 对照"没有它 / 有了它"
- **术语表前置**：工作区（CCC）/ 插件（ACC）/ MSM / SESSION.md 四个词一句话说清，正文不再重复解释
- **工具表换成"干什么 / 什么时候用"**：10 个工具逐个白话说明（含改名对照，保留）
- **机械约束改成"你会看到的效果 / 为什么这样做"**：安全模式、工作区围墙、黑名单、密钥守卫、对外输出守卫、轨迹提醒
- **对外入口表补全**：3080 主界面 / 3081 网页登录 / **3082 微信主动发送入口** / 3099 子角色调试 / 3100 ACP+问答页 / 微信桥
- **微信桥章节更新到 v1.30.10**：主动发消息（`weixin-send`，`--ccc` 必填）、**`autoReplyWithLastMessage` 开关**、消息记录 `source=reply|proactive`、排障入口
- **新增 FAQ 两条**：AI 的回复怎么发出去（自动 / 手动模式差异）、主动发的消息会不会被记录
- **新增"延伸阅读"**：理论文档 + 权威标准仓 + CHANGELOG
- **事实校准**：DSH 前置 `0.1.2-rc.1`（原写 0.1.0-rc）、工具数 10（原 13）、测试 **70 files / 993 tests**（原 62/895）、版本行 v1.30.10（原 v1.30.0）

### 声明面校准（review G 遗留）
- `dsh.plugin.json` `engines.dsh`：`>=0.1.0-rc.5` → **`>=0.1.2-rc.1`**（与 package.json 的 peerDependencies 对齐——此前声明面允许装在契约不满足的旧宿主上）
- `dsh.plugin.json` / `package.json` 描述：去掉"9 工具 / cc_fs / acc_msm / 五块注入 / 0.1.0-rc"等过时表述，改为当前 10 工具与 0.1.2-rc.1

### 验证
- **70 files / 993 tests 全绿** + typecheck 双面 ✓ + build ✓

### 发布链（2026-09-08，用户"等英文版一起发" = D14 显式触发）
- `version` 三处一致 1.30.11 ✓ → `publish` ✓（test 70 files / 993 tests → typecheck 双面 → build → readme-sync → pack-check **89 文件**；lib 83 项 = js 13 / d.ts 70）→ npm `@shgroup/dsh-serenity-hooks@1.30.11` → `push` origin ✓ → `github-push` github + omdsh ✓（三推全成）
- **发布前修复（本轮发现，否则 npm README 不会更新）**：npm 页面展示的是**包内** README（`hooks/dsh-serenity-hooks/README.md`，经 package.json `files` 白名单进 tarball），**不是仓库根 README**——v1.30.11 重写根 README 后，包内 README 仍停在 v1.30.0（"8 块"等过时事实；实证：jsdelivr 取 `@1.30.10` 包内 README 得旧短版）。修复 = `dsh-develop` 新增 **`readme-sync`** 子命令并在 `publish` 前置执行：根 README → 包内 README，仓库相对链接（docs/、CHANGELOG.md、LICENSE）改写为绝对 GitHub URL（tarball 内无这些文件，相对链接在 npm 页会 404）
- **发布后核对（五个表面全绿）**：npm 包内 README（jsdelivr `@1.30.11`）= 新版人话 README ✓ ／ npm `latest` = 1.30.11（89 文件，gitHead `e325ef0`）✓ ／ GitHub tellmewhattodo `README.md` ✓ ／ `README.en.md` 英文镜像 ✓ ／ omdsh 镜像 ✓
- **未执行 deploy / restart-web**：本版为纯文档 + 声明面变更（`engines.dsh` / 包描述），lib/ 运行时产物与 v1.30.10 等价——本机运行时仍为 v1.30.10（需要时随时 `dsh-develop deploy`）

## v1.30.10 — 2026-09-08（微信桥「关闭自动输出」开关：输出权交给 agent，S142）

**Scope:** 用户"在这个基础上，微信桥绑定的 skiff 就不用走尾部输出那一套了，而是直接可以依赖 msm 来输出，那么搞个开关，让微信桥可以关闭输出"（拍板：CCC 级开关、命名 `autoReplyWithLastMessage`、只关最终文本、不兜底）。

### `weixin.autoReplyWithLastMessage`（CCC 级，缺省 true = 现状）
- **关闭（false）**：桥不再把一轮结束时 agent 的**最终 assistant 文本**转发给用户（原 `source="reply"` 那条不再产生）；输出权交给 agent —— 每轮 `question` 前缀注入 **`── Reply Output (manual mode) ──`** 纪律块（新导出 `weixinManualOutputLine(root, accountId, userId)`）：含**已填好 ccc/account/user 的可直接照抄命令**、明文"桥不会替你转发"、"不发 = 用户收不到（no fallback）"、纯文本、以及"记录归 source=proactive 勿重复"四条
  - `--account` 用**收到消息的账号**（多账号下避免用错 bot 身份回话）；`--user` 用该用户 iLink id（免别名解析）
- **保留**（用户拍板边界）：系统类消息（「新的对话已开始」/ 语音无法解析提示）、typing 指示、incoming hook —— 只关"agent 的最终文本"
- **记录语义**：被抑制的最终文本**不记录**（记录 = 用户实际看到的内容）；agent 自己发的走 `source="proactive"`
- **归一**：`readWeixinSettings` 缺省非 false（未写该键 = 旧行为）；显式 false 才关（向后兼容，零迁移）

### 文档
- `container_admin msm ccc-config` §8 补该键（含语义边界与配置样例）
- `weixin-doctor guide` §7 补「关闭桥的自动输出」段（配置 / 效果 / 边界 / 适用场景）

### 验证
- **70 files / 993 tests 全绿**（990 → 993：+2 桥行为用例、+1 配置归一用例）+ typecheck 双面 ✓ + build ✓
- **⏸ 未发布**：bump/publish 待用户显式指令（D14）

## v1.30.9 — 2026-09-08（微信主动发送通道 + skiff 工作台两条缺陷根治，S142）

**Scope:** 用户需求「微信桥希望能支持被调用发消息给指定用户，允许 CCC 自己做个 MSM 来发消息、同时能被记录，但又不希望新增 ACC 层 tool」（拍板 A2：专用 loopback 监听、ccc 必填、不做密钥）+ 用户报「zhaocai skiff SESSION 爆炸」根治。

### 微信主动发送通道（零新增工具）
- **`weixinApi` 配置**（`config-ops.ts`）：`{ enabled: true, port: 3082 }`——默认启用；`port: 0` 或 `enabled: false` 关闭（defaults/merge/update 三处）
- **`src/weixin-send-api.ts`（新，326 行）**：**只绑 127.0.0.1** 的独立监听器（不经 3081 网关 → 公网不可达 → 不做共享密钥，但仍校验来源地址为 loopback）
  - `POST /send` `{ ccc, user, text, accountId? }` → `{ ok, accountId, userId, sessionId, role }`；`GET /health`
  - 纯函数可测：`parseSendRequest`（结构校验 + 4000 字上限）/ `isLoopbackAddress`（含 IPv4-mapped）/ `matchCcc`（绝对路径 → 目录名 → `.serenity` 名；**歧义报候选不猜**）
  - `weixinSendEndpoint()` 供 env 注入；按配置启停 + `serenity/config-updated`/`serenity/settings-changed` 热同步 + `registerDisposer` 拆卸
- **`weixin-bridge.sendProactiveText({root,toUserId,text,accountId?})`**：账号选择（显式 / 首个启用）→ 凭据校验 → `sendTextMessage`（**不带 context_token = bot 主动发起**）→ **触发既有 outgoing hook**（`source: 'proactive'`，`sessionId = weixinSessionIdFor(userId)`、`role` = 路由命中）；失败返回稳定 code（`BRIDGE_DISABLED` / `NO_ACCOUNT` / `ACCOUNT_NOT_FOUND` / `ACCOUNT_NOT_BOUND` / `SEND_FAILED`）
- **`weixin-hook.ts`**：outgoing 事件新增 `source?: 'reply' | 'proactive'`（缺省 reply，向后兼容）
- **`index.ts` 装配 + `msm-ops.buildMsmEnv` 注入 `SERENITY_WEIXIN_API`**（MSM 侧零硬编码端口）
- **顺带修复既有缺陷（P1，测试抓到）**：`weixin-api.apiPost` 只判 HTTP 状态 → iLink 在 **HTTP 200** 里用 `ret/errcode != 0` 表达失败（如 `{ret:1,errmsg:"denied"}`）被当成功 → **回复路径也会为一条从未送达的消息触发 outgoing 记录**（与 bridge 注释「发送失败不记录」矛盾）；新增 `assertIlinkOk(endpoint, rawText)` 用于 `sendTextMessage`
- **测试**：新 `tests/weixin-send-api.test.ts` **16 用例**（校验/loopback/CCC 解析/状态码映射/真实 loopback 往返/生命周期热同步）+ `weixin.test.ts` 新增 `sendProactiveText` 3 用例（含 5 条失败路径）

### skiff 工作台两条缺陷根治（用户报「zhaocai skiff SESSION 爆炸」）
- **根因（实证链）**：真实会话日志 `~/.dsh/sessions/--…--/skiff-weixin-74b2a0609d13657b/session.jsonl.zstd` **12302 行中 `serenity/bound` 出现 0 次**——v1.29.1~v1.30.5 的绑定写在**宿主不落盘**的自定义事件上（F-01 同源）→ 每条消息 `readLastBound` 恒 null → `ensureSkiffSession` 每次都新建；消息 ts 与 SESSION 目录 mtime **逐条同刻对应**（09-08 四条消息 → S169~S172 四个目录）；v1.30.4 起 `existing` 快路径也调 ensure → **每条消息一个 SESSION**
- **修复 ①：临时身份不建工作台**——`ensureSkiffSession(..., persistent)`：`createSkiffAgent` 传 `sessionId !== undefined`（微信桥 = 固定 id → 建；ACP/调试页/问答页 = 随机 id → 不建）。此前**每次临时问答都留一个永久空 SESSION 目录**（无界熵增，与「skiff 本质是临时会话机制」的模型冲突）
- **修复 ②：内存活跃自愈**——判定链新增 ②b：绑定文件失效时按 scope 复用内存活跃 SESSION 并**补写绑定**（`action: 'reconcile'`）——绑定持久化再失效也不会放大成「每条消息一个 SESSION」
- **回归测试 +5**：跨消息形态（新 agent 空 events + 既有 `.bindings.json` → 恢复不新建）/ 绑定文件被删后自愈补写 / 临时身份零创建 / `createSkiffAgent` 集成（固定 id 建、随机 id 不建）

### guide 同步
- `weixin-doctor guide` 新增 **§7 主动发送**（调用形态 / 通道链路 / 排障）+ §5 事件 schema 补 `source` 与 `file` 字段；原 §7 凭据管理顺延为 §8
- `container_admin msm ccc-config` §8 补「主动发送」段（入口归属 + loopback + `source=proactive`）+ hook schema 同步

### 依赖解耦（自造回归的即时修复）
- **问题（实测）**：`msm-ops.ts` 静态 import `weixin-send-api` 以取入口地址 → 拖进整条微信桥栈（`weixin-bridge` → `skiff-core` → `@deepseek-ai/dsh-llm`）→ `acc-extras` / `ops` / `skiff-admin` 三个测试套件**整文件加载失败**（它们只用到 MSM 注册表逻辑）
- **修复**：新叶模块 `src/weixin-send-endpoint.ts`（零依赖：写者 `weixin-send-api` 启停时 `setWeixinSendEndpoint`，读者 `msm-ops` 只读）——读/写解耦，MSM env 注入不再拖桥
- **镜像测试** `tests/weixin-send-endpoint.test.ts`（4 用例；同时满足 coverage-gate 门禁）

### 验证
- **70 files / 990 tests 全绿**（963 → 990）+ typecheck 双面 ✓ + build ✓
- **端到端实测（S142，2026-09-08，真实 bridge + 真实 CCC MSM 子进程）**：缺 `--ccc` → `MISSING_CCC` 拒绝（exit 1）✓；`--ccc <CCC> --user yh` → 消息真实送达微信 ✓；`_weixin-logs/2026-09-08.jsonl` 出现 `{"event":"outgoing","source":"proactive","role":"zhaocai","sessionId":"skiff-weixin-74b2a0609d13657b",...}` ✓（与对话回复同源、同一轨迹）
- **⏸ 未发布**：bump/publish 待用户显式指令（D14）

## v1.30.8 — 2026-09-08（review 修复轮 2b：宿主访问收口 + 生命周期/竞速 + 失败策略，S142）

**Scope:** review 轮 2b——用户"把 2b 也做掉，不留问题"。三条线：**F-06 宿主访问收口**（唯一读取入口）、**F-08 生命周期**（销毁订阅 + 资源拆卸 + 等待竞速）、**F-07 失败策略**（守卫输入失败必须响亮 + 空 catch 必须点名）。

### F-06 宿主访问收口 `src/host/access.ts`
- **唯一读取入口**：`hostService` / `hostInjected` / `hostSessions` / `hostAgents` / `hostWebServer` / `hostSettings` / `hostSessionCwds`——所有 `ctx.get` / `ctx.<service>` 的形状断言集中在此，**服务缺失一律返回 `undefined` 且不抛错**（宿主对插件 apply 抛错 = 整个 dsh 启动失败，访问层不能成为单点）
- **调用点迁移**：keeper / api / gateway / rebuild / skiff-debug / tools/session / index / weixin-bridge / skiff-core / autopilot-trajectory / settings-section；`host/contract.ts` 的 `readService` 改为复用本模块
- **残留裸读清零**：`gateway.ts` 的 `(ctx as unknown as {get}).get('webServer')` → `hostWebServer(ctx)`
- **镜像测试** `tests/host/access.test.ts` 7 用例：服务缺失/`get` 抛错/属性与 `get` 两级回落/形状不符 → 空数组，逐条钉死降级契约

### F-08 生命周期与竞速
- **销毁订阅** `src/seams/lifecycle.ts`：订阅 `agent/disposed` / `session/disposed`（宿主实证 `core/agent/src/runtime-types.ts:175`、`core/session/src/index.ts:62`）→ `cleanupSessionState`（skiff 注册表 + 活跃 SESSION 作用域）；此前约 10 处 per-会话 Map 在长跑进程里只增不减
- **资源拆卸** `src/host/effect.ts`（新，零依赖叶模块）：`registerDisposer(ctx, label, cleanup)`——`ctx.effect` 缺失 → **响亮降级**（告警 + 同标签去重 + 返回 false），装配期永不抛错
  - 已登记：gateway 第二监听器（此前卸载后端口占用 → EADDRINUSE）、autopilot 时钟（此前卸载后旧定时器仍 tick）、lifecycle 聚合资源（skiff 调试页 / ACP / 微信桥）
- **等待竞速** `src/agent-idle.ts`（新）：`waitAgentIdle` 三通道结算——`agent/status idle` / `agent/disposed` / `session/disposed` + 订阅后状态兜底。此前 skiff 问答与 handyman 各复制一份"只等 idle"的实现，**agent 先销毁则永久挂死**；两处重复实现收敛到本模块

### F-07 失败策略
- **P0 守卫/配置输入失败 → 响亮**：`ccc.loadSerenityConfig`（坏 JSON 不再静默 `{}`——安全模式黑名单/handyman 白名单/skiff 角色曾无声失效）、`localstore-ops.readAll`（凭据表现为"未设置"）、`skiff-role.readSkiffRoles`（权限面保持 fail-closed 但可见）、`settings-section`（缺 settings provider 不再静默降级，warnOnce）
- **策略文档** `docs/failure-policy.md`：四类失败（P0 守卫输入 / P1 可选宿主服务 / P2 尽力而为清理 / P3 边界翻译）与各自义务 + 硬规则（apply 永不抛错、生命周期一律吞错但留注释、去重告警 + 测试钩子）
- **机械门禁** `tests/failure-policy.test.ts`：src 下每个 **空 catch 必须含注释**（点名吞掉了什么），违规列出 `文件:行`；含扫描器自证用例（防空跑）。审计结论：190+ 处 catch 中空 catch 全部已命名，本轮补齐 4 处 P0 的响亮告警
- **测试替身保真**：`register.test.ts` 的 `mockCtx` 补 `effect`（宿主确有该成员，缺它会让 F-08 装配在测试里被误判）

### 验证
- **68 files / 963 tests 全绿**（933 → 963）+ typecheck 双面 ✓ + build ✓
- **coverage 门禁递归化**：`coverage-gate.test.ts` 原先只 `readdir` 顶层 → 嵌套测试目录（`tests/host/*`、`tests/seams/*`）对门禁不可见；改递归后新捕获 `seams/lifecycle.ts` 裸奔并补齐镜像测试
- **⏸ 未发布**：bump/publish 待用户显式指令（D14）

## v1.30.7 — 2026-09-08（review 修复轮 2：宿主契约层 + 编译期事件契约 + 发布门禁/CI，S142）

**Scope:** review（`docs/dsp-implementation-review.md`）轮 2 —— 针对"契约无单一拥有者 + 验证镜像自身假设"这两条系统性根因，建立**可执行的契约守卫**。用户拍板"直接开轮 2"。

### F-05/F-06（宿主契约层）`src/host/contract.ts`
- **声明式契约表**（单一真相源）：**15 个宿主服务**（injected/lazy 分级 + 依赖成员 + 缺失后果 + required 分级）+ **10 个宿主事件**（订阅点 + 后果）+ **版本范围** `REQUIRED_HOST_RANGE = ^0.1.2-rc.1`
- **`probeHostContract(ctx, hostVersion)`**：纯函数探针，**零宿主 import**（结构化读取 `ctx.get` / 属性）→ peer-only 打包下同样成立；返回 `{ok, checked, hostVersion, versionOk, issues[]}`
- **装载时告警**（`index.ts` apply 首段）：有 issue 即 `console.warn` 摘要；探针自身永不抛错——宿主对插件 apply 抛错会导致**整个 dsh 启动失败**（app-boot "plugin(s) failed to load" 语义），探针不能成为新单点
- **`dashboard health` 新增 `hostContract` 段**：`required` 缺失 → `status: degraded`（把"静默漂移"变成可读信号）；`tools/kit.ts` 改 `createKitTool(ctx)` 以取得只读上下文
- **版本探针**：`readDshVersion()` 的结果与 `REQUIRED_HOST_RANGE` 比对（低于下限 / 超出上界 / 未知 → 记为非致命 issue）——此前版本读了但从不比对（v1.30.5 那类漂移的最便宜守卫）

### F-04（编译期事件契约 + 探针测试）
- **`HOST_EVENT_NAMES ... as const satisfies readonly (keyof Events)[]`**：事件名写错或宿主改名 → **`dsh-develop typecheck` 编译失败**（本次实测通过 = 10 个事件名在 rc.1 中真实存在）。这是运行时无法验证的那一半（`ctx.on('typo')` 只会静默不订阅）
- **`tests/host-contract.test.ts` 13 用例**：完整宿主 → ok / 必需服务缺失 → ok:false / 成员被移除 → 精确到成员 / 可选项缺失 → 降级不中断 / 空 ctx 不抛错 / 版本范围四态 / 契约表自洽

### F-14（发布门禁 + CI）
- **`dsh-develop publish` 现在先跑测试**（此前只有 typecheck + build + pack-check——"绿着发布可能带红测试"）
- **新增 `.github/workflows/ci.yml`**：push/PR 上跑 typecheck（node + client 双面）+ test。⚠️ 文件头注明**首次运行需验证**（编写环境无 bash/网络，无法执行 CI）：① `@deepseek-ai/dsh@0.1.2-rc.1` 公开 npm 可安装 ② tsconfig paths 指向全局安装的宿主

### 验证
- **63 files / 933 tests 全绿**（920 → 933）+ typecheck 双面 ✓ + build ✓
- **⏸ 未发布**：bump/publish 待用户显式指令（D14）
- **轮 2b 待办**：F-06 宿主访问收口（约 40 处调用点迁入 `src/host/`）、F-07 失败策略（守卫 fail-open / 121 处 catch 审计）、F-08 生命周期（disposed 订阅 + `ctx.effect` 拆卸）

## v1.30.6 — 2026-09-08（review 修复轮 1：三个 P0——绑定持久化迁出会话日志 / ACP cancel 真中断 / 工作区白名单恢复生效，S142）

**Scope:** 用户"针对整个 dsp 的实现进行 review，关注架构缺失和 dsh 版本升级带来的这类问题"→ 六分片并行审计（`docs/dsp-implementation-review.md`）发现 3 个 P0，本版修复全部三个。用户拍板 D-1~D-5 全按建议执行。

### F-01（P0）绑定持久化迁出 dsh 会话日志 → `AGENT_SESSIONS/.bindings.json`
- **根因（宿主契约实证）**：dsp 自定义会话事件 `serenity/bound` 既不在宿主的生成白名单 `KNOWN_SESSION_EVENT_TYPES`（`core/session/src/known-event-types.ts:9-22`，注释明示 out-of-repo 插件事件不在集合内），而 `Session.append`（`core/session/src/index.ts:668-697`）构造事件时只写 `{type,seq,time,data,surfaceOp?,sourceEventSeqs?}`——**没有写 envelope `ignorable` 标记的通道**；宿主的 `assertEventsSupported`（`session-persistence/src/coordinator.ts:1248-1252`，调用点含恢复/HMR 路径 `:1027,:1057,:1074,:1509`）拒绝任何"未知且非 ignorable"的事件 → 含该事件的会话冷加载可能抛 `SessionFormatUnsupportedError`。v1.29.1 的设计文档虽写明要带 `ignorable: true`（`docs/session-binding-hardening-research.md:53`），但类型层声明 ≠ 持久层标记，实际从未落盘
- **修复**：绑定改为每 CCC 一个 JSON 文件 `AGENT_SESSIONS/.bindings.json`（会话 id 为键，latest-wins；**原子写** tmp + rename）；`appendBound`/`readLastBound`/`hasAnyBound` 签名不变（6 个调用点零改动），CCC 根由会话 `header.cwd` 上溯 `.serenity` 定位
- **向后兼容**：文件中无该会话记录时，仍回落扫描会话日志中的旧 `serenity/bound` 事件（存量绑定不丢；只读不写）
- **停止写入**：不再向会话日志 append 任何自定义事件类型（消除该 P0 契约违规的根源）
- **运维**：根仓 `.gitignore` 忽略 `AGENT_SESSIONS/.bindings.json`（运行时状态不入库）

### F-02（P0）ACP `session/cancel` 真中断
- **根因**：`acp-core.ts:187` 调 `agent.interrupt?.()`——宿主 rc.1 的 `Agent` **没有** `interrupt`（只有 `cancel(cause)`，`core/agent/src/runtime-types.ts:91`），可选链使其成为**永久 no-op 却返回 `cancelled:true`**；测试替身提供 `interrupt` 因而"认证"了这个不存在的调用
- **修复**：改 `agent.cancel({ kind: 'user' })`（`AgentCancelCause`，`core/session/src/types.ts:181-185`）；测试替身同步改为 `cancel`（不再供应宿主不存在的成员）

### F-03（P0）外部工作区白名单/禁建恢复生效
- **根因**：dsp 匹配 `POST /api/workspace.create` + `payload.path`，而宿主 rc.1 的 Remote 端点为 `typertEndpoint({namespace,method})` = `workspace/create`（`typert/registry/src/service.ts:63-69`）→ 浏览器请求 `POST /api/workspace/create`，wire 信封 `{type:'client-request',rpcId,method,payload:{args}}`（`api/gateway/src/index.ts:955` `args: payload.args`）→ **该分支从未命中**，`allowWorkspaceCreate=false` 与工作区白名单对外部用户形同虚设
- **修复**：新增纯函数 `isWorkspaceCreatePath`（rc.1 端点 + 旧端点兼容）+ `parseWorkspaceCreateBody`（`payload.args.path` 优先、`payload.path` 回落）；gateway 分支改走两者

### 验证
- **62 files / 920 tests 全绿**（913 → 920：session-bound 重写 16 用例 + gateway F-03 三用例；rebuild/skiff-core 断言同步为新形态）+ typecheck 双面 ✓ + build ✓
- 参考：`docs/dsp-implementation-review.md`（汇总）+ `docs/review/slice-{A..H}*.md`（六分片）
- **⏸ 未发布**：bump/publish 待用户显式指令（D14）

## v1.30.5 — 2026-09-08（图片粘贴补救失效修复——DSH 0.1.2-rc.1 错误码契约漂移兼容，S142 诊断实证）

**Scope:** 用户问"图片/文件粘贴在 Mac 上不好用"（图片能进 rail 但发送被拒、无自动落盘）——**功能代码没丢**，根因 = **DSH 0.1.1-rc.2 → 0.1.2-rc.1 升级把 host 图片拒绝错误码从 `attachment-error` 改为 `session/attachment-invalid` / `subagent/attachment-invalid`**（reason 仍 `MODEL_DOES_NOT_SUPPORT_IMAGES`），ImageFallbackDock 触发判定写死旧码 → rc.1 下补救永不触发。

### 诊断证据链（R↓）
- 功能完整实证：ImageFallbackDock/FileFallbackDock 代码 + client/index.ts 注册链 + `conversation.input.dock` slot 契约 rc.1 仍存（ui-conversation slots.ts）+ gateway `x-serenity-ui` 头 `{...reqHeaders}` 全量透传——排除"功能丢失"与网关路径
- rc.1 错误码实证：`dsh-harness-public`（checkout dsh-v0.1.2-rc.1）`session-controller/src/commands.ts:321` `RemoteError('session/attachment-invalid', ..., { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })`；rc.1 全仓 `attachment-error` 零命中
- 用户实测区分：Edge + 127.0.0.1:3080 直连 → 与 Mac/浏览器/网关无关，Windows 同失效（用户 Mac 上发现）
- 0.1.2-rc.1 适配轮（B4/A1/A2/B6）漏 client 错误码契约；测试只覆盖 image-fallback-api 层未达 Dock 触发判断

### 修复
- `client/image-fallback-api.ts`：新增纯函数 `isImageFallbackTrigger(code, reason)`——兼容三码（旧 `attachment-error` + rc.1 `session/attachment-invalid` / `subagent/attachment-invalid`）× reason `MODEL_DOES_NOT_SUPPORT_IMAGES` 双条件判定（可单测；client 无 DOM 测试设计同 collectNonImageFiles 先例）
- `client/ImageFallbackDock.tsx`：useEffect 触发判定改走 `isImageFallbackTrigger`（原 L67 `promptError?.code !== 'attachment-error'` 恒 true → 永不补救）
- 测试：image-fallback.test.ts +5（旧码兼容 / rc.1 主会话码 / rc.1 子代理码 / reason 非模型不支持 false / 未知码空码 false）

### 验证
- **62 files / 913 tests 全绿**（908 → 913 +5）+ typecheck 双面 ✓ + build ✓

### 发布链
- bump v1.30.5（package.json / dsh.plugin.json / CHANGELOG 三处一致，修复此前 1.30.4/1.30.4/1.30.5 漂移）→ test **62 files / 913 tests** ✓ → build ✓（typecheck node + client）→ publish npm @shgroup/dsh-serenity-hooks → 三推（origin/github/omdsh）→ deploy → restart-web
- **发布触发**：2026-09-08 用户到家显式触发（此前"修完别发布，回家喊再发布"= D14 显式指令）

## v1.30.4 — 2026-09-07（skiff 专属 SESSION 纪律强制在场——微信桥每轮注入工作台约束，S142 用户点破）

**Scope:** v1.30.3 自动建 SESSION 后用户实测发现：**LLM 不知道已绑定 SESSION、不知道要用它**——只往 systemPrompt 塞了一行英文路径（创建时快照），老 live agent（重启后 existing 快路径）根本收不到。用户点破："我们没有给 skiff 注入任何要求和约束" + "每次都注入也行，机制比历史重要"。

### 根因（R↓）
- v1.30.3 ensure 后只注入一行 `SESSION.md: <path>`——**只给了信息没给约束**，LLM 不会主动用
- 微信桥 `existing` 命中（重启后 live 复用）走**快路径跳过 createSkiffAgent** → 连 systemPrompt 注入都不发生 → 老 agent 完全无感知
- 约束放 zhaocai.md（CCC 人格）优先级低 + 老 agent 快照旧

### 修复
- `skiff-core.ts` `workspaceTrajectoryLine` 升级为**完整工作台纪律块**：AUTO-BOUND（无需 use）+ SESSION.md 路径 + 4 条纪律（持久记忆载体/写进度/rebuild 自动续接/不暴露路径）——信息 + 约束 + 动作指引
- `weixin-bridge.ts` handleIncoming：**每轮 incoming 在用户消息前注入纪律块**（用户拍板机制优先，不做一次性节流）——live/老 agent 也强制在场；hook 记录用原始 text 不泄漏注入段
- `weixin-bridge.ts` existing 快路径补 `ensureSkiffSession`（此前只 create 路径 ensure → live agent 未绑定）

### 验证
- skiff-core 测试断言更新（完整纪律块含 AUTO-BOUND/no logbook use/rebuild 续接/write/edit）
- weixin 新增集成测试：两段式（首次 create 建 SESSION → 二次 existing 快路径也注入纪律）
- **62 files / 908 tests 全绿**（907 → 908 +1）+ typecheck ✓

### 发布链
- bump v1.30.4（三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web

## v1.30.3 — 2026-09-07（Skiff 专属 SESSION：自动创建/按用户隔离，SESSION 机制零特调，S142 用户拍板）

**Scope:** 微信桥 zhaocai 绑定后变成**永久性会话**，但 skiff 原设计是临时会话（无 SESSION 轨迹）——机制错配。用户拍板方向：绑定的 skiff = **权限受限的普通 agent + 自动拥有的专属工作台**；SESSION 机制（logbook create/use/rebuild + SESSION.md 读写）**不因 skiff 有任何调整**。方案 `docs/skiff-bound-trajectory-design.md` v0.3 FINAL。

### 用户拍板全录（R↓）
① zhaocai tools +write/edit（SESSION.md 读写最简通道）② keeper 开（机制的一部分）③ 新建专属 SESSION（**不延续 S159** workaround）④ **多微信用户 = 各自 SESSION**（微信桥按用户派生固定 skiff 会话 id → scope 天然隔离，永不共享同一份）⑤ SESSION 命名只编号（用户不关心是谁）

### 实现
- `src/skiff-core.ts` 新增 **`ensureSkiffSession`**（懒绑定 + 幂等，per skiff 会话）：
  - 角色 `trajectory.session !== true` → 零变化（现状完全不变）
  - 会话日志已有**本机制自动创建**的 bound（note 前缀 `auto-created for skiff role`）→ 恢复（重启/续接记得）
  - 无 → 自动创建专属 SESSION（`createSession desc='<role> skiff'`——编号自动递增，复用全套既有机制）+ `setActiveSessionInfo`（scope = skiff 会话 id 隔离）+ `appendBound`（note auto-created 标记）
  - **旧手工 bound（S159 等）不认**（note 非 auto-created）→ 新建专属 SESSION（S159 workaround 退役语义）
- `createSkiffAgent`（create/resume/live 三路径统一）：ensure 后把工作台路径经 `workspaceTrajectoryLine` 注入 systemPrompt（agent 上下文，**用户对话面零打印**）——skiff 知道工作台在哪即可 write/edit 记进度 + logbook rebuild 续接
- **零改动** session-ops/rebuild/guards/context——复用的全是既有机制（bound 持久化 v1.29.1 / createSession / activeStore scope 隔离）

### 验证
- skiff-core 新增 7 用例：session=true 自动建（目录+SESSION.md+激活+bound）/ 幂等恢复不重复建 / session=false 零变化 / **两用户各自独立 SESSION** / 旧手工 bound 不认新建 / workspaceTrajectoryLine 内容 / createSkiffAgent 集成（提示词含工作台）
- **62 files / 907 tests**（900 → 907 +7）除版本一致性漂移外全绿 + typecheck ✓

### 发布链
- bump v1.30.3（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web

## v1.30.2 — 2026-09-07（Skiff MSM 调用报错语义化——"格式错"而非"没权限"，S142 用户 bug）

**Scope:** 微信桥 zhaocai 调用 memory-tool 等全部报 "tool not allowed in this skiff role"，用户实测为全拒 → 深挖破案：**模型把 MSM 名（memory-tool/anysearch 等）当直接工具调用**（不走 `msm()` 单入口），工具名不在 tools 白名单（白名单只有 msm 执行器）→ 守卫泛化拒绝 → 误导成"没权限"（read 通是因为 read 在 tools 白名单）。

### 根因链（R↓）
1. Skiff 角色双白名单：`tools`（直接工具）+ `msms`（经 msm 单入口的 MSM 面）。zhaocai 配置 tools 含 read/grep/glob/web_search/logbook/msm + msms 19 项——**配置正确**。
2. 模型调用形态错误：把 `memory-tool` 等 **MSM 名**当作**直接工具名**调用（旧 acc_msm 时代直觉残留 / LLM 对工具面误判）→ guards `decideGuard` skiff 分支：`roleToolWhitelist` 不含该名 → 泛化 deny。
3. 泛化 deny 消息 "tool not allowed in this skiff role" **无规避指引** → 模型无法自我纠正，反复误判为权限问题。

### 排除链实证（逻辑无 bug）
- 补 3 个真实 zhaocai 形态回归测试（6 tools + 19 msms）：msm/logbook/read 全 allow、白名单外 deny → guards 47/47 绿
- 全量 62/898 tests 全绿 → 纯 decideGuard 逻辑正确
- diag-live 实证 skiff 会话 cwd 指向正确 CCC 根；container_admin role list + dashboard health 实证磁盘配置为 6-tool 形态 → 运行时 root/role 解析无问题

### 修复
- `src/seams/guards.ts` skiff 分支加**两层区分**：
  - **工具名命中角色 msms 清单**（= 已授权 MSM 但调用格式错）→ deny 消息明确指引：`"<name>" is a registered MSM, not a direct tool in this role — call it through the msm tool: msm("<name>", ["<args>"])`（含 --help/inspect 提示）——告知命中 + 可行动规避（对齐 D2 打回语义化哲学）
  - **白名单外真工具**（write/bash 等）→ 保持保守泛化 deny（不泄漏白名单）
- 安全论证：msms 清单已注入角色 base prompt（`buildSkiffBasePrompt`）——对该 skiff 会话**无新增泄漏**；提示是可行动指引非白名单枚举

### 验证
- 新增 2 回归测试钉死：① 直接调 MSM 名 → deny 消息含该名 + `msm("` 指引 + 不含 "not allowed in this skiff role" ② 白名单外真工具（含旧名 acc_msm/cc_fs/session_rebuild）→ 仍保守泛化 deny 不泄漏
- **62 files / 900 tests 全绿**（895 → 900，+5）+ typecheck 双面 ✓ + build ✓

### 发布链
- bump v1.30.2（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web

## v1.30.1 — 2026-09-06（acc-* skill 模板同步 v1.30 工具面，S142 发布后核查）

**Scope:** v1.30.0 发布后用户核查发现——**技能目录（上下文注入）的 acc-* skill 描述仍是 v1.30 前旧工具语义**（acc-fs="cc-fs 语义"/acc-session="session 语义"/acc-msm="msm_list/exec/admin 语义"/acc-kit 无 dashboard 映射）。根因：v1.30 工具面重构改了代码/README/CHANGELOG/维护 skill，但**漏了 `src/templates/acc-*/SKILL.md` 模板资产**（随 npm 分发，install-skill 装到 `.dsh/skills/` 后被 DSH 技能目录投影展示给 LLM）。

### 修复
- `src/templates/` 9 个 acc-* SKILL.md 全部重写为 **v1.30 知识映射形态**（说明该领域由哪个新工具提供 + 旧→新对照；scripts/ 已退役为空目录说明）：
  - `acc-fs`：cc_fs → **container_fs**（15 子命令 + reveal）
  - `acc-git`：cc_git → **container_git**（6 子命令含 pull/diff）
  - `acc-kit`：acc_kit → **dashboard**（health/time/wait，registry 段）
  - `acc-msm`：acc_msm 拆分 → **msm**（单入口执行+发现：name/args/inspect/无参目录）+ **container_admin msm**（管理面 register/deregister/check/guide/catalog/ccc-config + 写保护）
  - `acc-session`：session + session_rebuild → **logbook**（12 子命令含 rebuild + 绑定持久化）
  - `acc-serenity`：入口全量重写——10 工具表 + 改名对照（硬切无别名）+ 版本 v1.30.0
  - `acc-eap` / `acc-neat`：praxis 关联注记（知识注入走 `praxis eap`/`praxis neat`）
  - `acc-safe-mode`：机制不变说明（WebUI 开关 + 拦截缝机械执行，非独立工具）
- **同步三层**：① 本机 CCC `.dsh/skills/`（立即生效——已实证技能目录描述即时更新）② 插件仓 `src/templates/`（发布源）③ build 时 `cp -r src/templates dist/templates`（自动）

### 验证
- 本机 9 个 acc-* 技能目录描述即时更新（DSH 技能目录投影实证：每个 write 后 catalog 立即反映新描述）
- 根仓 commit `7727095` + 插件仓 commit（fix(templates)）→ 双仓三 remote 同步

### 发布链
- bump v1.30.1（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web

## v1.30.0 — 2026-09-06（ACC 工具面重构：13 → 10 合一，S142 用户逐项裁决）

**Scope:** 用户拍板"工具面越小执行越好 + msm 重构直觉入口"——ACC 工具面从 13 个重组为 10 个：container 族命名（继承 ACC/CCC 背景）+ 知识工具三合一 praxis + session/session_rebuild 并入 logbook + acc_kit→dashboard + admin 全含 container_admin（机务舱）+ acc_msm 拆 msm 单入口（执行+发现）与 container_admin（管理）。方案 `docs/acc-tool-naming-rework.md`（v1.0 FINAL）+ `docs/acc-tool-merge-and-msm-entry-rework.md`（前版）。

### 用户裁决链（R↓ 全录）
① msm 单入口同意 → ② 命名继承背景（cc_xx→container_xx）/metaphor → ③ eap/neat/cce 合并但名要好（praxis 从 drawing/blueprint/doctrine/lenses/canon/tenets 中选）→ ④ container_admin 合并 skiff_admin 及系列 admin → ⑤ session→logbook（The Logbook 隐喻）→ ⑥ kit→dashboard（普适仪表；bridge 否——隐喻冲突）→ ⑦ **praxis 定名**（可实践理论注入）→ ⑧ admin 全含（机务舱）→ ⑨ **硬切无别名**（A）→ ⑩ R2+知识合并一起做

### 目标形态（13 → 10）
`container_fs` / `container_git` / `container_admin` / `msm` / `praxis` / `logbook` / `dashboard` / `handyman` / `localstore` / `autopilot-trajectory`

| 新工具 | 旧名 | 覆盖 | 隐喻 |
|--------|------|------|------|
| container_fs | cc_fs | 文件系统 15 子命令 | The Hull |
| container_git | cc_git | git 操作 | The Hull |
| container_admin | skiff_admin + acc_msm 管理面 | role（Skiff 角色）+ msm（register/deregister/check/guide/catalog/ccc-config）+ config | The Manifest + Crew（机务舱） |
| msm | acc_msm 执行面 | MSM 单入口执行+发现（name 自由文本默认执行 + 未命中候选 + inspect + 无参目录） | The Machinery |
| praxis | eap + neat + cce | 可实践理论注入（section: eap/neat/cce） | Engineering Drawings |
| logbook | session + session_rebuild | 会话全周期 + rebuild | The Logbook / Theseus |
| dashboard | acc_kit | health/time/wait（普适仪表） | 舰桥仪表盘 |
| handyman | handyman | 杂工编排 | Crew Rotation |
| localstore | localstore | 凭据/配置存储 | 保留 |
| autopilot-trajectory | 同 | 自主巡航 | 保留 |

### 代码实现
- `tools/msm.ts` 重写单入口（3 参数 name/args/inspect；buildMsmIndex 无参目录 + suggestMsm 模糊候选 + inspect 走 --schema 协议 + skiff 白名单门控保留）
- `tools/praxis.ts` 新建（import eap/neat/cce 的 CONTENT 常量——三源文件保留为内容提供者）
- `tools/container-admin.ts` 新建（domain: role/msm/config；role→skiff-admin 逻辑 import；msm→runMsm 管理 action；register/deregister 经 skiffMsmGate 拒绝）
- 改名：cc-fs.ts→container_fs / git.ts→container_git / kit.ts→dashboard / session.ts→logbook（+rebuild action 并入：SESSION_ACTIONS + 'rebuild' case 调 queueRebuild）
- `index.ts` 注册 10 工具（移除 eap/neat/cce/skiff_admin/session_rebuild 独立注册；rebuild.ts/skiff-admin.ts 保留为内部逻辑文件）
- `invariant.ts` REGISTERED_TOOLS → 10 新名；`dsh.plugin.json` contributes.tools → 10 新名
- `system-prompt.ts` toolsBlock 重写（10 行 + msm 单入口 4 行协议）
- **内部文件名不改**（session-ops/fs-ops/rebuild.ts/skiff-admin.ts）——只改 defineTool 对外注册名 + 引用该名的守卫/白名单/文案；内部函数 import 不变

### seams/文案同步（全仓引用旧名清理）
- `guards.ts` WRITE_TOOLS/CC_FS_WRITE_ACTIONS/isReadTool/isWriteTool/extractAction + 注册表保护提示 → container_fs / container_admin msm
- `ccc.ts` WRITE_TOOLS → container_fs
- `keeper.ts` SCORES → msm/container_fs；rebuildReminderText（普通+升级）session_rebuild → logbook rebuild
- `skiff-role.ts` roleToolWhitelist → msm（msms 非空时 MSM 通道自动可用）；buildSkiffBasePrompt msm 调用法
- `output-guard.ts` 机制词表删 session_rebuild（旧工具名已不存在；logbook/container_admin 是对外工具名不入敏感词表——防外部面误伤）
- `system-prompt.ts` identityBlock MSM 发现行 / principlesBlock use msm / localstoreBlock container_git / CodeMode container_fs/msm
- `msm-ops.ts` ACC_CATALOG 7 分区 + MSM_GUIDE + CCC_CONFIG_REFERENCE 全改新名；默认 usage `msm <name> [args...]`
- `fs-ops.ts` / `git-ops.ts` / `kit-ops.ts` / `localstore-ops.ts` 错误文案与注释全同步
- `SettingsSection.tsx` 超限重建面板文案 → logbook rebuild
- `experiments/autopilot-trajectory/SKILL.md` → msm autopilot-trajectory

### 死代码清理
- 删除 `src/tools/rebuild.ts`（session_rebuild 壳——logbook 已内联 rebuild action；服务端 src/rebuild.ts 保留）
- `skiff-admin.ts` 剥离死 defineTool 壳（container_admin role 域只 import 逻辑 + SKIFF_GUIDE）
- `tools/eap.ts`/`neat.ts`/`cce.ts` 保留为 praxis 内容源（知识常量导出）

### 测试
- **62 files / 895 tests 全绿**（新增：praxis.test.ts 6 用例镜像——coverage-gate 修复；container-admin.test.ts 10 用例 2026-09-06 早前已建）+ 全量断言同步（guards/skiff-role/skiff-core/keeper/output-guard/rebuild/osp-alignment/system-prompt/acc-extras/localstore/ops/skiff-admin）；typecheck ✓（node + client）；build ✓
- coverage-gate INDIRECT_COVERED 白名单清理（删 rebuild.ts，praxis 走独立镜像）

### 发布链
- bump v1.30.0（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web → 本地安装（D14 等用户显式要求）

## v1.29.2 — 2026-09-06（rebuild 任务焦点传递 + autopilot bound 优先唤起，S142 用户两项修正）

**Scope:** 用户两项修正——① session_rebuild 应能传递简短任务焦点文字到重建后会话（不含历史——历史完整在 SESSION.md）② autopilot-trajectory 会话绑定更稳固（唤起时能唤起最新的、绑定 autopilot SESSION 的会话）。方案 `docs/rebuild-focus-note-and-autopilot-bound-wake.md`。

### ① rebuild 任务焦点传递（R1：note 参数从丢弃 → 注入锚点）
- `src/rebuild.ts`：`buildRebuildAnchor` 加可选 `focus` 段——`- Task focus: {focus}` 置于锚点尾部（SESSION.md path 行后）；`sanitizeFocusLine` 纯函数（**单行化**换行/回车/制表→空格 + 控制字符清除 + **≤200 字截断**——防 LLM 传多行注入伪造锚点结构）；`queueRebuild` 去 `void note`（原半成品接线——note 参数曾设计但被显式丢弃）→ 透传 pending.focus + 锚点
- `src/tools/rebuild.ts`：note 参数 description 升级（"task focus ≤200 chars for the rebuilt self — what to work on next (short, no history; SESSION.md holds the full history). Injected as '- Task focus: …'"）
- **语义**：note 是给重建后自己的**任务焦点**（非历史）——锚点已有 SESSION.md 路径让模型读历史；focus 让它在读前后第一时间知道本轮做什么，降低重建后冷启动认知成本
- 无 focus → 锚点零变化（向后兼容）；空/纯空白 → 不输出 focus 段

### ② autopilot bound 优先唤起定位（R2：标题猜测 → 权威绑定）
- **gap 实证**：`resolveTargetAgent` 旧实现只按标题猜（=== sid / startsWith(sid-)）——若绑定该 autopilot SESSION（`--auto` 目录，如 S151）的 dsh 会话标题不是 `S###-` 前缀（LLM 改过/rebuild 后 rename 异常），绑定明明在（v1.29.1 `serenity/bound` 事件）却唤起失败
- `src/autopilot-trajectory.ts` `resolveTargetAgent` 重写：**bound.dirName 精确匹配优先**（权威证据，编码无关 U4）→ 标题匹配降级回退（存量无 bound 会话兼容）→ 多候选取 **bound.at 最新**（最近 use = 最可能当前在用）；agent 不可得继续返回 null
- `diagnoseTargetUnavailable` 同步：bound/标题命中但 agent 未加载统一提示"会话已绑定/匹配 … 但 agent 未加载"（原只查标题）；import `readLastBound`

### 测试
- **60 files / 879 tests 全绿**（871 + 8 净增：rebuild.test R1 4 用例——buildRebuildAnchor focus 段/无 focus 兼容/sanitizeFocusLine 消毒/queueRebuild note 透传 + autopilot-trajectory.test R2 4 用例——bound 命中即使标题不匹配/标题回退兼容/多候选取最新 bound.at/诊断文案更新 1）；typecheck ✓（node + client）；build ✓

### 发布链
- bump v1.29.2（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推 → deploy → restart-web → 本地安装


## v1.29.1 — 2026-09-05（SESSION 绑定持久化 + 切换守卫，S142 用户拍板 v1.0）

**Scope:** 用户需求——「会话和 SESSION 的绑定更坚固，避免 LLM 在过程中或 session_rebuild 后因智力因素自行更换 SESSION」+「能持久化更可靠」。调研实证 DSH `SessionEventMap` merge-extensible（compaction 先例）→ 绑定可做成**持久化会话事件**，零改 harness。用户裁决 U1-U8（含编码无关 U4：不假设 S###）。方案 `docs/session-binding-persist-plan.md` v1.0。

### 核心机制：`serenity/bound` 持久化绑定事件
- 新 `src/session-bound.ts`：`declare module '@deepseek-ai/dsh-session/types'` 扩展 SessionEventMap（官方 merge-extensible 机制，同 dsh-compaction compaction/* 先例）——`Session.append` 写入会话 append-only 日志 → 随 session.jsonl **持久化落盘**，重启后 snapshotEvents 可读
- `appendBound`（log-only 无 surfaceOp，失败不阻断主流程）/ `readLastBound`（latest-wins 权威）/ `hasAnyBound`
- **编码无关（U4）**：绑定锚 = 完整 AGENT_SESSIONS 目录名（`2026-09-05--S142--…` / issue `--apaas-26116` / autopilot `--…--auto` 均支持）；sessionId 仅派生展示
- tsconfig.json 补 `@deepseek-ai/dsh-session/types` paths（declare module 子路径解析）

### 写入点（每次绑定变化 append）
| 动作 | action | 守卫 |
|---|---|---|
| `session use` 成功 | activate（经 force 切换 = switch） | **G1 硬守卫**（U5）：已绑定 + 目标 ≠ 当前 → 拒绝英文消息，需 `--force` |
| `session create` 成功 | create（审计） | **G2（U6）**：不再 rename 夺绑定——新会话需显式 use 才绑定 |
| `session_rebuild` 排队 | rebuild | G3：queue 时持久化（权威绑定跨 rebuild 存续） |
| `session close` | release | **G4（U7）**：close 默认关**当前绑定**会话；name 不匹配拒绝 |
| 启动恢复 | reconcile | **U3 标题兼容**：无 bound + 标题含编码 → 编码无关解析 + 自动持久化 |

### 恢复链（context.ts seed 三层）
① `readLastBound`（权威绑定，替代脆弱文本扫描）→ ② `parseSessionContextFromEvents`（旧会话无 bound 回退）→ ③ 标题 reconcile（`resolveSessionByTitle` 编码无关 best-match → append reconcile + 恢复）

### 其他
- `session-ops.ts` + `resolveSessionByTitle`（完整目录名/`--<code>--` 段/唯一模糊；歧义 null 不猜）
- **效果**：LLM 不能因智力因素静默换 SESSION（每次切换需显式 --force + 日志审计）；绑定随 dsh 会话日志持久化跨 rebuild/重启；历史标题会话启动自动升级为持久绑定
- 设计：`docs/session-binding-hardening-research.md`（调研）+ `docs/session-binding-persist-plan.md`（v1.0 FINAL）

### 测试
- **60 files / 871 tests 全绿**（859 + session-bound.test.ts 9 用例 + rebuild.test 断言更新 3）；typecheck ✓（node + client，含 declare module 子路径）；build ✓

### 发布链
- bump v1.29.1（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推（origin + github + omdsh）→ deploy → restart-web → 本地安装

## v1.29.0 — 2026-09-05（三项完善 + trajectory-assistant 合并发布，S142 用户拍板）

**Scope:** 两批已实现未发布的代码合并为一个版本——① **三项完善**（用户拍板：星舰意象 / 配置合一 / DSH 平台会话物理删除）② **trajectory-assistant**（用户拍板：过程中提示注入统一命名 + 关卡化设计，含 D8 词法原则）。原计划 v1.29（三项完善）+ v1.29.x（trajectory-assistant）分开，用户 D14 显式要求"发新的小版本，然后本地安装"→ 合并 v1.29.0。

### ① 三项完善（three-improvements-design.md v0.1→定稿）
- **metaphor 星舰意象升级（①）**：metaphorBlock() 海船→星舰（one starship, one voyage / deep space has no mistakes—only stars you have not yet mapped / Departure Inspection→First Anchor / debris in the hold / star charts / flight-worthy / launching）；SHIP/VOYAGE/CREW 三层 + M-1~M-4 映射不变；osp-alignment 断言同步（Deep space 句 + Departure Inspection）；docs/metaphor-domain.md 同步（v1.29 变更历史）
- **配置合一 UI（②）**：RowCard 可展开（整行点击 + expandable/open/onToggle/detail）；双端口网关行内联 AccountsEditor（删独立「外部访问」Collapse）；超限重建行内联阈值+说明；Skiff/ACP/问答页/Autopilot 行内联 detail（问答页挂 PublicAskEditor、Autopilot 挂状态块+autopilotOn prop）；彩蛋/微信桥保留独立折叠；CSS 新增 .ss-expandable/.ss-expanded/.ss-expandMark/.ss-rowDetail/.ss-detailStack/.ss-detailIntro/.ss-error
- **DSH 会话物理删除（③）**：新 `src/session-cleanup.ts`（sessionsRootDir `$DSH_HOME/sessions` / findSessionLog / collectEligibleSessions **lastActive 基准** + live 会话保护跳过 / performCleanup dryRun + 物理删 / cutoffDaysAgo——纯逻辑零 ctx 可单测）；api.ts `GET/POST /serenity/session-cleanup`（GET 预览 / POST 执行，x-serenity-ui 头，live ids 从 ctx.get('sessions')）；SettingsSection 新增 SessionCleanupBlock（天数输入 + 预览 + 双击确认执行）——**不过滤不归档直接物理删**，仅保留 live 会话保护底线（用户拍板 ③ 决策）

### ② trajectory-assistant：关卡化注入统一命名（v0.3，D1-D8 用户裁决）
- **概念（用户拍板）**：dsp 全部"过程中动态提示注入"统一命名为 trajectory-assistant（轨迹助航员）；关卡设计思想塑造结构与时机，**不用于提示词用词**（D8——游戏黑话 BOSS/XP 禁，CHECKPOINT/LIMIT 等自然词可）
- **新 `src/trajectory-assistant.ts`**：token 常量单一真相源（ASSISTANT_PREFIX/EVENT_LABEL/eventToken/ACK 前缀）+ style facade（plain 默认 / metaphor 变体，**无 game 档**——D8）+ onSettlement seam（OP-1 预留——结算触发"工作完成且用户认可"难自动检测，留挂点）
- **全动态层 token 接线**：keeper.ts reminderText→`[TRAJECTORY-ASSISTANT · CHECKPOINT]` + rebuildReminderText→`· LIMIT`/`· LIMIT · MANDATORY`；rebuild.ts 锚点头→`· REBUILD`（2 处）；tools/rebuild.ts 描述引用；output-guard.ts→`· BOUNDARY GUARD`（+ 敏感词表补 TRAJECTORY-STEWARD/ASSISTANT 旧新名）；autopilot-trajectory.ts 头→`[Autopilot Trajectory · 唤起]`（正文 D8 不动）；system-prompt.ts sessionBlock 协议说明同步；msm-ops.ts 注释
- **协议正文保持纯净（D8）**：first-anchor 两轮 + autopilot 四段正文逐字节未动；[ACC] 身份信标保留
- 设计文档：`docs/trajectory-assistant-design.md`（v0.1 概念 + §0 D8）+ `docs/trajectory-assistant-plan.md`（v0.3 英文完整方案，APPROVED）

### 测试
- **59 files / 862 tests 全绿**（858 + 新增 8 用例 trajectory-assistant 模块 + 镜像门禁补覆盖；三完善 58/856 → 合并 59/862）；typecheck ✓（node + client）；build ✓

### 发布链
- bump v1.29.0（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推（origin + github + omdsh）→ deploy → restart-web → 本地安装（npm-install / deploy profile web）



**Scope:** 用户报告两个 3081 外部访问 bug——① 被 DSH 0.1.2-rc.1 新增 BrowserAuth 拦截（"dsh web authentication required"）② 登录后白屏（https://dsh.notfoundhome.cc）。排查实证两条独立根因链，分两个修复模块 + 一个诊断 MSM（gateway-diag，home-serenity 侧）。

### ① BrowserAuth 401（gateway-dsh-auth.ts 新模块）
- **机制实证**：0.1.2-rc.1 主端口所有 /api + index 需 authority 绑定的签名 cookie（`dsh-auth-<sha256(Host)>`，browser-auth.ts）；3081 网关反代 Host 已改写 loopback 过信任栅栏，但**无 dsh cookie** → 上游 401
- **方案（用户拍板：不 cookie 落盘绕，直接解决；用户 3081 无感）**：dsp 与 DSH 同进程 → 经 `ctx.connection`（HostConnectionHandle）官方通道（authenticatedUrl + authorizeIndex——web-app openBrowser 同款）**内存换取** authority=127.0.0.1:主端口 的 dsh cookie + 缓存（`createDshCookieProvider` 惰性换取，失败不缓存可重试）→ 注入所有反代上游请求头（upstreamHeaders/mergeCookieHeader 保留外部 cookie）
- **零落盘、无 HTTP 往返、不复制官方 HMAC**（版本漂移风险为零）；connection 服务缺失（旧 dsh/非 web 装配）→ 不注入天然兼容
- **时序坑**：`ctx.get('connection')` 在 gateway sync（apply 早期）时不可取（connection 晚装配）→ 改每次调用现取的**惰性 provider** → 日志实证 "connection ✓ 可取 + cookie ✓ 已内存换取" → 401 消除

### ② 登录后白屏（gateway-proxy.ts transformHtmlForProxy）
- **根因（gateway-diag gzip-test 复现 + cookie-test 决定性证据）**：浏览器带 `Accept-Encoding: gzip` → gateway 透传 → 主端口返回 **gzip 压缩 HTML** → 注入分支把**压缩字节** toString 当文本注入 → 找不到 `</head>` → polyfill 前置 → HTML 损坏 → 白屏
- **修复**：gateway-proxy.ts 新 `transformHtmlForProxy` 纯函数——content-encoding 存在则 gunzip/brotli/inflate 解压 → 明文注入 → 去 encoding 头 + 重算 content-length + 去 transfer-encoding；**解压失败返回 null → 调用方原样透传**（不破坏）。gateway.ts HTML 注入分支统一改用
- **gateway-diag 诊断 MSM**（home-serenity 侧，常驻）：status/proxy/index/main-index/login/cookie-test/gzip-test 七子命令纯 curl HTTP 定位——cookie-test 区分失效层（本机/Host/公网三路）、gzip-test 复现压缩破坏

### 测试
- **57 files / 848 tests 全绿**（848 = 828 + gateway-dsh-auth + transformHtmlForProxy +6）；typecheck ✓（node + client）；build ✓

### 发布链
- bump v1.28.2（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推（origin + github + omdsh）→ deploy → restart-web


## v1.28.1 — 2026-09-05（0.1.2-rc.1 适配补齐：Session.events 移除 → snapshotEvents()，7 处裸读收敛——first-anchor 重插 + SESSION 激活恢复失效根治，S142 用户 bug 双报）

**Scope:** 用户报告两 bug——① SESSION 激活 rebuild 后会乱掉（anchor 曾指向 S151 而非 S142）② 任何情况发消息都插入 first-anchor（resume/续跑也重锚）。排查实证：**0.1.2-rc.1 官方移除 `Session.events` 属性 → `snapshotEvents()` 方法**，但适配轮只修了 typecheck 直接报错的 2 处（handyman.ts / skiff-core.ts），其余 7 处裸读 `.events` 经 `as unknown as { events? }` 断言绕过 typecheck → 运行时静默 undefined → 判定链全断（测试替身仍用 `.events` 属性 → 815 全绿假象）。

### 变更
- **`session-ops.ts` 新增共享 `sessionEvents<T>()` helper**（snapshotEvents() 优先 + .events 兜底 + try/catch + 泛型，零 DSH 依赖）——**单一真相源**，所有消费方经此读取，禁止裸读 `.events`
- **7 处裸读全替换**（按 bug 影响排序）：
  - `seams/bootstrap.ts` L280 重锚判定（**bug ② 病根**：`session?.events?.some(user/message)` 恒 undefined → `!undefined`=true → 有历史也永不跳过 → 每条消息都重插锚定）→ `hasUserMessageHistory` 导出纯函数（可单测）；L119 scan 晋升状态同步修
  - `seams/context.ts` L114 shouldRestoreActive + L150 重启恢复解析（**bug ① 病根**：有历史才恢复 SESSION 激活判定失效 → rebuild 后恢复不到正确 SESSION）
  - `rebuild.ts` L123 parseAnchorMdPath + L155 resolveSessionMdPath 候选② events 恢复 + L295 performRebuild meter 定价（rebuild 定位错乱 + 计量漂移）
  - `output-guard-seam.ts` L38 守卫读最后 assistant 文本（外部面守卫失效——同根因连带）
  - `autopilot-trajectory.ts` L435 readSessionTitle（读 session/title 失效——面板标题 null）
- **skiff-core.ts**：本地 sessionEvents 副本保留（独立 import 面）但注释注明收敛基准指向共享 helper
- **测试补 16 用例（snapshotEvents 形态回归）**：session-ops 5（helper 双形态/抛错/空值）+ bootstrap 4（hasUserMessageHistory 含 snapshotEvents 形态）+ context 3（shouldRestoreActive snapshotEvents）+ rebuild 2（resolveSessionMdPath/queueRebuild snapshotEvents 定位 S142）+ autopilot-trajectory.test mock 补 sessionEvents 实现（mock 模块缺导出导致 readSessionTitle 全 null——首轮 test 6 失败即此，补后全绿）

### 测试
- **56 files / 828 tests 全绿**（812 + 16 净增）；typecheck ✓（node + client）；build ✓

### 发布链
- bump v1.28.1（package.json / dsh.plugin.json / CHANGELOG 三处一致）→ test → build → publish npm → github-push 三推（origin + github + omdsh）→ 本地安装


## v1.28.0 — 2026-09-05（五项需求实现 + review 双轮修复批 + rebuild 诊断通道：系统提示词工具块移尾 + 会话命名概括 + rebuild 阈值 K 数值 + MSM 注册表单级化与写保护 + acc_msm catalog 目录，S142 用户拍板）

**Scope:** 用户 09-04 晚回家对五项调研需求（`docs/three-feature-requests-research.md` v0.2）逐项拍板后开工实现——① rebuild 阈值百分比→K 数值 ② 会话命名加 ≤20 字概括 ③ 系统提示词 MSM 调用示例 + 工具列表独立块移末尾 ④ 目录式 ACC 使用指南（并入 acc_msm）⑤ MSM 注册表单级化 + 写保护 + ACC 层完整性检查。5 个 commit + 两轮独立 review + 发布。

### ① rebuild 阈值：百分比 → K 数值（用户拍板：新键 rebuildThresholdK 默认 400K，纯绝对无窗口比例保护）
- `settings-section.ts`：`rebuildThreshold`（0~1 比例默认 0.9）→ **`rebuildThresholdK`**（z.number min 50 max 4000 默认 400）；SimpleConfigFragment.rebuild.thresholdRatio → thresholdK；entryDefaults/defaultSimpleSettings 同步
- `seams/keeper.ts`：判定从 `ratio = projectedTokens/contextWindow; ratio >= threshold` 改 **`projectedTokens >= thresholdK*1000`**（不再依赖 contextWindow，缺失也照常触发）；文案 K 化 `Context usage at NNNK (threshold NNNK)`
- `config-ops.ts` RebuildSettings.thresholdRatio → thresholdK（默认 400；merge/update 校验 50~4000）；`client/accounts-api.ts` wire 同步；`index.ts` Config schema 同步
- `client/SettingsSection.tsx`：面板滑块（0.10~1.00）→ **K 数字输入**（50~4000 step 50）；help 文案 K 化
- 注：settings.yaml 旧键 `rebuildThreshold` 残留被 schema 忽略（非 strict z.object），新键默认 400K 生效——用户需在面板改回所需值

### ② 会话命名加 ≤20 字概括（用户拍板：summary 必填，编号日期服务端固定派生）
- `tools/session.ts`：`sanitizeSessionSummary`（去控制符/斜杠 + trim + ≤20 码点截断）；`namingTitleFor(active, summary?)` → **`S###-YYYY-MM-DD-<概括>`**；session **use/create 的 summary 参数必填**（缺省报错引导）；renameDshSessionOnUse/ForActive 透传
- `tools/rebuild.ts` + `rebuild.ts`：session_rebuild **summary 必填** → PendingRebuild 存 summary+mdPath → **renameAfterRebuild** 重建后重命名标题（S### 日期从持久轨迹目录派生，概括来自参数）
- 向后兼容：无 summary 时 namingTitleFor 回退 S###-日期（旧调用不破坏）；autopilot `startsWith(sid-)` 匹配天然兼容

### ③ 系统提示词：MSM 调用示例 + 工具列表独立块移末尾（用户拍板：SKILL 后 Session 前）
- `seams/system-prompt.ts`：`accBlock` 拆分 **`identityBlock`**（ACC 身份/CCC/平台工具说明——身份先行，不再内嵌 13 行工具清单）+ **`toolsBlock`**（13 工具含 autopilot-trajectory——修原清单滞后缺行 + skiff_admin 补 apply + **MSM 调用 3 步协议示例**：acc_msm list 发现 / `--schema 1` 查用法 / exec 执行 + mech-registry 不可直写声明）
- 装配序：ACC(身份)→Metaphor→Principles→CCE→EAP→状态→SKILL→**Tools**→Session
- tests/osp-alignment + system-prompt 同步（块序含 Tools + 工具断言改指 toolsBlock）

### ④ 目录式 ACC 使用指南（用户拍板：并入 acc_msm，不新建 acc_guide 工具）
- `msm-ops.ts`：新 action **`catalog`** + `ACC_CATALOG` 常量——ACC 能力目录 **7 分区**（会话与轨迹/认知质量/工具执行/角色对外/自主接入/CCC 配置/注册表安全），每区一句话定位 + 详细 guide 入口；**目录在前、详情各归各（单一真相源——不复制详情）**
- tools/msm 描述 + system-prompt toolsBlock/identity 指引同步（"First-time in a CCC? Run acc_msm catalog"）

### ⑤ MSM 注册表单级化 + 写保护 + ACC 层完整性检查（用户拍板：注册表只有一级对齐 osp；检查入 acc_kit health 只给指引；写保护）
- **⑤a 单级化**：`msm-ops.ts` findRegistries/registryPathFor **只读写 `.opencode/skills/<cccName>/references/mech-registry.json`**（cccName=.serenity 首行），skill 只进 entry 字段；废弃历史分散 skill 注册表（register --skill 曾写各自目录）+ root 级兜底
- **⑤b 写保护**：`seams/guards.ts` `isProtectedRegistryRel`（**写 deny 读 allow**——R6 与 localstore 读 deny 语义区分：注册表是结构核心不是秘密，需被 output-guard/skiff-admin 读取建 MSM 词表）；`fs-ops.ts` validateWritePath 保护改指 cccName 聚合档 + root 级（分散残留放行可删迁移）；acc_msm register/deregister 内部 writeRegistry 天然豁免
- **⑤c 健康检查**：`kit-ops.ts` `checkRegistryHealth` 入 **acc_kit health 的 registry 段**——parse（剥 BOM）/顶层 wrapper 结构/每 entry 字段类型/name 唯一/path 根内+脚本存在；**坏不抛错**（坏表 → ok:false + issues + git 恢复指引——register/deregister 精提交历史可 `git checkout -- <registry>` 恢复）；用户拍板：只输出指引不内置 --restore
- CCC 数据：home-serenity 聚合档并入 6 分散 entry（mail-tool/memory-tool/movie-search/home-diag/session-log-tool/h3-pipeline → 67 entries 总）；分散文件保留（用户拍板——新代码不读，无害残留）；其他 CCC（pangu/tiangong/sh）单级化后各自需手工并入自身 cccName 聚合档（待办）

### review 修复批（第一轮：P1 + P2-2~P2-5 + P3 五项，独立 review 后修复）
- **P1 单级化死锁**：root 级注册表解除写保护（废弃形态死锁——不被读又不可删/迁移）；**P2-1 平台大小写统一**（win32 不敏感/posix 敏感——Linux 大写 CCC 名不得误放行）
- **P2-2 祖先目录写保护**：受保护范围从"聚合档精确文件"扩为 **references/ 目录级**——`cc_fs rm -r references/` / `mv references/` 不再能绕过文件级保护删掉注册表（guards.ts isProtectedRegistryRel + fs-ops.ts protectedRegistryTargets 双实现一致；共享父目录 .opencode/skills/<cccName> 不纳入防误伤其他 skill 子目录）
- **P2-3 高级 rebuild 死双胞胎删除**：config-ops AdvancedSettings.rebuild / RebuildSettings / wire.rebuild / applyWirePatch rebuild 段全删——rebuild 归简单配置（settings.yaml）单源，/serenity/config 不再回显死配置；旧文件残留 rebuild 键被 mergeWithDefaults 幂等忽略；accounts-api WireConfig 同步
- **P2-4 迁移提示**：重建阈值面板 help 注明"旧版 0~1 比例（settings.yaml rebuildThreshold）已废弃被忽略——按 K 数值重设"
- **P2-5 跨平台路径判定**：checkRegistryHealth 脚本路径 escape 判断改 `pathInside`（替代 startsWith(root+'/')——Windows 全量误报）
- **P3-①**：session create **dry-run / issue 会话豁免 summary 必填**（未真实创建/无概括语义）；issue rename 以 issue 号作概括回退
- **P3-②**：queueRebuild 报错文案提示 `session use <S###> --summary <概括>`
- **P3-③**：register **首建统一 v1 wrapper**（旧裸数组与 v1 wrapper 并存分裂消除；既有裸数组保留格式承诺不破坏）
- **P3-④**：checkRegistryHealth 无 cccName 时 **issues 空 + ok:true**（path:null 已表达无注册表可查，不再 ok:true 与 issues 并存矛盾）
- **P3-⑤**：toolsBlock acc_kit 行补 "+ MSM registry integrity report"
- **测试同步 + 新增**：guards root 级改 allow（P1 语义）+ references deny ×3 / fs-ops rm -r references [SKIP] + mv 拒 + 普通目录不误伤 / config-ops legacy rebuild 忽略 —— **54 files / 792 tests 全绿 + typecheck/build 双面 ✓**

### rebuild 用户 bug 诊断通道（2026-09-05，用户："调用成功但会话没重建"）
- **症状**：用户 [TRAJECTORY] 触发后调 session_rebuild "调用无效/返回成功但会话没重建"——事实澄清（时间线实证）：v1.27.14 npm 发布物不含五项需求（bump 先于五项 commit）→ 本机 deploy = 未发布代码 → 用户感知 "27.14 改坏" 实为**未发布代码行为变化**（② summary 必填新语义）
- **诊断落盘 `src/rebuild.ts`**：`AGENT_SESSIONS/.rebuild-diag.json`（CCC 内可读）——每次 queued / ttl-dropped / rebuilt / failed / empty-surface 路径记录 + 计数；错误不再只 console.warn（此前 performRebuild 抛错仅 warn → 用户无感知 = "无反应"）
- **keeper 文案补 summary 指引（嫌疑①根治）**：`rebuildReminderText`（普通 + escalated）补 "passing --summary '<content summary ≤20 chars>' (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild)"——需求② summary 必填后，旧文案只叫 "call the session_rebuild tool" 未指导带 summary → 模型裸调必被拒（"调用无效"）；新文案让 [TRAJECTORY] 触发链一次成功
- **实证**：本会话自身 rebuild 全链路成功（diag: queue 1 / rebuilt 1 / dropped 0 / failed 0，[TRAJECTORY-REBUILD] 开头）

### 复验修复批（第二轮，独立复验 subagent 裁决"需修改后再发布"，09-05 修复后发布）
- **P1-1 references/ 目录保护收窄**（复验 P1，应修）：原 review P2-2 的 references/ 保护用**子树前缀**（startsWith refsDir/）→ 把 `.opencode/skills/<cccName>/references/` **整棵子树**（含与 mech-registry.json 并置的合法知识文档——home-serenity 实测 msm-writing-standards.md 等 8 个）都纳入写保护 → 上线后 agent 无法维护这些文档。**收窄 = 保护 ① 聚合档文件精确路径 + ② references/ 目录节点本身**（rm -r / mv 目录 deny）——防绕过语义 = 删目录，目录节点相等已足够；子树内兄弟文档写/编辑/删放行（guards.ts isProtectedRegistryRel + fs-ops.ts isProtectedRegistryTarget 双实现一致）
- **P2-1 session 工具描述同步豁免**（复验 P2）：描述仍写 create 一律要求 --summary，代码已对 dry-run/issue 豁免（P3-①）——LLM 契约漂移，描述补 "except --dry-run preview and --issue sessions which are exempt"
- **P2-2 cccName 解析收口**（复验 P2）：四处解析规则不一致（msm-ops/kit-ops 严格首行 vs guards/fs-ops 跳 # 注释空行）→ **统一收口 ccc.ts `readCccName`**（跳过 # 注释与空行的首非空行，null-safe），msm-ops 导出名转发 / kit-ops null 容错转发 / guards + fs-ops 删本地实现改用规范——.serenity 首行为注释时 register 目标路径与保护路径不再分叉
- **测试同步 + 新增**：guards references 兄弟文档写 allow ×2（文件级 + 子树深层）/ 目录节点 rm/mv deny 保留 / fs-ops 兄弟文档 append + rm 放行 —— **54 files / 794 tests 全绿 + typecheck/build 双面 ✓**

### 测试
- **54 files / 794 tests 全绿**（768 + 26 净增：③+2 / ②+6 / ⑤b guards+6 / ⑤c checkRegistryHealth+7 / ④ catalog+1 / 复验修复批 +4）；typecheck ✓（node + client）；build ✓


## v1.27.14 — 2026-09-04（白色主题通性修复：CSS 自造 token → 官方词汇；含 v1.27.13 hook 并入，S142 用户反馈 + 拍板）

**Scope:** 用户转述反馈："插件好像还有个白色主题通性问题，就是他喜欢用纯黑框，然后有的字体也是纯黑色"——client CSS 使用了 design-platform.css 官方 alias 词汇表中**不存在的自造 token**（bg-module / surface-raised / fill-l1 / text-primary / text-secondary / bg-secondary / accent / border / state-success / state-error / state-warning-fg / state-danger-* / state-success-fg / button-primary-bg/fg / bg-l2 / font-mono 等）→ `var()` 永不解析 → 永远走深色 fallback（`#1e1e1e` 等）→ **浅色主题下弹层/输入框/浮层呈黑色块（"纯黑框"）+ 深色底上文字解析为近黑（"纯黑字体"）不可读**；深色主题下 fallback 恰似深色观感而未暴露（白主题用户 wanglingqing 实测报告）。

> 注：v1.27.13（微信桥消息记录 hook，CCC 自写持久性保存）并入本版发布——hook 代码 2026-09-02 完成、S154 于 2026-09-04 E2E 测通（运行时 v1.27.12 已含 hook 支持，文档标注仅为发布补全）。

### 变更
- **token 合规修复（全部对齐官方 design-platform.css 词汇 + 官方组件用法实证）**：
  - `SafeModePanel.css`：`.sp-pop` 弹层背景 `bg-module`→`bg-overlay`（light=浅灰/dark=中灰，两端自适应）；`.sp-card`/`.sp-row`/`.sp-actions` 删 `color-mix(... bg-module ...)` 嵌套 fallback → 直接 `bg-layer-2`
  - `SettingsSection.css`：`.ss-helpTip` 帮助浮层 `surface-raised, #1e1e1e`→`bg-overlay`（**白主题"大黑块"直接根因**）；`.ss-portInput`/`.ss-select`/`.ss-routesEditor` `fill-l1`→`bg-layer-2`；`.ss-switch` 轨道/thumb 对齐官方（OFF=border-l3、ON=brand-primary、thumb=label-primary-foreground——官方 SubagentModelSelectionCard 同款）；`--ds-font-mono`→`--ds-font-family-code`（官方 base.css 变量）
  - `PersonaEditor.css`：整文件重映射——`text-primary/text-secondary`→`label-primary/label-secondary`、`bg-secondary`→`bg-layer-2`、`border`→`border-l2`、`accent`→`button-ghost-active-border`（focus）/`button-primary-fill`+`label-primary-foreground`（主按钮，官方 Button.module.css 同款）、`state-success/state-error`→`state-success-primary/state-error-primary`、`font-mono`→`--ds-font-family-code`
  - `AccountsEditor.css`：`.ae-input` `bg-module`→`bg-layer-2`、focus `button-primary-bg/accent`→`button-ghost-active-border`；`.ae-totpSecret` `surface-raised`→`bg-layer-2` + `--ds-font-family-code`；`.ae-totpUri`/`.ae-check` accent→`button-info-fill`；`.ae-totpBadge`/`.ae-warn` `state-warning-fg`→`state-warn-label`；`.ae-del`/`.ae-error`/`.ae-err`/`.ae-rotate`/`.ae-wsDel` `state-danger-*`→`state-error-primary` + `interactive-bg-hover-danger`（官方 danger hover token）；`.ae-save`/`.ae-chipOn` `button-primary-bg/fg`→`button-primary-fill`+`label-primary-foreground`；`.ae-chip`/`.ae-copy` `text-primary`→`label-primary`、hover accent→`button-ghost-active-border`；`.ae-saved` `state-success-fg`→`state-success-primary`；`.ae-key` `bg-l2`→`bg-layer-2`
  - 保留：`.ss-qrSvg`/`.ae-totpQr` 白底（二维码扫码物理需求，注释在案）；`.sp-switchThumb` 灰白 thumb（明暗通用中性色，Mac 滑块设计）
- **新增 `tests/client-css-tokens.test.ts`（4 用例）**：机械守卫 client CSS 引用的 `var(--dsw-alias-*)`/`var(--ds-*)` ∈ 官方词汇表（内嵌 design-platform.css + base.css 清单）——**防自造 token 再犯**（本次 bug 根因即自造名；放行 `--sp-*`/`--dsl-*` 自有前缀）

### v1.27.13 并入（微信桥消息记录 hook——2026-09-02 代码，2026-09-04 S154 E2E 测通后并入发布）
- **微信桥双向消息记录 hook**：`src/weixin-hook.ts`（新：buildIncoming/OutgoingHookEvent 纯函数 + runWeixinHook spawn 执行器——CCC 根脚本 stdin 单行 JSON 事件，bun 优先 node 兜底，15s 超时 kill + fire-and-forget 旁路容忍）+ `ccc.ts` WeixinSettings.hook 字段 + `weixin-route.ts` readWeixinSettings 透传 + `weixin-bridge.ts` handleIncoming 双向触发（incoming 在媒体落盘后 askSkiff 前 / outgoing 在 sendTextMessage 成功后；reply = markdownToPlainText(stripThink(answer))——hook 记录与微信实际收到一致）；**事件不含会话凭据**（无 context_token/bot_token/token——最小暴露面）；媒体带 relPath 或 null
- **CCC 指南双通道**：插件侧 `msm-ops.ts CCC_CONFIG_REFERENCE` 大而全扩展（5 段 → 8 段：skiff.roles / autopilotTrajectory / weixin 含 hook 完整用法）+ CCC 侧 `weixin-doctor` guide 子命令（微信桥大而全指南含 hook 事件格式 + 示例脚本）
- 测试 +12 → 53 files / 764 tests；顺带修复 autopilot 测试跨日 flake（setMtimeHoursAgo baseMs 基准参数）
- 📄 docs/weixin-message-hook-design.md（设计 v0.1）
- **CCC 落地实证（S154，非本仓代码）**：home-serenity `scripts/weixin-message-hook.ts` + serenity.json weixin.hook 接线 → `AGENT_SESSIONS/_weixin-logs/YYYY-MM-DD.jsonl` 双向事件 + media/ 媒体拷贝落盘 E2E 测通

### 测试
- **54 files / 768 tests 全绿**（764 + 4 新 token 合规）；typecheck ✓（node + client）；build ✓


**Scope:** 用户 "把这个上限删了吧，没意义"——Autopilot Trajectory 的每日唤起预算（`maxDailyWakes`，默认 8）对高频实验构成人为限制：intervalHours 已支持小数（v1.27.8，0.01h≈36s）但每日上限仍卡总次数。彻底移除：**唤起频率只受 intervalHours 与避开窗口约束**（实验想多快就多快），审计日志保留（recentWakes 仍记录每次唤起，仅不再参与判定）。

> 注：v1.27.11 草案（maxDailyWakes=0 表示无限制）被本版本取代——用户裁定直接删除配置项，不做特殊值语义。

### 变更
- **`src/autopilot-trajectory.ts` 彻底移除预算**：
  - 删 `DEFAULT_MAX_DAILY_WAKES` 常量 + `dailyWakeCount`（当日计数）+ shouldWake 预算检查（今天已唤起 N 次 → false）
  - `performAutopilotWake` 不再读预算；`shouldWake` 条件收敛为 enabled / 未运行 / --auto 标志 / 窗口 / 间隔 / 偏见脚本（出参 `_history` 保留仅审计）
  - 阈值注释/行为注释同步清理（预算字样归零）
- **`src/ccc.ts` 删 `maxDailyWakes` 配置字段**（AutopilotTrajectorySettings / 默认值 / 校验）
- **`src/client/SettingsSection.tsx` 删面板「每日预算」项**（AutopilotTrajectoryStatus wire 去 maxDailyWakes；状态区块注释同步）
- **`tests/autopilot-trajectory.test.ts` 删 3 预算用例**（当日计数归零/预算满拒绝/预算恢复）+ 改名 1 处（"当日预算已满也跳过" → "已有唤醒历史也跳过（历史仅审计不限制）"）+ 头部注释更新

### 测试
- **52 files / 752 tests 全绿**（755 − 3 删除）；typecheck ✓（node + client）

## v1.27.10 — 2026-09-02（修复：面板打开 autopilot 全局开关不热启动定时器——"开了但不唤起"，S142 用户报告）

**Scope:** 用户 v1.27.9 发布后实测："唤起有问题，我开了但是不唤起，bug？读不到某个CCC的配置"。diag-live 排查确认：home-serenity 配置健全（enabled ✓ / session S151 ✓ / --auto ✓ / 偏见脚本 ✓ / agent 可注入 ✓；空闲 1.7h < interval 2h 是等待中非 bug）——**真 bug = 面板打开全局开关不热启动定时器**。

### 根因
v1.27.9 全局开关 `autopilotEnabled` 只在**插件 apply 时 + session/created 时**读一次启动定时器；**面板打开开关 → settings.yaml 变化 → 只 emit `serenity/settings-changed`（gateway 在听）→ 没有监听者启动 autopilot 定时器** → 全局开了但定时器不启动 → 永不唤起。

### 变更
- **`src/autopilot-trajectory.ts` `registerAutopilot` 增加第三事件监听**：`serenity/settings-changed` → `startTimer()`——面板打开/关闭全局开关即时热启动/生效（startTimer 内部 `if (timer) return` + `globalOn()` 幂等守卫）；settings 服务缺失时降级（用户可重启 web 生效）

### 测试
- **autopilot-trajectory.test.ts +1**：全局关启动 → 面板开（source 切 true）→ emit settings-changed → 定时器热启动
- **52 files / 755 tests 全绿**（754 + 1）；typecheck ✓（node + client）

## v1.27.9 — 2026-09-02（Autopilot Trajectory 全局开关，默认关，S142 用户需求）

**Scope:** 用户 "考虑给autopilot-trajectory做全局开关，默认关闭；这样可以只在指定的电脑进行autopilot-trajectory"——plugin 全局总开关（settings autopilotEnabled，默认 false）：多台电脑装 dsp 时只有开启的那台跑 autopilot，其余默认零资源占用。

### 变更
- **`src/settings-section.ts` 全局开关 wire**：`SerenitySimpleSettings` / `simpleSettingsSchema` / `entryDefaults` / `defaultSimpleSettings` 加 `autopilotEnabled`（**默认 false**）——settings.yaml 持久化（`serenity-hooks.autopilotEnabled`），面板 Toggle 即时保存
- **`src/autopilot-trajectory.ts` 双重门控**：`registerAutopilot` 内 `globalOn()` 读 `readSimpleSettings().autopilotEnabled`——
  - 全局关 → **定时器不启动**（零资源占用，插件加载即无）
  - tick 内也检查 → **中途关闭全局即停**（不再唤起）
  - 双重门控：`全局开关 AND CCC 级 enabled（serenity.json）` 都满足才运行；CCC 级配置（interval/session/bias/topPrompt）不动
- **`src/client/SettingsSection.tsx` 面板**：「外部能力」组加 **Autopilot Trajectory 开关**（带 help——全局/默认关/双重门控/指定电脑语义）；Autopilot 折叠 desc 动态显示「全局已开启 / 全局关闭（外部能力组开启）」

### 测试
- **autopilot-trajectory.test.ts +2**：全局关（即使 CCC 启用也不启动定时器——零资源）+ 全局开（双重门控启动）；register describe 默认注入全局开（验证 CCC 级语义）
- **settings-section.test.ts 断言补 autopilotEnabled: false**（entry 默认 + Config 覆盖）
- **52 files / 754 tests 全绿**（752 + 2）；typecheck ✓（node + client）

## v1.27.8 — 2026-09-02（Autopilot Trajectory 间隔支持小数 + tick 5min，S142 用户实验需求）

**Scope:** 用户在做 autopilot-trajectory 实验，想把某 CCC 频率设到很快（1 分钟就重新走随机脚本）——"让它支持小数行吗，这样可以配0.01"；随后"tick改为5分钟吧"。① intervalHours 支持小数（0.01h ≈ 36s，高频实验）② tick 10min → 5min。

### 变更
- **`src/autopilot-trajectory.ts` 间隔支持小数（v1.27.8 核心）**：
  - 新增 `MIN_INTERVAL_HOURS = 0.01`（≈36s）——`shouldWake` / `performAutopilotWake` / `getAutopilotStatus` 的 `Math.max(1, ...)` 全部改为 `Math.max(MIN_INTERVAL_HOURS, ...)`
  - 语义说明：配置 `intervalHours: 0.01` → 距上次活动满 36s 即满足间隔；真实唤起频率受 tick 限制（0.01h 等价于每个 tick 都唤起）
  - 每轮仍重跑随机偏见脚本（`fetchBiasContent` 每次唤起执行——"1 分钟后重新走随机脚本"成立）
- **tick 10min → 5min（用户追加）**：`TICK_MS = 5 * 60 * 1000`——更快响应间隔评估，高频实验更近实时
- **buildWakeMessage 间隔人性化显示**：`<1h` → `约 N 分钟`（0.01h → "约 1 分钟"）；`>=1h` 仍显小时

### 测试
- **autopilot-trajectory.test.ts +2**：小数间隔判定（0.01h 满 36s 唤起 / 30s 不足不唤起 / 0.5h 生效）+ 唤起消息分钟显示（0.01h → "约 1 分钟"；2h → "2 小时"）
- **52 files / 752 tests 全绿**（750 + 2）；typecheck ✓（node + client）

## v1.27.7 — 2026-09-02（输出守卫不检查 think 内容，S142 用户反馈）

**Scope:** 用户 "敏感词防护是做在哪一层的；要求不检查think内容（因为不输出）"——① 明确防护层级（turn-stopping 拦截缝 + 词表 + steer 打回，仅外部面）；② **think 块不再参与敏感词检测**——` thinking…` 是模型思考过程，不进入用户可见输出；原实现取全部 text（含 think 块），think 内推演内部机制词会被误打回。

### 变更
- **`src/output-guard-seam.ts` `lastAssistantText` 先 stripThink 再返回**：
  - 取 turn 最后 assistant text 后调用 `stripThink()`（复用 v1.26.8 状态机，v1.27.1 微信桥回复链路同款）——剥离 ` thinking…` 块，只保留最终呈现文本
  - 效果：think 内提及凭据词/机制词/端口/MSM 名（思考过程必然推演内部机制）**不再触发打回**；最终输出正文仍严格检测
  - 作用范围不变：仅外部面（skiff-/acp-/rebuild- 前缀）；本地维护会话豁免
- **防护层级答案（S142 记录）**：拦截缝 `agent/turn-stopping`（serial）+ 词表 `buildSensitiveTable`（凭据 localstore 名/值 + 机制词静态表 + 端口 + MSM 工具名）+ 动作 `agent.steer(buildRebuke())` 打回重生成（≤3 次，超限保留审计）

### 测试
- **output-guard.test.ts +1**：`v1.27.7 think 块内敏感词 → 不检测不打回`——` thinking` 内含 SSH_UBUNTU_PASSWORD + dsh-serenity-hooks，断言无 steer
- **52 files / 750 tests 全绿**（749 + 1）；typecheck ✓（node + client）

## v1.27.6 — 2026-09-02（配置面板「?」帮助说明 + 端口文案审计，S142 用户需求）

**Scope:** 用户 "还是面板小问题，双端口网关 额外端口是3081，没写明，整体检查下是否有类似的不明确问题；每个功能最好设计个问号说明，说明其用途（三行以上严谨说明）"——① 全局端口文案审计（3081/3099/3100 写明）；② 每个配置功能加「?」帮助浮层（hover 显示三行以上严谨说明）。

### 变更
- **端口文案审计（不明确处修正）**：
  - 双端口网关 desc：`额外监听一个端口` → `额外监听端口 3081`（+ help 注明默认 3080 仅本机、适用范围/安全/白名单/热重建）
  - Skiff 调试 desc：补 `端口 3099` + `127.0.0.1`（+ help：Skiff 概念/仅本地/角色配置/对外走问答页）
  - ACP JSON-RPC desc：补 `端口 3100` + `127.0.0.1`（+ help：ACP 作用/JSON-RPC 形态/IM 桥场景/共用端口）
  - Skiff 问答页 desc：补 `端口 3100` + `需 key`（+ help：对外问答/key 认证/白名单/外部暴露/轮换）
  - 外部访问折叠 desc：补 `网关监听（端口 3081）`
- **「?」帮助浮层（全新 UI 件）**：
  - `SettingsSection.css` 新增 `.ss-help` / `.ss-helpMark` / `.ss-helpTip`——问号按钮 + hover/焦点浮层（300px，pre-line 排版，暗色 surface-raised + 阴影）
  - `RowCard` 支持 `help?` prop：desc 下方渲染「?」标记
  - 覆盖行卡（每个 4~5 行严谨说明）：双端口网关 / 超限重建 / 重建阈值 / Skiff 调试 / ACP JSON-RPC / Skiff 问答页 / Autopilot 目标 CCC·运行状态·立即唤起 / 微信桥 目标 CCC·总开关·扫码绑定·路由表
- **微信桥历史上下文：不做**（调研结论记录）——iLink 协议仅 getupdates（长轮询增量）+ sendmessage + getconfig + sendtyping，**无历史拉取端点**；绑定前的聊天拿不到，自积累价值有限。用户拍板不做（keep-as-is）

### 测试
- **52 files / 749 tests 全绿**；typecheck ✓（node + client）

## v1.27.5 — 2026-09-02（配置面板折叠收尾：微信桥/Autopilot 收起 + Skiff 问答页更名，S142 用户反馈）

**Scope:** 用户 v1.27.4 发布后验收："收起的配置很棒，微信桥和Autopilot trajectory能否也收起来；建议问答页 更名为Skiff问答页"——① Autopilot Trajectory + 微信桥两个区块改折叠（默认收起）；② 用户可见文案"建议问答页"统一更名为"Skiff 问答页"。

### 变更
- **`src/client/SettingsSection.tsx` 微信桥 + Autopilot Trajectory 折叠**：两个区块由 `ss-group` div 改为 `Collapse`（details/summary，默认收起）——折叠标题带摘要 desc（微信桥："扫码绑定微信账号 · 路由到 skiff 角色"；Autopilot："多 CCC 自动巡航轨迹 · 状态与立即唤起"）
- **"建议问答页" → "Skiff 问答页" 更名（用户可见面）**：
  - 外部能力组开关标题：`建议问答页` → `Skiff 问答页`
  - 折叠标题：`建议问答配置` → `Skiff 问答页配置`
  - ACP 端口 title：`ACP + 建议问答共用端口` → `ACP + Skiff 问答共用端口`
  - `PublicAskEditor.tsx` warn 文案：`开启上方「建议问答页」开关` → `开启上方「Skiff 问答页」开关`
  - 内部术语（publicAsk/F4d/PublicAskEditor/服务端注释）保持"建议问答"为内部名，不随 UI 更名

### 测试
- **52 files / 749 tests 全绿**；typecheck ✓（node + client）

## v1.27.4 — 2026-09-02（Autopilot Trajectory 正式化 + 配置面板紧凑化，S142 用户需求）

**Scope:** 用户 "微信桥是做好了，测试很好，autopilot也很好，改进下配置面板，目前内容太多了，太长，很多功能没几个配置项占用好几行"——① Autopilot Trajectory 改名迁移（autotrajectory → autopilot-trajectory，S151 自主管家轨迹沿用）+ 多 CCC 独立；② 配置面板紧凑化（折叠次要块 + 只读状态定义列表 + 开关端口内联）。

### 变更
- **Autopilot Trajectory 正式化（v1.27.4 改名迁移）**：
  - `autotrajectory` → `autopilot-trajectory` 全库机械改名（工具名/配置键/偏见脚本名/目录/测试）
  - **多 CCC 独立**：`collectAutopilotCccs`（所有 live+enabled CCC）替代 enabled[0]——每 CCC 各自 shouldWake+唤起，per-CCC running 守卫，全局串行化
  - **可靠性**：唤起失败指数退避重试 / 审计日志 / 轮次预算（interval 下限 + maxDailyWakes 每日上限）/ 偏见脚本沙箱（超时 + 8KB 输出截断）
  - **面板 CCC 选择器**：Autopilot 区块加 CCC 选择器（/serenity/cccs 数据源）+ GET/POST 显式 ccc 参数——修复"两个 CCC 都设定但手工唤起只能唤起一个"（根因：client 无参 fetch → collectAutopilotCccs[0] 只取第一个）
- **微信桥完善（v1.27.3 批并入）**：
  - **语音支持**：`voice_item.text` = 微信服务端自带语音转写（无需下载/ASR）；无转写 → 降级提示"暂时无法解析"
  - **正在输入**：处理前 `sendtyping 1`（微信显示"正在输入..."），处理后（含异常 finally）`0`；typing_ticket 按 (accountId,user) 缓存复用；typing 失败静默不阻断
  - **媒体接收 P1**：图片/文件 CDN 下载 + AES-128-ECB 解密 → 落盘 `_tmp/weixin-inbound/<userhash>/` → 存在性注入（ACC 层可达，处理归角色）；降级不静默（下载失败/超 20MB → 注入说明）
  - **live 会话优先复用**（`ctx.agents.get` 命中直接续用）——修复重启后微信桥不响应（resume-while-live + create-already-exists 双拒）
- **配置面板紧凑化（v1.27.5 语义并入本版）**：
  - `SettingsSection.tsx`：新增 `Collapse`（details/summary 折叠组）+ `DefList`（只读定义列表）组件；Skiff/ACP/建议问答合并「外部能力」一组（开关+端口内联一行）；建议问答配置/外部访问/彩蛋模式折叠默认收起
  - `AccountsEditor.tsx`：监听设置/外部能力/工作区白名单折叠，登录账号表保留展开
  - `AutopilotTrajectoryStatusBlock`：9 行卡 → 3 行卡（选择器 + 运行状态 + 只读定义列表 2 列网格 + 立即唤起）
  - `WeixinBridgeEditor.tsx`：总开关+账号列表合并一行；desc 精简；路由 textarea 5→3 行；二维码 160→120px
  - `PersonaEditor.css`：textarea 默认 120px→72px（4 行，可拖拽）
  - CSS：折叠组/定义列表/开关行样式 + desc 2 行截断（hover title 看全文）

### 测试
- **52 files / 749 tests 全绿**（微信三批 +12 → 734 → autopilot 改名重写 58 用例 → 749）；typecheck ✓（node + client）

## v1.27.3 — 2026-09-01（微信桥完善：语音支持 + 正在输入 + 媒体接收，S142 用户需求）

> 本批实现随 v1.27.4 一起发布（用户拍板"全部一起发"）；此段保留为 CHANGELOG 版本线完整记录。

**Scope:** 用户 "很好效果很不错，现在做完善"——微信桥 ① 语音消息支持 ② 正在输入状态 ③ 媒体（图片/文件）接收落盘。三者均为微信桥能力完善，非用户反馈 bug。

### 变更
- **语音支持（D-voice-1 服务端转写路线）**：`voice_item.text` = 微信服务端自带语音转写（官方 openclaw-weixin 直接读该字段，无需下载/ASR）→ `extractWeixinText` 扩展读取 type 3 voice_item.text，与文本同路径进 skiff 对话；语音无转写 → `hasVoiceItem` 判定 + 降级提示"（抱歉，暂时无法解析这条语音消息，请尝试发送文字）"；原 P4 的 SILK 解码+ASR 链路仅当腾讯停止转写时作为备选（设计文档 §5 已更新）
- **正在输入状态（D-typing-1：sendtyping 协议）**：`getConfig` 取 typing_ticket（每 (accountId,user) 缓存复用，对齐参考实现 typingTicketCache）→ 处理前 `sendTyping status=1`（微信侧显示"正在输入..."）→ 处理完（含异常 finally）`status=0`；typing 失败静默不阻断主流程；**协议文档注释"2=CANCEL"为误记，修正为 0（对齐官方参考实现 onCleanup）**
- **媒体接收 P1（用户拍板 v0.2：ACC 层最小闭环）**：`image_item.media` / `file_item.media`（CDNMedia）下载 = CDN GET → **AES-128-ECB 解密**（key 兼容 hex/base64，`item.aeskey || media.aes_key`），零鉴权头 → 落盘 `_tmp/weixin-inbound/<userhash>/`（净化文件名 + 魔数嗅探扩展名）→ 存在性注入对话；降级不静默（下载失败/超 20MB → 注入说明）；**可执行文件不做防护**（用户拍板）
- **文档**：weixin-bot-api.md（sendtyping 状态修正 + voice_item.text 转写发现）+ weixin-bridge-design.md（§5 分期状态更新）+ docs/weixin-media-design.md（方案 v0.2）

### 测试
- **52 files / 734 tests 全绿**（+12：单元 URL/key 三型/解密向量/魔数嗅探/文件名净化/落盘路径/媒体提取 + 集成 图片下载解密落盘注入/文件净化落盘/下载失败降级/超限降级）；typecheck ✓；顺带修复 autotrajectory 时间 flake（avoidWakeHours {0,0} 时间无关化）

## v1.27.2 — 2026-08-31（微信桥固定会话 id collision 根治：resume-or-create，S142 用户报告）

**Scope:** 用户 "同一个用户的会话绑定有问题，会话报错：session skiff-weixin-... already has a persisted log on disk that does not match this live session (id collision)"。根因 = 微信桥每次进程重启后用**固定 sessionId**（`weixinSessionIdFor`，同用户长期映射）调 `ctx.agents.create`——DSH 持久化语义 **sessionId 即身份**：磁盘已有该 id 的持久化 log 时必须 `load/resume`（coordinator `adoptLivePrefix` 校验 seed 覆盖旧事件，不匹配抛 id collision）。修复 = **resume-or-create**：有持久化 log → resume（历史延续，重启后记忆保留——真正的"同用户长期延续"）；无（首次）→ create。

### 变更
- **`src/skiff-core.ts` `createSkiffAgent` resume-or-create（核心修复）**：
  - 新增 `createOrResumeAgent` 分派：固定 id → 优先 `ctx.agents.resume({ resumeSessionId, setup, agentOptions })`（DSH AgentRegistry public API，恢复历史 + turn 续号）
  - **v1.27.2 this 绑定根因修复（微信桥"重启后不唤醒"真因）**：resume 调用曾**解构方法**（`const resumeFn = ctx.agents.resume` 后裸调用）→ 丢失 `this` → DSH `resume` 内部 `this.ctx` 抛 "Cannot read properties of undefined (reading 'ctx')"（v1.23.2 同病第三次）→ 改经类型断言 `agentsWithResume.resume({...})` **方法调用**（this 保持绑定）
  - **resume 失败一律降级 create + 打印完整堆栈（用户拍板）**：不再区分错误类型透传——任何 resume 错误都降级新建，保证微信桥**不静默不唤醒**；堆栈落日志供定位
  - `SkiffAgentRef` 新增 `resumed: boolean`（true=历史恢复，false=新建）——调用方据此区分"新对话"与"延续"
  - resume 可用性守卫：旧版 dsh / 测试环境无 `agents.resume` 方法 → 直接 create（v1.27.0 行为兼容）
  - setup 提取复用（preset 挂载回调 create/resume 共用）
- **`src/weixin-route.ts` `weixinSessionIdFor` 会话 id 错位一位（用户拍板）**：`.slice(0, 16)` → `.slice(1, 17)`——旧规则生成的固定 id 已绑定**磁盘损坏的持久化 log**（dsh 不可硬删，create 同 id 必撞）→ 新规则下同用户生成**全新 id** 避开损坏 log；固定可重建语义不变（同用户恒同 id）
- **`src/weixin-bridge.ts` `handleIncoming` 通知语义修正**："新的对话已开始"通知**仅真正首次（create）发送**；resume（历史延续）/ 进程内延续不发——用户记得之前的对话，重启后不再被告知"新对话"；catch 打印完整堆栈（诊断面）
- **`tsconfig.json` + `client/tsconfig.json` client 类型源修复（SESSION #3 漂移）**：npm 全局 dsh 升级 0.1.1-rc.2 后 ui-slots/ui-primitives（private workspace 包，不随 CLI 发布）paths 悬空 → 改指 staging 源码 `~/.dsh/source/current/packages/client/.../lib/types/index.d.ts`（与运行时同源）；**运行时不受影响**（dsh-client-web 官方依赖自带这两个包）
- **语义升级**：v1.27.0"重启后自动重建，记忆从新开始"是次优设计（固定 id 本意 = 同用户长期延续）——DSH resume 原生支持历史恢复，重启后**记忆保留**，与 weixin-bridge-design.md §9 待拍板②"固定 sessionId 会话延续"完全对齐

### 测试
- **skiff-core.test.ts +4**：固定 id + resume 成功 → resumed=true（历史延续）/ resume not-found（首次）→ 降级 create resumed=false / 无固定 id 恒 create（resume 不参与）/ **resume 任意错误 → 降级 create + 堆栈已打印**
- **weixin.test.ts 语义更新**：首条消息（not-found → create）→ 通知+答案；**重启后 resume 恢复 → 无"新对话"通知只有答案**（原"重建+通知"用例改写）
- **52 files / 714 tests 全绿**（710 + 4）；typecheck ✓（node + client，含 client 类型源修复）

## v1.27.1 — 2026-08-31（微信桥反馈三修：多账号 / 回复去 think / 会话命名恒开，S142 用户反馈）

**Scope:** 用户 v1.27.0 微信桥两条反馈 + 一条配置原则——① "要支持添加多个账号，每个都是扫码"；② 微信桥回复用户的消息**去掉 think 标签**（用户不应看到思考过程）；③ "会话命名开关下掉，永远开启"。均为反馈修复（用户"修好先别发布"→ 测试全绿后本版发布）。

### 变更
- **多账号支持（反馈 ①）**
  - `src/weixin-route.ts` `nextWeixinAccountId`（新）：最小未占用自增（wechat-N，删中间账号后复用缺口号而非跳到最大+1）
  - `src/api.ts` login-start 用 nextWeixinAccountId 生成账号 id（每账号独立扫码绑定）
  - `src/client/WeixinBridgeEditor.tsx`：**每账号独立移除按钮**（removal 按 accountId 精确移除）+ 扫码按钮**可反复使用**（修复原 bug：`!status.enabled === false` 优先级错误导致桥启用时按钮被错误禁用）
- **回复去 think（反馈 ②）**
  - `src/skiff-debug.ts` `stripThink`（新导出）：复用 v1.26.8 `extractThinkBlocks` 状态机（弃正则）剥离 `<think>` 块——**只保留正文**（占位符替换为空，think 内容丢弃）；未闭合 think 优雅截断（开标签前正文保留）
  - `src/weixin-bridge.ts`：`handleIncoming` 回写前 `stripThink(answer)`——微信纯文本通道不渲染思考过程
- **会话命名永远开启（反馈 ③）**
  - `src/settings-section.ts`：删 namingEnabled 开关项；`src/tools/session.ts`：删门控恒执行命名；`src/client/SettingsSection.tsx`：删「会话」开关组
  - `src/index.ts`：删 naming Config 装配；`src/config-ops.ts`：删 NamingSettings 死配置（wire/merge/update 全清）
- **测试同步**：settings-section / config-ops / session-title 用例更新（命名恒执行 + 无 naming 配置）+ weixin.test 补 nextWeixinAccountId 复用断言

### 测试
- **52 files / 710 tests 全绿**（709 + 1，stripThink 未闭合断言修正：开标签前正文保留，仅截断 think 内容）；typecheck ✓（node + client）→ build ✓

## v1.27.0 — 2026-08-31（微信桥 F4c-3：CCC 级 iLink 接入，S142 用户拍板）

**Scope:** 用户 "dsp 能否接入微信的扫码协议，考虑多用户接入招财 role"——skiff 强化后支持微信扫码接入 → 代替 openclaw（招财平台）的微信接入面。协议实证（裸调 get_bot_qrcode 无需 OpenClaw）+ 用户七项裁决后实现。**架构决策**：配置归 **CCC**（dsh 一进程多 CCC，每个 CCC 独立对接微信桥）——结构/路由/开关进 `.opencode/serenity.json`，**bot_token 凭据进 CCC localstore**（credential scope）；ACC 不绑定具体 role（路由 user → role 用户自选）；管理面 = **CCC 面板**（显式 CCC 选择器——WebUI 顶层全局，配置写入必须显式）；不做 agent 侧管理工具。

### 变更
- **`src/weixin-api.ts`（新）**：iLink Bot API 纯 fetch 客户端（零依赖）——fetchQRCode（裸调无凭据可取码）/ pollQRStatus（wait/scaned/confirmed/expired + bot_token）/ getUpdates（35s 长轮询 + get_updates_buf 游标）/ sendTextMessage（BOT/FINISH + context_token 回带 + **md→plain 内置**）/ markdownToPlainText（代码块/图片/链接/表格/标题/粗斜体/删除线 7 类）；`__setWeixinFetchForTest` 测试注入
- **`src/weixin-route.ts`（新）**：CCC 配置层——readWeixinSettings（serenity.json weixin 段归一）/ 凭据读写（**credential scope** `WEIXIN_<ACCOUNT_ID>_TOKEN/_BASEURL/_USERID`）/ `weixinSessionIdFor`（固定可重建 `skiff-weixin-<sha256(userid).slice(16)>`——同用户长期会话）/ `matchWeixinRoute`（exact → 通配 `*` 兜底）/ `extractWeixinText`（P1 文本）/ upsert/remove/saveRoutes/setEnabled（写回 serenity.json，保留既有字段）
- **`src/weixin-bridge.ts`（新）**：CCC 级装配——syncCccBridge（每 CCC enabled + 有凭据账号启动轮询循环）/ runAccountLoop（getupdates 长轮询 → 逐消息分发 → 失败 3s 重试）/ handleIncoming（路由命中 → **createSkiffAgent 固定 sessionId 创建/延续** → askSkiff includeTrajectory:false → 回复回写；重启后自动重建 + "新的对话已开始"通知）/ weixinBridgeStatus（面板数据源）/ registerWeixinBridge（live 会话扫描 + session/created 事件驱动）
- **`src/skiff-core.ts`**：`createSkiffAgent` 增加可选 `sessionId` 参数（外部面固定 id 映射；不传保持随机——ACP/调试页默认路径兼容）
- **`src/ccc.ts`**：`SerenityConfig.weixin`（WeixinSettings：enabled/botType/accounts/routes）+ 类型定义
- **`src/api.ts`**：`/serenity/weixin` 端点（**全部显式 ccc 参数，无参 400**，x-serenity-ui 头限定）——GET 状态（账号脱敏：只回元信息 + bound）/ POST login-start（出码存 loginKey）/ GET /serenity/weixin/login（扫码轮询 → confirmed 自动写凭据 + 账号元信息 + syncCccBridge）/ remove-account / save-routes（role 合法性校验 ∈ skiff.roles）/ set-enabled（启用前要求已绑定账号）
- **`src/client/WeixinBridgeEditor.tsx`（新）**：「微信桥」区块——**CCC 选择器**（/serenity/cccs discoverCccs 数据源，显式配置目标）/ 总开关 / 账号列表（含桥运行状态）/ **扫码绑定**（qrcode-generator 生成二维码 SVG——复用 v1.24.6 TOTP 同款机制，手机微信扫 liteapp 确认页 → 1s 轮询 → confirmed 显示绑定成功）/ 移除账号 / 路由表 JSON 编辑（保存校验）
- **`src/client/SettingsSection.tsx/.css`**：微信桥分组 + 样式（select/扫码按钮/二维码白底展示/路由编辑框）
- **`src/index.ts`**：registerWeixinBridge 装配

### 测试
- **weixin.test.ts（新，18 用例）**：weixin-api（buildClientVersion/fetchQRCode 裸调/pollQRStatus wait→confirmed/网络错误→wait/getUpdates 游标/sendTextMessage body 结构 + md→plain/7 类转换）；weixin-route（会话 id 固定可重建/配置归一 + 清洗/**凭据读写分离** token 只进 localstore credentials/路由匹配 exact→通配/extractWeixinText/写回操作）；weixin-bridge 集成（fake ctx 对齐 acp-core 模式——首条消息 → 通知+答案回写 context_token/重启自动重建/无路由不创建/非文本忽略）
- **52 files / 709 tests 全绿**（691 + 18）；typecheck ✓（node + client）→ build ✓

## v1.26.17 — 2026-08-31（轨迹焦点 topPrompt：CCC 定义，每次唤起最先注入，锚定防漂移，S142 用户需求）

**Scope:** 用户 "为了确保自动轨迹的质量，我们需要改进下，支持让ACC定义一段顶层提示词，这个提示词会在每次唤起注入，确保顶层提示词的影响力"。**设计定位（用户两次纠正定稿）**：topPrompt = **CCC 定义 autotrajectory 时自己填写**的本轨迹顶层提示词（核心目标/纪律/质量要求）——**不是用户配置、不是 ACC 硬编码**，是 CCC 的实验定义项。动机：autotrajectory 实验在具体 CCC 中运行时 trajectory 多轮腐化严重（焦点丢失）→ 稳定焦点锚定。

### 变更
- **`src/ccc.ts` `AutoTrajectorySettings.topPrompt?`（新）**：注释定位 = CCC 定义的轨迹焦点（防漂移），与偏见内容分工（焦点=稳定锚每轮不变，偏见=随机探索每轮不同，互补）
- **`src/autotrajectory.ts` `buildWakeMessage` 四段式**（轨迹焦点 / 身份锚定 / 先验偏见 / 任务）：`[轨迹焦点]` 段**最先注入**（位于身份锚定之前，影响力最大）；`performAutoTrajectoryWake` 传递 `settings.topPrompt?.trim() || null`；`getAutoTrajectoryStatus` 返回 topPrompt（空白归一 null）
- **`src/client/SettingsSection.tsx`**：「轨迹焦点 (topPrompt)」卡片（未定义 → 提示 CCC 应填写防漂移）
- **`src/tools/autotrajectory-exp.ts` description**：补 topPrompt 语义
- **`experiments/autotrajectory/scripts/autotrajectory-exp.ts`**：guide 六步（②定义轨迹焦点）+ init 配置模板生成 topPrompt 占位 + 输出 ⚠ 提示编辑 + check 未定义时 ⚠ 提示（非阻断，兼容存量）+ status 显示 topPrompt ✓
- **`experiments/autotrajectory/SKILL.md`（doc 入口）**：三步→四步（新增②轨迹焦点章节）+ 配置示例 + 机制运行①焦点注入
- **`docs/autotrajectory-experiment.md`**：三步→四步 + 配置示例 + 唤起消息示例 + 分工表（焦点/偏见都由 CCC 定义）

### 测试
- **autotrajectory.test +2**：buildWakeMessage 轨迹焦点最先注入（startsWith [轨迹焦点] + 位置 < [自主轨迹唤起]）/ 无焦点兼容（存量行为一致）；getAutoTrajectoryStatus topPrompt 归一（空白→null）
- **51 files / 691 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.16 — 2026-08-31（npm 包 tarball 完整性修复：缺 chunk 加载即崩 + 类型全缺，S142 用户报告）

**Scope:** 用户反馈 "npm我们发的dsp不完整，少东西了，检查下"。unpkg 实证 v1.26.15 tarball 仅 9 文件——缺 tsdown chunk（`lib/ccc-CfDrlfA7.js`），`lib/index.js` 第 1 行 import 解析失败 → **插件安装后加载即崩**；`.d.ts` 类型全缺（`package.json types` 悬空）。发布链修复 + 常驻校验工具。

### 根因
- **根因 1（files 白名单）**：`package.json files` 写死 3 个 JS（index/client/invariant），tsdown 把共享依赖抽成 chunk（`lib/ccc-*.js`，内容哈希名）不在白名单 → `npm publish` 只发白名单内文件 → chunk 丢失
- **根因 2（prepare 链）**：npm publish 跑 `prepare`（tsdown.prepare.config.ts）只构建 JS；`build` 的 `tsc && tsdown` 顺序中 tsdown `clean:true` 清空 lib/ → tsc 产出的 `.d.ts` 全部丢失

### 修复
- **`package.json files`**：加 `lib/*.js`（覆盖 chunk）+ `lib/*.d.ts` + `lib/**/*.d.ts`（覆盖类型）
- **`package.json build` / `prepare`**：改 `tsdown ... && tsc -p tsconfig.json --emitDeclarationOnly`——tsdown 先跑（clean 归它），tsc 后跑只补类型（不 clean 不覆盖 js）→ .d.ts 产出并进包
- **`scripts/dsh-develop.ts` 新增 `pack-check` 子命令**：`npm pack --dry-run --json` 机械核对——固定必需 3 文件 + **动态核对 lib/ 全部 JS 产物**（tsdown chunk 名会变，写死必漏）+ 打印 lib/ 完整清单（js/d.ts 分列）——发布前强制校验（verifyTarball 抽函数，cmdPublish 复用）

### 验证
- `dsh-develop pack-check`：**64 文件全绿**（lib/ 58 项 = js 4 + d.ts 54；含 `lib/ccc-CfDrlfA7.js` + `lib/index.d.ts`）；typecheck ✓ → build ✓
- unpkg 复核（发布后）：tarball 应含 chunk + 54 个 .d.ts

## v1.26.15 — 2026-08-31（自主轨迹三连修复：立即唤起 / 面板解析 / 时钟定时器，S142 实测驱动）

**Scope:** 用户在 pangu-serenity 实测 v1.26.14 后三轮反馈：① "点唤起也没用，未唤起，排查"；② "实验状态检测不到pangu了，排查访问不到写个msm来排查"；③ "手动唤起执行正常，时钟唤起不工作，排查原因"。三个根因全部实证定位 + 修复 + 进程内诊断工具。**本机 deploy 已生效；npm 1.26.14 未含本版（发布补全）**。

### 修复 1：立即唤起不生效——resolveTargetAgent 匹配不存在的 `s.title`
- **根因**：`resolveTargetAgent` 遍历 `ctx.sessions.list()` 匹配 `s.title`——但 dsh `session.list` wire schema（及 Session 对象）**均无 title 字段**（只有 sessionId/cwd/agentPreset），匹配永远失败 → "目标会话 agent 不可得"
- **修复（`src/autotrajectory.ts`）**：标题实际存在 session log 的 `session/title` 事件（latest-wins）——新增 `readSessionTitle(session)` 从 `session.events` 提取标题（rebuild 同款 events 读取模式）+ **cwd 归属校验**（同实例多 CCC 时只匹配目标 SESSION 所在 CCC 的会话；targetRoot 可解析→CCC 根比较，不可解析→路径祖先兜底）+ `diagnoseTargetUnavailable` 区分失败原因（"目标 CCC 内无 live 会话 / 标题均不匹配 / agent 未加载"——面板/日志可直接行动）

### 修复 2：面板检测不到实验 CCC——无参 GET 解析到当前维护会话 CCC
- **根因**：面板 fetch 无 workspace 参数 → `resolveWorkspace` 解析到第一个 live 会话（home-serenity，configured:false）→ 显示"未配置"，用户实验 CCC（pangu）检测不到
- **修复（`src/autotrajectory.ts` + `src/api.ts`）**：新增 `resolveAutoTrajectoryCcc(ctx)`（**优先「配置了 autotrajectory 的 live CCC」**：enabled 优先，其次 configured）；api GET/POST 无 workspace/sessionId 参数时用它（面板显示与唤起目标一致——显示什么就唤起什么）
- **新增 `diag-live` 进程内诊断（`src/tools/autotrajectory-exp.ts` 改造）**：工具改闭包捕获 ctx（`createAutoTrajectoryExpTool(ctx)`，rebuild 同款）——`diagLive(ctx)` 输出 live 会话清单（id/cwd/ccc/标题）+ 各实验 CCC 状态（配置/目标/agent 定位/诊断）+ 面板解析目标；**脚本 diag 是独立进程看不到运行时，diag-live 在插件进程内能看到 sessions/agents**

### 修复 3：时钟唤起不工作——启动时 live 会话为空，定时器永不启动
- **根因**：旧 `registerAutoTrajectory` 在 apply（web 启动）时一次性 `resolveAutoTrajectoryRoot(ctx)`——启动时 live 会话为空（用户尚未打开实验 CCC 会话）→ root=null → settings=null → **定时器根本不启动**；手动唤起走 HTTP（点击时重新解析）→ 正常
- **修复（`src/autotrajectory.ts`）**：① **动态解析**——每次 tick 重新 resolveRoot/settings（不绑定启动时值，live 会话变化即跟上）；② **事件驱动启动**——监听 `session/created` → 启动定时器（用户打开实验 CCC 会话即启动；启动时已有则立即启动）；③ **优先实验 CCC**——`resolveAutoTrajectoryCcc` 优先于进程 cwd/任一 live（多 CCC 同实例时绑定实验 CCC）；零资源占用语义保留（未配置/未启用 → tick 内直接 return）

### 测试
- **autotrajectory.test +11**：resolveTargetAgent——events 标题 latest-wins / cwd 归属（其他 CCC 不匹配）/ 诊断信息三态（无 live 会话/标题不匹配/agent 未加载）；diagLive/resolveAutoTrajectoryCcc/listLiveSessions；registerAutoTrajectory——启动时有会话立即启动 / 无会话 → session/created 后启动（修复核心）/ enabled=false 不启动 / 零资源占用
- **51 files / 690 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.14 — 2026-08-30（自主轨迹面板状态 + 立即唤起按钮 + diag 扫描扩大，S142 调试闭环）

**Scope:** 用户两连发：① "给CCC的面板加个状态来看情况"（自主轨迹实验状态可视化）；② 状态通过后 "加个立即唤起按钮，方便调试"（手动触发一轮唤起）。另：diag 无参扫描此前只覆盖 `/home/yh/home` + `/home/yh/our-home`，用户实验 CCC（pangu-serenity，`/home/yh/zy/`）扫不到——扩大为递归扫描 `/home/yh` 两层。

### 变更
- **`src/autotrajectory.ts` `getAutoTrajectoryStatus(root)`（新，面板数据源）**：纯逻辑状态函数（可单测）——configured/enabled/intervalHours/biasProvider/session/avoidWakeHours + 目标会话（dirName/--auto 标志/空闲小时/当前可唤起判定）+ 当前北京小时/窗口允许；不运行偏见脚本（运行验证走 autotrajectory-exp random）
- **`src/autotrajectory.ts` `performAutoTrajectoryWake(ctx, root, settings, {force})`（新，唤起执行体提取）**：时钟 tick 与「立即唤起」共用——force=false（时钟）完整校验（enabled/目标/--auto/窗口/间隔/偏见脚本）；force=true（手动调试，用户在场）**跳过窗口与间隔**，仍校验 enabled/目标/--auto/偏见脚本；成功 → `agent.steer` 注入前台会话；返回 `{ok, detail}` 供 tick 打日志 / 面板显示
- **`src/autotrajectory.ts` `registerAutoTrajectory` 重构**：tick 改调 `performAutoTrajectoryWake(force:false)`（行为等价，日志语义化：✓ 唤起 / ✗ 跳过原因）
- **`src/api.ts` `GET /serenity/autotrajectory`（新端点）**：按 workspace 解析当前 CCC → 返回 `getAutoTrajectoryStatus` 状态（未在 CCC 内 → `{status:null}`）；动态 import autotrajectory（保持 api.ts 静态链纯净，纯函数测试不受影响）
- **`src/api.ts` `POST /serenity/autotrajectory {action:'wake'}`（新端点）**：手动立即唤起（`performAutoTrajectoryWake(force:true)`）；**x-serenity-ui 头限定**（agent 不可自行唤起自己——防实验循环自激）；未配置 → 400
- **`src/client/SettingsSection.tsx` 「自主轨迹」只读区块（新）**：实验状态/目标会话（含 --auto 标志与空闲时长）/唤起窗口（北京小时 + 高峰避开）/偏见提供者名 + **「立即唤起」按钮**（enabled + 目标就绪时可用；点击 POST wake，显示执行结果 detail；完成后刷新状态）
- **`src/client/SettingsSection.css`**：`ss-wakeBtn` 按钮样式（官方 button 语言，hover 绿色提示）
- **`src/tools/autotrajectory-exp.ts`**：描述版本号 v1.26.13→v1.26.14 + diag 扫描说明更新（递归扫描 /home/yh 两层）
- **`experiments/autotrajectory/scripts/autotrajectory-exp.ts` diag 扫描扩大（dsp + specs 同源）**：弃固定双 base 一层扫描，改 **`collectCccs` 递归收集 .serenity 目录**（跳过隐藏目录，maxDepth 2 层，base `/home/yh`）——覆盖 `/home/yh/home/*`、`/home/yh/our-home/*` 及任意实验 CCC 位置（pangu-serenity/tiangong-serenity/sh-serenity 等）；脚本头注释补 diag + 面板说明

### 测试
- **autotrajectory.test +11**：getAutoTrajectoryStatus——未配置/已配置未启用/启用+会话命中(--auto/空闲/可唤起)/启用+未命中；performAutoTrajectoryWake——force=true 跳过窗口间隔注入成功 / force=false 间隔不足拒绝 / 未启用拒绝 / 无 --auto 标志拒绝 / 偏见脚本缺失拒绝 / agent 不可得拒绝
- **51 files / 679 tests 全绿**（+13）；typecheck ✓（node + client）→ build ✓

## v1.26.13 — 2026-08-30（autotrajectory-exp 实验脚本定位修复，本机安装实测）

**Scope:** 本机安装 v1.26.12 后调用 `autotrajectory-exp` 报"脚本缺失（.../@shgroup/experiments/...）"——**根因：tsdown bundle 后 `import.meta.url` 指向 `lib/index.js`，工具里 `'..','..'` 越过包根**（resolve 到 `@shgroup/` 而非 `@shgroup/dsh-serenity-hooks`），实验脚本路径算错。

### 变更
- **`src/tools/autotrajectory-exp.ts` 路径解析修复（v1.26.13）**：弃固定 `'..','..'` 相对解析，改 **`findExpScript` 逐级上溯查找**（从 `import.meta.url` 目录向上直到找到 `experiments/autotrajectory/scripts/autotrajectory-exp.ts`）——bundle 布局（lib/index.js → 包根 1 层）与源码/测试布局（src/tools → 包根 2 层）都稳；找不到 → 明确报错提示包完整性
- execute 增加 EXP_SCRIPT 空值/缺失双重校验（`!EXP_SCRIPT` / `!existsSync` 分别提示）

### 测试
- **autotrajectory.test +3**：findExpScript——bundle 布局（lib 一层上溯）/ 源码布局（src/tools 两层上溯）/ 找不到 null
- **51 files / 669 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.12 — 2026-08-30（自主轨迹实验机制：autotrajectory，S142 用户猜想落地）

**Scope:** 用户提出 AGI 猜想（serenity-acc-specs `docs/self-sustaining-trajectory-hypothesis.md`）：Trajectory 是主体，人类 waiting 拖慢轨迹——设计"无人等待的 trajectory"（时钟自动唤起 + 先验偏见 + 人类=反馈源）加速运转。本版在 dsp 实现实验机制（默认关）+ 一站式实验管理工具（第 13 工具）。**实验是 CCC 的自选动作——dsp 只提供工具与知识，不向 CCC 自动安装任何东西**（实验可能失败，不污染 CCC）。

### 变更
- **`src/autotrajectory.ts`（新，机制）**：CCC 配置驱动（`.opencode/serenity.json autotrajectory` 段，默认关零资源占用）——时钟驱动自动唤起（每 10min tick）+ **前台运行**（`ctx.agents.get` + `agent.steer` 注入活跃会话，复用 v1.22.5 自动继续通道；用户全程可见、随时可介入）+ 先验偏见注入（自生=SESSION.md「下一轮动机」段 / 偏见内容=biasProvider 脚本 stdout）+ 会话标志=目录名后缀 `--auto`（`AGENT_SESSIONS/<date>--<desc>--auto/`）+ **session 必填**（用户拍板：自动唤起不默认任何会话——CCC 日常多轨迹并行，未配置明确目标绝不唤起）+ **唤起窗口避开北京时间 8~18 点**（用户拍板：用量峰谷省钱；avoidWakeHours 可覆盖）+ 防重入
- **偏见内容提供者（biasProvider）**：用户拍板命名（"它就是偏见内容提供者"）——CCC 根目录下脚本（缺省 `autotrajectory-bias.ts`），tool 直接运行取 stdout；**脚本缺失 → 唤起中止 + 报错要求实现**（不再经 mech-registry 注册 MSM）
- **`src/tools/autotrajectory-exp.ts`（新，第 13 工具）**：一站式实验管理——无参/action=all 全报告（背景摘要 + 就绪检查 + 状态 + 下一步）/ init 初始化辅助（写配置 + 生成偏见脚本模板）/ random 验证偏见内容 / doc / check / status / guide；exec 包内静态脚本（npm files 含 `experiments/autotrajectory/`），注入 SERENITY_ROOT
- **实验包随 npm 分发**：`experiments/autotrajectory/SKILL.md`（参与 skill，CCC 加载即懂实验）+ `scripts/autotrajectory-exp.ts`（工具执行脚本；specs 仓同源）——装新版 dsp 即就绪，CCC 自己决定是否参与
- **`ccc.ts`**：`SerenityConfig.autotrajectory?`（AutoTrajectorySettings：enabled/intervalHours/biasProvider/session/avoidWakeHours，纯类型扩展）
- **`index.ts`**：工具注册 +1（13 工具）；**零影响**：不修改任何现有工具/seams/外部面

### 测试
- **autotrajectory.test.ts（新，18 tests）**：北京时间/唤起窗口（用量峰谷）/ `--auto` 后缀标志 / session 必填定位 / 唤起条件全链（mtime 边界/窗口/防重入）/ 自生动机读取 / biasProvider 脚本运行（缺失报错/路径逃逸/执行失败）/ 唤起消息三段式
- register.test 工具数 12→13；**51 files / 666 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.11 — 2026-08-29（打回消息语义化：命中词分类 + 规避指引，S142 用户实测）

**Scope:** 用户实测 v1.26.10 打回消息（"contained 1 sensitive internal term(s)...: 3080"）仍不满意——**裸词 "3080" 是端口号，模型不知道它是什么、为什么敏感、怎么规避**（用户："还是没告诉LLM 具体哪个词应该规避啊"）。改方案：**命中词分类 + 按类给规避指引**——模型不仅看到词，还知道"这是内部服务端口，不要提及内部端口/地址/端点"。

### 变更
- **`output-guard.ts` 命中结构化（v1.26.11）**：`SensitiveCategory`（credential/mechanism/port/msm）+ `SensitiveHit {word, category}`；`SensitiveWordTable` 增分类词表（credentialWords/mechanismWords/portWords/msmWords，exact/substring 聚合视图保留）；`detectSensitive` 返回带分类命中
- **`buildRebuke` 语义化打回（v1.26.11）**：逐词 `- "3080" — internal service port or address — never mention internal ports, addresses, or service endpoints`；四类指引（凭据=name/key/token/password、机制=内部实现名/配置路径、端口=端口/地址/端点、工具名）；单复数修正（`1 sensitive internal term` 不再 `term(s)`）；多命中全列出
- **`output-guard-seam.ts`**：无改动（detectSensitive→buildRebuke 透传兼容）

### 测试
- **output-guard.test 重构**：detectSensitive 断言改 `toContainEqual({word, category})`（凭据值/条目名/msm/机制词/端口 5 类全覆盖）；buildRebuke 新增分类指引断言（端口/凭据/机制/工具名 4 类 + 单复数 + 多命中）；seam 测试透传兼容
- **50 files / 648 tests 全绿**（+2）；typecheck ✓（node + client）→ build ✓

## v1.26.10 — 2026-08-29（两项用户调整：打回告知命中词 + 3100 对外去 trajectory）

**Scope:** ① 输出守卫打回消息不告知命中词 → 模型不知道怎么改（用户："这里不告诉人家敏感词是什么，人家怎么改，要告知"）；② asktest 公网问答响应含 trajectory（含工具结果等内部信息）→ 3100 对外只提供问答（用户："3100是对外的，只提供问答，不提供trajectory"）。

### 变更
- **`output-guard.ts` `buildRebuke` 告知命中词（v1.26.10）**：打回消息列出全部命中词（去重 `, ` 分隔）——模型据此精准重写；R↓ 安全性：命中词本就已在被拦截回复中进入会话（已暴露面），打回重复一次不扩大暴露；steer 是 plugin source 消息不回显给用户（配合本版 3100 去 trajectory，打回文本不达外部用户）
- **`skiff-core.ts` `askSkiff` +`options.includeTrajectory`（v1.26.10）**：默认 true（3099 调试页保留轨迹）；false 跳过 `eventsToTrajectory` 计算（3100 长会话不再每轮 O(n) 算全量轨迹）
- **`acp-http.ts` 公开问答响应去 trajectory（v1.26.10）**：200 响应仅 `{answer, answer_html, sessionId, continued}` + `askSkiff(..., { includeTrajectory: false })`
- **`acp-core.ts` `session/prompt` 结果去 trajectory（v1.26.10）**：返回 `{answer, sessionId}`（3100 JSON-RPC 同为对外面）

### 测试
- **output-guard.test 更新**：buildRebuke 含命中词断言（单/多词）+ seam steer 含命中词（原"不含"断言反转）；**acp-core.test 更新**：prompt 返回不含 trajectory（`not.toHaveProperty`）；**jsc-json-safe.test 更新**：3100 ask 响应形态对齐新结构（无 trajectory）
- **50 files / 646 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.9 — 2026-08-29（3100 iOS Safari 错误根治：JSC JSON.parse 快速路径正则兼容层，S142 调研定稿）

**Scope:** 用户实测：3100 问答页在 iPhone/iPad（WebKit/JSC）上报 `The string did not match the expected pattern`，仅"内容极其复杂"的回答触发，v1.26.8 服务端 think 状态机重写无效。调研定稿：**错误不在插件代码的正则**，而在 **Safari/JSC 的 `JSON.parse` 内部正则快速路径**——WebKit bug 200190「JavaScriptCore's Regex can't match the content」：JSC 对 JSON 做正则预校验，内容含**原始** `\u2028`（行分隔符）/`\u2029`（段分隔符）时对**合法 JSON** 也抛此 SyntaxError（sentry-javascript #2487 同源）；`JSON.stringify` **不转义**这三个字符（合法 JSON 字符串字符）→ 复杂回答的 JSON 以原始形态含它们 → 3100 页面 `await res.json()` 触发。修复 = **方案 A（用户拍板）：服务端 JSON 文本层等价转义**。

### 变更
- **`skiff-debug.ts` 新增 `jscSafeJsonText`（v1.26.9）**：JSON 文本层把原始 `\u2028`/`\u2029`/`\uFEFF` 替换为字面 `\uXXXX` 转义序列——**JSON.parse 后语义完全一致**（还原原字符），JSC 正则看到常规 ASCII 转义（与 JSON.stringify 对控制字符的输出同形态，安全）；已是 `\uXXXX` 形态的内容不二次转义
- **`acp-http.ts` `sendJson` 全量应用（v1.26.9）**：所有 3100 JSON 响应（/ask 问答 + JSON-RPC 面）经 `jscSafeJsonText`——覆盖 answer/answer_html/trajectory 复杂内容的响应
- **两处页面内嵌 JSON 同步应用**：`acp-http.ts` ask-data 嵌入 + `skiff-debug.ts` cccs 嵌入（同为 JSC JSON.parse 风险面，页面加载即解析）

### 测试
- **`tests/jsc-json-safe.test.ts` 新建 5 用例**：文本层替换断言（三个原始字符消失、转义序列出现）/ round-trip 深比较（值/嵌套/键位全覆盖）/ 常规 JSON 逐字节不变 / 已转义形态不二次转义 / 3100 ask 响应完整形态 parse 等价 + 无原始触发字符
- **50 files / 646 tests 全绿**（+5）；typecheck ✓（node + client）→ build ✓

## v1.26.8 — 2026-08-29（think 提取状态机重写，弃正则——用户批评"老用正则不是个办法"）

**Scope:** 3100 公网问答页输出报错 "The string did not match the expected pattern"——旧实现用 `<think>([\s\S]*?)<\/think>` 正则提取（V8 g-flag lastIndex 抛错 + 未闭合泄漏 + 嵌套错位 + 代码块误判 + 占位符冲突，纯函数 74 用例未复现、真实输出含特殊形态）。用户裁决：**弃正则，重写为状态机扫描**。

### 变更
- **`skiff-debug.ts` `extractThinkBlocks` 状态机重写（v1.26.8）**：逐字符扫描识别开/闭标签（`matchOpenThink`/`matchCloseThink`）——**大小写不敏感**（`<think>`/`<THINK>`）、**属性变体**（`<think lang="...">` 跳 `>` 后取内容）、**尾随空格**（`</think >` 允许）、**未闭合优雅截断**（剩余全部作为 think 内容，不泄漏标记）、**嵌套按内容处理**（内层不递归，DeepSeek think 不嵌套）、**占位符改 `\u0001T<idx>\u0001`**（ASCII 控制字符——正文几乎不可能出现，消除旧 `@@T<idx>@@` 占位符与正文冲突）；`renderSkiffMarkdown` 改调新提取
- **Bug 修复（R↓）**：`matchOpenThink` 标签名切片错位——`<think` 的 t 在 i+1，正确 `slice(i+1,i+6)` + `after=s[i+6]` + `contentStart=i+7`（旧实现首轮 5 用例失败根因）；`matchCloseThink` 的 `</think` t 在 i+2 本就正确

### 测试
- **`tests/think-render.test.ts` 新建 16 用例**：基础折叠 / hideThink 移除 / 未闭合截断（hideThink 两态）/ 嵌套按内容 / 属性变体 / 大小写 / 尾随空格 / 多块保序 / 占位符不冲突 / markdown 渲染完整性 / XSS 注入防护 / 空 think / 长文本 / CRLF 换行
- **49 files / 641 tests 全绿**（+16）；typecheck ✓（node + client）→ build ✓

## v1.26.7 — 2026-08-29（public 口 key 即存修复，S142 用户实测）

**Scope:** 用户实测：key 填写了没存 localStorage——对话页提示无 key。

### 变更
- **`acp-http.ts` 列表页 key 即存（v1.26.7 修复）**：`gateKey` input 事件补 `localStorage.setItem(KEY_STORE, value)`——v1.26.6 重构漏掉保存（只做卡片门控 applyGate，v1.26.5 对话页保存点又被删），导致对话页 `getStoredKey()` 恒空。现在填 key 即记忆（用户"填一次就记录"语义），无需保存按钮

### 测试
- **acp-core.test 更新**：列表页断言含 `localStorage.setItem(KEY_STORE`（即存逻辑回归）
- **48 files / 625 tests 全绿**；typecheck ✓（node + client）→ build ✓（149316 B）

## v1.26.6 — 2026-08-29（public 口 key 门前置 + 移动端适配，S142 用户需求）

**Scope:** 用户：① key 应该在选择容器前填写，不填不让选容器（对话页没必要填，填一次就记录）；② 3100 暴露的页面适配移动端。

### 变更
- **`acp-http.ts` 列表页 key 门（v1.26.6）**：`publicAskListPage` 顶部新增 key 输入框（keyGate）——**key 在选容器前填写**（用户拍板）；未填 key 时容器卡片禁用（pointer-events:none + 半透明 + aria-disabled），填写后恢复可点击；key 自动从 localStorage 恢复（`serenity-public-ask-key`，填一次就记录）
- **`acp-http.ts` 对话页去 key 输入（v1.26.6）**：`publicAskContainerPage` 移除 keyRow 输入行——key 从 localStorage 读取（`getStoredKey()`）；无 key 时发送提示「请先回到容器列表页填写 key」；keyRow CSS 删除
- **`acp-http.ts` 移动端适配（v1.26.6，参考 v1.22.1 登录页标准）**：两页面 viewport 加 `viewport-fit=cover`（safe-area 生效）；`@media (max-width:640px)` 块——**输入控件 16px 防 iOS 聚焦放大**（key/textarea/select）、**触控目标 ≥44px**（back/select/newBtn/sendBtn/keyGate input）、`100dvh` 防 iOS 地址栏跳动、safe-area-inset-top/bottom 全适配、消息气泡/卡片/间距移动端舒适化；key 输入 `autocapitalize="none" enterkeyhint="done"`、textarea `enterkeyhint="send" autocapitalize="sentences"`

### 测试
- **acp-core.test 更新**：列表页断言 key 门（gateKey/先填写访问 key/localStorage）；对话页断言无 keyRow + getStoredKey；移动端标记断言（viewport-fit=cover / 100dvh / font-size:16px）
- **48 files / 625 tests 全绿**；typecheck ✓（node + client）→ build ✓

## v1.26.5 — 2026-08-29（public 口公网可靠校验：key 常驻可见 + 失败锁定 + 轮换，S142 用户需求）

**Scope:** 用户反馈：① key 输入框不见了（v1.26.4 隐藏逻辑）——"不能搞隐藏哈，不好说要换 key 呢"；② "key 的校验必须是可靠的；我要开放到公网"——公网暴露需防暴力破解 + 可轮换 key。

### 变更
- **`acp-http.ts` 聊天页 key 行常驻可见（v1.26.5 修复）**：localStorage 只做**预填**不再隐藏（`keyRow.style.display = 'none'` 移除）；已记忆时 placeholder 提示「访问 Key（已记忆，可修改）」——用户随时可查看/修改 key
- **`config-ops.ts` 公网 key 失败锁定（v1.26.5）**：复用 gateway-auth 指数退避模式（按 **IP**——key 是全局单值，按 IP 锁定不误伤其他用户；攻击者换 IP 需换出口）：`PUBLIC_ASK_FAIL_THRESHOLD=5` / 首次锁定 15min / 指数退避上限 4h；`isPublicAskIpLocked` / `recordPublicAskFail` / `resetPublicAskIpFail`；成功校验自动重置该 IP 计数（防历史失败累计误锁）
- **`acp-http.ts` handleAskParsed 接入锁定**：请求 IP 取 `X-Forwarded-For` 首个（公网反代/tunnel）→ 回退 `remoteAddress`；锁定期间直接 429；失败计数达到阈值 → 429（含剩余锁定分钟）
- **`config-ops.ts` `rotatePublicAskKey()`（key 轮换）**：生成新 32 字节 hex → 覆盖写回（**强制替换**，旧 key 立即失效）
- **`api.ts` /serenity/public-ask 支持 PUT {action:'rotate'}** → 返回新 key（x-serenity-ui 头限定）
- **client PublicAskEditor**：key 行加「重新生成」按钮（confirm 确认 + 警示色 `.ae-rotate`；成功后本地刷新显示新 key）

### 测试
- **acp-core.test +2**：rotatePublicAskKey（新 key 非旧 key / 旧 key 立即失效 / 新 key 生效）/ IP 失败锁定（4 次 401 → 第 5 次 429 / 锁定期间正确 key 也 429 / 其它 IP 不受影响 200 / reset 后恢复）
- **48 files / 625 tests 全绿**（+2）；typecheck ✓（node + client）→ build ✓（149316 B）

## v1.26.4 — 2026-08-29（public 口聊天体验升级：完整对话 UI + think 不渲染 + 连续对话，S142 用户需求）

**Scope:** 用户：public 口的会话体验要更好，目前很简陋，**参考好的案例强化**；回答中 **markdown 渲染器对 `<think>` 标签不渲染**；**要有对话记录**（不需要存储，就是用于连续对话用户看看用的）；**最终这个渠道是用于对接各类 IM 的**，只不过先做个好的体验让用户感受。

### 变更
- **`skiff-debug.ts` `renderSkiffMarkdown(raw, hideThink = false)`**：新增可选参数——`hideThink=true` 时 `<think>` 内容**直接移除不渲染**（public 口：思考过程对普通用户不展示）；默认 false（skiff 调试页保持 🧠 折叠卡）
- **`acp-http.ts` `publicAskContainerPage` 重写为聊天 UI（v1.26.4 体验升级，参考 ChatGPT/Claude 会话形态）**：
  - **顶部 header**：返回容器链接 + 容器名 + 角色下拉（保持 v1.26.2 角色选择）+ **「新对话」按钮**（清空当前会话）
  - **消息流**（msgList）：用户/助手气泡（用户右侧绿色、助手左侧白底），markdown 渲染（answer_html），**打字指示器**（三点 blink），错误气泡（⚠️ 前缀）
  - **连续对话记录**：前端内存数组（不存储，刷新即失——用户明确"不需要存储，就是用于连续对话用户看看用的"）；sessionId 延续服务端会话（追问上下文保留）
  - **底部输入区**：key 输入（localStorage 自动记忆 + 记住后隐藏 key 行）+ 自适应 textarea（**Enter 发送 / Shift+Enter 换行**）+ 发送按钮
  - **初始欢迎消息**（textContent 防注入）
- **`acp-http.ts` `handleAskParsed`**：`renderSkiffMarkdown(result.answer, true)`——public 口 answer_html 不含 think

### 测试
- **skiff-debug.test +1**：hideThink=true → `<think>` 内容完全不渲染（无 details.think/无思考文本），正文保留
- **acp-core.test 适配**：GET /c/<name> 断言聊天 UI 新结构（msgList/chatInput/新对话按钮）
- **48 files / 623 tests 全绿**（+1）；typecheck ✓（node + client）→ build ✓（147762 B）

## v1.26.3 — 2026-08-29（敏感数据保护：localstore 数据面守卫 + 最终输出守卫打回重生成，S142 用户需求）

**Scope:** 用户关切：认知容器对外提供认知结果时，**支撑宁静号的凭据与机制不应透露**（提示词纪律是软约束，仍有意外可能）。调研（`docs/sensitive-data-protection-research.md`：wardn "structural guarantee, not policy" / Docker redact_secrets / dsh-guardian / liteLLM+Presidio / redteams.ai 共识——没有万无一失的提示词防线，重心 = 最小化敏感信息进上下文 + 机械后处理兜底）。**用户拍板方案**：不做工具结果 redaction（代价高 + 面向错——工具结果是模型工作内存），**改卡最终输出——敏感词表检测 + 打回重生成**；词表 = 凭据词 + 机制词 + **msm_list 工具名**（"这样比较全面了"）。

### 变更
- **`guards.ts` 数据面守卫（localstore.json read 黑名单）**：新增 `SENSITIVE_CREDENTIAL_FILES` 硬名单 + `decideGuard` 新分支——**任何工具**（read/grep/glob/cc_fs 只读子命令与写工具一视同仁）命中 `localstore.json` → deny（`access blocked: ... sensitive credential file`）。**不依赖 safe-mode 开关**（结构性边界，对齐 wardn "structural guarantee"）；与 v1.18.5 写黑名单语义独立（写黑名单只拦写、REPOSITORIES/ 只读参考源不误伤读；凭据文件是数据面硬边界——值进不了上下文）。用户指令："localstore.json 需要在 read 工具的黑名单里"
- **`src/output-guard.ts`（新，纯逻辑）**：
  - `buildSensitiveTable(root)`：敏感词表 = ① 凭据词（localstore.json credentials **条目名 + 值**精确匹配，运行时读）② 机制词（静态内置：`dsh-serenity-hooks`/`serenity-hooks.json`/`mech-registry.json`/`localstore.json`/`.opencode/serenity.json`/`AGENT_SESSIONS`/事件名/端口 3080-3100/内部实现词）③ **MSM 词**（`loadMsmEntries` 读 mech-registry 注册工具名——用户补充"msm_list 列表里的工具名也包含进去"）；**不含公开概念词**（宁静号/Serenity/认知容器/EAP/CCE/Neat——正常交流词，误伤灾难）
  - `detectSensitive(text, table)`：精确匹配（条目名/值/工具名）+ 子串匹配（机制词），返回命中列表
  - `buildRebuke(hits)`：steer 打回消息——**不含命中词本身**（防二次泄露）；要求重新生成、不向用户解释
  - `REBUKE_MAX_ROUNDS = 3`（防死循环；达上限放弃打回 + 审计）
- **`src/output-guard-seam.ts`（新，拦截缝）**：`registerOutputGuardHook` 接 `agent/turn-stopping`（serial）——取 turn 最后 assistant 文本 → 检测 → 命中 → `agent.steer()` 打回。**机制依据（DSH 官方注释）**："a listener that objects steers and the machine re-reads its inbox: fresh steering runs another step, none closes the turn"——steer 是官方重生成通道（v1.22.5 rebuild 自动继续同款先例），零改 DSH。**作用范围（用户拍板）：仅外部面**——`isExternalFaceSession`（skiff-/acp-/rebuild- 前缀）；本地维护会话豁免（必然提及机制词，打回会瘫痪自身工作）
- **index.ts**：装配 `registerOutputGuardHook(ctx)`

### 测试
- **guards.test +4**：read localstore.json deny（含 safe-mode 开）/ grep/glob/cc_fs 只读 deny / 写工具 deny / 嵌套同名不误伤（docs/localstore.json allow）/ 先于黑名单
- **output-guard.test（新，19 tests）**：词表构建（凭据条目名+值 / MSM 名 / 机制词 / 凭据缺失不抛错）/ detectSensitive（正常认知零命中（公开概念词不敏感）/ 凭据值/条目名/MSM 名/机制词命中 / 空文本）/ buildRebuke（不含命中词 / 重新生成指令）/ seam 接线（外部面合规不打回 / 命中 steer 打回 / 连续 3 次放弃 / 合规重置计数 / **本地维护会话豁免** / ACP 会话检测 / 非 CCC 零干预）
- **48 files / 622 tests 全绿**（+23）；typecheck ✓（node + client）→ build ✓（147762 B）

## v1.26.2 — 2026-08-29（F4d 建议问答页：按容器权限控制 + URL 容器名 + localStorage key + 角色选择 + 配置处取 key/地址，S142 用户需求）

**Scope:** 用户对 v1.26.1 问答页的演进要求：① **按容器进行权限控制**——配置开放哪个容器（不再是全局开放所有 CCC）；② **容器名体现在 URL 上**——`/c/<容器名>` 单容器页；③ **用户只需要输入 key 即可使用**（URL 已锁定容器，页面不再选 CCC）；④ **key 自动存储在 localStorage**（输入一次浏览器记住）；⑤ 3100 应能**选择角色**（初版漏了）；⑥ **配置处需能获取 key 和地址**（管理员分享给使用者）。

### 变更
- **`config-ops.ts`**：`PublicAskSettings` +`allowed: string[]`（开放容器白名单，容器名；**空 = 全部开放**——向后兼容 v1.26.1 全局开放语义）；merge/update/applyWirePatch/toWire 全链路（数组过滤非空字符串）；`AdvancedSettingsWire.publicAsk.allowed` wire 暴露（面板读写）
- **`acp-http.ts`**（路由重构）：
  - **GET /** → 容器列表页（只列已开放容器，卡片链接 `/c/<name>`；空白名单 = 全部）
  - **GET /c/<name>** → 单容器问答页（URL 锁定容器；**key 输入 + 角色下拉** + 问题；**key 自动存 localStorage**（`serenity-public-ask-key`，加载恢复/提交保存）；含 容器不存在 / 未开放 提示页）
  - **POST /c/<name>/ask** → 该容器问答（白名单 403 + key 401 + 角色参数 + 会话延续 v1.25.10 语义）
  - **POST /ask** 兼容旧形态（`{key, ccc|name, ...}`）→ 同样做白名单校验（`handleAskParsed` 公共核心抽出，两路由共用）
  - `containerAllowed(name)`：allowed 空 = 全放行；非空 = 容器名 ∈ 白名单
- **`api.ts`**：新增 **GET /serenity/cccs**（候选容器列表，`discoverCccs` 动态 import 保持 api.ts 静态链纯净）+ **GET /serenity/public-ask**（x-serenity-ui 头限定：`{enabled, port, key, allowed, urls: [{name,url}], listUrl}`——配置处获取 key 与地址）
- **client**：`accounts-api.ts` WireConfig +`publicAsk.allowed` + saveConfig patch；**`PublicAskEditor.tsx`（新）**——开放容器白名单 chips（候选 /serenity/cccs）+ 保存（/serenity/config）+ **key/地址展示区**（复制按钮；开关打开时拉取 /serenity/public-ask）；SettingsSection「ACP / 建议问答」组下方新增「建议问答」配置组；AccountsEditor.css +chips/key/copy 样式
- **测试隔离修正**：acp-core.test.ts 补 `SERENITY_HOOKS_CONFIG` 临时文件隔离（防 ensurePublicAskKey 污染真实 ~/.dsh）+ schemastery/dsh-settings mock

### 测试
- **acp-core.test +4**：GET /c/<name> 单容器页（角色下拉 qa + localStorage key）/ GET /c/unknown 不存在页 / allowed 白名单（未开放 POST 403 + GET 关闭页 + 列表不含 + 空白名单恢复全开）/ POST /c/<name>/ask 会话延续 + 角色参数（未知角色回退第一个 200）
- 原 F4d 测试适配：GET / 断言改列表页（/c/<name> 链接）
- **47 files / 599 tests 全绿**（+4）；typecheck ✓（node + client）→ build ✓（147762 B，含 PublicAskEditor 区块）

## v1.26.1 — 2026-08-29（F4d 建议问答页：3100 复用 ACP 端口，key 认证，S142 用户需求）

**Scope:** 用户：「建议问答页面——新开 3100 接口，按认知容器暴露一个建议问答页面供他人验证：① 页面可配置开关（按认知容器开关）② 基本 key 认证——没有 key 不工作；key 随机生成后固定（配置时生成）」。用户拍板：**复用 ACP 的 3100 端口**（GET / 渲染问答页，POST / 处理 JSON-RPC + /ask 处理问答，一个服务两个面）/ **全局开关**（settings 面板 `publicAskEnabled`，非按 CCC 单独开关）/ **key 首次启用自动生成写回**（`~/.dsh/serenity-hooks.json publicAsk.key`，crypto.randomBytes(32) hex 64 字符，幂等不覆盖手改）。

### 变更
- **`config-ops.ts`**：`AdvancedSettings` +`publicAsk: PublicAskSettings{key}`（merge/update 同步）；**`ensurePublicAskKey()`**（首次生成写回，幂等——二次调用返回同一 key，不覆盖手改）；**`verifyPublicAskKey()`**（timing-safe 比对；key 未生成恒 false）
- **`settings-section.ts`**：`SerenitySimpleSettings` +`publicAskEnabled`（默认 false）+ schema/entryDefaults/defaultSimpleSettings 同步 + `__setSimpleSourceForTest`（测试注入钩子）
- **`acp-http.ts`**：`startAcpHttpServer(ctx, port, defaultRoot?)` 三参（默认 CCC 根注入）；handle 路由重构——POST /（JSON-RPC，需 acpEnabled 否则 403）、**GET /（问答页，publicAskEnabled 门控，关闭渲染未启用提示页）**、**POST /ask**（key 校验 timing-safe → 401「invalid or missing key」；ccc 缺省 defaultRoot；角色缺省取该 CCC 第一个；会话延续复用 v1.25.10 语义——sessionId 命中 + role/ccc 绑定校验 → continued:true，不匹配/不可恢复 → 静默新建；返回 answer + answer_html（marked）+ sessionId + continued + trajectory）；`publicAskPage(cccs)`（key 输入 + CCC 下拉 + 问题框 + 答案区，`\u003c` JSON 注入防护）
- **`index.ts`** `registerAcp`：`anyFace = acpEnabled || publicAskEnabled`——任一面开启即启动服务（传 resolveSkiffRoot(ctx) 为 defaultRoot）
- **client SettingsSection.tsx**：wire 类型 +`publicAskEnabled`；ACP 组改名「ACP / 建议问答」+ 开关行 + 端口行 disabled 条件放宽

### 测试
- **acp-core.test +5（F4d describe）**：ensurePublicAskKey 幂等（64 hex + 二次同值）/ verifyPublicAskKey 四态（正确/错误/空/未生成）/ POST /ask 无 key 与错误 key → 401 + 正确 key → 200 答案 + 追问延续 continued:true / 问答页关 → POST /ask 403 / GET / 开启渲染页面
- **测试修复（首跑 3 处）**：① acp-core.test 补 `vi.mock('@deepseek-ai/schemastery')` + `vi.mock('@deepseek-ai/dsh-settings')`（F4d 使 acp-http.ts → settings-section.ts 进依赖链，settings-section.test.ts 同款模式）② settings-section.test 两处 toEqual 补 `publicAskEnabled: false`（entryDefaults 新增字段断言未同步）③ acp-core.test `httpPost(port, '/ask', {...})` 参数顺序颠倒（path 当 body → ERR_UNESCAPED_CHARACTERS）5 处修正 + **fakeCtx sessionId 真实化**（硬编码 `skiff-qa-uuid` → 尊重传入 opts.sessionId；注册表 key 与 askSkiff 返回值不一致 → 追问延续查不到 → continued:false 根因修复）
- **47 files / 595 tests 全绿**（+5）；typecheck ✓（node + client）→ build ✓（136867 B，含问答页区块）

## v1.26.0 — 2026-08-29（F4c ACP server：指定 CCC+角色+会话 程序化对话，S142 用户需求）

**Scope:** 用户：Skiff 提供 **ACP 能力**——指定 **认知容器 + 角色 + 会话（可选）** 进行对话（程序化/机器人调用），以企业微信机器人为对接例子（初版方案 `docs/acp-wecom-design.md` 用户审核定稿：先支持个人后群聊 / 管理员可测 / 公网走 cloudflare tunnel）。**实现修正（R↓）**：官方 dsh-acp（--profile acp）不绑定 skiff 角色机制 → **自研进 dsp 复用 skiff 核心**；dsp 是 dsh web 进程内插件，**stdio server 需独占进程 stdout（污染主进程日志）→ 首版 HTTP JSON-RPC 端点**（协议处理器传输无关，企业微信桥同进程直调；stdio 独立进程部署留待后续，复用同一 acp-core）。

### 变更
- **`src/acp-core.ts`（新）**：ACP 会话管理层（**传输无关**）——`AcpServer` 类 + `dispatchRpc`（JSON-RPC 2.0 单帧批处理）+ `RpcMethodError/RpcInvalidParams` + 标准错误码；方法面（对齐 ACP v1 + 官方演进）：
  - `initialize`（协议 v1 + skiff 扩展能力声明：ccc/role/sessionId）/ `authenticate` no-op / `request_permission` 恒 allow（G9 白名单即授权）
  - **`session/new {ccc, role, sessionId?}`**（skiff 扩展）——无 sessionId → createSkiffAgent（新会话 continued:false）；有 → 进程内延续（getSkiffAgent 命中 + role/ccc 绑定校验；未命中 → 「not recoverable」；绑定不匹配 → 「belongs to role」）
  - `session/prompt {sessionId, question}` → askSkiff(agent, q, 0)（答案 + 全量轨迹）/ `session/cancel`（agent.interrupt）/ `session/close`（unregisterSkiffSession）/ `session/list`（注册表快照 role+ccc）
- **`src/acp-http.ts`（新）**：HTTP JSON-RPC 端点（node:http，默认关仅 127.0.0.1；仿 skiff 调试服务单实例幂等）——POST / 单帧 → 响应数组；parse error → -32700 帧；404 兜底
- **装配（index.ts + settings-section.ts）**：Config/schema/defaultSimpleSettings/entryDefaults +`acp.{enabled,httpPort}`（默认关 / 3100）；`registerAcp`（settings acpEnabled 启停，settings-changed 同步，启动时恢复）
- **client SettingsSection.tsx**：新增 **ACP 区块**（开关 + HTTP 端口输入，仿 Skiff 区块）
- **skiff_admin guide**：运行节增 ACP 程序化面说明（session/new/prompt/cancel/close/list）

### 测试
- **acp-core.test（新，23 tests）**：initialize/authenticate/未知方法；session/new（新建/延续/缺参/未知角色/未恢复/绑定不匹配）；prompt（答案+全量轨迹/未知会话/缺参）；cancel/close/list/request_permission；dispatchRpc（请求响应/通知无响应/方法错误 -32601/参数错误 -32602/非法帧 -32600）；acp-http（start→POST initialize/非法 JSON 帧/GET 404/重复 start 幂等）
- settings-section.test 适配 acp 默认 +2——**47 files / 590 tests 全绿**（+23）；typecheck ✓（node + client）→ build ✓（136232 B，含 ACP 客户端区块）

## v1.25.11 — 2026-08-29（F3 会话命名：create 后也重命名 dsh 会话，S142 用户反馈）

**Scope:** 用户：「修个小问题，会话命名的，use session 正常，但 create session 也要进行命名」。现状：F3 命名仅在 **use** 分支触发（激活后 `renameDshSessionOnUse` 把当前 dsh 会话重命名为 `S###-日期`），create 分支创建 SESSION 后 dsh 会话保持默认标题。**修复**：create 后立即重命名（不再等 use）。

### 变更
- **session.ts**：新增导出 `activeInfoFromCreate(result: CreateSessionResult): ActiveSessionInfo`——createSession 结果已含 sessionId（S###/issue）与 dirName，无需等待 use 激活即可构造命名信息（mdPath = sessionPath/SESSION.md，与 use 一致）
- **session.ts**：新增导出 `renameDshSessionForActive(ctx, exec, info)`——use 分支内联重命名逻辑提取为共用封装（门控/失败可见性与原一致：成功 log / 失败 warn，主流程不阻断）；use 分支改调此封装（行为不变）
- **create 分支**：createSession 成功后（非 dry-run）→ `renameDshSessionForActive(ctx, exec, activeInfoFromCreate(result))`——dsh 会话立即重命名为 `S###-日期`（issue 会话回退目录名）；dry-run 不命名（未真实创建）

### 测试
- session-title.test +5：activeInfoFromCreate（desc 模式 S###/mdPath/命名标题 S###-日期；issue 模式回退目录名）/ renameDshSessionForActive（门控通过 rename 调用 / 缺 agent session warn 不抛 / sessionTitle 缺失 warn 不静默）——**46 files / 567 tests 全绿**（+5）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.10 — 2026-08-29（Skiff 两项增强：md 提示词引用 + 会话追问延续，S142 用户需求）

**Scope:** 用户两项新需求：① CCC 倾向定义超长提示词，JSON 内嵌不可读——**支持引用 md 文件作为角色系统提示词**（推荐配置方法）；② **dsh 会话概念在 skiff 绑定**——允许使用同一个 qa 会话追问（多轮对话上下文延续），而非每次提问新建会话。用户拍板：页面级会话 + 新对话按钮 / **仅进程内延续**（首版不做跨进程 resume，官方 `ctx.agents.resume` 路径已调研确认可行留待后续）/ 全量轨迹重绘 / v1.25.10 patch 级。

### 变更
- **R1 md 提示词引用（`systemPromptFile`）**：
  - `ccc.ts`：`SkiffRoleConfig` 新增 `systemPromptFile?: string`（相对 CCC 根）
  - `skiff-role.ts`：`readSkiffRoles` 只透传字段不读文件（guards/seams 每次工具调用查询的热路径零 IO）；新增 **`resolveRoleSystemPrompt(root, role)`**——file 优先（`resolveInside` 路径逃逸守卫 + `existsSync` + `readUtf8` 去 BOM），否则回退内嵌 `systemPrompt`（兼容旧配置），都无 → 空；文件缺失/逃逸 → 抛错（装配 catch 降级 + validate 报 issue）；新增 `systemPromptSource`（file/inline/none）
  - `skiff-core.ts`：`createSkiffAgent` CCC 段改 `resolveRoleSystemPrompt`——缺失 → console.warn 降级仅基础段（不阻断创建）
  - `skiff-admin.ts`：validate 改 resolve 后校验（file 缺失/逃逸 → issue；两者都无 → 「system prompt is empty」）；list 显示 `promptSource` + `systemPromptFile`；SKIFF_GUIDE schema 示例改 `systemPromptFile` 首选（内嵌标注兼容）
- **R2 会话追问延续（同会话多轮）**：
  - `skiff-registry.ts`：注册表值 `string`（role）→ `{ role, ccc }`（**SkiffSessionBinding**）；`skiffRoleFor` 返回 role 不变（guards/seams 向后兼容）；新增 `skiffSessionInfo`（role + ccc 完整绑定）
  - `skiff-core.ts`：`registerSkiffSession` 三参→四参（+ccc）；新增 **`getSkiffAgent(sessionId)`**（进程内活体查询）；`askSkiff` eventsStart 语义修正——**显式传 0 = 全量轨迹**（页面重绘完整时间线），不传（undefined）= 本轮增量（原实现 0 被当作当前长度，与注释矛盾——v1.25.10 修复）
  - `skiff-debug.ts` /ask：无 sessionId → 新建（`continued:false`）；有 sessionId → 进程内命中（校验 role+ccc 绑定一致 → 复用 `continued:true`）/ 未命中（重启后/不存在）→ 400「session is not recoverable」/ 绑定不匹配 → 400「belongs to role」；返回 `continued` 标记 + **全量轨迹**（`askSkiff(..., 0)`）
  - **调试页 UI**：会话徽标（短显 `skiff-qa-…` + 「追问续接」样式）+ **「新对话」按钮**（清 sessionId + 区清空）；追问直接继续输入；角色/CCC 下拉切换自动视为新对话；服务端 400 时前端清 sessionId 重建
  - `skiff_admin` description 同步（system prompt resolvable）

### 测试
- skiff-role +6：resolveRoleSystemPrompt（file 优先 / 内嵌回退 / 都无空 / 文件缺失抛错 / 路径逃逸拒绝 / BOM 剥除）+ systemPromptSource
- skiff-core +4：skiffSessionInfo 绑定 / getSkiffAgent 查询 / createSkiffAgent systemPromptFile 优先 / 缺失降级不阻断
- skiff-debug +3：会话延续全链路（新建 continued:false → 同会话追问 continued:true + created 不增 + 全量轨迹增长）/ 未注册 sessionId 400 不可恢复 / 绑定角色 CCC 不匹配 400
- skiff-admin +2：systemPromptFile 缺失 → issue / 合法 file → ok；list promptSource=file + 路径展示
- 签名适配：guards/keeper/skiff-core 测试 registerSkiffSession 新签名——**46 files / 562 tests 全绿**（+16）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.9 — 2026-08-29（Skiff 回答改 marked 正经渲染器（服务端），用户批评手写正则渲染器）

**Scope:** 用户：「用个正经 markdown 渲染器不要乱来啊」+ console 报错 `Invalid regular expression flags`。**采纳**：放弃 v1.25.8 的手写正则渲染器（脆弱 + 模板字符串内嵌反引号陷阱），改用 **marked**（成熟 markdown 库，GFM）——**服务端渲染**：node half 内联打包（tsdown noExternal），POST /ask 返回 `answer_html`，页面只插 HTML；`<think>` 折叠由服务端生成。

### 变更
- **依赖**：`marked@18`（hooks devDependencies，自带类型；纯 JS 零传递依赖）；tsdown Node half `noExternal: ['marked']` → marked 打包进 lib/index.js（非 DSH 生态依赖，插件运行时无 node_modules 解析面）
- **skiff-debug.ts**：新增 `renderSkiffMarkdown(raw)`（导出可测）——① 提取 `<think>…</think>`（`\u0000T<idx>\u0000` 占位符）② 正文与 think 内容**先 `escapeHtml` 再 `marked.parse({breaks,gfm})`**（markdown 语法不受转义影响，原始 HTML 注入被消除——安全）③ think 占位符还原为 `<details class="think"><summary>🧠 思考过程</summary>`（默认折叠）；POST /ask 响应加 `answer_html`
- **页面 JS**：删除手写 `renderMd/inlineMd/thinkHtml`（v1.25.8 反引号转义陷阱随之消失）；`answer.innerHTML = data.answer_html || esc(answer)`；CSS 保留（markdown 元素 + details.think 样式）
- 页面版本号 v1.25.9

### 测试
- skiff-debug.test +3：markdown 语法渲染（标题/粗体/行内码/列表/代码块 `language-js` class）/ `<think>` 提取折叠（🧠 summary + 内容 + 正文前后段 + 无裸 think 标记）/ 原始 HTML 注入转义（`<script>` → `&lt;script&gt;`）——**46 files / 546 tests 全绿**（+3）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.8 — 2026-08-29（Skiff 回答 Markdown 渲染 + `<think>` 折叠，S142 用户需求）

**Scope:** 用户：「很好玩能跑了——回答的渲染上 markdown 渲染器，其中对于 `<think>` 部分支持折叠」。调试页回答区从纯文本升级为**零依赖轻量 Markdown 渲染**（不引 CDN——本地 127.0.0.1 页面，外网不可靠），`<think>…</think>` 思考块提取为 **`<details>` 原生折叠**（默认收起）。

### 变更（skiff-debug.ts `skiffDebugPage` 内联 JS/CSS）
- **`renderMd(src)`**：零依赖 markdown——标题（#~###）/粗体/斜体/行内代码/代码块（``` 围栏）/无序列表/引用/链接；`<think>…</think>` 非贪婪提取（`\u0000T<idx>\u0000` 占位符 → 还原为 `<details class="think"><summary>🧠 思考过程</summary>…`，默认折叠，点击展开）
- **回答区渲染**：`answer.innerHTML = renderMd(data.answer)`（替换 textContent）；错误/提示仍 textContent（不渲染）
- **CSS**：#answer 去 `white-space: pre-wrap`（markdown 结构自行控制）；新增 p/h1-3/code/pre/ul/blockquote/a 样式；`details.think` 琥珀描边折叠卡（summary 可点 + hover）
- **模板字符串转义陷阱**（typecheck 定位）：页面 JS 内嵌于 TS 模板字符串——**裸反引号会提前终止模板**——代码围栏正则 `/^```/` 与行内代码正则 `/`([^`]+)`/g` 的 6 处反引号全部改 `\u0060` 转义（页面 JS 运行时解析为反引号）

### 测试
- 无新测试（页面内联 JS 无单测覆盖面；typecheck client ✓ 验证模板字符串完整）——**46 files / 543 tests 全绿**；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.7 — 2026-08-29（Skiff 调试页 JSON.parse 崩溃修复：内嵌数据 escapeHtml 破坏 JSON，用户 console 报错定位）

**Scope:** 用户实测——下拉仍空，**console 报错**：`Uncaught SyntaxError: Expected property name or '}' in JSON at position 2 (at (index):52:19)`（页面脚本 `JSON.parse(document.getElementById('skiff-data').textContent)`）。**根因**：v1.25.4 起内嵌候选数据经 `escapeHtml` 整体转义——`"` → `&quot;`，而 `textContent` 返回**原始文本**（浏览器不反转义），`JSON.parse` 遇到 `{&quot;root&quot;...` 的 `&`（position 2）即抛错 → CCCS 未定义 → 下拉空。

### 变更（skiff-debug.ts `skiffDebugPage`）
- 内嵌 JSON **只转义 `<` → `\u003c`**（JSON 合法转义，`JSON.parse` 还原；防 `</script>` 注入）——引号等原样保留，`JSON.parse(textContent)` 正常工作
- `data-default` 属性值仍走 `escapeHtml`（HTML 属性语境，语义正确）

### 测试
- skiff-debug.test：页面渲染断言改回原始 JSON 形式（`"root":"..."` / `"roles":[...]`）；新增防注入断言（含 `<` 路径 → `\u003c` 转义 + 无裸 `</script>{` 序列）；实时读取用例断言同步——**46 files / 543 tests 全绿**；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.6 — 2026-08-29（Skiff 候选 CCC 加 sessionPersistence 兜底，用户实测仍空）

**Scope:** 用户实测——v1.25.5（workspaceRegistry）后「认知容器」下拉**仍空**。根因排查：workspaceRegistry 是可选装配服务（依赖 storageDomain + sessionPersistence），web 环境可能未装配或注册表无记录 → list() 空 → 兜底 live 会话仍空（其它 CCC 无 live 会话）。**加固：加 sessionPersistence 兜底**——必装配的持久化会话服务，`list()` 返回**全部历史会话 headers**（含 cwd），覆盖所有曾工作目录的 CCC，即使无 live 会话。

### 变更（skiff-debug.ts `discoverCccs` → async 三层）
- ① **workspaceRegistry**（持久化工作区注册表，同步）
- ② **sessionPersistence**（持久化会话 headers，async `list()` → `SessionHeader[]`）——workspace 缺失/为空时兜底，覆盖所有历史会话工作目录
- ③ **live 会话**（`ctx.sessions.list()`）——持久化均缺失时兜底
- ④ 默认绑定 root 兜底（不在列表时放首位）；`pushRoot` 统一上溯 `.serenity` 去重（只收具体 CCC）
- handle GET / 改 `await discoverCccs(...)`

### 测试
- skiff-debug.test 更新：discoverCccs 用例全部 await；新增 sessionPersistence 兜底用例（持久化会话 headers 列出 + 空 cwd/缺 cwd 跳过）；live 会话用例改为「持久化缺失兜底路径」——**46 files / 543 tests 全绿**（+1）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.5 — 2026-08-29（Skiff 候选 CCC 改为拉 dsh 工作区注册表，用户实测反馈）

**Scope:** 用户实测——v1.25.4 调试页「认知容器」下拉**拉不出来**（只有默认 CCC），指出：「应该直接拉 dsh 工作区，且是具体的 CCC 的」。根因：v1.25.4 用 live 会话（`ctx.sessions.list()`）发现候选——其它 CCC 无 live 会话时列表为空；用户要的是 **dsh 持久化工作区注册表**（workspaceRegistry.list()，所有工作目录即使无 live 会话）。

### 变更（skiff-debug.ts `discoverCccs`）
- **① workspaceRegistry 优先**：`ctx.get('workspaceRegistry').list()`（DSH `WorkspaceRegistry` 服务，持久化注册表，`Workspace.path` 字段）→ 逐工作区 `findSerenityRoot(path)` 上溯 `.serenity` → **只收具体 CCC**（无 .serenity 的工作区跳过）
- **② live 会话兜底**（workspace 服务缺失 / 注册表为空时）
- **③ 默认绑定 root 兜底**（不在列表时放首位）

### 测试
- skiff-debug.test 更新：新增 workspaceRegistry 优先用例（持久化工作区列出 + 非 CCC 工作区跳过 + 子路径上溯）；live 会话用例改为「workspace 缺失兜底路径」；默认 root 兜底适配（fake ctx 含 get）——**46 files / 542 tests 全绿**（+1）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.4 — 2026-08-29（Skiff 调试页多 CCC 手工切换，S142 用户需求）

**Scope:** 用户：「当 dsh 管理多个 CCC 时，debug 页可以手工切换就比较方便，加强下，我要去测测别的 CCC 了」。调试页从「绑定单个 CCC」升级为「候选 CCC 列表 + 手工切换」。

### 变更（skiff-debug.ts）
- **`discoverCccs(ctx, defaultRoot)`**（新）：候选 CCC 发现——live 会话 cwd 上溯 `.serenity` 去重 + 默认绑定 root 兜底（不在列表时放首位）；每个 CCC 实时读取 `skiff.roles` 角色名列表
- **`skiffDebugPage(cccs, defaultRoot, webPort)`**：页面新增 **「认知容器」下拉**（列出全部候选 CCC：目录名 + 角色数；默认选中绑定 root）+ 角色下拉联动（切换 CCC → 角色列表更新）+ CCC 徽标实时显示当前 root；候选数据内嵌 `script[type=application/json]`（escapeHtml 转义，JS `JSON.parse(textContent)` 消费）
- **POST /ask 增加 `ccc` 字段**：按所选 CCC 读角色 + 创建 agent（缺省回退默认绑定 root）；角色校验按目标 CCC

### 测试
- skiff-debug.test 更新 +3：discoverCccs（live 会话去重 + 默认兜底放首位 / 无 live 会话仅默认）、POST /ask 切换 CCC（目标 CCC 无该角色 → 400）；页面渲染断言适配新签名（内嵌数据转义形式 `&quot;`）+ CCC 切换器/默认选中
- **46 files / 541 tests 全绿**（+3）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.3 — 2026-08-29（Skiff 三合一：平台工具面修复（read/glob 不生效根因）+ skill 恒可用 + skiff_admin apply 生效机制，S142 用户需求/实测）

**Scope:** 三项——① 用户实测：qa 角色白名单加了 read/glob 但**不生效**——根因：**skiff agent 未挂 agent preset → 平台工具（read/grep/glob/web_search）不在工具面**（handyman 经 `agentPresets.composeFrom` 继承父 ctx、skiff 无父上下文直接创建；插件工具 acc_msm 全局注册不受影响 → MSM 通道可用但 read/glob 不可见）② 用户：**skill 加载也要让 skiff 支持（不设白名单）** ③ 用户：改了 json 应该有个生效机制——**skiff_admin 新增 apply**。

### 变更
- **skiff-core.ts `createSkiffAgent`**：`agents.create` 增加 `setup` 钩子——`agentPresets.mount(agentCtx, 'standard')`（DSH 默认 preset → 平台工具面）；`meta.agentPreset: 'standard'`（持久化重建恢复工具面）；agentPresets 可选服务缺失 → 跳过不阻断创建；guard 角色白名单仍按角色过滤（白名单外工具 deny）
- **seams/guards.ts**：skiff 白名单分支 **`skill` 恒放行**（豁免在角色查询之前——未注册会话也放行；读知识面无写能力）
- **tools/skiff-admin.ts**：新增 **`apply` 子命令**（`applySkiffConfig`）——① 校验（复用 validate：msms 注册 / model 白名单 / systemPrompt 非空）② 非法 → `applied:false` + 问题清单 + 修复提示（不应用）③ 合法 → `applied:true` + 绑定 CCC + 角色清单 + 说明（角色实时读取，调试页刷新即生效）；SKIFF_GUIDE 补 apply + skill 恒可用说明；description/enum 更新

### 测试
- skiff-core.test +2：createSkiffAgent 挂载 standard preset（meta + mount 调用 + scoped 提示词 + 注册表）/ agentPresets 缺失不阻断创建
- guards.test +1：skill 恒可用（tools 空角色 + 未注册会话均 allow；非 skill 仍白名单约束）
- skiff-admin.test +3：apply 合法（applied + cccRoot + roles）/ 非法（applied false + issues + hint）/ 无角色（applied true 零影响）
- 修复：SKIFF_GUIDE 模板字符串内嵌反引号提前终止（语法错误）；applySkiffConfig validate 返回值类型收窄
- **46 files / 538 tests 全绿**（+6）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.2 — 2026-08-29（Skiff 绑定 CCC 修复：实时读取角色 + 页面显示绑定 CCC，用户设计批评）

**Scope:** 用户实测——3099 调试页**看不到角色**，并指出设计缺失：**「skiff 应该绑定 CCC，这个玩法没绑定 CCC」**。根因双链：① 服务启动时 `resolveSkiffRoot` 按「进程 cwd 优先」猜 root（多 CCC 时可能绑定错目标，且绑定不可见）；② 启动时 `readSkiffRoles(root)` **快照角色**——配置写入/修改后服务已 active（幂等 return），角色永不刷新（除非重启服务）。

### 变更（CCC 绑定根治）
- **skiff-debug.ts**：角色配置**每次请求实时读取**（GET / 与 POST /ask 均 `readSkiffRoles(root)`，删除启动时快照）——改 `.opencode/serenity.json` 后**刷新页面即生效，无需重启服务**；问答页新增 **CCC 徽标**（`CCC: <root>` 顶部显示，绑定目标可核对）；v1.25.2 版本号
- **index.ts `resolveSkiffRoot`**：绑定优先级重排——① live 会话中**配置了 skiff.roles 的 CCC 优先**（用户认知中的绑定目标）② 回退进程 cwd ③ 任一 live CCC

### 测试
- skiff-debug.test：页面渲染断言 +CCC 徽标（含路径）；新增「角色配置实时读取」用例（空配置 → 写 skiff.roles → 刷新页面立即可见，不重启服务）——**46 files / 532 tests 全绿**（+1）；typecheck ✓（node + client）→ build ✓（134857 B）

## v1.25.1 — 2026-08-29（Skiff 区块 UI 补全：设置面板「Serenity」页缺 Skiff 开关，用户实测反馈）

**Scope:** 用户实测——v1.25.0 发布后设置面板「Serenity」页**看不到 Skiff 区块**。根因：简单配置层分 host/client 两半——v1.25.0 只更新了 host 侧 schema（settings-section.ts `skiffEnabled/skiffDebugPort`），client half 的 `SettingsSection.tsx` 是**自绘表单**（不自动跟随 schema），未渲染 Skiff 组。

### 变更
- **src/client/SettingsSection.tsx**：`SerenitySimpleWire` + `skiffEnabled/skiffDebugPort`；新增 **Skiff 分组**——① 认知子集调试服务开关（`skiffEnabled`）② 调试端口 number 输入（1024~65535 clamp，默认 3099，`disabled` 跟随开关）；`setSkiffPort` 经 `scope.set` 写回 settings.yaml
- **src/client/SettingsSection.css**：新增 `.ss-portInput`（number 输入，--dsw-alias token，关闭时半透明）
- host 侧无需改动（v1.25.0 已注册 schema + entryDefaults）

### 测试
- 无新测试（UI 组件无单测覆盖面；typecheck client ✓ 验证 wire 类型一致）——**46 files / 531 tests 全绿**；typecheck ✓（node + client）→ build ✓（134857 B，client +1867 B 含 Skiff 区块）

## v1.25.0 — 2026-08-29（F4 Skiff 认知子集角色：会话核心 + 调试问答页 + skiff_admin 工具 + 双白名单强制 + 拦截缝旁路，S142 用户设计驱动）

**Scope:** 知识型 CCC 价值释放（F4）首版——Skiff（舢板）= 宁静号放出的独立小艇：完整 trajectory（全知全能）的**任意子集角色**，由 CCC 定义（`.opencode/serenity.json skiff.roles`）。用户拍板（2026-08-28 累计）：① 首版只提供**调试页**（ACP stdio 协议 F4c 后续，复用同一会话核心）② 双白名单（MSM 独立 + 非 MSM 工具独立，白名单外全隐藏，默认全隐藏）③ dsp 只给基础提示词，角色人格 CCC 完全定义（全替换 ACC 默认注入）④ Skiff 默认不使用 trajectory 机制（不建 SESSION.md / 无 keeper / 无 rebuild），轨迹纪律按角色子集选择性开启 ⑤ 新增第 12 个 ACC 工具 `skiff_admin`（guide/validate/list）⑥ 启停 = 人工（设置面板开关，不随插件加载自动启动）⑦ per-role 模型 CCC 直接指定（无白名单校验）⑧ 实验性质：默认全关、guard/旁路只对 skiff 会话生效、未配置角色零影响。

### 变更（F4a' 会话核心 + 调试页 + 工具）
- **`src/skiff-core.ts`**（新）：Skiff agent = 标准 DSH agent（`ctx.agents.create({ sessionId: 'skiff-<role>-<uuid>' })`，cwd=CCC root，per-role model）→ `createSkiffAgent`（scoped 系统提示词 `serenity-skiff` order -60：`buildSkiffBasePrompt` 动态白名单清单 + CCC systemPrompt 全替换）→ `askSkiff`（followup → waitIdle → 读 session.events 答案 + `eventsToTrajectory` 增量轨迹）；`skiffTrajectoryEnabled`（seams 旁路判定：非 skiff 恒 true，skiff 按角色 trajectory 子集，注册表缺失保守 false）；`skiffMsmGate`（acc_msm 白名单门控：exec 校验 / register-deregister 必拒 / list 白名单 / check-guide-ccc-config 只读放行）
- **`src/skiff-role.ts`**（新，纯逻辑）：`readSkiffRoles`（serenity.json skiff.roles → Map，非法跳过）、`roleToolWhitelist`（tools ∪ acc_msm）、`roleMsmWhitelist`、`trajectorySubset`（缺省全关）、`buildSkiffBasePrompt`（身份 + 可用 MSM/工具清单 + 调用协议 + 边界声明）
- **`src/skiff-registry.ts`**（新，零依赖）：会话注册表（sessionId → role）独立成模块——guards/seams 安全查询，不引入 skiff-core 的 dsh-llm 运行时依赖（测试/装配级联成本）
- **`src/skiff-debug.ts`**（新）：node:http 调试端口（默认关，仅 127.0.0.1；启停 = 人工）——GET / 问答 HTML 页（角色下拉 + 输入 + 答案区 + 轨迹区 JS 渲染 + WebUI 链接）；POST /ask `{role, question}` → 会话核心 → `{answer, sessionId, trajectory}`；单实例幂等
- **`src/tools/skiff-admin.ts`**（新，第 12 工具）：`skiff_admin` guide（定义教程：概念/schema/认知 MSM 写法/双白名单/轨迹纪律/示例角色 qa-readonly+code-review）/ validate（roles schema / msms 已注册 / model ∈ handyman.models / systemPrompt 非空）/ list（角色摘要）

### 变更（F4b 机制 4 件套）
- **⑧ guard 角色白名单**（seams/guards.ts）：`decideGuard` 新增 skiff 分支（skiffSessionId 判定）——工具 ∈ `roleToolWhitelist(role)` 否则 deny（拒绝信息泛化不泄漏白名单外工具名；完备性：按角色判定不枚举工具名）
- **⑨ acc_msm 白名单**（tools/msm.ts + skiff-core `skiffMsmGate`）：exec 非白名单 MSM 拒绝（不列名单）/ register-deregister 必拒 / list 过滤显示 / check-guide-ccc-config 放行
- **⑩ 拦截缝旁路**（只对 skiff 会话生效）：context.ts（session-start 播种 + pre-step 注入 + shouldAutoRestore 跳过 skiff——完全独立不恢复宁静号会话）/ keeper.ts（计分按 trajectory.keeper、重建压力按 trajectory.rebuild）/ bootstrap.ts（锚定跳过 + `skiff-` 恒 promoted）/ compact.ts（compaction/end 不重注入）/ system-prompt.ts（全局 + scoped section 对 skiff 返回空——角色 CCC 提示词全替换）
- **装配**（index.ts）：`registerSkiff`（settings-changed 监听 + 启动时 sync：skiffEnabled → `startSkiffDebugServer`（root 解析：进程 cwd 优先 live 会话兜底，webPort 读 ctx.webServer）/ 关 → stop）；Config + skiff entry（enabled false / debugPort 3099）；invariant REGISTERED_TOOLS 11→12（补 session_rebuild/localstore 历史欠账 + skiff_admin）；system-prompt accBlock 工具清单 +1 行；dsh.plugin.json contributes.tools +skiff_admin + description

### 测试
- 新增 4 文件：skiff-role（12：判定/解析/子集/白名单/基础提示词）、skiff-core（13：注册表/轨迹子集/MSM 门控/askSkiff 往返）、skiff-admin（8：guide/validate 各路径/list）、skiff-debug（7：页面渲染/GET/POST 错误路径/404/幂等）
- 追加：guards +9（skiff 白名单 allow/deny/不泄漏/未注册保守 deny/非 skiff 不受影响/纯 MSM 角色）、context +2（shouldAutoRestore/Active skiff 不恢复）、bootstrap +2（skiff 恒 promoted 含历史事件）、compact +1（skiff 不重注入）、keeper +3（keeper 子集关旁路/开生效/非 skiff 正常）、invariant +1（12 工具断言）
- 修复：waitIdle dispose TDZ（ctx.on 同步触发场景）、guards skiff 测试 root 用真实 fixture、settings-section entry 期望 +skiff 字段、register 12 工具断言
- **46 files / 531 tests 全绿**（+55）；typecheck ✓（node + client）→ build ✓（132990 B）



**Scope:** 用户需求——在提示词中告知 LLM：rebuild 前若掌握了重要、值得沉淀的认知，需修订宁静号 CCC 的现有 skill（eap 结构化）；若需新建 skill，则写入 SESSION 中供用户参考。**用户审核裁决**：只在 [TRAJECTORY] 提醒中写（不加 Session 块预声明/锚点/工具描述）；简短留自由度（不提"加载 eap 工具"——模型自知；只说修订 skill + 新建 skill 落 SESSION）；**新建 skill 一律不自行创建**（用户裁决）。

### 变更
- **keeper.ts `rebuildReminderText`**（仅此一处，普通 + 升级两版）：
  - **[TRAJECTORY] 普通版**：ACT NOW 前插入——`Before rebuilding: if this conversation produced valuable cognition, revise the relevant existing skill of this CCC (structure it with eap); if a new skill is warranted, write a short proposal into SESSION.md for the user to review — do not create it yourself.`
  - **[TRAJECTORY-ESCALATED] 升级版**：STOP 后插入紧凑句——`preserve valuable cognition into the CCC skills (or write a new-skill proposal into SESSION.md), then call the session_rebuild tool immediately.`（不拖慢强制 rebuild）
- **不引入新机制**：沉淀/提案均为 LLM 既有工具面（eap 工具 + read/write/edit + session 工具）——纯提示词引导，零代码面扩大

### 测试
- keeper.test +2 断言组：普通版（`revise the relevant existing skill of this CCC` / `write a short proposal into SESSION.md` / `do not create it yourself`）、升级版（`preserve valuable cognition` / `new-skill proposal into SESSION.md`）；rebuild.test F2 断言 +2（`revise the relevant existing skill` / `SESSION.md`）——**42 files / 476 tests 全绿**；typecheck ✓（node + client）→ build ✓（132990 B）

## v1.24.11 — 2026-08-28（session_rebuild 会话定位稳固化：重建后新会话准确知道从哪个 SESSION 恢复，S142 用户需求）

**Scope:** 用户反馈——session_rebuild 会话清空后继续，SESSION.md 的目录**偶尔拿不准**，要求稳固方案确保「继续的会话在开始准确知道从哪个 SESSION 恢复」。**根因三链**：① `queueRebuild` 的 fallback 是**未校验的虚假路径** `AGENT_SESSIONS/SESSION.md`（内存活跃会话缺失时必现）② 重建锚点的轨迹行 `- Persistent trajectory (SESSION.md, unmoved): <rel>` **不是恢复机制可解析的格式**（`parseSessionContextFromEvents` 只认 `SESSION.md path:`）→ 仅靠锚点的会话（从未显式 `session use`）无法从 events 恢复 ③ 恢复机制要求 `[SESSION CONTEXT]` 标记与路径同串且**无存在性校验** → 无 use 标记的历史无法恢复 + 陈旧标记可能恢复出已归档/错误目录。

### 变更（稳固化 4 件套）
- **① 锚点规范行**（rebuild.ts `buildRebuildAnchor`）：轨迹行改为 `- Persistent trajectory — SESSION.md path: <rel>`——与 `session use` 上下文**同格式**（`SESSION.md path:` 短语），恢复机制从 events 直接解析；路径独立成行（persistent-body 尾注换行），不污染路径捕获
- **② queueRebuild 多层解析 + 存在性校验**（rebuild.ts 新增 `resolveSessionMdPath(root, scope, session)`）：候选按序 ① 内存活跃会话（本会话显式 use 过）→ ② events 恢复（use 标记 + 重建锚点规范行，进程重启后）→ ③ surface 首条 user 消息锚点解析（`parseAnchorMdPath`，events 异常兜底）→ ④ AGENT_SESSIONS 约定回退（`findLatestActiveSessionMd`：最新未完成活动目录）；每候选 resolve 后 **existsSync 校验**（相对路径按 root 解析）；全部失败 → **抛错引导「Run session use <S###> first」**——**绝不输出虚假路径**；会话名从路径派生（`sessionNameFromMdPath`：S### 或 issue 目录名，单一真相源）
- **③ 恢复升级 path-only**（session-ops.ts `parseSessionContextFromEvents`）：从尾到头扫描 events，**最后一条 `SESSION.md path:` 行即可恢复，不再要求 `[SESSION CONTEXT]` 标记**（向后兼容）；目录名/ID 从路径本身派生（`basename(dirname())` + S### 正则，不猜）；兼容目录形态路径（旧写）并归一为文件路径（补 `/SESSION.md`）；新增 `extractSessionMdPathFromText`（剥同行已知尾注，如 Session 块 persistent-body 注释）与 `findLatestActiveSessionMd`（约定回退）
- **④ seed 处校验**（seams/context.ts）：重启恢复解析后 `resolve(root, rel)` 绝对化 + `existsSync` 验证通过才 `setActiveSessionInfo`——陈旧/已归档/不存在的标记不污染内存

### 测试
- rebuild.test +8：锚点规范行断言 / queueRebuild 约定回退解析（真实路径）/ 无上下文抛错引导（不写虚假路径）/ resolveSessionMdPath 多层 4 用例（内存优先 / 陈旧候选跳过→锚点命中 / 全缺 null）/ 夹具 mkActiveSession
- session-ops.test +4：path-only 恢复（锚点格式无标记）/ 旧 use 标记 + 新锚点最后胜出 / findLatestActiveSessionMd 2 用例（最新未完成胜出 / 全完成 null）；旧恢复测试对齐真实文件路径契约（`.../<session-dir>/SESSION.md`）
- **42 files / 476 tests 全绿**（+8）；typecheck ✓（node + client）→ build ✓（132990 B）

## v1.24.10 — 2026-08-28（Windows 兼容性补丁 8 文件全量合并 + 状态胶囊改版，S013 实机交付 + S142 用户设计稿）

**Scope:** 两项合并——① S013 会话（Windows 实机）交付的 **Windows 兼容性补丁**（9 源文件 8 类问题，`docs/overlay-on-1249-src.patch`，实机逐项复测验证：spawn EINVAL / 注册表保护绕过 / mv-cp 毁 CCC / 空格路径 / 大小写 / 反斜杠规则 / emoji 截断 / 穿越防御）；② 用户设计稿「胶囊改版」（对齐 OcgoDockEntry pill）——v1.24.x 状态卡片信息密度高、配色刺眼，重做为迷你胶囊。

### 变更（Windows 兼容性，8 文件）
- **msm-ops.ts**（🔴 核心：acc_msm Windows spawn EINVAL）——新增 `bunExecutablePath()`：win32 下探测真 bun.exe 绝对路径（`~\.bun\bin` / `%APPDATA%\npm\node_modules\bun\bin` / `%LOCALAPPDATA%\npm\...` 三候选带缓存）→ **零 shell 直跑真 bun（argv 保真）**；`runMsm` 同步分支 + `runMsmAsync` 异步分支统一 `baseOpts`，无 bun 回退走 `npx` **`shell: platform === 'win32'`**（`.cmd` 直 spawn 抛 EINVAL）；register/deregister `isV1Wrapped` **剥 BOM**（`\uFEFF` 防 Windows 编辑器，与 parseRegistry 一致）；check DC-M3 `registeredPaths` **norm 归一**（正斜杠 + 小写，win32 路径形式统一避免误报）
- **fs-ops.ts**（🔴 安全）——mech-registry 写保护修相对路径失效：`relCi`（win32 小写）+ `/(^|\/)(opencode|\.opencode)\/skills\//`（兼容带点/不带点 + 大小写变体，原 `includes('/.opencode/skills/')` 要求前导斜杠 → 相对路径永不命中）；**mv/cp 分支补 `assertNotProtected`**（原仅 rm 有——`cc_fs mv .serenity x` 单命令毁 CCC）；reveal 含 `[\s,]` 路径退化 `dirname`（explorer /select 按词拆分 Win 长期缺陷）；find glob win32 加 `'i'` flag（`*.PNG` 匹配 `assistant.png`）
- **ccc.ts**——matchBlacklist 反斜杠规则归一：`rule.pattern.split('\\').join('/')` 后再 startsWith（`\.secrets\` 死规则修复）
- **handyman-ops.ts**——sanitizeLabel **码点截断**（`[...str].slice(0,50).join('')`；原 slice(0,50) 切散 emoji 代理对 → 文件名 U+FFFD）
- **skills-discovery.ts**——新增 `isSafeSkillName()`（拒绝 `/`、`\`、`..`、`.` 路径段），findSkillMd 入口守卫（.serenity marker / entry-skill 指针名穿越）
- **seams/opencode-skills.ts**——`loadOpencodeSkill` 返回 null 空判 2 处（list `!skill ||` + get `if (!skill) return undefined`）
- **skills/opencode-scan.ts**——`loadOpencodeSkill` try/catch 读失败（EPERM/占用）返回 null，单目录容错
- **seams/system-prompt.ts**——`HIDDEN_LINES` **去 `g` flag**（`.test()` lastIndex 游移偶发漏滤）

### 变更（胶囊改版，SafeModePanel.tsx/.css）
- **胶囊形态**：全圆 `border-radius: 999px` + `padding 4px 9px`（无固定 height，内容撑高）+ 半透明 `--dsw-alias-bg-layer-2` 背景（对齐 Ocgo pill）
- **绿点**：7px 恒亮绿 `state-success-primary`（语义 = Serenity 在线，不随 SAFE 变）；未激活灰
- **信息层次**：`Serenity`（font-weight 500）+ `v1.24.10`（monospace，`translateY(1px)` 下沉对齐）+ 1px 分隔线（`--dsw-alias-label-tertiary`，两侧紧凑 margin 0 2px）
- **SAFE 状态**：盾牌 + SAFE 文字（11px，字距 0）用 **`--sp-safe-green` 统一绿家族**（`#0ba875` emerald-550 / deep `#059669`，`:root` 一处改全改）；ON = 盾牌 emerald + SAFE 文字 **emerald 渐变**（`background-clip: text` 质感）；OFF = 灰 `label-secondary`（低姿态提醒）
- **Mac 风格滑块**：轨道 24×13（ON 绿 / OFF 灰 `border-l2`）、thumb 11px 灰白 `#f2f4f6` **无图标**、`cubic-bezier(0.4,0,0.2,1)` 平滑位移（left 1px ↔ 12px）；**`.sp-switchOn:hover` 同特异性后定义补回**（S013 踩坑：hover (0,2,0) 覆盖 On (0,1,0) → 绿底消失）
- **官方 Modal → 自绘 popover**：340px 右上角卡片（`z-index: 2000`、深阴影 `0 12px 40px`、bg-module）、**外点 mousedown / Escape 关闭**、内部滚动（max-height calc(100vh-140px)）；同步移除 Modal import（防 ReferenceError）；弹层内容保留（运行环境 / 安全模式大开关 / Handyman 运行 / 配置提示）
- **import 清理**：移除 `Modal`（IconChevronDownOutline14 / IconWarningOutline16 保留仍用）；CSS 删除死代码 `.sp-modal`/`.sp-tabs*`

### 测试
- **+3**：opencode-scan（读失败返回 null）、handyman-ops（sanitizeLabel 码点截断：代理对不切散无 U+FFFD，`[...str]` 数码点断言）、skills-discovery（恶意 marker `../evil` + 反斜杠指针穿越被拒）——**42 files / 468 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 132990 B）

## v1.24.9 — 2026-08-27（CSRF 登录死循环根治：服务端 token 集合 + 失败页注入，S142 用户实测 debug）

**Scope:** v1.24.8 后仍失败——用户要求 debug。运行日志实证（dsh-crash-investigate logs）：`登录拒绝（CSRF 校验失败）：user=admin ip=192.168.1.232 cookieSecure=off cookieCsrf=present formCsrf=present`（×3）交替 `formCsrf=missing`（×3）。**根因双链闭合**：① 每次 GET 登录页生成新 token **覆盖 cookie**——多标签页/刷新后，早先打开的标签携带旧 form token 提交时与最新 cookie **不匹配**（present/present 死循环）；② 登录失败路径 `loginPageHtml(msg)` **不传 csrf** → 失败页无 csrf 字段 → 重试时 formCsrf=missing（恶性循环）。

### 变更
- **CSRF token 服务端集合**（gateway-auth.ts）：`newCsrfToken()` 生成的 token 存入内存集合（TTL 10min，上限 50 自动清理）；新增 `isCsrfValid(token)`——提交时 form/cookie token **只要 ∈ 集合即有效**（多标签各自 GET 生成的 token 都接受，不再因 cookie 被最新 GET 覆盖而拒绝旧标签提交）；安全不变（token 随机 256-bit + 集合短期有效，跨站无法猜测/读取）
- **失败路径注入新 csrf**（gateway.ts）：CSRF 失败（403）/ 锁定（429）/ 凭据失败（401）三处统一——生成新 token + Set-Cookie（form+cookie 同步）+ `loginPageHtml(msg, csrf)`——重试表单始终带 csrf 字段，消除 missing 恶性循环
- **测试 +1**：isCsrfValid（生成即有效 / 未知 token 无效 / 多标签各自 token 都有效——集合语义）——**42 files / 465 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 133133 B）

## v1.24.8 — 2026-08-27（登录 CSRF cookie 去 Secure 修复：明文 HTTP 外部访问登录失效，S142 用户实测）

**Scope:** 用户实测外部端口（3081）登录失败——"会话校验失败，请刷新页面重试 校验不通过，我扫的是对的"。定位：登录页注入的 **CSRF cookie 带 Secure 属性**（受 cookieSecure 配置控制）——用户开启 Secure Cookie 后，**明文 HTTP 下浏览器规范不发送 Secure cookie** → `serenity_csrf` cookie 永远缺失 → CSRF 双提交校验在验证码校验**之前**就失败（与验证码对错无关，用户误以为码错了）。

### 变更
- **CSRF cookie 独立于 cookieSecure**（gateway.ts 登录页注入）：`serenity_csrf` 去掉 Secure——CSRF token 是**短时随机会话防护**（HttpOnly + SameSite=Strict + 双提交已足够，泄露无认证价值），不应受传输加密开关影响；**只有登录成功的会话 token cookie 保留 cookieSecure 控制**（HTTPS 反代时仍 Secure）
- **诊断增强**：CSRF 失败日志带 `cookieSecure=on/off` + `cookieCsrf/formCsrf=missing|present`；失败页提示补充"若仍失败：设置面板关闭 Secure Cookie——明文 HTTP 下必须关闭"
- typecheck ✓（node + client）→ test ✓（42 files / 464 tests）→ build ✓（lib/client.js 133133 B）

## v1.24.7 — 2026-08-27（TOTP 绑定去确认码：生成即绑定，S142 用户反馈）

**Scope:** 用户反馈"绑定 admin 的验证器需输入 6 位确认码 这个是什么意思，讲道理生成密钥固定下来就行了"——确认码是防呆校验（防止保存一个用户没录进去的 secret），但二选一登录下冗余：没录的 secret 登录时 TOTP 方式自然不生效（密码仍可用）。**用户拍板：生成密钥固定下来就行**——去掉确认码。

### 变更
- **config-ops.ts**：删除 totpConfirm 校验（line 372-379）——设置新 secret 直接落库；保留 **base32 合法性轻校验**（base32Decode 包裹，非法 secret 拒绝——防粘贴垃圾/无效数据落库，不增加 UX 负担）
- **accounts-api.ts**：`AccountDraft` 删 `totpConfirm` 字段；`validateDraft` 删 pending 确认码要求（生成即绑定）
- **AccountsEditor.tsx**：绑定态 UI 删确认码输入框 → 提示"扫码或手动录入后，点「保存」即完成绑定"；startTotpBind/cancelTotpBind/markTotpClear 去 totpConfirm
- **AccountsEditor.css**：`.ae-totpConfirm` → `.ae-totpHint`（绑定提示样式）
- **测试更新**：accounts-api（pending 绑定无需确认码断言替换 3 个确认码断言）、config-ops（"totpSecret 非空 → 直接绑定" + "非法 base32 → 拒绝" 替换确认码测试）——**42 files / 464 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 133133 B）

## v1.24.6 — 2026-08-27（登录凭据二选一 + TOTP 二维码扫码绑定，S142 用户需求）

**Scope:** 用户两项需求——① "authenticator 安全性很好，能不能和用户账号密码搞成二选一"：登录凭据从双因素（密码 && TOTP）改为**二选一**（密码 或 6 位验证码，任一正确即登录）；② "配置 TOTP 的时候，可以随机生成渲染个二维码来绑定"：绑定流程从手动录入 secret 升级为**扫码绑定**（随机生成 secret → 渲染二维码 → Authenticator 扫码 → 输码确认）。

### 变更
- **登录二选一（gateway.ts）**：`passOk || totpOk` 替代 `passOk && totpOk`——密码校验不再前置；绑定验证器的账号可用**密码或验证码任一**登录（未绑定仅密码；totpEnabled 关闭时 TOTP 完全禁用）；登录日志记 `via=password|totp`；失败统一计账号锁定（防组合爆破）；防重放 counter 保留（30s 窗口同码拒绝）
- **登录页（gateway-auth.ts loginPageHtml）**：密码框去掉 `required`（二选一场景可只输验证码）；label "密码（或下方验证码，二选一）"；hint "已绑定验证器的账号：密码 或 6 位验证码任一即可登录"
- **二维码扫码绑定**：`qrcode-generator`（MIT 零依赖）经 tsdown noExternal **内联进 client bundle**（零运行时新依赖）；`totpQrSvg(secret, label)`（typeNumber 0 自动 + 纠错 M + scalable SVG）→ AccountsEditor 绑定态显示二维码（白底 132px）+ secret 文本兜底手动录入 + otpauth:// 链接 + 确认码（既有 totpConfirm 机制不变）
- **开发通道扩展**：dsh-develop 新增 `npm-install-dev <pkg...>` 子命令（pnpm install --save-dev + store-dir 对齐既有 .pnpm-store；package.json `pnpm.onlyBuiltDependencies: ["esbuild"]` 解决 pnpm 10 build-script 审批 exit 1）——devDeps 记录 qrcode-generator 2.0.4 可复现
- **文案同步**：AccountsEditor「启用 Authenticator 登录（二选一：密码 或 6 位验证码任一登录）」
- **测试 +3**：totpQrSvg（合法 SVG / 同 secret 可复现 / 异 secret 不同）——**42 files / 466 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 133484 B，+qrcode-generator 内联）

## v1.24.5 — 2026-08-27（方案 O 细节校准：滑块 thumb 恒白 + 盾牌恢复描边，S142 用户反馈"细微差距"）

**Scope:** 用户实测截图对比设计稿——两处细微差距：① 滑块 thumb 用了 `--dsw-alias-bg-module`（暗色下深色底），设计稿字面是**纯白圆**（`#fff`，暗色下也白，与彩色轨道对比——标准开关视觉）；② ON 盾牌我加了绿色 fill（18%→30%），呈"实心色块与 SAFE 文字融为一体"，而设计稿 SVG 是 `fill="none"` 纯描边盾（琥珀空心/绿描边同构，颜色表达状态）。

### 变更
- `.sp-switchThumb` 背景 `--dsw-alias-bg-module` → **`#fff` 恒白**（设计稿字面；thumb 内 ✗/✓ icon 仍琥珀/绿 currentColor）
- `.sp-cardProtected .sp-shield path:first-child` **删除 fill**（恢复纯描边盾——设计稿 SVG fill=none 一致；ON/OFF 仅 stroke 颜色差异：琥珀=提醒 / 绿=安心）
- typecheck ✓ → build ✓（lib/client.js 83141 B）；test 不变（463）

## v1.24.4 — 2026-08-27（滑块快速开关：方案 O 滑块变体落地，S142 用户要求"抄到位"）

**Scope:** 用户要求把方案 O 设计稿的**滑块变体**也实现——"滑块快速开关也实现下吧，抄到位！"。设计语义：SAFE 文字保留 + 滑块（无 ON/OFF 文字）——**滑块左 = OFF（琥珀 ✗，写工具全开）/ 右 = ON（绿 ✓，写工具隐藏）**，开关隐喻直接表达开关状态，**头部卡片内快速切换**（不必打开弹层）。

### 变更
- **头部卡片滑块**（SafeModePanel.tsx）：`[绿点] Serenity [v1.24.x] [分隔线] [盾牌] SAFE [滑块] [chevron]`——status-word 从 "SAFE ON/OFF" 收敛为 **"SAFE"**（滑块表达开/关）；滑块 `role="switch"` + `aria-checked` + 状态类（sp-switchOn/Off）
- **快速切换交互**：滑块 `onClick` **stopPropagation**（不触发卡片开 Modal）→ 直接调 `toggle(!safeModeOn)`（同弹层大开关的 POST /serenity/status 通道）；busy 期间禁用（sp-switchBusy）；滑块点击后 `refresh()` 状态同步（盾牌/滑块颜色即时翻转）
- **CSS（设计稿移植）**：`.sp-switch` 30×17 圆角胶囊（OFF = warning 28% + border-l2 混合 / ON = success 40%）；`.sp-switchThumb` 13×13 白底圆（`--dsw-alias-bg-module` 明暗自适应）阴影 + left 过渡 0.2s（2px ↔ 15px）；thumb 内嵌 8×8 ✗/✓ icon（SWITCH_OFF_ICON / SWITCH_ON_ICON，琥珀/绿 currentColor）
- 交互分工：**滑块 = 快速开关**（高频）；**卡片其余区域点击 = 打开 Modal**（查看 CCC/handyman 详情 + 弹层大开关）
- typecheck ✓（node + client）→ build ✓（lib/client.js 83098 B）；test 不变（463）

## v1.24.3 — 2026-08-27（暗色主题版本号对比度修复，S142 用户反馈）

**Scope:** 用户实测反馈——方案 O 盾牌版在黑色背景下"版本号的字看不清"。根因：`.sp-ver` 用 `--dsw-alias-label-dimmed`（暗色 #71717a，on #18181b 对比度不足）。

### 变更
- `.sp-ver` 颜色 `label-dimmed` → `label-secondary`（暗色 #a1a1aa，对比度提升一级；亮色 #4b5563 同步可读）
- typecheck ✓ → build ✓（lib/client.js 80179 B）；test 不变（463）

## v1.24.2 — 2026-08-27（状态卡片方案 O 盾牌版：绿点=激活恒绿 + 盾牌=SAFE 状态，S142 用户设计）

**Scope:** 用户提供外部设计稿「方案 O 盾牌版」（HTML + 暗色截图，经文件/图片粘贴自动落盘链路传入）——"有人提供了更好的设计，抄走"。设计语义：**前面的绿点 = Serenity 生效（恒绿）**，**后面的盾牌 = SAFE 状态**（琥珀空心盾 = SAFE OFF 未保护提醒 / 绿实心盾 = SAFE ON 保护中安心）。取代 v1.23.6~1.23.8 的 safe tag 方案（tag 的红=错误语义不适合 OFF——OFF 是用户自己的开关选择，琥珀=提醒更准确）。

### 变更
- **头部卡片重构（方案 O）**：`[绿点] Serenity [v1.24.x（code font）] [竖分隔线] [盾牌] SAFE OFF/ON [chevron]`——布局对齐设计稿（height 30px / padding 0 8px 0 14px / gap 8px）
- **状态语义分离**：`.sp-dot` 只表激活（绿=在 CCC 内恒绿 / 灰=未激活）；SAFE 状态由 **盾牌 SVG + status-word** 承担——`sp-cardUnprotected`（琥珀 warning：提醒非错误）/ `sp-cardProtected`（绿 success：实心 fill color-mix 18%）/ `sp-cardInactive`（降透明度）
- **删除 v1.23.8 的 safe tag**（`.sp-tag*` 红底标签 + 实心红底 CSS）；弹层大开关（`.sp-toggle*` 红色 ON）保留
- 交互不变：卡片点击 → 官方 Modal（弹层安全模式大开关）；title 文案对齐新语义（SAFE ON — 写工具已隐藏 / SAFE OFF — 写工具全开，无保护）
- 设计稿备份：`docs/status-card-scheme-O-shield.html`（用户原始 HTML 落盘存档，含滑块变体参考）
- typecheck ✓（node + client）→ test ✓（42 files / 463 tests 不变）→ build ✓（lib/client.js 80176 B）

## v1.24.1 — 2026-08-27（任意文件粘贴自动落盘 _tmp/files_from_user/，S142 用户需求）

**Scope:** 用户需求——"粘贴文件（非图片格式）自动也放 _tmp 去"。调研确认 DSH 输入框只认图片（`InputBar.onPaste` 把所有文件交给 `intakeImages` → 非图片被 `addImages` 拒绝 toast+丢弃，无 rail 无发送通道）→ 任意文件必须**主动拦截 paste + 落盘**。用户拍板：① 提示方式 = **draft 追加**（不自动发送，随用户消息进对话）；② 单文件上限 = **10MB**（与图片一致）；③ 版本号放缓（归 v1.24.1，不升 minor）。

### 变更
- **node half `/serenity/file-upload`**（api.ts）：`saveFileToTmp` 核心（可测）——文件名校验 + **可执行扩展名拒绝**（`BLOCKED_FILE_EXTS`：exe/dll/msi/bat/cmd/ps1/com/scr/lnk/sh/vbs/bin/app/deb/rpm/jar——安全边界，agent 不被诱导执行）+ base64 解码 + **10MB 上限** → 写 `_tmp/files_from_user/<ts>-<rand>-<safeName>`（与 `images_from_user` 并列）；`sanitizeFileName`（路径成分剥离/去前导点/非法字符替换/限长 100）；handler：POST + x-serenity-ui 头 + readBody 20MB + 按会话 cwd 解析 CCC 根
- **client half `FileFallbackDock`**（input.dock 槽，静默无 UI）：document 级 **capture 阶段 paste 监听**（先于 DSH textarea onPaste）——剪贴板含非图片文件时：① 纯文件粘贴（无图片无文本）→ preventDefault（阻止 DSH toast 拒绝）；混合粘贴（含图片/文本）→ 不拦截（图片正常进 rail / 文本正常插入，文件异步处理）② 逐个上传 ③ 成功 → **draft 末尾追加** `The user provided a file (path: ...)`（多文件每行；draft 快照 ref 防异步期间打字覆盖 + 连续粘贴串行队列）
- **`file-fallback-api.ts`**（client）：`collectNonImageFiles`（items 注入纯函数，可单测——图片留给 DSH）、`fileNoteTemplate`（单/多文件路径模板，模型可见英文对齐 v1.20.6 图片教训）、`uploadFile`
- **client/index.ts**：注册 `serenity-file-fallback` dock 条目（order 110，与图片兜底 order 100 并列）
- **测试 +14**：api-file-upload.test.ts（sanitizeFileName 3 + saveFileToTmp 6：合法 pdf/路径剥离/可执行拒绝/缺失拒绝/超限/唯一性）、file-fallback.test.ts（collectNonImageFiles 3 + fileNoteTemplate 2）——**42 files / 463 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 78259 B）

## v1.24.0 — 2026-08-27（loop（牛马）→ handyman（杂工）重构，S142 用户拍板）

**Scope:** 用户对 loop 工具的四点重设计——① jobs 并行上限 10（便宜模型便宜）；② worker 工具面不含 handyman（编排归主 agent，递归只走 subagent）；③ 不兼容旧 loop 进度文件（仅 handyman- 前缀）；④ handyman.models 未配置 → 报错要求配置。语义对齐 osp loop：同步（非异步）+ 指定白名单模型 + 自主循环到完成（stop-token 唯一完成判据）+ 内部递归同样低能 subagent（DSH 原生模型继承）+ workflow jobs 编排能力。方案文档 `docs/handyman-design.md`（用户确认后落盘）。

### 变更
- **工具改名 `loop` → `handyman`（全新身份，非 alias）**：`src/tools/handyman.ts`（createHandymanTool：task/label/session/model/jobs/guide；白名单校验 `requireWhitelistedModel`；jobs 编排 Promise.all 并行 ≤ maxParallel；同步阻塞；worker session `handyman-<label>-<uuid>`；HANDYMAN_MAX_ROUNDS/RESTARTS=100）；`src/index.ts` `createLoopTool` → `createHandymanTool`；`src/invariant.ts` REGISTERED_TOOLS `loop` → `handyman`；`src/seams/system-prompt.ts` 工具清单行同步
- **纯逻辑层改名**：`loop-ops.ts` → `handyman-ops.ts`（进度文件 `handyman-<label>.md/.json`；stop token `SERENITY_HANDYMAN_DONE_`；`HANDYMAN_GUIDE` 含白名单/递归/jobs 并行/不兼容说明；`listActiveHandymen()` 扫 handyman-*.json）；`loop-preset-inherit.ts` → `handyman-preset-inherit.ts`（**工具面收窄**：setup 钩子 composeFrom 后 `tools.restrict({ deny: ['handyman'] })`——worker 看不到 handyman，防无限嵌套）
- **配置不兼容（用户拍板）**：`SerenityConfig.loop.defaultModel` → `handyman.{models, defaultModel, maxRounds, maxParallel}`；`readHandymanConfig()` models 未配返回 null（工具报错要求配置）；defaultModel 缺省 models[0]；maxRounds 缺省 100；maxParallel 缺省 10
- **拦截缝同步**：`seams/context.ts` shouldAutoRestore `loop-` 前缀 → `handyman-`；ACC 注入 `loop default model` → `handyman default model`（读 readHandymanConfig）；`seams/bootstrap.ts` `loop-` 恒 promoted/免锚定 2 处 → `handyman-`
- **API/UI 同步**：`/serenity/loops` → `/serenity/handymen`（LOOPS_PATH → HANDYMEN_PATH；`{handymen: listActiveHandymen(root)}`）；status `loopModel` 字段 → `handymanModel`（读 readHandymanConfig 默认值）；SafeModePanel.tsx/.css 全量改名（LoopRunInfo→HandymanRunInfo、runningLoops→runningHandymen、CSS 类 .sp-loops*→.sp-handymen*、「Loop 运行」→「Handyman 运行」）；ccc-config 参考/工具描述/localstore 示例 loop.defaultModel → handyman.models
- **旧文件删除**：`src/tools/loop.ts` / `src/loop-ops.ts` / `src/loop-preset-inherit.ts`；测试 `loop-ops.test.ts` → `handyman-ops.test.ts`（+白名单 requireWhitelistedModel 测试 + 旧 loop- 进度文件不列入断言）、`loop-preset.test.ts` → `handyman-preset.test.ts`（deny handyman 四路径断言）；context/ccc/status/invariant/register/system-prompt/osp-alignment/bootstrap/localstore 8 文件 loop 断言 → handyman
- **typecheck 修复**：jobs 参数 schema `required`/`additionalProperties` 与 ObjectValueSchemaSpec 契约对齐（items 内不支持 required → 运行时 `parseJobs` 校验）；args.jobs/args.session 类型收窄；jobs 结果 `as unknown as JsonValue`
- **README.md/.en.md/CHANGELOG**：工具表 loop → handyman（含 jobs 编排/白名单说明）、配置表 handyman.models、状态卡 handyman 模型；hooks 子包 README 同步
- typecheck ✓（node + client）→ test ✓（40 files / 449 tests，+3）→ build ✓（lib/client.js 72971 B）

## v1.23.8 — 2026-08-27（safe tag 实心化：红底白字大写 SAFE，无 icon，S142 用户反馈）

**Scope:** 用户反馈 v1.23.7 仍不满意——"换成实心 tag，不要 icon 试试看，大写 SAFE"。

### 变更
- **SafeModePanel 头部 safe tag 实心化**：`.sp-tagOn` 从透明红混底改为**实心红底**（`--dsw-alias-state-error-primary`）+ 反色文字（`--dsw-alias-label-primary-foreground`，实心底先例 ConnectionBanner 同款 token）——大写 **SAFE** / **OFF**（`text-transform: uppercase`，字重 700，letter-spacing 0.04em）；**移除 icon**（`.sp-tagIcon` 删）；OFF 灰底实心化（`--dsw-alias-label-secondary`）
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 72803 B）

## v1.23.7 — 2026-08-27（safe tag 红色化，S142 用户反馈）

**Scope:** 用户反馈 v1.23.6 的橙色 tag 太丑——"safe 标亮起来用红色"。

### 变更
- **safe 状态语义色 warning（橙）→ error（红）**：`.sp-tagOn`（头部卡片 safe tag）与 `.sp-toggleOn`（弹层安全模式开关）统一改用 `--dsw-alias-state-error-primary`（明暗主题自适应，红 600/400）——背景 16%/14% 透明混合 + 边框 45%——"safe = 警惕/危险"的红色语义，不再橙色
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 73039 B）

## v1.23.6 — 2026-08-27（safe 状态 tag 化：从外面一眼可见，非胶囊嵌套，S142 用户反馈）

**Scope:** 用户反馈 v1.23.5 的点颜色编码不够直观——"安全模式做成 tag 吧，从外面看方便知道，不像之前那么丑就行"。

### 变更
- **SafeModePanel 头部卡片 safe tag**：恢复卡片内 safe 状态标签，但**方形小标签**（border-radius 4px，非胶囊 9px——避免"胶囊套胶囊"）——ON=橙底 `safe`（含警告图标）/ OFF=灰底 `off`；绿点回归纯 CCC 活跃语义（on/off 由 tag 承担）；hover title 保留 safe-mode 说明
- CSS：`.sp-sm*` 胶囊样式 → `.sp-tag*` 方形标签（`sp-tagOn`/`sp-tagOff`/`sp-tagIcon`）；移除 `.sp-dotWarn`（点不再编码 safe）
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 73001 B）

## v1.23.5 — 2026-08-27（双修复：rebuild shadow-price 协议合规 + 状态卡去嵌套，S142 用户反馈）

**Scope:** 用户两反馈——① 问询 rebuild 后上下文少了但历史保留、担心 dsh 会话爆炸（实测 UI 计量矛盾：总用量 15% 但「对话消息」~1M）；② 头部状态卡「胶囊套胶囊」不好看。双根因均实证修复。

### 变更
- **rebuild shadow-price 协议合规（根因实证）**：`performRebuild` 此前**裸 surface replace**——DSH token-meter 的 `foldSurfaceProjection` 对 `replace` 要求**紧邻其前的 metering 事件**（`compaction/summary` 或 `compaction/prune`）声明被替换范围 token 价；claim 缺失 → `deltaTokens=0` → `contextBreakdown.messageTokens` **永不扣减** → UI「对话消息」虚高累计（截图实证：总 15% 但对话消息 ~1M——两个计量源矛盾）。**修复**：replace 前先 `session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })`——定价 = 逐被替换节点 `ctx.tokenMeter.estimateMessage(deriveEventMessage(event))` 累加（官方先例 `compaction-tool-result-pruner` 同款协议）；tokenMeter 经 `ctx.get('tokenMeter')` 动态取（可选，缺失退化无 claim 仅计量漂移，会话功能不受影响）。测试 +1（带 meter → 先 prune 定价 shadowedRange/Seqs/TokenCount + 后 replace 紧邻）——**40 files / 446 tests 全绿**。设计答复：log append-only 是 DSH 持久性契约（surface=模型投影 / log=不可变审计源，surface.ts:44-47 权威注释），上下文复位与磁盘增长一体两面；修复后 UI 计量正确回落，磁盘增长缓解（chunk 打包 ~56× + zstd），列表不随单会话大小退化
- **状态卡去嵌套（UI 反馈）**：头部卡片移除内部橙色 `safe` 胶囊（胶囊套胶囊）——safe 状态**分离**为状态点颜色编码：非 CCC=灰 / CCC+safe off=绿 / CCC+safe on=琥珀（`sp-dotWarn` + 光晕）；hover title 含 safe-mode 状态；弹层「安全模式」分组保留（唯一可操作项）。CSS 删 `.sp-sm*`（-2KB bundle）
- typecheck ✓（node + client）→ build ✓（lib/client.js 72053 B）

## v1.23.4 — 2026-08-27（TRAJECTORY-REBUILD 锚点 SESSION 定位修复：完整目录名 + 含空格路径解析，S142 用户反馈）

**Scope:** 用户实测反馈——rebuild 锚点"没写 SESSION 完整名称，导致定位困难"。实测锚点显示 `Persistent trajectory: AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin`（截断），而真实目录为 `…--S142--dsh-serenity-plugin 长期维护/`（含空格后缀）。根因 + 双修复。

### 变更
- **根因（events 恢复截断）**：`session-ops.ts` `parseSessionContextFromEvents` 用 `/SESSION\.md path:\s*(\S+)/` 提取 mdPath——`\S+` 遇空格即停，会话目录名含空格（如" 长期维护"）时解析出**残缺路径**（丢目录后缀 + 丢 `SESSION.md` 文件名）。修复：正则改为 `/SESSION\.md path:\s*([^\r\n]+)/`（匹配整行，路径可含空格）+ 结果 `.trim()` 防尾部空白；`sessionBlock`/`resolveActiveSessionInfo` 同源自动受益
- **锚点补完整目录名（用户需求）**：`buildRebuildAnchor` 新增 `- Serenity session: {sessionId} ({完整目录名})` 行（目录名 = SESSION.md 父目录 basename，从 mdPath 推导，可含空格）——重建后 agent 一眼定位 SESSION，不再靠残缺路径猜；无激活会话（fallback `AGENT_SESSIONS/SESSION.md`）时该行省略
- 测试 +2：session-ops 含空格目录名 mdPath 完整解析回归（`…--S142--dsh-serenity-plugin 长期维护` → mdPath 完整 + dirName 完整 + sessionId=S142）；rebuild 锚点含空格场景（完整目录名行 + 完整相对路径断言）——**40 files / 445 tests 全绿**
- typecheck ✓（node + client）

## v1.23.3 — 2026-08-27（重建提醒修复：行动指令化 + 不做节流 + 升级催促，S142 用户反馈）

**Scope:** 用户反馈"[TRAJECTORY] 一直在触发，为啥没执行 rebuild，这个词是不是有问题"——机制语义澄清 + 三处修正：① 旧文案是**状态播报式**（"[TRAJECTORY] Context usage at N%..."）模型当成系统状态而非行动请求可一直忽略；② 无节流每轮刷屏（用户阈值 0.4，44% 就每轮刷）；③ 用户拍板：**不做节流，催就行了** + **不向 LLM 植入阈值建议**（设定是用户自由）。

### 变更
- **rebuildReminderText 行动指令化（v1.23.3）**：新签名 `(ratio, threshold, escalated)`——普通语气 = **ACT NOW 行动指令**（"at the next natural pause call session_rebuild... Do not ignore this; rebuild is the expected action, not an option"），对齐 steward ACK 协议风格（模型知道该做什么、何时做、必须做）；**升级语气** `[TRAJECTORY-ESCALATED]`（连续 3 轮超阈值未 rebuild → "STOP and call session_rebuild immediately... persists until you call session_rebuild"）
- **不做节流（用户拍板）**：删除冷却机制——**每次超阈值都注入**（每轮都催，直到 rebuild 后压力自然回落）；保留**升级状态机**（per-session consecutive 累计，≥3 → 升级强制语气，此后持续升级催不重置）
- **不向 LLM 植入阈值建议（用户拍板）**：文案不含"0.75~0.9 是好主意"类引导——阈值设定是用户自由，提示只陈述当前占用与阈值
- **语义澄清（用户疑问）**：`[TRAJECTORY]` 是**提示**不是**执行**（v1.22.1 设计：不自动执行防误清空）——执行需要 agent 收到提示后主动调用 session_rebuild；新文案明确 "rebuild is the expected action" 消除歧义
- 测试 +3：行动文案断言（ACT NOW/not an option/不含阈值建议）/ 升级文案断言（mandatory/STOP/persists until）/ 升级状态机集成（每次注入 + 第 3 轮升级 + 升级后持续催不重置，rebuildReminderStateSnapshot 可见）——**40 files / 443 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 72871 B）

## v1.23.2 — 2026-08-27（双修复：F3 会话命名 this 绑定 + 配置面板 CSS 唯一 marker，S142 用户反馈）

**Scope:** 用户两反馈——① 会话命名"还是不生效"；② 配置面板排版"像网页丢失资源"。双根因均实证修复。

### 变更
- **F3 会话命名修复（this 绑定，日志实证）**：根因 = 调用点 `const rename = titles.rename` **解构裸函数**后传入，`renameDshSessionOnUse` 内部 `rename(session,title)` 调用时 `this=undefined` → DSH 服务方法内部读 `this.assertServiceActive` 抛错（日志：`Cannot read properties of undefined (reading 'assertServiceActive')`；与 v1.20.2/1.20.3 图片落盘同款"解构丢 this"bug 第三次出现）。修复：第三参从裸函数改为**整个 sessionTitle 服务对象**，内部 `titles.rename(session,title)` **方法调用**（this=titles 服务实例）；调用点同步（传 titles 对象 + 服务缺失/无 rename 方法均有明确 reason）；测试 +2（this 绑定回归：方法内部读 this 服务态成功 / 服务无 rename 方法 reason）
- **配置面板 CSS 修复（唯一 marker，bundle 实证）**：根因 = tsdown CSS 内联插件所有 CSS 共用**同一幂等 marker** `style[data-sp-css]`——第一个 CSS（SafeModePanel）注入后创建该 style，后续 3 个（SettingsSection/AccountsEditor/PersonaEditor）的幂等判断 querySelector 非 null → **全部跳过注入** → 面板只剩一个 CSS 生效（"网页丢失资源"外观）。修复：按文件名生成**唯一 marker** `style[data-sp-css="<basename>"]`，每个 CSS 独立注入（bundle 验证 4 个 marker 各自存在）
- 测试：40 files / **440 tests 全绿**（+2）→ typecheck ✓（node + client）→ build ✓（lib/client.js 72871 B，4 独立 CSS marker 验证）

## v1.23.1 — 2026-08-27（彩蛋功能：persona 模式——替换输出约束/指令遵循约束，S142 用户需求）

**Scope:** 用户需求——用户常想改变 agent 的输出风格和指令遵循风格（如社区流行的「大肥鱼」模式）；为让用户开心且不影响正常工作，做彩蛋功能：在插件设定中可替换 ACC 系统提示词中**输出约束/指令遵循约束**部分（EAP 块 + MSM 原则段），配置后用户文本替代原本；未配置 → 完全默认行为，零影响。

### 变更
- **config-ops.ts**：新增 `PersonaSettings { mode, overrideText }`（plugin 全局文件 `~/.dsh/serenity-hooks.json`，v1.22 归属原则）——默认 mode=''（彩蛋关闭）；mergeWithDefaults/updateAdvancedSettings/toWire/applyWirePatch 全链路支持（部分 patch 语义：persona 未传保留现有）
- **system-prompt.ts**：
  - `personaBlock(mode, overrideText)`：mode 空/文本空 → 空串（装配回退默认）；否则 `=== Serenity Persona ===` 块（独立标记头，幂等检测兼容）
  - `principlesBlock(root, omitMsmPrinciples)`：persona 生效时剥离 MSM 原则段（指令遵循约束被 persona 承接）；本体论/关系段/操作边界（安全硬约束）永远保留
  - `serenitySystemPrompt` 装配：persona 生效 → EAP 块替换为 Persona 块（原位 CCE 之后）；未配置 → 与 v1.23.0 逐字节一致
- **api.ts**：/serenity/config 通用 applyWirePatch 自动支持 persona（GET wire 含 persona / PUT patch），零改动
- **client**：`PersonaEditor.tsx/.css`（新）——DSH 设置面板「彩蛋模式」区块：模式名输入 + 替换文本 textarea + 「填充大肥鱼 demo」/「清空」/「保存」（PUT /serenity/config → 热生效，新会话即时）；`SettingsSection.tsx` 挂载区块；`accounts-api.ts` WireConfig 补 persona + saveConfig 支持 persona patch
- **demo**：内置 `BIG_FAT_FISH_DEMO`（DeepSeek 社区娘化人格：大肥鱼/鲸鱼娘——输出风格鱼化但保留 EAP 精神 + 指令遵循风格诚实精确、容器规则神圣）
- **测试 +9**：config-ops persona（默认关闭/设置持久化/清空/部分 patch/merge 默认）+ system-prompt（personaBlock 门控/未配置逐字节一致/配置替换+安全边界保留/装配位置/principlesBlock 剥离纯函数）——**40 files / 438 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/index.js + lib/client.js 72745 B）

## v1.23.0 — 2026-08-27（提示词全英化 + Trajectory Steward 定名 + Session=载体定义，S142）

**Scope:** specs v1.3.1 定义升级（用户拍板）——**Session = Trajectory 的可重建载体**（同义视角：宁静号 session 与 trajectory 指同一认知存在的两个面；载体视角：SESSION.md 是轨迹持久身体原位不动，工作会话是可丢弃重建的运行副本）。dsp 所有提示词全英化 + 维护机制定名 **Trajectory Steward**（用户从 Keeper/Warden/Curator/Custodian 中选定 Steward）。

### 变更
- **概念定义（Session = Trajectory 载体）**：
  - Session 块：`Active session: {id} — {dir} (this session is the rebuildable carrier of the trajectory)` + `SESSION.md path: {path} (the trajectory's persistent body — stays in place through rebuilds)`
  - Principles 块新增 **The session-trajectory relation** 段（本体论后：identity belongs to the trajectory, not to any session）
  - Metaphor 第 7 条载体化：`SESSION.md is the trajectory's logbook — the persistent body of the voyage; sessions are rebuildable carriers of the trajectory. Discard the carrier, keep the logbook.`
  - rebuild 锚点/steer/工具描述：`[TRAJECTORY-REBUILD] ... (Ship of Theseus: the carrier is replaced, the trajectory continues)` / `Continue the work of {SESSION name}` / `Persistent trajectory (SESSION.md, unmoved)`
  - keeper rebuildReminderText：`This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy`
- **机制定名 Trajectory Steward（用户拍板）**：计分提醒前缀 `[SESSION-KEEPER]` → **`[TRAJECTORY-STEWARD]`**，ACK 码 `[TRAJECTORY-STEWARD-recorded-{code}]` / `[TRAJECTORY-STEWARD-skipped-{code}]`；内部标识（registerKeeper/KeeperTracker）保留；`[TRAJECTORY]` 重建提示前缀保持（v1.22.1 已拍板）；改名兼容：ACK 码单次使用不跨会话，旧前缀零影响
- **机制预声明（specs §5.10 要求，用户指出缺口）**：Session 块新增 TRAJECTORY-STEWARD 预声明段——模型预先知道存在计分督促机制 + ACK 码协议（write/edit=3, task=10, read/grep/glob/msm=1, +1/min），机制先于提醒
- **提示词全英化（模型可见文本，7 处 + 工具面）**：
  - system-prompt.ts：EAP 块英化（E↑ Explicit / R↓ Reconstructable / S↑ Stable）、ACC 块工具清单行英化（11 工具含 session_rebuild/localstore）、ℹ️ 路径提示行英化、Code Mode 适配行英化
  - keeper.ts rebuildReminderText 英化；context.ts `[ACC]` 注入英化；env.ts DSH_SERENITY_* description 英化
  - rebuild.ts / tools/rebuild.ts 锚点/steer/instruction/错误消息英化
  - 11 工具 description + 参数 description（53 处）英化；eap/neat/cce 工具内容全文英化（EAP_CONTENT/NEAT_CONTENT/CCE_CONTENT + section 切分锚点同步英文）
  - 错误消息英化：guards deny（bash/path escape/governance/blacklist）、fs-ops/msm-ops/localstore-ops/git-ops/kit-ops/config-ops/session/loop 全部 throw、git REJECTED 建议文本、loop-ops buildRoundPrompt/LOOP_GUIDE、session SEP hook-guide、skills-discovery 截断提示、imageNoteTemplate（对话消息）
- **保留不动（向前兼容）**：SESSION.md 模板与中文章节名（qa/keeper 按中文章节解析）、mech-registry 描述（CCC 内容）、SKILL.md 全文、人类 UI（登录页/设置面板/状态卡/console 日志）、client 校验消息
- **测试同步**：osp-alignment（Session 块新结构/Principles 关系段/accBlock 11 工具）、keeper/gate（steward 前缀）、rebuild（英文锚点）、context（[ACC] 英文）、system-prompt（EAP 英文）、acc-extras（EAP/NEAT/CCE 内容）、guards/skills-discovery/loop-ops/config-ops/ops/fs-ops 断言——**40 files / 429 tests 全绿**
- **specs 同步**：serenity-acc-specs v1.3.1 已先行发布（§0.3.1 Session 载体定义 / §2 术语表 / I6 扩展 / §5.2 Metaphor 第 7 条 / §5.10 trajectory-steward + 预声明要求 / §5.8 Session 块）
- typecheck ✓（node + client）→ test ✓（429）→ build ✓（lib/index.js + lib/client.js 64053 B）

## v1.22.9 — 2026-08-27（F3 会话命名修复：可观测性 + S###-日期格式 + 测试真实链路，S142）

**Scope:** 用户实测"use 后名字没改" + 确认"use 交给 LLM 是核心设计"。诊断结论：rename 链路被静默吞错（无日志）、测试测假路径（mock sessionTitleAvailable=true）、命名格式不符需求（dirName 超长 + 中文 vs 用户拍板 S###-日期）。

### 变更
- **可观测性（不再静默）**：`tools/session.ts` use 分支——rename 成功 `console.log`（dsh 会话 id → 标题）、失败 `console.warn`（明确原因：naming 关/服务不可用/rename 抛错）、异常 `console.warn`——下次实测若仍不生效，日志直接定位断点
- **命名格式修正（S###-日期）**：新增 `namingTitleFor(active)` 纯函数——`S143` → `S143-2026-08-26`（从 sessionId + dirName 日期前缀派生，用户拍板格式）；issue 会话（无 S###）→ 回退目录名；无日期前缀 → 回退 sessionId
- **renameDshSessionOnUse 返回结果对象**（`{ok:true,title} | {ok:false,reason}` 而非 null 歧义）——门控失败/rename 抛错均有明确 reason，不再"失败=null"无法区分原因
- **测试真实链路**：session-title.test.ts 重写 +4——namingTitleFor 三种格式断言 / rename 成功断言标题为 S###-日期 / 门控失败断言 reason / rename 抛错断言 reason 捕获（不传播）；**429 tests 全绿**
- **peerDependencies 补 `@deepseek-ai/dsh-session-title`**（F3 调研"唯一小改动"——tsconfig paths 早有引用，peerDeps 此前缺失）
- typecheck ✓（node + client）

## v1.22.8 — 2026-08-27（熵点治理：gateway.ts 拆分三模块，S142）

**Scope:** 代码整体梳理（codebase-overview-v1.22）发现的熵点治理——gateway.ts 894 行单文件混三类职责，拆分为认证域/代理域/装配层三个模块（行为零变更）。

### 变更
- **`src/gateway-auth.ts`（新，认证域纯逻辑）**：`verifyGatewayLogin` / 会话（`SESSION_TTL_MS`/`issueToken`/`revokeToken`/`validateToken`）/ 失败锁定（`FAIL_LOCK_*`/`getFailState`/`resetFailState`/`isAccountLocked`/`recordLoginFailure`/`accountLockRemaining`）/ CSRF（`newCsrfToken`/`csrfFromRequest`/`safeEqual`/`originAllowed`）/ `cookieValue` / `loginPageHtml`
- **`src/gateway-proxy.ts`（新，代理辅助纯逻辑）**：`RANDOM_UUID_POLYFILL`/`injectPolyfillHtml`/`buildProxyHeaders`/`filterWorkspaceList`/`workspaceAllowed`/`workspaceDenyResponse`
- **`src/gateway.ts`（装配层，894→~620 行）**：只保留 HTTP 装配（`startGateway`/`registerGateway`/`readBody`）；从两新模块 import 并 **re-export 全部导出**（既有 import 面兼容——`tests/gateway.test.ts` 直接 import gateway.js 的 20+ 导出无需改动）；v1.22.3 回归测试的源码锚点（`const proxy =`/`server.on('upgrade'`/`'/serenity/login'`/`clientError`）全部保留原位
- 测试：40 files / 425 tests（**零改动全绿**——纯逻辑原样搬移 + re-export 兼容）→ typecheck ✓（node + client）

### 后续熵点（本次不动，理由见 codebase-overview §7）
- `session-ops.ts`（30KB）/ `msm-ops.ts`（24KB）：单一领域内聚实现，拆分收益低
- `system-prompt.ts`（26KB）：8 块 spec 文本 + 注册，osp-alignment.test.ts 契约绑定，不宜拆
- `.restrict-diag.json` 跟踪问题：需 bash `git rm --cached`（safe-mode 无通道）

## v1.22.7 — 2026-08-27（移除工作区手输兜底，S142）

**Scope:** 用户确认 v1.22.6 修复后工作区白名单列表正常加载——删除手输路径兜底 UI（工作正常后不再需要）。

### 变更
- `src/client/AccountsEditor.tsx`：删除 `wsInput` state / `addWorkspace()` / 手输输入框 + 添加按钮；加载失败文案改为「暂无可选工作区（workspace.list 未返回条目）」（不再引导手输）
- `src/client/AccountsEditor.css`：删除 `.ae-wsAdd`（不再使用）
- `src/client/accounts-api.ts`：注释同步（失败返回空数组 → 面板显示"暂无可选工作区"）
- 测试：40 files / 425 tests（无新增——纯 UI 删减）→ typecheck ✓（node + client）

## v1.22.6 — 2026-08-27（修复：工作区白名单列表加载失败，S142）

**Scope:** 用户报告设置面板工作区白名单显示"未能加载工作区列表（workspace.list 不可达）"——已有工作区下拉为空。

### 变更
- **根因**：`fetchWorkspaces` 的 POST body 只发 `{ rpcId, payload }`——DSH RPC 信封要求完整 **ClientRequest** `{ type: 'client-request', rpcId, method, payload }`（api/rpc.ts wire 契约）——缺 `type`/`method` → `clientRequestSchema.safeParse` 校验失败 → bad-request → `result.value.items` 缺失 → 面板回退"手输路径"兜底
- **修复**：`src/client/accounts-api.ts` `fetchWorkspaces` 补 `type: 'client-request'` + `method: 'workspace.list'`（payload 空对象）——与 DSH 官方 `fetch/client.ts` `callUnary` 信封一致
- 测试：accounts-api.test.ts +4（信封完整断言 type/method/payload + rpcId 前缀 / 非 200 空数组 / 缺 items 空数组 / 无 path item 过滤 + title 缺省回退）——**40 files / 425 tests** → typecheck ✓（node + client）

## v1.22.5 — 2026-08-27（session_rebuild 增强：自动继续 + 保留 first-anchor，S142）

**Scope:** 用户实测 rebuild 有效后提出两项改进：① rebuild 完成后自动继续（不让用户手工继续）；② rebuild 后保留 first-anchor 内容（或重新走一轮 first-anchor）。

### 变更
- **自动继续（turn-stopping steer）**：`performRebuild` 执行 surface replace 后 `agent.steer()` 注入 `[TRAJECTORY-REBUILD] 会话已清空重建。请立即按上方锚点指令读取持久轨迹（SESSION.md）并从上次进度自动继续工作。`——DSH 官方先例（hooks-claude-code Stop hook：turn-stopping 里 steer 强制再执行一步）：next-step 队列非空 → turn 循环不 break → 模型同轮自动消费指令读取 SESSION.md 继续，**无需用户手工输入**
- **保留 first-anchor 协议正文**：`buildRebuildAnchor` 并入 `DEFAULT_ANCHOR_MESSAGES` 两条正文（ACC 身份/EAP/协作协议）——**去掉 acknowledge 尾句**（`stripAckSuffix`：重建后直接干活，不重走确认轮）；系统提示词层身份未丢（每轮注入），bootstrap 晋升状态不受影响（surface replace 不改 events → promoted 保持完整工具目录；events 有历史 user/message → 不重复锚定；steer 消息 source=plugin → 不递归锚定）
- `src/rebuild.ts`：`buildRebuildAnchor` 增加 anchorMessages 参数（缺省 DEFAULT_ANCHOR_MESSAGES）；`stripAckSuffix` 导出（可测）；`registerRebuildTurnHook` 执行 replace 后 steer
- `src/tools/rebuild.ts`：description/instruction 同步（自动继续 + first-anchor 保留语义）
- 测试：rebuild.test.ts +3 断言（stripAckSuffix 去尾句/原样 / buildRebuildAnchor 含协议正文且无 acknowledge / turn-stopping 后 steer 被调用 source=plugin）——**40 files / 421 tests** → typecheck ✓（node + client）

**✅ 预期效果**：模型调用 session_rebuild → turn 结束清空 → 注入「协议正文 + 继续 S### 的工作」锚点 → 自动继续读取 SESSION.md 工作（无需用户再发消息）

## v1.22.4 — 2026-08-27（登录安全审计加固 + session_rebuild 语义根治：完全丢弃+新建，S142）

**Scope:** 两条主线——① 用户：外部监听将放公网，安全性必须可靠（登录机制安全审计 S1-S12）；② 用户实测 S141 崩溃：session_rebuild 原地 replace 方案有致命缺陷，语义再修正为**完全丢弃 + 新建**。

### 变更
- **登录安全审计（S1-S12）**：基础扎实（scrypt+timing-safe+256-bit token+HttpOnly/SameSite=Strict+0600+token 不落盘），但为内网设计；公网硬门槛 = S1 明文传输 / S2 无爆破防护 / S3 无 CSRF / S6 config 接口透传。**用户原则**：① 不影响体验的直接修正 ② 影响体验的改方案 ③ 不限制 IP
- **直接修正（不影响体验）**：S3 CSRF（登录双提交 token + config PUT Origin 校验）/ S5 token 滑动 TTL 24h + `POST /serenity/logout` 登出 / S7 `cookieSecure` 配置项 / S9 审计日志（登录成败 console.log/warn）
- **改方案（影响体验）**：S2 账号维度失败锁定（5 次 → 15min 指数退避，不按 IP）/ S1 TOTP 第二因素（RFC 6238 零依赖，Authenticator 兼容，可选绑定）
- **`src/totp.ts`（新）**：base32/RFC6238/otpauth URI，零依赖
- **config-ops 账号扩展**：`totpSecret` + wire `hasTotp` + `cookieSecure` 全链路
- **gateway 会话升级**：`Map(token→session TTL)` + `revokeToken`、失败锁定状态机、CSRF（`newCsrfToken`/`safeEqual`/`originAllowed`）、登录流 TOTP+锁定+CSRF+登出、cookieSecure 传递、登录页加 TOTP 输入框+CSRF 隐藏字段
- **session_rebuild 语义根治（v1.22.2 原地 replace 致命缺陷）**：S141 实测崩溃 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`——rebuild 在 turn 中途执行 surface replace 把当前 turn 的 assistant tool-call 节点也 shadow 掉 → 孤儿 tool 消息 → LLM API 报错。**新实现**：① `workspaceRegistry.archiveSession(旧 id)` 丢弃（UI 隐藏 log 保留）② `ctx.agents.create({ sessionId: rebuild-<uuid>, meta.cwd=旧会话 header.cwd, agentOptions=当前 provider/model, preset 继承 })` 新建 ③ `handle.agent.followup({source:{kind:'user'}})` 注入「继续 S### 的工作」④ SESSION.md 原位
- **scope bug 修复**：session 工具 agentScope = 裸 dshSessionId（曾用 `session:${id}` 前缀 → 激活信息读不到）
- **cwd 继承修复**：新会话 meta.cwd 用旧会话 header.cwd（workspace 按 cwd 分组，保证同工作区）
- **client 自动切换**：订阅 sessions.list 检测 `rebuild-*` 新会话出现即 `sessions.open(id)`（零改 DSH）
- **测试重写**：rebuild.test.ts（buildRebuildPrompt / executeRebuild 建新会话+归档 / scope 激活信息 / cwd 继承 / 无 registry 降级）——**40 files / 419 tests** → typecheck ✓（node + client）

**✅ 实测通过**：prompt=「继续 S142 的工作。」、sessionMdPath 正确、oldSessionId 已归档、newSessionId rebuild-* 已创建、无 INVALID_REQUEST

## v1.22.3 — 2026-08-27（gateway 反代链路 error 监听防崩溃，S142）

**Scope:** 用户报告：外部（3081）正常使用中 dsh 崩溃——日志实证 `node:events:497 throw er; // Unhandled 'error' event` + `Error: read ECONNRESET` + `Emitted 'error' event on Socket instance` + `Node.js v22.22.1`。

### 变更
- **根因**：gateway 反代链路客户端侧 socket/req/res 缺 'error' 监听——外部客户端（经 3081 使用）连接中断（切网络/锁屏/关页/超时）→ socket ECONNRESET → 无监听器 → Node throw → **整个 dsh web 进程崩溃**
- **`src/gateway.ts` 修复**：① `proxy()`：客户端 req/res 挂 error（销毁对端）+ 透传路径 upstream error；② WS upgrade：客户端 socket + 上游 usock 双向挂 error（pipe 不传播 error）；③ 登录 POST 分支 req/res 挂 error；④ server 级 `clientError` 兜底（静默销毁）
- **新 MSM `dsh-crash-investigate`**（`scripts/dsh-crash-investigate.ts`，注册 mech）：status（进程/端口/版本/日志清单）/ logs [N] / crash（FATAL/未捕获/OOM/core/信号扫描）/ collect（全量报告落盘 /tmp/）；只读采集零副作用
- 测试 +4（源文件监听注册回归断言）——**39 files / 380 tests** → typecheck ✓

## v1.22.2 — 2026-08-27（轨迹跟踪器 rebuild 语义修正：原地重建，S142）

**Scope:** 用户纠正 F2 rebuild 语义——**归档丢掉的是 dsh 会话（对话历史工作副本），不是宁静号 SESSION.md**；SESSION.md 是持久轨迹永远原位；rebuild = dsh 会话**原地** surface replace 重建（同一会话 id，从 SESSION.md 自动延续身份）。

### 变更
- **rebuild.ts 重写为原地重建**：`executeRebuild` ① 定位当前 dsh 会话（`ctx.sessions.get`）② `surface.nodes` 全部节点 → `session.append('user/message', anchor, { surfaceOp:{op:'replace', start:nodes[0], end:nodes[last]}, sourceEventSeqs:nodes })` 原地替换整个 surface（同一会话 id 不变）③ SESSION.md **原位不动**（持久轨迹）；**删除** `archiveSessionNow`/建新宁静号会话/`ctx.agents.create` 逻辑
- **`buildRebuildAnchor` 语义对齐**：`[TRAJECTORY-REBUILD]` 前缀 + "持久轨迹（SESSION.md，未移动）"——不再引用 `_archived/`
- **`tools/rebuild.ts` 适配**：description 改轨迹跟踪器语义；execute 传 `dshSessionId`（当前会话原地重建）
- **测试重写**：fakeSession surface replace 断言（start/end/sourceEventSeqs 全覆盖 + 不建新会话/不归档 + 空 surface/会话缺失抛错）——39 files / 376 tests
- 撤销误操作：S142 目录已从 `_archived/` 恢复原位 + 状态改回进行中；误建的 S144 已删除

## v1.22.1 — 2026-08-27（移动端登录页 + 轨迹跟踪器 + 上下文回收修复，S142）

**Scope:** 用户三项需求：① 外部（3081）登录页移动端适配；② 上下文阈值回收不生效（修复）；③ 机制正式命名——**轨迹跟踪器（Trajectory Tracker）**：SESSION.md = 持久 agent（轨迹），自身会话 = 临时可重建（工作副本）。

### 变更
- **移动端登录页**：viewport meta（防移动浏览器 980px 缩放）+ `env(safe-area-inset-*)` 安全区（刘海屏/手势条）+ 触控目标 ≥50px（Apple HIG）+ 输入字号 16px（iOS 聚焦不自动放大）+ `autocapitalize="none"`/`autocorrect="off"`/`enterkeyhint`（移动输入优化）+ `prefers-color-scheme` 明暗自适应 + 响应式卡片 `min(340px, calc(100vw - 48px))` + `theme-color`
- **轨迹跟踪器（Trajectory Tracker）概念（用户拍板命名）**：F2 rebuild 机制语义正式化——**SESSION.md 是持久轨迹（agent 身份本体）；当前会话只是临时可重建的工作副本**；`rebuildReminderText` 文案改为 `[TRAJECTORY]` 前缀并显式阐述该语义
- **上下文阈值回收不生效修复（用户报告）**：两个根因——① `inject` 缺 `sessionProjections`（`ctx.get` 拿不到服务 → `readContextPressure` 恒返回 null → 永不触发）② contextPressure 检测**嵌套在计分提醒内**（KeeperTracker 计分不到阈值永不查上下文，与用户设定的 rebuildThreshold 无关）。修复：`index.ts` inject 补 `sessionProjections`；`keeper.ts` post-execute **重构为两个独立机制**——SESSION-KEEPER 计分提醒（DCP 确认码）+ 轨迹跟踪器压力检测（**每次工具调用后独立检查** contextPressure 投影，超 rebuildThreshold 追加 [TRAJECTORY] 提示）
- 测试：39 files / 376 tests（+4：登录页移动端断言 / rebuildReminderText 新文案 / readContextPressure 装配+未装配）→ typecheck ✓（node + client）

## v1.22.0 — 2026-08-27（归属重构 + 外部访问稳定性修复，S142）

**Scope:** 用户三轮实测驱动：① 架构原则升级（**plugin 是全局的，CCC 是具体的**——账号密码归 plugin，不挂 CCC localstore）；② 3081 外部访问完整可用（登录/工作区/会话/WS 事件流）；③ 设置面板 UI 专业重构（DSH 设置面板承载全部 plugin 配置，CCC 状态栏面板只展示状态）。

### 变更
- **归属重构（config-ops 全局化）**：`serenityAdvanced` 从 CCC localstore.json **迁移到 plugin 全局文件 `~/.dsh/serenity-hooks.json`**（env `SERENITY_HOOKS_CONFIG` 覆盖；0600 权限；`migrateLegacyLocalstore` 首次 session-start 一次性迁移）；所有读写函数去 root 参数
- **gateway 开关打通（3081 未启动根因修复）**：`registerGateway` 的 enabled 改读 **`readSimpleSettings().gatewayEnabled`**（DSH settings 面板开关，plugin 全局）——此前读 localstore `serenityAdvanced.gateway.enabled`（永远 false）与用户设置割裂 → 永不启动；host/port/accounts 读全局文件；**不依赖任何具体 CCC**（apply 即尝试 + session-start 兜底）
- **信任栅栏修复（HTTP 403 根因）**：DSH `isTrustedApiRequest` 要求 **Origin.host === Host.host**——反代除改写 Host（127.0.0.1:主端口）外 **Origin 同步改写**为 loopback（浏览器 POST/WS 握手必带 Origin，透传外部地址 → 403 → host.pickDirectory 等全挂）；`buildProxyHeaders` 纯函数（可测）
- **WS 稳定性修复（ERR_INVALID_HTTP_RESPONSE 根因）**：upgrade 转发①**回写 101 状态行+响应头**到客户端 socket（Node http upgrade 不自动回写——只 pipe 数据 → 无头响应 → handshake 失败）②监听 `response` 透传非 101（403/426）③head/uhead 方向修正（客户端数据→上游，上游数据→客户端）
- **WS 会话保持**：`dispose` **不再清空 token**（token 模块级，进程重启自然清空；热重建清 token → 已登录用户 WS 断 + 重连 cookie 无效）；settings 简单配置变化走 `serenity/settings-changed`（非强制 sync），仅 /serenity/config PUT 走 `serenity/config-updated`（强制重建）——拖动阈值不再打断 WS
- **gateway listen 防崩溃**：EADDRINUSE（旧进程未释放）→ **不抛 unhandled error 崩溃**，1s 重试 ×10；restart-web 双端口（3080+3081）等待释放 + 强杀覆盖
- **工作区白名单（用户需求）**：`gateway.workspaces` 路径前缀白名单（空=全部允许，向后兼容）——gateway 拦截 `POST /api/workspace.list` 响应过滤 items + `workspace.create` 校验（不在白名单 → 403 RPC error）；`filterWorkspaceList`/`workspaceAllowed`/`workspaceDenyResponse` 纯函数
- **crypto.randomUUID polyfill（非安全上下文修复）**：第二端口 http://LAN-IP:3081 是非安全上下文 → 浏览器 Web Crypto `randomUUID` 不可用 → provider 目录加载失败；gateway 反代 HTML 注入 polyfill（getRandomValues 实现，DSH 官方 random-uuid.ts 同算法，幂等 marker）
- **CCC 状态栏面板（SafeModePanel 重构）**：只展示状态（运行环境/安全模式/Loop 运行 + 配置入口引导提示）——账号等配置移出；分组标题 + 行卡 + 清晰换行 + 底部引导
- **DSH 设置面板承载全部 plugin 配置（SettingsSection + AccountsEditor）**：简单配置（开关/阈值）+ 「外部访问」区块（监听地址/端口 + 登录账号 CRUD + 工作区白名单 chips）——账号 CRUD 从 CCC 面板移到 plugin 层（用户拍板）
- **远程状态显示修复**：`resolveWorkspace` 无 sessionId 时**遍历 live sessions 找 CCC 会话**（回退 process.cwd()=$HOME 错误显示"未激活"）；`resolveWorkspaceCore` 纯函数
- 删除 `AccountsTab.tsx/.css`（被 AccountsEditor 取代）；`client/index.ts`/`SettingsSection.tsx` 同步

**测试：** 39 files / 372 tests（+24：workspaces patch / polyfill / workspace 白名单 / 信任栅栏 / workspace-resolve）→ typecheck ✓（node + client）



**Scope:** 用户三截图反馈 + 功能实测：
① UI 看齐 dsh 自身（层级标题/行卡/官方 token）；② F1 3081 端口未监听（功能 bug）修复。

### 变更
- **F1 gateway 功能修复（3081 未监听根因）**：`registerGateway` 原用 `findSerenityRoot(process.cwd())`——dsh web 进程 cwd 是 $HOME 非 CCC → **永远 null → 永不启动**。改为：**root 从 `agent/session-start` 的 header.cwd 发现**（首个会话出现即启动）；sync **幂等**（配置签名 diff 才重启）；**enabled=true 即监听**（无账号时登录页提示而非端口不通）；`/serenity/config` PUT 后 emit `serenity/config-updated` 事件 → 立即重建
- **SettingsSection UI 重构**：官方 settings 设计语言——`section/title/intro + rowCard 行卡`（标题+说明 左列 / 开关右置），开关用 `--dsw-alias-*` token 的自绘 toggle；多级标题（页面标题 → 行卡 → 说明）解决"怎么用"困惑；`Toggle`/`RowCard` 纯组件
- **SafeModePanel 状态卡**：卡片本体加 **safe-mode 徽标**（ON 琥珀 / OFF 灰，--dsw-alias-state-warning-*）——不进模态即可见状态；loop 详情默认折叠（计数 + 展开按钮）
- **模态内容溢出修复**：`sp-modalBody` 改 `overflow-y: auto`（内容超出滚动，不再截断）；loop 详情展开后最多 3 条 + 其余提示
- `SettingsSection.css` 重写：官方 token 词汇表（border-l2/r12 行卡、36px 胶囊按钮风格、32px 输入字段高度）

**测试：** 38 files / 348 tests（gateway 修复 + accounts-api 已覆盖）→ typecheck ✓（node + client）

## v1.21.0 — 2026-08-26（三功能 + 双层配置面板：F1 双端口网关 / F2 session_rebuild / F3 会话命名 / 高级面板，S142）

**Scope:** 用户 S142 需求组（细化+拍板）：零改 DSH 前提下——① F1 dsh web 额外监听一个端口（账号密码登录后即原生 Web UI，适应任何部署）；② F2 上下文超限 LLM 主动触发 `session_rebuild` 清空重建（SESSION.md 实时整理 → 压缩不再需要）；③ F3 dsh 会话命名受宁静号 SESSION 控制（use 激活时重命名为目录名）；④ 配置双层：**简单配置（开关/阈值）→ dsh 原生设置面板**（官方新 RC 已删 WEB_SETTINGS_NAMESPACES 白名单，第三方 ns 零改 DSH 可进），**复杂配置（账号列表）→ 宁静号高级面板**（双 tab 状态/账号）。

### 变更
- **F1 `src/gateway.ts`（新）**：第二 node:http 监听器（默认 0.0.0.0:3081）→ 内嵌极简登录页 → POST /serenity/login 验证（localstore accounts scrypt hash）→ HttpOnly cookie（重启失效）→ 反代 127.0.0.1:主端口（**Host 头改写**过信任栅栏）→ WS upgrade 转发 pipe；`registerGateway` 按 localstore 配置启停
- **F2 `src/rebuild.ts`（新）+ `src/tools/rebuild.ts`（新）**：`session_rebuild` tool——① 归档当前会话（SESSION.md 标记 completed + 立即移 _archived/）② createSession 新宁静号会话 + ctx.agents.create 新 dsh agent ③ 锚点注入（SESSION.md 路径 + 摘要 + 重建指令）；`src/seams/keeper.ts` 扩展 **contextPressure 投影检测**（超 rebuildThreshold → 提醒 LLM 主动触发，不自动执行）
- **F3 `src/tools/session.ts`**：`sessionTool` → **`createSessionTool(ctx)`** 工厂——use 激活宁静号会话后同步 rename 当前 dsh 会话为目录名（`sessionTitle.rename` user source pin 住；naming.enabled 门控；sessionTitle 可选服务守卫）
- **配置分层**：`src/settings-section.ts`（新）——`installSettingsSection(serenity-hooks, schema)` 注册简单配置（gatewayEnabled/rebuildEnabled/rebuildThreshold/namingEnabled）到 dsh 设置面板 + `readSimpleSettings()` 运行时读取 + **降级守卫**（旧 RC 白名单时 client 显示降级提示）；`src/config-ops.ts`（新）——localstore `serenityAdvanced` 节账号 CRUD + scrypt hash + wire 形态（hash 永不落 wire）
- **API `src/api.ts`**：+ `/serenity/config`（GET wire 形态 / PUT patch：新账号必带 pass、既有账号 pass 空保留原 hash）
- **面板 `src/client/SafeModePanel.tsx` 重构**：双 tab 大面板（460px 无滚动条）——状态（CCC/loop/守卫/safe-mode + loops 列表）+ 账号（`src/client/AccountsTab.tsx` 新：host/port + 账号 CRUD）；`src/client/accounts-api.ts`（新）纯转换 + fetch
- `src/index.ts`：Config 加 gateway/rebuild/naming 段 + apply 注册 settings-section/gateway/rebuild/session_rebuild；`src/session-ops.ts`：`sessionsRoot` 导出
- `tsconfig.json`/`client/tsconfig.json`：paths + dsh-settings/dsh-session-title/dsh-client-ui-settings
- 官方源码更新：repo-git 新增 pull 子命令（dsh-harness-public 47f9438→b150a551；5 API 面复核通过）

**测试：** 38 files / 349 tests（+56）→ typecheck ✓（node + client）

**Scope:** 用户两轮反馈迭代：
① 状态条（input.dock 常驻"图片已保存"）永久停留碍眼 → **删除 UI，补救静默化**（组件仅保留 effect 逻辑，return null）
② 对话消息必须写名具体图片路径（目录级提示让 agent 还要猜）→ **恢复路径**：单图「用户提供了一张图片（路径：_tmp/images_from_user/xxx）」；多图「用户提供了 N 张图片：\n- 路径1\n- 路径2…」

### 变更
- `client/ImageFallbackDock.tsx`：**移除全部状态条渲染**（idle/busy/done/error 均不渲染，return null；CSS 文件删除）——补救逻辑保留（上传 + 清 rail + 重发），失败仅 console.warn
- `client/image-fallback-api.ts`：`IMAGE_NOTE_TEMPLATE_SINGLE/MULTI` → **`imageNoteTemplate(paths)`**——单图/多图均写名具体路径
- `client/index.ts`：注册不变（input.dock 条目仍挂载以运行补救 effect）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.5 — 2026-08-26（图片落盘：消息模板友好化——去掉突兀的原始文件路径，S142）

**Scope:** 用户 UI 反馈（截图标注）：对话里显示「用户提供了图片在 _tmp/images_from_user/2026-08-26T00-25-00-741Z-ajlq48.jpg」原始路径很突兀。修正：消息改为目录级自然提示，不展示具体文件名；agent 自行查 _tmp/images_from_user/ 目录找图片 → 调 CCC 的 vlm MSM 识别。

### 变更
- `client/image-fallback-api.ts`：`IMAGE_NOTE_PREFIX` → **`IMAGE_NOTE_TEMPLATE_SINGLE`**（"用户提供了一张图片（已保存到 _tmp/images_from_user/），请查看该目录下的图片并处理"）+ **`IMAGE_NOTE_TEMPLATE_MULTI(count)`**（多图）
- `client/ImageFallbackDock.tsx`：消息构造用新模板（不拼接具体路径）；补 import

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.4 — 2026-08-26（图片落盘：补救后自动清空输入框 rail 图片——用户实测需求，S142）

**Scope:** 用户要求：提供图片后自动删除输入框（rail）里的图片，免手动 ✕。技术：ui-conversation `sessions.provide({ props: ['inputActions'] })` 给所有 session-scope 组件提供 `inputActions`（setDraft/removeImage/submit）——input.dock 组件经 props 直达官方输入机器。

### 变更
- `client/ImageFallbackDock.tsx`：补救成功路径改为 **官方输入机器操作**——`inputActions.removeImage` 逐个清 rail 图片 → `inputActions.setDraft(原文+路径消息)` → `inputActions.submit()`（机器发送，draft 自动清空，无残留）；inputActions 不可用时 fallback 原 resendText（RPC 直发）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.3 — 2026-08-24（图片落盘修复：resendText 同样解构丢 this——改为方法调用，S142）

**Scope:** 用户实测 v1.20.2 仍失败：`Cannot set properties of undefined (setting 'promptError')`。根因与 v1.20.2 同类：`resendText` 把 `binding.session.prompt` **解构取出后调用**——prompt 内部读 `this.promptError`（session.ts:191），解构后 `this` = undefined → 抛错。

### 修复
- `client/image-fallback-api.ts` `resendText`：**改为方法调用 `session.prompt(...)`**（this = Session 实例）；注释固化约束
- 全面检查 image-fallback-api：uploadImage（模块函数无 this）/ getDraftFiles（v1.20.2 已修）/ resendText（本次）——**无残留解构调用**

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.2 — 2026-08-24（图片落盘修复：draftImages this 丢失——解构调用改为方法调用，S142）

**Scope:** 用户实测 v1.20.1 仍失败：`Cannot read properties of undefined (reading 'draftAttachments')`。根因：`getDraftFiles` 把 `conversation.draftImages` **解构取出后调用**（`const draftImages = conversation.draftImages; draftImages(ids)`）——draftImages 内部读 `this.draftAttachments`，解构后 `this` = undefined → 抛错。

### 修复
- `client/image-fallback-api.ts` `getDraftFiles`：**改为方法调用 `conversation.draftImages(ids)`**（this = conversation 实例）；注释固化该约束（防回归）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.1 — 2026-08-24（图片落盘修复：上传带 sessionId 解析 CCC 根 + conversation root get + 错误详情显示，S142）

**Scope:** 用户实测 v1.20.0 图片保存失败。根因排查：① 上传接口 workspace 解析——client 未带 sessionId → node half 回退进程 cwd（不可靠）→ 404；② getDraftFiles 经 scope() 寻址 conversation 存在不确定性；③ 失败原因不可见（状态条无详情）。

### 修复
- `client/image-fallback-api.ts`：
  - `uploadImage(file, sessionId)`：**必传 sessionId** → node half 经会话 header.cwd 解析 CCC 根（resolveWorkspace 的 sessionId 分支）
  - `getDraftFiles`：改为 **`ctx.get('conversation')` root singleton 直接取**（draftImages 读 controller 的 draftAttachments Map，与调用 ctx 作用域无关），避开 scope 寻址不确定性
- `client/ImageFallbackDock.tsx`：上传传 sessionId；**错误状态条显示具体失败原因**（err.message，诊断友好）
- `client/index.ts`：inject 签名同步

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.0 — 2026-08-24（图片自动落盘兜底——WebUI 图片粘贴 → 模型不支持时自动存 _tmp 供 CCC vlm MSM 处理，S142）

**Scope:** 用户需求：DSH 输入框粘贴图片，当且仅当当前模型不支持图片时，自动把图片存到 CCC 目录 `_tmp/images_from_user/`，并以「用户提供了图片在 {path}」文本消息交给 agent 自主处理（各 CCC 自己的 vlm MSM 识别，ACC 不约束 CCC 实现——职责分离）。零配置、完全自动：host 权威门禁（inputModalities）判定，失败即自动补救。

### 变更
- **node half**（`src/api.ts`）：
  - 新增 `POST /serenity/image-upload`（client 专属 x-serenity-ui 头）：类型白名单 png/jpeg/webp/gif + 10MB 上限 → 写 CCC 根 `_tmp/images_from_user/<ts>-<rand>.<ext>` → 返回相对路径
  - 抽取可测核心 `saveImageToTmp(root, mediaType, data)`（导出）
- **client half**：
  - `src/client/ImageFallbackDock.tsx/.css`：`conversation.input.dock` 条目（id serenity-image-fallback）——监听会话 promptError（attachment-error / MODEL_DOES_NOT_SUPPORT_IMAGES）→ 自动补救：rail 图片 File 上传 → 以「用户提供了图片在 {path}」+ 原 draft 纯文本重发（绕过图片门禁）→ 状态条展示已保存路径
  - `src/client/image-fallback-api.ts`：uploadImage（fetch node half）/ getDraftFiles（conversation.draftImages）/ resendText（session.prompt）——官方 client 服务面，零 core 改动
  - `src/client/index.ts`：注册 input.dock 条目（inject slots/conversation/sessions）
- **测试**：`tests/api-upload.test.ts`（+5：类型白名单/缺失数据/超限/目录幂等/路径格式）；全量 293 通过
- home-serenity CCC：零配置（无开关——完全自动）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.19.9 — 2026-08-24（MSM 机制约束——原则 + 隐喻，S142）

**Scope:** 用户要求补充笔墨约束 MSM 机制（存在的原则 + 对应隐喻）。隐喻域 THE SHIP 层 +2 条（The Machinery → MSM 确定性分层 / The Manifest → Single Source of Truth）；Principles 块 +MSM 原则段（确定性优先/单一真相源/注册才能行动）。

### 变更
- `seams/system-prompt.ts`：
  - **metaphorBlock +2 条（重编号 10 条）**：`4. The Machinery → MSM (Mech & Semi-Mech)`（机械确定性 vs 舵手判断——Mech 零推理 / Semi-Mech 决策点；Verdict: 手搓已有机械 = 浪费船员）、`5. The Manifest → Single Source of Truth`（工具只有登记在 manifest 上才存在；唯一 manifest；MSM 自描述 --help/--schema；Verdict: 文档重复记载用法 = 两张矛盾海图）
  - **principlesBlock +MSM 原则段**（Operational boundaries 之前）：Determinism first / Single source of truth / Registered to act
- `docs/metaphor-domain.md`：隐喻表重编号 1-10 + 两条新映射；M-1 映射对象扩展至机制；变更历史
- `tests/osp-alignment.test.ts`：metaphor 断言 8→10 条（+Machinery/Manifest +MSM/Single Source of Truth 映射 +Verdict×10）
- `tests/system-prompt.test.ts`：Principles 断言 +MSM 原则段
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.8 — 2026-08-24（系统提示词结构精简——重建视角 R↓，S142）

**Scope:** 用户要求层次精简 + 内容归位（重建视角 EAP R↓）：Principles 与 Constraints 合并（同属容器约束体系）、CCE 与 EAP 保持独立（维度不同）、Metaphor 提前（世界模型前置）。新增认知容器本体论（无错误只有认知不足）与 safe-mode 无人值守语义（用户设计思路）。**Constraints 不再作为独立对齐块（spec 修订：同步 osp compacting.ts——内容并入 Principles）**。

### 变更
- `seams/system-prompt.ts`：
  - **Principles 块（v1.19.8 合并）**：`constraintsBlock()` 删除 → `principlesBlock(root)`（认知容器本体论 "all work is cognition / no errors — only insufficient cognition / not-knowing is a state to be repaired" + Operational boundaries 段 = 原 Constraints 内容）
  - **装配重排**：ACC → **Metaphor**（提前：世界模型前置）→ Principles → CCE → EAP → 状态块 → SKILL → Session
  - **Metaphor 块 World 层呼应句**：`The Sea has no mistakes — only waters you have not yet charted.`（本体论隐喻化）
  - **Safe Mode 块重排**：语义（why——无人值守自由 "the guards are not chains; they are the ballast"）→ 机制（Operational details：bash/blacklist/governance）→ 约束（Behavior constraints）
  - CCE 与 EAP 保持独立（决策：时间一致性 vs 产物质量维度不同，不合并）
- `tests/osp-alignment.test.ts`：OSP_CONSTRAINTS 参照删除；Constraints 对齐断言 → Principles 断言（本体论 + 边界）；块序断言重排；metaphor 断言加呼应句
- `tests/system-prompt.test.ts`：Constraints 断言 → Principles；块序/装配顺序断言重排；safeModeBlock 断言适配新结构
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.7 — 2026-08-24（Metaphor 块三层结构化——隐喻域构成 EAP 抽象结构，S142）

**Scope:** 用户要求隐喻本身构成 EAP 抽象结构（隐喻之间存在关系），供后续具体 CCC 按顶层隐喻约束做隐喻改造。方案 B：注入文本完整呈现三层骨架（THE SHIP / THE VOYAGE / THE CREW）+ 每条隐喻 `→ 约束名` 映射标注（M-1）+ Verdict 判据（M-2）。结构约束 M-1~M-4 文档化（docs/metaphor-domain.md）。

### 变更
- `seams/system-prompt.ts`：`metaphorBlock()` 文本重构——头部 3 行说明三层结构；8 条隐喻按 SHIP（Hull/Deck/Drawings）→ VOYAGE（Harbor/Logbook/Theseus）→ CREW（Rotation/Blueprint）分组；每条标题带 `→ 约束映射`（Bounded Space / Entropy (H_op) / EAP / First Anchor / Session Tracking / Continuity / Multi-Agent Cognition / Reconstruction > Preservation）
- `tests/osp-alignment.test.ts`：metaphor 断言升级——三层分组标题 + 8 条本体 + `→` ×8 + 约束名 ×8 + Verdict ×8 + 无中文
- 新增 `docs/metaphor-domain.md`：三层骨架 + 三种显式关系（containment/mapping/sequence）+ 结构约束 M-1~M-4（CCC 隐喻改造模板）
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.6 — 2026-08-24（系统提示词去冗余 + Metaphor 强化块——S142 用户设计）

**Scope:** 用户以 EAP 原则审查系统提示词注入：去除重复真相源（EAP 定义两处、Root 两处），新增"宁静号宇宙"隐喻块（全英文 8 条，隐喻 = 记忆钩子 + 行为判据）增强约束力与表达力。CCC 零变动；破坏 CCE 块与 osp 的逐字节对齐（D2）——**验证顺利后修订 specs（同步 osp compacting.ts）**。

### 变更
- `seams/system-prompt.ts`：
  - **去冗余 R1**：CCE 块删 `CCE AND EAP` 段（EAP 三变量定义唯一真相源 = EAP 块；CCE 块回归纯 CCE 主题）
  - **去冗余 R2**：ACC 块删 `Root:`（Root 边界语义唯一真相源 = Constraints 块；ACC 块只做身份标识）
  - **新增 `metaphorBlock()`**：`=== Serenity Metaphor ===` 全英文 8 条（Hull/Logbook/Ship of Theseus/Deck Order/Blueprint over Statue/Crew Rotation/Harbor Inspection/Engineering Drawings），每条隐喻 + Verdict 行为判据；装配于 EAP 之后、SKILL 之前；独立块可回退
- `tests/osp-alignment.test.ts`：OSP_CCE 参照同步删段（R1）；ACC 断言改为"不含 Root"（R2）；块序断言加 Metaphor；新增 metaphorBlock 内容断言（8 条 + Verdict×8 + 无中文）
- 备份：`docs/system-prompt-v1.19.5-baseline.ts`（v1.19.5 注入文本基线，回退参照）
- home-serenity CCC：零变动

**测试：** 全量通过（对齐断言按新基线修订）→ typecheck ✓

## v1.19.5 — 2026-08-24（first-anchor 零配置化——协议固有，S142 用户原则）

**Scope:** 用户原则：任何 CCC 在抽象层都是宁静号/ACC，first-anchor 属 ACC 协议层——机制与内容均不可配置（零配置面）。旧 `serenity.json` bootstrap 段（S137 调参入口）移除，锚定消息与机制参数全部代码固化，所有 CCC 行为与首轮话语一致。

### 变更
- `seams/bootstrap.ts`：`DEFAULT_ANCHOR_MESSAGE`（单条通用人设）→ **`DEFAULT_ANCHOR_MESSAGES`**（两条协议级锚定消息，文本 = 原 home-serenity CCC 配置：ACC 身份+EAP+we/us+先锚定后行动 / 协作协议 5 条+acknowledge 要求，S142 用户确认）
- `resolveBootstrapSettings()` 无参——返回唯一固化设置：`zeroTools=true`（首请求 0 工具，晋升信号仅 assistant/message）、`requiredSignals=2`（两轮锚定）、bootstrapTools/suppressedSources/compactionTools 用协议常量
- `readBootstrapConfig` + `settingsByRoot` 缓存删除——不再读取 CCC 配置；`SETTINGS` 单例全局一致
- `ccc.ts`：SerenityConfig 移除 `bootstrap` 段（配置面收缩；遗留字段静默忽略）
- `index.ts`：注释更新（协议固有、零配置面）
- 测试：bootstrap.test.ts 配置解析块重写为协议固有默认值断言（+锚定消息内容断言）；阶段机测试不变
- home-serenity CCC：`.opencode/serenity.json` 删除 bootstrap 段（行为不变——固化默认 = 原配置）

**测试：** 全量通过（阶段机 + 协议默认值）→ typecheck ✓

**Scope:** v1.19.3 的轮次兜底数 `assistant/message` 事件，但 responses API（opencode-go-responses/muse-spark）下该事件在 assemble 时可能延迟/缺失 → 兜底计数失效 → 首轮锚定后仍不晋升 → 工具仍被裁空（用户实测 tiangong-serenity 会话 turn 4 仍无 ACC 工具）。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion` 兜底计数：`assistant/message` → **`step/start`**（平台稳定事件，responses/completions 都触发；JSONL 实证存在）
- 语义不变：首轮锚定（0 工具）→ 3 步后强制晋升（完整工具），对齐"首轮无工具，后续全面"设计
- 测试更新 +3（step/start 兜底 / scan 路径 / compaction 回落）；292/292 全过

## v1.19.3 — 2026-08-20（bootstrap 晋升轮次兜底——responses API 模型工具不可用修复）

**Scope:** 用户实测 opencode-go-responses（responses API）模型下整套 ACC 工具不可见（模型工具列表为空）。根因：CCC 配置 `bootstrap.zeroTools:true` + 2 条锚定消息 → `requiredSignals=2` 且晋升信号仅监听 `assistant/message`；responses API 模型的会话不产生标准 `assistant/message` 晋升信号（或信号延迟/缺失）→ 永不晋升 → bootstrap 阶段工具被裁成 `tools:[]`（首请求 0 工具），ACC 工具（cc_fs/acc_msm 等）永不可见。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion()`：新增第 3 参 `maxRoundsFallback`（默认 3）——**轮次兜底**：无论晋升信号是否到达，观察到的模型回复轮数（`assistant/message` 事件计数，独立于 `promoteEvents`）达阈值即强制 promoted（开放完整工具）
- 正常模型不受影响：锚定轮数（requiredSignals ≤ 2）< 默认兜底 3，锚定完成后正常晋升
- 防御性、通用：任何不发晋升信号的模型/协议（responses API 等）3 轮后自动解锁完整工具，不再永久卡 0 工具
- compaction/end 后回落需重新计数（epoch 感知保持）
- 测试 +4（bootstrap.test.ts）：兜底强制晋升 / scan 路径生效 / compaction 回落重计数 / resume 场景；292/292 全过

## v1.19.2 — 2026-08-20（loop agent 完整继承 DCP/anchored-standard 层——S140 修复）

**Scope:** 用户实测 loop 子代理缺失 DCP/anchored-standard 层：无法调用 ACC 工具、无法继承循环协议与标准层约束。根因：loop agent 经 `ctx.agents.create` 直接创建（非 DSH delegation 路径），`delegationDepth` 为 0 且 `events` 为空，绕过 anchored 的 `delegationDepth>0 恒 promoted` 分支，落入 bootstrap 收窄路径；当前 CCC 配置 `zeroTools:true` → loop agent 拿到 `tools:[]`（0 工具）+ 2 条 whoami 锚定轮，实质瘫痪。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion.status()`：新增 `session.id` 以 `loop-` 前缀 → 恒 `{boundary:-1, promoted:true}`（完整工具目录，无 anchor 轮）；沿用 `context.ts` `shouldAutoRestore` 既有的 `loop-` 前缀约定，保持一致性
- `seams/bootstrap.ts` `agent/inbox/inserted`：对 `loop-` 会话跳过锚定注入（autonomous worker 不需要 whoami 锚定轮，避免浪费 2 轮 + 0 工具轮）；loop agent 已通过全局 `systemPrompt.section` 获得 ACC 5 块
- 不改 `keeper.ts`：loop agent 工具复原后，`tools/post-execute` 自然按 CCC root 计分/提醒（DCP 生效）
- 测试 +2（bootstrap.test.ts）：`loop-` 前缀恒 promoted / 含 compaction 事件仍恒 promoted；289/289 全过

## v1.19.1 — 2026-08-16（cc_fs 只读子命令误拦黑名单修复——复合工具按 action 判定读写）

**Scope:** 用户实测 `cc_fs exists REPOSITORIES/arsenal`（只读）被 REPOSITORIES 只读参考源黑名单误拦。根因：`decideGuard` 的写类判定用**工具名**（cc_fs 整体 ∈ 写工具），但 cc_fs 是 15 子命令复合工具，只读子命令（root/resolve/exists/list/tree/relative/reveal/info/find）不该查黑名单。

### 修复
- `guards.ts`：新增 `WRITE_TOOLS` + `CC_FS_WRITE_ACTIONS` + `isWriteTool(toolName, action)`——普通工具按名判定；**cc_fs 按子命令 action**（mkdir/rm/mv/cp/touch/append 为写，其余 9 只读）
- `GuardInput` 增 `action` 字段；`extractAction` 从 exec.arguments 提取；`evaluate` 透传
- `extractPathArg` 扩展支持 cc_fs 的 src/dst/paths 数组字段（越界检查不漏主体路径）
- 语义对齐 v1.18.5：黑名单/治理文件只拦写操作；越界检查读写都拦（安全底线不变）
- 测试 +4：cc_fs 只读子命令放行 / 写子命令仍拦 / 无 action 保守 allow / 治理文件按 action 分流；287/287 全过

## v1.19.0 — 2026-08-16（heartbeat 机制彻底移除——无程序价值 + 产生 stray 文件）

**Scope:** 用户发现 turn-heartbeat 机制产生带换行符文件名的 stray 文件（D-1），经评估该机制本身无程序价值，用户决策彻底移除。

### 根因（D-1 stray 文件）
- turn-heartbeat 曾有版本把「路径 + 戳记内容」拼成完整文件路径传给 `writeFile`，文件系统按字面创建名为 `SESSION.md\n\n2026-08-19T…→ heartbeat` 的 stray 文件
- **机制无价值**：`appendHeartbeat()` 写 SESSION.md 文件，而 health 的 stale/stalled/排序全用**会话目录** mtime（`statSync(dirPath).mtime`）→ append 不刷新目录 mtime → 对活性判定零影响；heartbeat 行无任何代码解析消费 → 纯噪声

### 移除（不留死代码）
- `src/seams/loop.ts`（registerTurnFlush + resolveActiveSession）**文件删除**
- `session-ops.ts`：`appendHeartbeat` + `appendFileSync` import 删除
- `index.ts`：`turnFlush` Config 字段/import/注册/apply 调用删除（**破坏性：Config 移除 turnFlush**，故 minor bump）
- `ccc.ts`：`hooks.turnFlush` scheme 字段删除
- 测试：register.test.ts（turnFlush 配置 + turn-stopping 断言）、session-ops.test.ts（心跳块删除；`resolveActiveSession`→`readActiveSessionMd`）
- 文档：design.md（2.5 段标记已移除/表格/决策类型/里程碑）、PLUGIN-MANAGEMENT.md（turnFlush 行）
- 保留 `readActiveSessionMd`（system-prompt.ts Session 块仍用）

**测试：** 283/283（原 285，删 2 个心跳测试）→ typecheck ✓ / build ✓（lib 无 heartbeat 残留，seams/loop.js 产物消失）

## v1.18.8 — 2026-08-16（cc_git push 拒绝误报成功修复——non-fast-forward 被当成功）

**Scope:** 用户实测：`git push --dry-run` 真实拒绝（non-fast-forward，exit 1，本地 1 提交 vs 远程 17 提交分叉），但 cc_git push 返回 "Pushed to origin/serenity-18423"（声称成功无 [REJECTED]），提交从未上远程。

### 根因
`git-ops.ts push` 的成功判断 `stderr.includes('->')` 在拒绝检查**之前**——git push 拒绝输出 `! [rejected]  branch -> branch (non-fast-forward)` **含 `->`** → 拒绝被误判成功。该判断照抄 osp（osp 同病：cc-git-tool.ts 190 行同序）。

### 修复
- `git-ops.ts push`：**先检查拒绝**（non-fast-forward/rejected/[rejected]）→ 返回 [REJECTED] + 操作建议；再判成功（`->`）；其余抛错
- 测试 +1：本地模拟远程分叉（bare repo + 双工作树）→ push 拒绝断言 [REJECTED] 且不含 "Pushed to"；285/285 全过
- 附注：用户此前 cc_git log 看到本地提交是 remote-tracking ref 缓存旧值误导——fetch 前本地 refs/remotes 指向旧状态

## v1.18.7 — 2026-08-15（SESSION-KEEPER 提示词：英文 + 不中断工作语气）

**Scope:** 用户要求 SESSION-KEEPER 提醒文案：1) 使用英文；2) 要求"继续工作，无需中断，顺手回应即可"。

### 修复
- `keeper.ts reminderText`：中文 → 英文；语气改为不中断工作（"No need to interrupt your work — just acknowledge inline and keep going."），确认码 `[SESSION-KEEPER-recorded-{code}]` 保留
- 测试：keeper 断言依赖确认码（不依赖语言）；284/284 全过

## v1.18.6 — 2026-08-15（workflow subagent 宁静号上下文注入 + 锚定生效）

**Scope:** 用户报告 workflow 触发的 subagent 没有宁静号系统上下文注入，first anchor 也没生效。

### 修复
- **系统上下文注入**：`system-prompt.ts agentCwd` 加回退——有 agent 但无 `header.cwd`（workflow subagent 等）回退 `process.cwd()`（对齐 context.ts）；无 agent 仍返回 undefined（不注入，保持原语义）
- **锚定对子 agent 生效**：`bootstrap.ts` 锚定判定重构——根会话（delegationDepth 0）保持 fresh 判定（无历史 user/message，resume 不重锚）；**子 agent（workflow subagent 等）进程内只锚定一次**（`anchoredSessions` Set），不再因 delegationDepth > 0 排除
- 测试：284/284 全过（system-prompt 无 agent → 空 语义保留）

## v1.18.5 — 2026-08-15（黑名单/治理文件保护只拦写操作——读操作不误伤，对齐 osp）

**Scope:** 用户报告"读操作也被拦截了"——REPOSITORIES/ 下的 repo（天工开发流程只读参考源黑名单，对象条目自定义 message）连 **read** 都被拦。根因：dsp 的 `decideGuard` 对**所有带路径参数的工具**（含读）都检查黑名单/治理文件；而 osp 的 permission-guards 只在 `write/edit` 时查黑名单（读操作放行）。

### 修复（对齐 osp permission-guards）
- `guards.ts decideGuard`：**黑名单 + 治理文件保护仅在写类工具**（write/edit/str_replace_editor/cc_fs/bash/append/touch）时检查；**读操作**（read/glob/grep 等）只做路径越界检查（安全必需），不再被黑名单/治理文件误伤
- 路径越界检查保持对所有工具生效（读写都拦——跨根逃逸是安全底线）
- 测试：+2（读工具 + 黑名单路径 → allow；读工具 + 治理文件 → allow；写工具仍拦）；284/284 全过

## v1.18.4 — 2026-08-15（多轮递进锚定：两轮开头控——认知框架 + 工作协议，抽象→具体递进）

**Scope:** 用户验证首轮 0 tool + 约束提示词提高 LLM 整体表现，提出假设"上下文开头对后续产生很大约束，开头应当具备高抽象性"；首轮单条锚定信息量不足 → 设计**两轮递进**锚定问题（EAP 视角：第 1 轮身份/原则高抽象，第 2 轮工作协议中抽象）。

### 实现
- **`anchorMessages` 数组**：按序 prepend 到 next-turn 队列——每轮消费一条（0 工具纯文字回复），逆序插入保证消费顺序
- **阶段机 `requiredSignals`**（createEpochPromotion 扩展）：zeroTools 时 = 锚定轮数——每条锚定回复（assistant/message）计一次，**最后一条回复后晋升**；压缩后计数重置需重新累计
- 配置：`serenity.json bootstrap.anchorMessages: [第一轮, 第二轮]`（兼容单条 anchorMessage）
- CCC 配置：zeroTools + 两轮递进（第 1 轮 Serenity/EAP 认知框架，第 2 轮 5 条工作协议）

**测试：** 282/282（+4：anchorMessages 配置/多轮 requiredSignals/两轮晋升/压缩重置）

## v1.18.3 — 2026-08-15（首轮锚定消息改为 persona + we/us 人称设定）

**Scope:** 用户指定首轮锚定消息改为 "You are a helpful software engineer assistant.The personal pronoun is us/we."——首轮模型以 we/us 人称回答（对齐 anchored 实测的 "we" 轨迹特征）。

### 修复
- `bootstrap.ts DEFAULT_ANCHOR_MESSAGE`：'请介绍当前宁静号…' → 'You are a helpful software engineer assistant.The personal pronoun is us/we.'
- 测试：常量引用自动跟随（自定义 anchorMessage 覆盖不受影响）；278/278 全过

## v1.18.2 — 2026-08-15（Zero-Anchored 变体：0 工具首轮——严格按 zero-anchored-standard 实现）

**Scope:** 用户要求加 Zero-Anchored 变体（首轮 0 工具，纯文字锚定），**必须与 anchored-standard 实现原理一致**。提取 zero-anchored-standard/zero-tool-bootstrap.mjs + anchor-turn.mjs 源码逐行对照移植。

### 实现（对齐 zero-anchored-standard 原理）
- **晋升信号仅 `assistant/message`**（zero-tool-bootstrap.mjs 的 `createEpochPromotion(['assistant/message'])`——零工具首轮模型无法调工具，锚定回复即唯一晋升信号）
- **首请求 0 工具**：`system-prompt/assemble` 在 boundary < 0（未压缩过）时返回 `tools: []`
- **压缩后回落**：compaction/end 后受控阶段 = `compactionTools` 工作集（默认 [] → 0 工具，模型中途继续）
- **per-root tracker**：promoteEvents 按 CCC 配置（zeroTools → assistant/message only；anchored → either），session/event 按 session 所属 root 路由
- **锚定注入复用**：anchorMessage（"请介绍当前宁静号…"）prepend 到 next-turn——首轮模型无工具纯文字回答锚定问题，回复即晋升，第二轮完整工具 + 真实消息
- 配置：`serenity.json bootstrap.zeroTools: true` 切换变体（缺省 false = anchored 5 工具）

**测试：** 278/278（zeroTools 变体晋升信号断言 +1）

## v1.18.1 — 2026-08-15（bootstrap 直接默认开启：移除全部开关——用户明确"直接开启不能关"）

**Scope:** 用户验证 v1.18.0 bootstrap 无效（轨迹无锚定首轮）。根因：两级开关都没开（插件级 Config.bootstrap 默认 false + CCC serenity.json 无 bootstrap.enabled）。用户指示：**"这东西配什么，直接开启，不能关"**——bootstrap 直接默认生效，不做成可关闭的。

### 修复
- `index.ts`：移除 `Config.bootstrap` 开关，`registerBootstrap(ctx)` 无条件注册
- `bootstrap.ts readBootstrapConfig`：移除 `enabled` 门控——总是返回设置（CCC bootstrap 段仅调参数，缺省用默认）
- `ccc.ts`：`SerenityConfig.bootstrap` 移除 `enabled` 字段（文档注明直接默认开启不能关）
- 调用点适配（assemble/anchor/pre-step：非 CCC 跳过，CCC 内总是生效）
- 测试：register.test.ts 全关断言更新（bootstrap 恒注册）；277/277 全过

**用户开启（无需任何配置）：** 重启 dsh web 后新会话即生效——首轮工具目录窄化 + 锚定问题轮（"请介绍当前宁静号…"）

## v1.18.0 — 2026-08-15（Anchored Standard 整合：两阶段工具目录 bootstrap——移植 xiaobright/dsh-anchored-standard，验证能力提升）

**Scope:** 用户要求严格按 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 实现移植到 dsp，验证"首轮最小工具目录锚定轨迹 → 晋升开放完整工具"是否有实际能力提升（用户自行验证）。核心机制：V4 Pro 强依赖 API 可见工具目录选轨迹——首请求暴露最小工具集 + 剥离自动注入上下文，首次 tool/call 或 assistant/message 后晋升。

### 实现（独立模块 seams/bootstrap.ts，方便摘除）
- **阶段机**（移植 compaction-epoch.mjs）：epoch 感知晋升——tool/call + assistant/message 晋升信号（promoteOn: either/tool-call/assistant-message）；compaction/end 后回落受控阶段需新信号；从持久 session events 推导（resume/reload 不丢）；子 agent（delegationDepth>0）恒晋升
- **目录窄化**（移植 tool-bootstrap.mjs）：system-prompt/assemble 过滤器——bootstrap 阶段只留 bootstrapTools（缺省 read/write/edit/glob/grep，anchored 的 bash/str_replace_editor 适配为 dsp 核心）；compaction 后 + compactionTools；promoted 后开放完整目录；工具缺失降级完整目录 + 一次性告警
- **上下文剥离**：agent/pre-step 剥离 suppressedContextSources（缺省 skill-catalog + agent-instructions）；过滤器出错绝不吞上下文（降级保留全部）
- **首轮锚定**（移植 whoami-turn.mjs）：新会话第一条真实消息到达时把锚定问题 prepend 到 next-turn 队列——第一轮模型只回答锚定问题（最小工具），回复即晋升信号，真实消息第二轮处理。默认锚定问题 = **"请介绍当前宁静号，它是什么，为了什么，200字以内回答"**（用户指定，可配置）
- **配置**：插件级 `bootstrap: true`（Config，默认 false）+ CCC serenity.json `bootstrap.enabled: true` 二级开关（bootstrapTools/promoteOn/suppressedContextSources/compactionTools/anchorMessage 可配置）——零侵入，验证失败一行关摘除

**测试：** 277/277（bootstrap +12：阶段机晋升/epoch/子agent/resume/配置解析）

## v1.17.5 — 2026-08-15（Windows 兼容性全面修复：v1.17.x 深审计 17 项——bun EINVAL 回退/跨盘漏判/反斜杠绕过/CRLF/BOM 等）

**Scope:** Windows 用户提交 v1.17.x 深度审计报告（S009 会话，17 问题）。高优先级：问题 5（acc_msm bun 回退死代码）、问题 6（guards 跨盘漏判）、问题 7（reveal /select, 传参）、问题 8（mech-registry 反斜杠绕过）、问题 9（黑名单斜杠结尾+嵌套治理保护失效）；中优先级 10-17。全部修复。

### 高优先级（功能/安全）
- **问题5**：`msm-ops` bun 回退触发放宽 `ENOENT || EINVAL || EPERM`（新增 `isBunMissing`）——Windows 无 bun 时 execFile('bun') 抛 EINVAL 非 ENOENT → fallback 死代码；async + sync 双路径
- **问题6（安全）**：`guards.decideGuard` 跨盘漏判改用 `pathInside`（旧 `relative().startsWith('..')` 跨盘返回绝对路径原文漏判）
- **问题7**：`reveal` Windows 文件 case 合并参数 `/select,<abs>`（分开传 `/select,` + 路径被 explorer 当空路径）
- **问题8（安全）**：`mech-registry.json` 写保护用 `relative` 归一化反斜杠（Windows 反斜杠路径使正斜杠字面量永不匹配 → 保护失效）
- **问题9（安全）**：`guards.decideGuard` rel 反斜杠归一化（`.secrets/` 规则匹配 `.secrets\file`；嵌套治理路径 `.serenity\child` 拦截）

### 中优先级
- **问题10**：session create 目录名脱敏（`sanitizeDirName`：非法字符→'-'、去尾点/空格、保留名 CON/NUL 前缀）
- **问题11**：session close 读入 CRLF 归一化（`\r\n`→`\n`，防假完成）
- **问题12**：git 操作加 30s timeout（网络路径 GCM 弹框挂起冻结事件循环；超时显式 stderr 提示）
- **问题13**：`status.readDshVersion` 跨平台探测（npm_config_prefix / APPDATA\npm / ~/.npm-global）
- **问题14**：fs-ops `assertNotProtected` win32 大小写不敏感比较
- **问题15**：fs-ops `validateWritePath` 写路径 realpath symlink/junction 防御
- **问题16**：BOM 剥离（`ccc.readUtf8` helper + localstore JSON + msm parseRegistry + opencode-scan frontmatter）
- **问题17**：fs-ops rm 只读文件 win32 先 chmodSync(0o666)；loop label 脱敏（`sanitizeLabel`）

**测试：** 265/265（+5：sanitizeDirName/sanitizeLabel/反斜杠黑名单/嵌套治理/pathInside 跨盘）

## v1.17.4 — 2026-08-15（黑名单对象条目支持：修复 osp 风格 `{pattern, message}` 条目不生效——dsp 只解析 string 导致对象规则变 "[object Object]" 失效）

**Scope:** 用户报告"写黑名单不生效"；参考 osp 排查。osp 的 readBlacklist 支持两种条目格式（string + object `{pattern, message}`），dsp 的 readBlacklist 只 `rules.map(String)`——对象条目被转成 "[object Object]"，规则完全失效（写操作不被拦截）。实证：string 规则拦截正常（write 到黑名单路径被拒），对象形式是唯一失效场景。

### 修复（对齐 osp safe-mode.ts）
- `ccc.ts readBlacklist`：支持 string（`".secrets/"` / `"regex:..."`）与 object（`{pattern, message}`）混合条目；非法条目（数字/null/无 pattern 对象）跳过
- `ccc.ts matchBlacklist`：返回条目对象 `BlacklistRule {pattern, message?}`（原返回规则字符串）
- `guards.ts decideGuard`：命中对象条目时 deny 提示用自定义 `message`（缺省回退 `命中规则 "<pattern>"`）
- `system-prompt.ts safeModeBlock` / `status.ts`：黑名单展示/输出适配条目对象（message ?? pattern）
- 测试：+3（对象条目 deny 提示 message / string+object 混合解析 / 非法条目跳过）；ccc/status/guards 断言适配条目对象

**测试：** 260/260（原 257 + 3 新增）

## v1.17.3 — 2026-08-15（MSM 开发指南补充"交互与确认规范"：禁止阻塞性确认，二次确认走两段式返回+重试）

**Scope:** 用户要求补充 MSM 开发规范——MSM 子进程无用户交互通道（spawn/execFile，600s 超时），阻塞性确认（readline/prompt/stdin 等待）会卡死至超时；需要二次确认时应直接返回确认信息，agent 确认后重新调用并带确认参数重试。

### 补充内容（acc_msm guide → MSM_GUIDE）
- **新增「交互与确认规范」节**：禁止 readline/prompt/process.stdin 阻塞等待；两段式确认模式（首次调用不带确认 flag → 输出确认请求 + exit 非 0 + 不执行变更；agent 重新调用带 --confirm/--yes/--force → 执行）
- 适用场景：删除/覆盖/推送/批量等不可逆或影响面大的操作
- 测试：acc-extras guide 断言补「交互与确认规范/禁止阻塞性确认/--confirm」

**测试：** 257/257

## v1.17.2 — 2026-08-15（Session 块平台适配：todowrite 首项移除 DSH 不支持的 priority 字段——修复 `todos[0].priority is not a declared property` 报错）

**Scope:** 用户报告更新 todo 偶尔报错 `Error: invalid arguments: "todos[0].priority" is not a declared property (additionalProperties: false)`。根因：Session 块（逐字节对齐 osp）指导 agent 调用 todowrite 时首项带 `priority: "low"`，但 osp 的 opencode todo 工具支持 priority 而 **DSH 平台 todowrite schema 无 priority（additionalProperties: false 拒绝）** → agent 照做即报错。提示词与平台工具 schema 不匹配。

### 修复
- `system-prompt.ts sessionBlock`：todowrite 首项约定 `{ content: "...", status: "completed", priority: "low" }` → `{ content: "...", status: "completed" }`（移除 priority；其余文本逐字对齐 osp）
- `osp-alignment.test.ts`：Session 块断言改为"除 DSH todowrite priority 差异外与 osp 一致"（DSH 适配版模板 + replace 还原证明唯一差异 = priority 字段）
- 平台差异本质：osp 对齐原则（D2）限"平台无关文本"；todowrite 参数 schema 是平台相关部分 → DSH 版适配

**测试：** 257/257（osp-alignment Session 断言更新为适配版）

## v1.17.1 — 2026-08-15（热修复：cc_git schema 移除公测 rc.6 不支持的 minimum/maximum 键——defineTool 阶段 DSL 拒绝导致插件 import 失败、web boot 崩溃）

**Scope:** 用户部署 v1.17.0 后 web boot 崩溃。根因：`tools/git.ts` 的 `count` 参数 schema 用了 `minimum: 1 / maximum: 100`，但公测 rc.6 的 dsh-tools value schema DSL 只支持 type/enum/const + description 等注释键，无数字边界键 → defineTool 阶段被 DSL 拒绝 → 插件 import 失败。用户已临时补丁（移除安装包中这两个键）使 web 恢复。

### 修复
- `tools/git.ts`：删除 `count` 的 `minimum/maximum` 键（保留 type + description）；边界校验（1-100）已在 `git-ops.ts` 运行时 clamp（`Math.min(Math.max(args.count ?? 10, 1), 100)`）——schema 边界移除后运行时校验完整保留
- 全包扫描确认：仅此一处违规（其他参数键 type/enum/required/items 均受支持；源码其余 minimum/maximum 出现均为注释/文本）

**测试：** 257/257（git-ops log clamp 运行时行为不变）

## v1.17.0 — 2026-08-15（工具实现全面对齐 osp spec：dsp/osp 无缝兼容）

**Scope:** 用户要求"dsp 和 osp 的工具实现应当逻辑一致（无缝兼容的强要求），工具设计应属于 specs，全面对照并修正"。以 osp（opencode-serenity-plugin）为 ACC 工具 spec，逐工具对照 dsp 全部 9+ 工具并修正行为差异。触发：session create `--issue` 静默降级建 `S080--untitled`（apaas-26116 事故根因）。

### session（对齐 osp session-tool/lib）
- **create**：`--desc <desc> [--goal]` 或 `--issue <工单号>` 二选一（缺省/互斥报错，不再静默 untitled）；issue 模式目录 `YYYY-MM-DD--<issue>`（无 S###）；dry-run 预览；长度限制（issue≤100/desc≤200）；goal 写入目标段
- **close**：需 `--name` + `--confirm`（防误关）；标记 [x] 已完成+已关闭 + 进度"关闭"
- **archive**：name 缺省批量归档（completed + ≥7 天 → 移动 `_archived/`）；单会话需 completed + grace
- **list/show/health/summary/qa**：文本输出对齐 osp（health 4 类 stale/stalled/ghost/drift；qa 5 类结构/一致性/新鲜度/决策质量/产出物）
- **hook-develop-guide** 子命令；extHint（session-tool MSM 注册提示）
- **CCC 扩展模型**：整命令委派 → osp 钩子后处理（create-transform）
- S134 内存化活跃会话保留（events 恢复）+ use 输出对齐 osp（todowrite 指令）

### cc-fs（对齐 osp file-system-tool）
- **rm 需 recursive 才删目录**（非空目录 [SKIP]）；cp 目录需 recursive；**.serenity 保护**
- mv dst 存在报错+建父目录；touch 更新 mtime+建父目录；append 建父目录+返回字节数
- list/tree/exists/info/find 输出结构对齐（元数据/嵌套树/glob+fuzzy/absolute/max-depth）
- 参数集补全：recursive/filesOnly/dirsOnly/absolute/maxDepth

### cc_git（对齐 osp cc-git-tool）
- **补 pull（--ff-only + [REJECTED] 建议）与 diff（staged/ref/path）**——6 子命令
- status 输出 {clean, files:[{status,file}], summary}；log 参数 n（默认 10 max 100）
- commit/push 文本输出对齐；localstore git 合规联动保留（S134）

### acc_kit（对齐 osp acc-kit）
- health 输出 `{ccc, root, version, status: healthy|degraded, principles: {P1_rooted, P2_git_managed, P3_binary_permissions}}`；CCC 缺失返回 degraded 不抛错
- time 输出 {now_iso, now_local, epoch_ms}；wait 缺省 1s（正整数），返回 'waited Ns'
- P3 平台适配：检查配置路径（DSH 无 opencode.json）

### acc_msm（对齐 osp msm 三件套）
- **path-arg symlink 防御**（realpath 指向根外拒绝）
- **register**：path 根内 + 脚本存在 + name 全局唯一校验；保留原注册表格式（v1/数组）；精提交（只 add 注册表文件）；flags/usage 入参
- **exec 注入 env**：SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION
- 协议 flag 缩小到参数首位（--list/--schema/--format=json），业务参数无损透传
- **check 补全 DC-M1~M4**：M1 补 .spec.ts；M2 判定放宽（function main( / isMain / require.main / import.meta.url）；M3 双向（脚本未注册 + 引用缺失）；**M4 新增**（路径型 flag 未标 type:"path"）
- list 加 header（plugin version + CCC + root）+ flags 展示；guide 补全（flag schema/守卫细化/env）
- **exec 失败追加 --help TIP**（对齐 osp v0.5.38：exit≠0 且未传 --help 时 stderr 追加 TIP）
- **新增 ccc-config action**（对齐 osp：CCC 配置参考——loop.defaultModel/sessionKeeper.threshold/localstore.gitTrack/hooks.autoRestoreSession/safeMode）

### loop（对齐 osp loop-runner 保险阀）
- **补对话轮次上限 LOOP_MAX_ROUNDS=100**（osp round≥100 强制 done）；续跑/重启/guide/model 覆盖保留（dsp 增强）
- **finishReason**（done/max_rounds/restart_exceeded）+ **writeFailedStatus** 失败状态落盘（status:failed + errorCode，对齐 osp）；task 标 required；label 长度约束；description/guide 措辞与实现一致（轮次上限 100）

### 保留的 dsp 增强（不冲突，文档化）
- cce 工具（osp 无）、eap/neat section 渐进披露（中文内容）、loop 续跑/agent 重启、reveal win32 spawn、localstore 联动、msm --schema 协议

**测试：** 257/257（fs-ops/session-ops/ops 断言重写为 osp spec 行为；osp-alignment 6 项逐字节仍过）

## v1.16.14 — 2026-08-15（SESSION 跟踪内存化：活跃会话不落盘（对齐 osp active-state），进程重启从当前会话 events 解析 [SESSION CONTEXT] 恢复——根治泄漏与并行串台）

**Scope:** 用户追问泄漏根因（"放内存里了？并行怎么办"）→ 仔细检查确认：落盘标记（`.dsh/active-sessions/<scope>` 文件）**无生命周期累积** + `restoreActiveSession` **全局 mtime 扫描**（无"谁在用"感知）→ 新会话继承旧 SESSION（apaas-26116 场景）+ 并行串台。用户指示：**不能落盘，必须内存，参考 osp 完整方案**。实施：活跃会话改内存 Map，进程重启从当前会话 events 解析 `[SESSION CONTEXT]` 标记恢复（只扫自己会话）。

### 泄漏根因链（仔细检查结论）

| 层 | 根因 | 修复 |
|---|---|---|
| ① 标记累积 | 落盘标记无生命周期（use 写新 scope；close 只删当前 scope；旧会话标记永久保留） | **不落盘**——内存 Map |
| ② 恢复全局扫描 | `restoreActiveSession` 扫**所有**标记取 mtime 最新，无活跃感知 → 任何会话捞起任意旧标记 | 恢复源 = **当前会话自己的 events**（`[SESSION CONTEXT]` 标记） |
| ③ 并行串台 | 恢复的"最近激活"在并行下无唯一性 → B 会话可能捞 A 的标记 | Map keyed by scope（并行隔离）；恢复只扫自己会话 |

### 实施（对齐 osp active-state）

- **session-ops.ts 内存化**：删除 `.dsh/active-sessions` 落盘机制（`ACTIVE_SESSIONS_DIR`/`sanitizeScope`/`activeSessionMarker`/`listActiveMarkers`/`restoreActiveSession`/legacy 清理）；新增内存 `activeStore` Map（scope → {sessionId, dirName, mdPath}）+ `lastActive` + `get/set/clearActiveSessionInfo` + `resetActiveSessionStore`（测试用）
- **useSession**：写内存 Map + 返回 `context` 含 `[SESSION CONTEXT] Activated: <dir>` + `SESSION.md path: <md>`（标记随工具结果进 events——进程重启恢复源）
- **closeSession**：删内存条目（+ lastActive 修正）——不落盘无文件残留
- **readActiveSessionMd**：读内存 Map
- **恢复**：`parseSessionContextFromEvents(events)`——从**当前会话 events** 递归收集字符串，取最后一条 `[SESSION CONTEXT]` 标记解析（目录名 YYYY-MM-DD-- 校验 + SESSION.md path 提取）；`context.ts seed` 用其替代 `restoreActiveSession`（进程重启 Map 空 + 会话有历史才恢复；`hooks.autoRestoreSession` 配置保留）
- **并行**：Map keyed by scope（dsh 会话 id）→ 多 conversation/subagent/loop 各自 key，互不干扰；恢复只扫自己会话 → 无跨会话串台
- **新会话不继承**：无历史 → events 无 `[SESSION CONTEXT]` → 不恢复（v1.16.13 泄漏修复成为内存方案固有属性）
- **测试**：session-ops.test.ts 重写（内存语义 / context 标记 / scope 隔离 / close / events 恢复解析 4 例 / 心跳内存读）；osp-alignment 两处 Session 测试改用 `useSession`（内存）——共 247 测试

**测试：** 247/247（落盘机制移除 + 内存语义重写）

## v1.16.13 — 2026-08-15（SESSION 泄漏修复：恢复只对续跑/恢复的会话（有对话历史）触发——全新会话不继承旧 SESSION）

**Scope:** 用户报告 SESSION 泄漏 bug——新建会话（apaas-26116，新任务）却注入了过去 S077 的 Session 上下文。根因：v1.16.6「会话重启恢复」的 `restoreActiveSession` 对**任何主会话**（含全新无历史会话）无条件恢复最近激活 → 新任务会话继承了旧 SESSION（跨任务污染）。

### 根因与修复

- **根因**：`context.ts seed` 里 `shouldAutoRestore(agent)` 只排除 subagent/loop——全新主会话（无对话历史）也触发 `restoreActiveSession`（回退 mtime 最近标记 → 复制为当前 scope 标记 → Session 块注入旧会话）
- **修复**：新增 `shouldRestoreActive(agent)` ——**根会话 + 已有对话历史**（`agent.session.events` 非空 = 续跑/恢复的会话）才触发恢复；全新会话（events 空）不恢复
  - 新任务新会话（apaas-26116 场景）→ 无历史 → 不注入旧 SESSION ✓
  - DSH web 重启后 resume 同一 conversation → 有历史 → 恢复上次激活 ✓（保留原「重启恢复」需求语义）
  - `hooks.autoRestoreSession` 配置保留（默认 true，受 events 门控）
- `seed` 改用 `shouldRestoreActive`；测试：+3（新会话不恢复 / 续跑恢复 / subagent+loop 不恢复）

**测试：** 253/253（原 250 + 3）

## v1.16.12 — 2026-08-15（运行时状态动态块：safe-mode 状态告知 + localstore git 策略行为提示——利用系统提示词约束 agent 行为）

**Scope:** 用户要求利用系统上下文注入（系统提示词层）约束 agent 行为：① safe-mode 开启后系统提示词告知已开启（行为约束）；② localstore 是否提交设定（gitTrack）决定敏感行为提示（deny=本地私有 / allow=进 git 但敏感数据只限该文件）。

### safe-mode 状态块（`=== Serenity Safe Mode ===`，英文）

- **ON 时注入**（OFF 不注入；`isSafeModeOn` 动态检测，开关切换每轮即时生效）
- **文案与实现逐项对应**（用户审核修正：原稿与 guards.ts 不符——safe-mode 实为**只禁用 bash**）：
  - `bash is disabled (hidden and blocked)` — `restrict({ deny: ['bash'] })` + `decideGuard` bash deny（guards.ts）
  - `blacklist rules apply to file paths` — `matchBlacklist` 路径拦截
  - `CCC governance files (.serenity, .serenity-safe-on) protected` — 治理文件写拒绝
  - `Other read/write tools remain available` — `SAFE_MODE_DENY_TOOLS` 只含 bash（write/edit 保留）
  - `do not attempt to bypass` — 行为约束
- **黑名单规则动态列出**（Active blacklist rules）
- **C5 修订**：safe-mode 状态对 agent 可见（行为约束），但开关权仍归用户（WebUI `x-serenity-ui` 头保护，agent 不可自开关）

### localstore git 策略块（`=== Serenity Localstore ===`，英文，localstore.json 存在时注入）

- **deny（缺省）**：`local private file (gitTrack=deny — not committed to git, .gitignore enforced)`——凭据仅存本机，不写入对话/日志，不尝试提交（cc_git 会拒绝）
- **allow**：`committed to git (gitTrack=allow — personal private repository)`——敏感数据可进入 git 但 **ONLY in this file**（只限 localstore.json 内，不外泄到其他文件/对话/日志）——用户审核确认语义
- 文件不存在不注入；`readGitTrack` 缺省 deny

### 结构

- 注入点：#1/#2 系统提示词层——`serenitySystemPrompt` 中 Constraints 块后、EAP 块前插入两个条件动态块（每轮装配按当前状态生成，即时生效）
- 不影响 osp-alignment 逐字节断言（独立新块）；SKILL 内容 HIDDEN_LINES 过滤保留
- 机制硬防线不变：guards 拦截 + cc_git 拒绝；提示是行为约束补充

**测试：** 250/250（原 245 + 5：safeMode ON/OFF/黑名单列出 / localstore 无文件/deny/allow / 装配顺序）

## v1.16.11 — 2026-08-15（上下文注入去重：系统提示词层已注入的完整身份，对话消息/压缩重注入渠道不再重复——只留简短身份锚点）

**Scope:** 用户发现上下文注入浪费——系统提示词层（systemPrompt.section，含 subagent）已成功注入 ACC+CCC 完整内容，对话消息（session-start inject / pre-step 前置）与压缩重注入（compaction/end）再注入同一完整全文 = 每轮 token 双倍浪费。修复：完整身份只走系统提示词层；对话流/压缩渠道只注入简短锚点。

### 注入方案梳理（5 个注入点 → 职责收敛）

| 注入点 | 修复前 | 修复后 |
|---|---|---|
| #1 systemPrompt.section 全局（每轮装配自动，含 subagent） | 完整身份（ACC/CCE/Constraints/EAP/SKILL/Session） | **保持（唯一完整身份通道）** |
| #2 agent 级 scoped section（抗 shadow） | 同上 | 保持（与 #1 shadow 关系） |
| #3 context.ts session-start `agent.inject` | 简短头 + **完整全文重复** | **只注入简短身份锚点**（[ACC] 已激活 + CCC 根 + 约束 + loop 模型 + Phase 2） |
| #4 context.ts pre-step 前置消息 | 同上完整全文重复 | 同上只注入锚点 |
| #5 compact.ts 压缩重注入 | 完整全文恢复 | **只注入锚点**（完整身份在系统提示词层，不随压缩折叠——压缩无需恢复全文；锚点保压缩后可追溯 R↓） |

- **激活 SESSION（Session 块）注入位置澄清**：由 `system-prompt.ts sessionBlock` 构建，经 #1/#2 系统提示词层注入（scope = agent.session.id 按会话隔离）——修复后对话流/压缩渠道不再携带（不再重复）
- `accMessage` 签名去 scope（简短头无 Session 块）；compact.ts 未用 scope 变量清理
- **测试**：context.test.ts 更新——accMessage 只含简短头（不含 5 块/SKILL/Session）；Session 块注入由 osp-alignment 的 sessionBlock 测试独立覆盖

**测试：** 245/245（typecheck 验证 accMessage 签名变化）

## v1.16.10 — 2026-08-15（loop 等待界面修复：loop agent 注册为子代理（origin:'subagent' + parentSession）→ WebUI 子代理活动卡实时可见）

**Scope:** 用户反馈"启动 loop 没有反馈"→ 深入调研（S134）：workflow 等待界面的真实机制 = 子 agent 活动可视化（client runtime 按 `origin:'subagent'` + `parentSessionId` 识别子代理，session 事件驱动实时显示）；而 loop agent 创建时 meta 缺这两个标记 → 不被 UI 识别 → 隐形。修复：loop agent 补标记 → 对齐 workflow 子代理可见性。

### 根因（调研结论）

- **workflow 机制**：workflow 子 agent（`agent()`）创建 session 带 `origin:'subagent'` + `parentSession` → client runtime（sessions/manager.ts:774 `frame.origin === 'subagent' && frame.parentSessionId`）归入子代理目录 → WebUI（ui-subagent/workspace 树）**session 事件驱动实时显示活跃子代理卡**
- **loop 缺陷**：`ctx.agents.create` meta 只有 `cwd` + `agentPreset`——无 `origin` / `parentSession` → client 不识别为子代理 → **UI 零可见**；v1.16.9 的 /serenity/loops 详情卡需手动展开 + 首轮响应才写盘 → 用户感知"启动无反馈"

### 修复

- **loop.ts spawnAgent**：meta 补 `origin: 'subagent'` + `parentSession`（父会话 id，`exec.agent.session.id`）→ loop agent 一创建即出现在父会话的**子代理活动卡**（对齐 workflow 机制，立即有反馈）
- **副作用正确性**：`shouldAutoRestore` 本就排除 subagent origin（loop 不恢复主会话激活）✓；subagent 路由（agent-lookup）接管普通会话消息——loop 用 `loopAgent.followup` 自主驱动（agent 对象方法，不经普通路由）不受影响
- 保留 v1.16.9 的 /serenity/loops 详情卡（轮次细节 / 并行任务可视化补充）

**测试：** 245/245（typecheck 验证 meta.origin/parentSession 类型）

## v1.16.9 — 2026-08-15（loop guide 说明命令（eap 设计方案要求/并行策略/提示词规范）+ EAP 化轮次提示词（阅读/文字类加载 eap）+ WebUI loop 等待界面（/serenity/loops + 进度卡））

**Scope:** 用户反馈 goal/workflow 不如 loop 好用 → loop 增强：① guide 说明命令（使用前先加载 eap 设计规模化方案；并行策略；提示词规范；阅读/文字类 loop 内部加载 eap）；② buildRoundPrompt EAP 化（固定详尽结构）；③ WebUI loop 等待界面（类似 workflow 进度展示：/serenity/loops 接口 + 会话头部详情卡轮询显示运行中 loop）。

### loop guide 说明命令

- **`loop guide`**（参数 `guide: boolean`）：不创建 agent，直接输出 `LOOP_GUIDE` 规模化使用指引：
  - **使用前必须先加载 eap**（acc-eap）设计规模化方案：任务拆解（E↑ 显式：目标/输入/边界/验收标准）、提示词设计（task 详尽固定符合 EAP，含正反例）、并行策略
  - **并行策略**：无依赖子任务各一个独立 loop（独立 label + task）；执行方式 = 后台 subagent / workflow parallel 阶段；并发安全已保证（sessionId 唯一 + 进度按 label 隔离）；汇总方式
  - **完成判定**：唯一 = 内部 agent 精确回显验证码；对话轮无上限；非正常停止重启 ≤100
  - **等待界面**：WebUI 详情卡显示运行中 loop 进度
- 工具 description 更新（含 guide 用法）

### EAP 化轮次提示词（buildRoundPrompt）

- **固定详尽结构**：工作规范（每轮固定）——自由工作 / **阅读整理或文字编写类工作先加载 eap（acc-eap）按 EAP 标准输出（E↑ 显式 / R↓ 可重建 / S↑ 稳定）** / 汇报具体可核验；每轮汇报固定格式（做了什么/下一步/是否完成→只输出验证码）

### WebUI loop 等待界面（类似 workflow 进度展示）

- **Node half**：`/serenity/loops` GET 接口（registerStatusApi 新增路由）——按 workspace 解析 CCC 根 → `listActiveLoops`（AGENT_SESSIONS/loop-*.json 全部进度，按 updated 倒序，坏文件跳过）；不依赖工具执行上下文（进度文件驱动，并行任务天然多行）
- **client half**：SafeModePanel 详情卡新增 **loops 区块**——展开时每 3s 轮询 /serenity/loops；显示运行中 loop（label / R轮次 / 更新时间 / 最近响应摘要，最多 5 条，done 显示 ✓）；并行任务各自一行
- CSS：`.sp-popSection / .sp-loopItem / .sp-loopHead / .sp-loopLabel / .sp-loopRound / .sp-loopTime / .sp-loopResp`（--dsw-alias-* token）

**测试：** 245/245（原 242 + 3：prompt EAP 化 / guide 内容 / listActiveLoops）

## v1.16.8 — 2026-08-14（serenity.json 规范位置修正：.opencode 优先（历史兼容，不依赖 dsh）+ 系统提示词相对路径提示行）

**Scope:** 用户指出 ACC 依赖的 CCC 文件必须兼容历史（历史在 .opencode）——serenity.json 规范位置应为 `.opencode/serenity.json`（.dsh 仅回退），localstore.gitTrack 等配置随之生效；另修复"注入绝对路径 vs 工具调用相对路径打架"——加一行提示。

### serenity.json 位置修正（历史兼容，不依赖 dsh）

- **根因**：`DEFAULT_SERENITY_CONFIG_PATHS` 原为 `['.dsh/serenity.json', '.opencode/serenity.json']`（.dsh 优先）——但 ACC 依赖的 CCC 文件历史在 `.opencode/`，.dsh 是 dsh 运行时特有目录，依赖它违背"不依赖 dsh"（本机配置实际就在 `.opencode/serenity.json`，.dsh 一直靠回退才读到）
- **修正**：`DEFAULT_SERENITY_CONFIG_PATHS = ['.opencode/serenity.json', '.dsh/serenity.json']`——**`.opencode` 规范位置（历史兼容、跨运行时一致），`.dsh` 仅作 dsh 运行时回退**
- **联动生效**：localstore.gitTrack（`localstore-ops.ts readGitTrack`）、loop.defaultModel、sessionKeeper.threshold、safeMode.blacklist 全部随路径序修正
- 全部测试/文案更新：ccc.test.ts（新增 .dsh 回退优先级用例）、context/status/ops/localstore 测试改 .opencode、keeper/loop/localstore/index/ccc 注释与工具描述同步

### 系统提示词相对路径提示（注入路径 vs 工具调用打架）

- **根因**：CCC 注入路径为绝对路径（Root / SESSION.md path），但 DSH 要求 CCC 内 read/write/edit 用相对路径——agent 混合使用易错
- **修正**：绝对路径注入**保留**（标识用），ACC 块工具清单后新增提示行：
  `CCC 内文件操作（read/write/edit/glob/grep 等）请使用相对 CCC 根的相对路径；Root / SESSION.md path 等绝对路径仅作标识，不作工具入参`
- **顺带**：accBlock 的 localstore 行描述从旧 `~/.serenity/` 更新为 `CCC 根 localstore.json + git 策略`

**测试：** 242/242（原 241 + 1：.dsh 回退优先级）

## v1.16.7 — 2026-08-14（localstore 重设计：CCC 根 localstore.json + git 提交策略 + cc_git 联动）

**Scope:** 用户反馈 localstore 设计不够好（存 ~/.serenity/ 主目录不可靠/不透明）→ 重设计：存储迁到 **CCC 根根目录 `localstore.json`**（JSON 格式，MSM 可直接读取）；新增 **git 提交策略**（可靠机制 × 用户自由）；**联动 cc_git 检查**防误提交。

### 存储位置与格式（S134 重设计）

- **位置**：`~/.serenity/credentials.yaml + settings.yaml`（主目录，YAML）→ **CCC 根根目录 `localstore.json`**（单文件，JSON）
- **格式**：JSON 顶层分节——`credentials` 保留节（凭据，key 大写蛇形）+ 其余节（config，path = section.key）：
  ```json
  { "credentials": { "HOME_GITLAB_TOKEN": "xxx" }, "loop": { "defaultModel": "..." } }
  ```
- **方便 MSM 读取**：JSON.parse 零解析依赖（弃 YAML 轻量自实现解析器）；doc 子命令更新为 JSON 规范
- **权限**：CCC 内普通文件（弃 0600/0644 chmod——git 不存权限位，安全由 git 策略承担；Windows 也更干净）
- 旧 `~/.serenity/` 数据不迁移（用户已确认清理）

### git 提交策略（可靠机制 × 用户自由）

- **配置**：`.dsh/serenity.json` `localstore.gitTrack`: `"allow"`（可提交）| `"deny"`（禁提交）
- **缺省 deny（没配就是不提交）**；且 deny 的保证**不依赖 dsh 运行**：
  - **物理保证**：`localstore` 写入时自动确保 `.gitignore` 含 `localstore.json`（`ensureLocalstoreGitignored`，写一次永久生效——即使 dsh 不在/用户手动 git commit 也不会误提交）
  - **第二道防线**：`cc_git` 联动——`checkLocalstoreGitCompliance`：文件存在 && deny && .gitignore 未覆盖 → **commit 拒绝**（throw 明确提示）+ **status 输出 warning**（不阻断）
- **allow**：放行（不写 .gitignore；文件可提交，用户自行管理）

### 其他

- `ccc.ts` SerenityConfig 新增 `localstore.gitTrack`
- `tools/localstore.ts`：execute 解析 CCC 根（findSerenityRoot），set 返回 `gitTrack/gitOk`
- 测试：`localstore.test.ts` 重写（路径/JSON 格式/双命名空间/gitignore 联动/合规检查）+ `ops.test.ts` +3（cc_git 联动：deny 拒绝 commit+warning / deny+gitignore 放行 / allow 放行）

**测试：** 246/246（原 237 + 9）

## v1.16.6 — 2026-08-14（Windows 兼容性修复（审计 4 问题 + 2 观察点）· S134 会话重启自动恢复 · loop 语义修正：移除 maxRounds，对话轮无上限，非正常停止重启 ≤100）

**Scope:** ① 落实 Windows 黑盒审计报告（S009，针对 v1.16.3）的 4 个真实问题 + 2 个观察点（跨盘路径逃逸 / reveal / wait sleep / inject 核对 / quotepath / npx.cmd）；② S134 新需求——DSH 会话重启后自动恢复最近激活的宁静号会话；③ loop 语义修正（用户反馈）——轮次不需要调用者指定，对话轮次无上限（不完成不返回），100 为非正常停止时重启 agent 的次数上限，当且仅当 agent 回显验证码才算正常结束。

### Windows 兼容性修复（审计报告落实）

- **问题 1 · cc_fs 跨盘符绝对路径逃逸（🔴 安全，P3 失效）**：`ccc.ts classifyPath` 从 `path.relative().startsWith('..')` 改为**前缀判定**（新增 `pathInside`）——跨盘时 relative 返回绝对路径原文不以 `..` 开头导致漏判；前缀 + sep 边界杜绝兄弟目录陷阱（`home` vs `home2`）；Windows 大小写不敏感由调用方按平台传 `caseInsensitive`。`resolveInside` 与 msm-ops 的 path 校验（均复用 classifyPath）一并修复。新增测试：跨盘 / 大小写 / 兄弟目录
- **问题 2 · cc_fs reveal Windows 不可用（🔴）**：win32 分支改为**目录 → `explorer <dir>`、文件 → `explorer /select,<abs>`**（原对目录用 `/select,` 语义错误）；explorer 是 GUI 子系统进程（成功也常返回非零）→ 弃 `execFileSync` 退出码判定，改 `spawn` 分离 + unref（fire-and-forget）+ error 监听静默。新增测试：win32 目录/文件分支（mock platform + spawn）
- **问题 3 · acc_kit wait 依赖外部 sleep（🟠）**：`kit-ops.ts` 弃 `execFileSync('sleep')`（Windows 无 GNU coreutils），`runKit` 改 async，wait 用纯 Node `setTimeout`——跨平台统一，无平台分支。`tools/kit.ts` 同步 await；ops 测试补 wait 用例（0 秒立即 / 1 秒耗时 / 负秒拒绝）
- **问题 4 · loop inject 缺 agents（🔴）**：**核对为已修复**——v1.16.4 已把 `'agents'` 加入 inject 列表（CHANGELOG v1.16.4 有据），本版无需改动，标注复核
- **观察点 B · cc_git status/log 中文路径转义（🟡）**：status 与 log 均加 `-c core.quotepath=false`——中文/空格路径按原文输出，避免 agent 拿八进制转义串做后续路径操作
- **观察点 A · acc_msm exec Windows 空输出（🟡）**：`.cmd` 不能被 CreateProcess 直接解析 → `execFile('npx')`/`spawnSync('npx')` 在 Windows 必 ENOENT → 新增 `NPX_BIN`（win32 → `npx.cmd`）用于两处 tsx 回退；bun 优先保留（bun.exe 可被 libuv 按 PATHEXT 解析）
- **accBlock 文案**：`wait: sleep N seconds` → `wait: wait N seconds`（不再依赖 sleep）

### S134 新需求：会话重启自动恢复

- **根因**：活跃会话标记按 scope（`agent.session.id`）隔离（v1.16.2）；DSH 重启/新开 conversation → 新 session id → 自身 scope 无标记 → Session 块不注入，需手动 `session use`
- **实现**：`session-ops.ts` 新增 `listActiveMarkers` + `restoreActiveSession`——当前 scope 无标记时，把 **mtime 最新**（最近激活）且根内有效的标记复制为当前 scope 标记（激活语义延续：use = 激活，重启自动恢复 = 重新激活）；`context.ts` session-start 播种时触发，`shouldAutoRestore` 根会话判定（subagent `origin='subagent'` / 派生 `parentSession` / loop 牛马 `loop-` 前缀 → 不恢复，维持 v1.16.2 scope 隔离）；`serenity.json hooks.autoRestoreSession` 可关（默认开）
- **测试**：+11（pathInside 3 / 恢复 6 / shouldAutoRestore 5 / wait 2 —— 计 16）

### loop 语义修正（用户反馈）

- **移除 `maxRounds` 参数**：轮次不需要调用者指定——参数 schema / description / usage 同步（原可传参导致"12 轮就返回未完成"）
- **对话轮次无上限（不完成不返回）**：`for (round ≤ roundCap)` 改为 `while(true)`——只有 stop token 命中或达重启保险阀才返回；续跑从进度 round+1 继续，不再有轮号绝对截断
- **100 = 非正常停止时重启 agent 的次数上限**：`LOOP_MAX_ROUNDS` → `LOOP_MAX_RESTARTS`——followup/waitIdle 抛错 → dispose 旧 agent + 重新 create（新 sessionId）→ 同一轮重试（不消耗对话轮号），重启计数 ≤100 防死循环
- **当且仅当验证码命中 = 正常结束**：`done` 仅在 `lastResponse.includes(stopToken)` 置 true；agent 自报完成但未回显验证码 → 继续下一轮；异常路径永不置 done
- **buildRoundPrompt**：移除 maxRounds 字段，标题 `round N/M` → `round N`（续跑时 M 误导）
- **返回**：新增 `restarts` 字段（本次调用重启次数）；usage.next 文案改"已达内部 100 次重启保险阀"
- **测试**：loop-ops 用例同步（去 maxRounds）

### 运维修复（deploy 脚本，内部不进公开仓库）

- **deploy 双挂载冲突（duplicate loader entry id: serenity-hooks）**：deploy 步骤 4 原逻辑把插件自带 `cordis.patch.yml` 的 insert 块原样追加进 profile——与 npm-install 写入的 `dsh.profile.bundles`（bundle 层挂载）对同一 loader entry 双挂载 → web 启动报 `duplicate loader entry id: serenity-hooks`。修复：`profileBundleMounted`（读 profile package.json `dsh.profile.bundles`）→ bundle 层存在则**跳过 insert 写入 + 幂等清理历史 insert**（`stripInsertBlock` 按块剥离）；无 bundle 层（纯 deploy 本地开发）才写 insert 作为唯一挂载。profile 的 cordis.patch.yml 保留 `- id: serenity-hooks` 的 config 定向覆盖（v-bundle 语义，不重复加载）——deploy 不再触碰该覆盖行

**测试：** 234/234（原 218 + 16）

## v1.16.5 — 2026-08-14（loop 修复：sessionId 唯一化 + maxRounds 降级保险阀；新增 localstore ACC 标准凭据/配置存储工具）

**Scope:** ① loop 工具修复——label 不能重复（sessionId 固定冲突）+ 语义对齐（调用者不关心轮数，硬性 while + stop token 随机码验证防提前结束）；② 新增 `localstore` 工具——ACC 标准本地凭据/配置存储（S133 设计，跨 opencode/dsh × win/mac/linux）。

**loop 修复（S134）：**

- **sessionId 唯一化**：`loop-<label>` → `loop-<label>-<uuid>`——同 label 多次调用不再冲突（session 是每次新建的临时执行载体）；label 仅用于进度文件/续跑（`AGENT_SESSIONS/loop-<label>.json`）
- **maxRounds 降级保险阀**：调用者不关心轮数——`startRound` 不再 min 截断（续跑从进度 round+1 直接继续）；maxRounds 仅作防死循环绝对上限；工具描述/参数/usage 文案同步
- **stop token 随机码验证保留（loop 本质）**：`newStopToken()` 每轮 prompt 要求精确回显 → `lastResponse.includes` 判定完成——防低智能 LLM 提前结束，零改动

**localstore 工具（S133，第 10 个工具）：**

- **ACC 标准**：一个工具管理 credential（凭据，0600）+ config（偏好，0644）两命名空间；存储 `~/.serenity/`（平台感知，win `%USERPROFILE%\.serenity\`），目录 0700，不在任何 git 仓库内
- **子命令**：`list / get / set / unset / show / doc`，`--scope credential|config`（默认 credential）
- **doc 说明子命令**：输出存储路径/格式/key 规范/权限/读写方法/安全边界——agent 可按说明直接用 fs 工具（read/write）操作
- **存储格式**：`credentials.yaml`（扁平 REF→value，key 大写蛇形）+ `settings.yaml`（命名空间分节，config path = section.key 小驼峰）
- **安全边界**：list/show 对凭据只返回 key 名不返回值；get 标记 source；权限不符报错提示 chmod
- **零依赖**：YAML 轻量自实现子集（扁平映射 + 注释），不引入 yaml 包
- **注册**：index.ts（10 工具）+ accBlock 工具清单 + dsh.plugin.json contributes.tools
- **测试**：`tests/localstore.test.ts`（16 例：路径/权限/格式/读写/doc/安全）；homedir 全程 mock 临时目录

**测试：** 218/218（原 202 + 16 localstore；register 断言 9→10）

## v1.16.4 — 2026-08-14（修复 loop ctx.agents 未 inject 运行时错误 + S131 ACC 增强：scoped 身份 section / Code Mode 适配 / EAP 块 / status 扩展 / 版本自省）

**Scope:** ① bug 修复——loop 工具与 compact 缝访问 `ctx.agents` 但插件 inject 未声明 `agents` → Cordis proxy 运行时抛 "cannot get property agents without inject"；② 实施 S131 CCE×EAP 增强研究中的插件侧可实现项（P0-1 scoped 身份 section / P0-2 Code Mode 适配 / P1-6 EAP 提示块 / P2-7 status 扩展 / P2-9 版本自省）。

**Bug 修复：**

- **inject 缺 `agents`**：`index.ts` inject 列表加 `'agents'`（AgentRegistry 服务）——loop.ts `ctx.agents.create` 与 compact.ts `ctx.agents.get` 均访问；typecheck 通过是因类型层存在，运行时 Cordis proxy 拒绝未 inject 属性

**S131 增强（CCE 存续 × EAP 表现）：**

- **P0-1 scoped 身份 section**：`registerEntrySkillSection` 升级为主动路径——session-start / pre-step 时在 agent.ctx 注册 `serenity-entry`（最近层），抗 preset/动态 Cordis 插件同名 shadow 覆盖 ACC 身份；全局 section 保留为冷恢复/未走 session-start 的 fallback
- **P0-2 Code Mode 适配**：新增 `codeModeAdaptationLine`——装配时按 `ctx.tools.get('run_code', scope)` 可见性（code|both）追加 `=== Serenity Code Mode ===` 引导块（工具须经 run_code 程序内 `await tools.*` 调用），消除 Code Mode 下按 native 语义直呼工具的 UNKNOWN_TOOL 误导；全局+scoped 两个 section 的 text 回调均接入
- **P1-6 EAP 提示块**：新增 `eapBlock`（`=== Serenity EAP ===`：E↑ 显式/R↓ 可重建/S↑ 稳定自检清单），独立块插入 Constraints 与 SKILL 之间——CCE/Constraints 受 osp-alignment 逐字节断言约束不可改，EAP 为 DSH 扩展
- **P2-7 status 扩展**：`getStatus` 增 `dshVersion`（npm 全局 dsh package.json）/`nodeVersion`（process.version）；`/serenity/status` API 增 `codeRuntime` 装配态（language/isolation，PTC/Code Mode 可用性可查）
- **P2-9 版本自省**：`acc_kit health` 增 `accVersion`/`dshVersion`（升级提示依据）

**测试：** 202/202（原 196 + 6：EAP 块 2 / Code Mode 适配行 3 / status 扩展 1）

## v1.16.3 — 2026-08-14（loop 牛马 agent 继承父会话 preset，修复 read/write 等 preset 层工具不可用）

**Scope:** loop 工具创建牛马 agent 时未 join 父会话的 agent preset → web profile 下（host 全局层 tool-fs 等被 preset 化禁用）loop agent 落在空工具层，read/write/edit 等 preset 层工具不可用。修复 = 对齐 subagent 先例：创建经 `ctx.agents.create` + setup 钩子 `agentPresets.composeFrom`，继承父 preset standing mount。

**主要变化：**

- **loop agent preset 继承**：`ctx.agentLoop.create(...)`（无 setup 钩子，裸 agent）→ `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })`；setup 钩子在 agent 未发布前执行 `agentPresets.composeFrom(childCtx, parentCtx)`，使 loop agent 获得父会话 preset 的工具层（read/write/edit 等）
- **meta.agentPreset 落库**：子 session 记录父 preset id（对齐 subagent childSessionMeta），持久化重建可还原同一组合
- **可选服务退化**：`agentPresets` 经 `ctx.get` 可选读取——无 roster 部署/父未 join preset 时跳过，loop agent 落全局工具层（历史行为），不报错
- **owned handle 清理**：`ctx.agents.create` 返回 `AgentHandle`，循环结束 `finally` 中 `handle.dispose()`（停止 loop/注销 agent/移除 session/展开 scope），不再依赖插件 fiber 兜底
- **新增纯函数模块** `src/loop-preset-inherit.ts`（`loopPresetInheritance`：解析父 preset + 组装 setup 钩子，仅 type-only 依赖 cordis，可单测）+ 测试 `tests/loop-preset.test.ts`（4 例：已 join / 未 join / 无服务 / 无父）
- **package.json**：peerDependencies 增 `@deepseek-ai/dsh-agent-presets`（optional，类型引用）；tsconfig paths 增对应映射

**测试：** 196/196（原 192 + 4：loop preset 继承四路径）

## v1.16.2 — 2026-08-14（SESSION use 按 dsh 会话隔离修复 + 发包缺陷修复）

**Scope:** ① 系统提示词 Session 块泄露修复——活跃会话标记从 CCC 级全局单文件改为按 dsh 会话隔离；② 三个发包缺陷（tarball 缺 lib/client.js / schemastery peer 范围不可满足 / README 方式二失效）。

**SESSION use 隔离（主 bug）：**

- **泄露根因**：`.dsh/active-session` 是 CCC 级**全局单文件**；系统提示词注入（systemPrompt.section 全局注册，text 回调只按 agent cwd 解析 CCC）让**任何 DSH 会话**（多开 conversation / subagent / 后台 agent / loop 牛马）都注入同一个活跃会话 → A 会话 use 的 Session 块泄漏给 B 会话，B 被引导读写 A 的 SESSION.md
- **修复**：活跃会话标记改为 `.dsh/active-sessions/<scope>`（scope = dsh 会话 id `agent.session.id`，缺省 `default`）——`useSession/closeSession/readActiveSessionMd` 按 scope 读写；系统提示词/上下文注入/turn-stopping 心跳/压缩重注入全部按当前 agent 的会话 id 取 scope；多会话互不覆盖、互不注入
- **迁移**：旧全局标记 `.dsh/active-session` 不再读取；use 时删除（迁移清理），close 顺带清理；升级后各会话重新 use 一次即生效
- **安全**：scope 文件名白名单 `[A-Za-z0-9_-]`（`.` 排除，杜绝 `..` 路径段穿越）
- **测试**：+8（scope 隔离互不覆盖 / legacy 迁移删除 / close 只清自身 scope / scope 清洗 / 心跳按 scope 隔离 / accMessage 按 scope 注入互不泄露 / osp-alignment Session 块带 scope）

**发包缺陷修复（用户报告）：**

- **tarball 缺 lib/client.js**：根因 = `npm publish` 自动运行 `prepare`，而 `tsdown.prepare.config.ts` 只构建 Node 半且 `clean: true` → **发布时 client.js 被清掉**（files/exports 已声明但包内无文件）→ DSH web 激活抛 MissingClientBundleError。修复：prepare 配置改为**复用完整双 bundle**（`export { default } from './tsdown.config.js'`，单一真相源）；`dsh-develop publish` 新增 **`npm pack --dry-run --json` 机械核对**（缺 index.js/client.js/invariant.js 任一即中止）；compliance 新增 F5（prepare 复用断言）+ E4 端到端断言 client.js 产出
- **schemastery peer 范围不可满足**：`@deepseek-ai/schemastery: ^0.1.0-rc.5` → **`^3.18.1`**（npm 实际版本 3.18.x 系列；原范围无匹配版本 → `dsh plugin add` 报 ERR_PNPM_NO_MATCHING_VERSION）。cordis 4.0.0-rc.7 在 npm 存在（已核实），无需改
- **README 方式二已失效**：`dsh plugin add github:tellmewhattodo/dsh-serenity-plugin` 安装的是仓库根包（`@shgroup/dsh-serenity-plugin`，workspace 容器、无 dsh.bundle）不会激活 → README 中英双语方式二改为 **clone + `link:<repo>/hooks/dsh-serenity-hooks`**，并警告不要用 github: 根 URL

**测试：** 192/192（原 184 + 8：session 隔离 5 + context scope 注入 1 + compliance 2）

## v1.16.1 — 2026-08-13（npm 公开发布 1.16.0 + README 补丁）

**Scope:** 公开发布 @shgroup/dsh-serenity-hooks 到 npm registry（1.16.0 成功），补插件包 README（npm 包页面显示）+ files 字段 + publishConfig access public + repository。

**主要变化：**

- **hooks/README.md**（新增）：插件包 README（安装/工具/系统提示词/配置），随包发布
- **package.json**：files 加 `README.md`；补 `license` / `repository`（GitHub）/ `publishConfig.access: public`；去 `private`
- **npm 发布**：`@shgroup/dsh-serenity-hooks@1.16.0`（2026-08-13 23:24 UTC，maintainer shgroup）；1.16.1 补 README

**测试：** 184/184

## v1.16.0 — 2026-08-13（适配 DSH 公开测试版 deepseek-ai/deepseek-harness 0.1.0-rc + 系统提示词对齐 osp 收紧）

**Scope:** DSH 公开测试版（github.com/deepseek-ai/deepseek-harness，本地运行时 0.1.0-rc.6）发布后全量适配：包/服务/事件改名 + 类型基准切换 + 系统提示词对齐 osp 收紧（去 `---` 分隔线与包裹头，CCE/Constraints/Session 逐字节一致）+ 运行时加载修复。

**公开版改名（DSH 侧）：**

- `@deepseek-ai/dsh-compact` → **`@deepseek-ai/dsh-compaction`**（压缩事件 `compact/*` → **`compaction/*`**，载荷增加 compactionId/sourceCommandId）
- `@deepseek-ai/dsh-bash` → **`@deepseek-ai/dsh-shell`**、`@deepseek-ai/dsh-bash-env` → **`@deepseek-ai/dsh-shell-env`**（服务 `ctx.bashEnv` → **`ctx.shellEnv`**）
- `ctx.httpServer` → **`ctx.webServer`**（webserver 服务改名）
- `schemastery` → **`@deepseek-ai/schemastery`**、`cordis` 运行时为 **`@deepseek-ai/cordis@4.0.1`**
- 声明合并目标改为 `@deepseek-ai/dsh-session/types`（compaction 事件类型）

**主要变化：**

- **tsconfig.json / client/tsconfig.json**：路径映射从私有 staging（`~/.dsh/source/current`）切换为**公开版已安装包**（`~/.npm-global/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/*`，0.1.0-rc.6）；类型检查全绿
- **seams/compact.ts**：监听事件 `compact/end` → **`compaction/end`**（语义不变：无 error 即成功重注入）
- **seams/env.ts / api.ts / index.ts**：`shellEnv` / `webServer` / `@deepseek-ai/schemastery` 适配；inject 列表更新
- **seams/system-prompt.ts**：① 块间拼接去掉 `---` 分隔线（对齐 osp 逐项 push 的换行拼接）；② SKILL 全文**原文直推**（去掉 `# CCC 入口技能` 包裹头，对齐 osp `output.system.push(state.skillContent)`）；③ 修复 `resolveActiveSessionInfo` 目录名解析 bug（basename(abs) → basename(dirname(abs))，Session 块正确显示会话目录名）
- **tests/osp-alignment.test.ts**（新增）：CCE/Constraints/Session 与 osp v0.8.5 参照文本**逐字节断言**（唯一例外 = Constraints 工具名 `msm_exec`→`acc_msm` 平台替换）；SKILL 原文直推 + 装配结构断言
- **package.json**：peerDeps 全部切到公开版包名（^0.1.0-rc.5）+ 新增 dsh-shell/shell-env/skill/system-prompt/agent-loop/compaction/schemastery；devDeps tsdown 0.7.5 → 0.22.14（rolldown 1.2.3 移除了 `transformPlugin`，0.7.5 无法构建）+ unrun
- **dsh.plugin.json**：engines dsh >=0.1.0-rc.5

**运行时加载修复（根因）：**

- profile 中 `~/.dsh/profiles/node_modules/@shgroup/dsh-serenity-hooks` 曾是**指向旧 staging 的符号链接**（@deepseek-ai 依赖解析到旧包名，宿主 rc.6 与插件依赖版本错配 → 工具不注册）——改为**真实目录**安装，依赖经 profile node_modules 解析到 rc.6；headless 验证：9 工具（cc_fs/session/acc_kit/cc_git/acc_msm/eap/neat/cce/loop）+ `serenity-entry` section（order -50）全部注册

**测试：** 184/184（原 178 基线 +6：osp 对齐 6 用例）

## v1.15.8 — 2026-08-09（EAP 优化：session use/close + Session 块激活 + 平台工具说明）

**Scope:** EAP 评估优化（#1 Session 块 + #2 工具清单）；用户确认 dsh session 缺 `use`（osp 有）。

**主要变化：**

- **session-ops.ts**：新增 `use`（写 `.dsh/active-session` 标记，内容 = 相对 CCC 根的 SESSION.md 路径 → **系统提示词 Session 块激活**）与 `close`（删标记）——9 子命令（list/show/create/use/close/health/qa/archive/summary）
- **tools/session.ts**：use/close 路由 + 描述更新（`ACTIVE_SESSION_MARKER` 导出）
- **system-prompt.ts**：ACC 块工具清单补**平台工具说明**（read/write/edit/glob/grep/web_search/ask_user_question/subagent/workflow/goal 等仍可用——ACC 工具是宁静号原生层，非全部工具）
- **tests**：session-ops +3（use 写标记/Session 块生效、use 未找到抛错、close 删标记）；system-prompt ACC 块断言补平台工具说明

**测试：** 178/178

## v1.15.7 — 2026-08-09（[ACC] 注入消息包含完整系统提示词 + CCC 顶层 skill 原文）

**Scope:** 用户要求：**在此处**（[ACC] 注入消息，agent.inject 通道）注入完整 ACC 系统提示词内容 + CCC 顶层 skill 原文——此前 accMessage 只有简短 4 行身份头。

**主要变化：**

- **context.ts**：`accMessage` 改为完整注入 = 简短身份头 + `serenitySystemPrompt(root)`（ACC 5 块 + CCC 顶层 skill 原文，对齐 osp system.transform）；导出供 compact.ts 复用
- **compact.ts**：复用 context.ts 的 `accMessage`（单一真相源，压缩重注入同样完整）
- **tests/context.test.ts**：+1 用例（accMessage 含简短头 + ACC/CCE/Constraints 块 + .serenity 记号发现的 tg-serenity 原文）

**测试：** 175/175

## v1.15.6 — 2026-08-09（系统提示词完整注入：5 块对齐 osp + .serenity 记号发现）

**Scope:** 用户指出：① 注入内容必须**完全参考 opencode-serenity-plugin**（不得有误差）；② CCC 的根提示词位置记录在 **`.serenity` 记号文件**中（内容 = 顶层入口 skill 名，如 tiangong-serenity 的 `.serenity` = `tg-serenity`）。

**根因：** findEntrySkills 硬编码 `home-serenity`/`acc-serenity` 名字，无法发现 tiangong-serenity 的 `tg-serenity`；且只注入 SKILL 全文，缺 ACC/CCE/Constraints/Session 块。

**主要变化：**

- **skills-discovery.ts**：入口发现改为——① **`.serenity` 记号文件内容 = 顶层入口 skill 名**（最高优先，权威语义）；② `.dsh/entry-skill` 指针兼容；③ 自动扫描 `.opencode/skills/*-serenity`；④ 自动扫描 `.dsh/skills/*-serenity`。任何 CCC（home-serenity/tg-serenity/pangu-serenity）自动发现
- **system-prompt.ts**：完整 **5 块注入，逐字对齐 osp compacting.ts system.transform**：
  1. `=== Serenity ACC ===`（ACC 身份 + CCC/Root + 9 工具清单）
  2. `=== Serenity CCE ===`（CCE 5 行为约束 + H_op，逐字）
  3. `=== Serenity Constraints ===`（Root + 文件/shell/subagent/session-first，逐字）
  4. SKILL.md 全文（该 CCC 顶层入口全量）
  5. `=== Serenity Session ===`（活跃会话 + todowrite 首位约定）
- **tests/system-prompt.test.ts**：重写覆盖 .serenity 记号发现 + 5 块注入内容断言（ACC 工具清单/CCE 5 约束/H_op/Constraints 四行）

**测试：** 174/174

## v1.15.5 — 2026-08-09（入口 skill 全文注入根因修复：inject 补 systemPrompt）

**Scope:** 用户反馈：v1.15.4 后系统提示词仍未注入。查明最终根因：**插件 `inject` 列表缺 `systemPrompt` 服务**——`ctx.systemPrompt` 在 apply 时未就绪（Cordis 依赖注入），`registerEntrySkillSectionGlobal` 的 try/catch 静默吞掉注册失败。官方对照：plan-mode `static inject = ['tools', 'systemPrompt']` 明确声明。

**主要变化：**

- **index.ts**：`inject` 加 `'systemPrompt'`（`['tools', 'httpServer', 'sessions', 'bashEnv', 'skills', 'agentLoop', 'systemPrompt']`）
- **system-prompt.ts**：注册失败改为**显式 console.error 告警**（不再静默吞错——系统提示词注入是关键能力）；成功打印确认
- **验证依据（DSH 源码）**：`assembleContextFor(agent)` 返回 `{ agent, scope: agent }`，assembly scope = agent；`systemPrompt.section` 经 ScopedLayers 全局+scoped 合并，全局 section 参与所有 assembly

**测试：** 169/169

## v1.15.4 — 2026-08-09（入口 skill 全文注入修复：agent 级 → 全局 section）

**Scope:** 用户反馈：ACC 插件必须在任何会话注入 CCC 顶层 skill（xx-serenity）全文，检查实现。查明根因：原 `registerEntrySkillSection` 用 **agent.ctx**（agent 级 scoped）注册 `systemPrompt.section`，scope 绑定脆弱，注入不可靠。

**根因（源码级）：** DSH `systemPrompt.section` 经 ScopedLayers 注册——官方惯例（plan-mode/tool-bash/goal）是**全局 ctx 注册 + text 回调按 `context.agent` 动态判断**；`AssembleContext` 被 agent 包扩展为含 `agent?: Agent`（agent/types.ts declare module 合并）。

**主要变化：**

- **system-prompt.ts**：新增 `registerEntrySkillSectionGlobal(ctx)` — **全局一次注册** `serenity-entry` section（order -50），text 回调按 `context.agent.session.header.cwd` 上溯 `.serenity` → 返回该 CCC 的顶层入口 skill **全量原文**（home-serenity + acc-serenity，sanitize 过滤治理内容）；非 CCC/无 agent 返回空。任何会话（主 agent/subagent/后台 agent）自动获得全文
- **context.ts**：移除 agent 级 `registerEntrySkillSection` 调用（全局已覆盖）与 `entrySkillSection` 配置项
- **index.ts**：apply 中调用 `registerEntrySkillSectionGlobal(ctx)`
- **tests/system-prompt.test.ts**：+2 全局注册用例（text 回调按 agent cwd 解析 CCC → 全文；非 CCC/无 agent → 空；重复注册不抛）
- **旧接口** `registerEntrySkillSection`（agent 级）保留导出兼容既有调用方

**测试：** 169/169

## v1.15.3 — 2026-08-09（safe-mode deny 提示不泄露机制：bash 直接提示不存在）

**Scope:** 用户反馈：safe-mode 下 bash 被 deny 时的错误提示泄露了 safe-mode 机制（"先关闭 .serenity-safe-on"），应直接提示 bash 不存在（与 restrict 隐藏 bash 后的模型视角一致）。

**主要变化：**

- **guards.ts**：bash deny 消息 `safe mode: "bash" 被禁用，先关闭 .serenity-safe-on` → `bash: 没有这个工具`（safe-mode 对 agent 不可见的一致性）
- **tests/guards.test.ts**：断言更新——deny 含 bash、不含 safe mode/serenity

**测试：** 167/167

## v1.15.2 — 2026-08-09（压缩保留 P2：compact/end 后重注入 ACC 身份）

**Scope:** osp/dsp 机械门控对比（第五轮）：osp 生态限制未做的 P2（压缩保留）在 DSH 有缝可做，用户同意实施；P8（GUI 审批策略）确认 DSH approval 原生已解决，关闭。

**主要变化：**

- **新增 `seams/compact.ts`** — `session/event` 监听 `compact/end`（成功，无 error）→ `ctx.agents.get(session.id)` 解析 agent → 若 cwd 在 CCC 内，`agent.inject` 重注入 ACC 身份消息（与 context.ts 共用 `accIdentityText`，恢复性注入不依赖计数）
  - 依据：DSH compact 事件语义（`compact/start` 持锁 / `compact/summary` / `compact/end` 带 error 记录失败）；压缩折叠早期注入的 `[ACC]` 消息 → 重注入防模型丢失 CCC 约束
- **index.ts**：新 Config 项 `compactRetention`（默认 true）+ 注册接入
- **tsconfig.json**：paths 加 `@deepseek-ai/dsh-compact`（staging packages/compact/compact）
- **compact.ts**：`import type {} from '@deepseek-ai/dsh-compact'` 拉入 SessionEventMap 的 declare module 合并（compact/* 事件类型化）
- **tests/compact.test.ts**：+4 用例（成功重注入 / error 跳过 / 非 compact 事件跳过 / 重复压缩每次都注入）
- **README**：拦截缝表加压缩保留行；版本/测试数同步

**测试：** 167/167

## v1.15.1 — 2026-08-09（cc_fs 补 reveal：OS 文件管理器打开路径）

**Scope:** 用户要求：cc_fs 应支持 reveal（opencode-serenity-plugin 已支持，本插件补齐）。

**主要变化：**

- **fs-ops.ts**：新增 `reveal` action（15 子命令）——Linux `xdg-open`（文件打开所在目录、目录打开自身）/ macOS `open -R`（Finder 选中）/ Windows `explorer /select,`；10s 超时；路径仍经 `resolveInside` 守卫（逃逸阻断）；返回 `{ ok, revealed }` 规范值
- **tools/cc-fs.ts**：工具描述 14 → 15 子命令
- **tests/fs-ops.test.ts**：+6 reveal 用例（打开文件→父目录、打开目录→自身、缺 path、不存在路径、逃逸阻断、CC_FS_ACTIONS 含 reveal；`vi.mock('node:child_process')` 避免真实弹窗）
- **模板 acc-fs/SKILL.md + README**：子命令清单同步 15

**测试：** 163/163

## v1.15.0 — 2026-08-09（DSH plugin 开发标准合规化）

**Scope:** 用户要求：研究 DSH 完整 plugin 开发标准（turtle-ui 参考 + 官方文档），标准成文入仓，并按标准改造插件到合规。

**标准文档：**

- **新增 `docs/plugin-development-standard.md`** — DSH plugin 开发标准成文（A 插件形态 / B bundle 清单 / C defineTool 契约 / D 拦截缝 / E 安装分发 / F 构建工程 / G 测试策略 + 本仓合规核对清单），权威来源 = DSH staging 官方文档 + turtle-ui / marisa 范例

**合规改造（B/E/F 项）：**

- **B1/B2/B3**：新增插件自带 `cordis.patch.yml`（bundle 层，`insert` 行 `name` 用包名）+ package.json 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — 官方 bundle 形态（此前用自创 `dsh.plugin.json`，官方无此字段）
- **E4**：新增 `prepare` script + `tsdown.prepare.config.ts` + `tsconfig.prepare.json` — 消费端自包含构建（git 安装场景，不依赖 sibling staging checkout、不 typecheck）
- **F1**：package.json 补 `files`（lib/ + cordis.patch.yml + dsh.plugin.json）
- **F2**：补 `peerDependencies`（cordis + @deepseek-ai/dsh-tools/agent/session/llm/host-webserver，host-webserver optional）
- **F3**：build script 对齐标准（tsc + tsdown 双 bundle）
- **load-plugin.sh / dsh-develop deploy**：profile patch 内容改为读取插件自带 cordis.patch.yml（不再硬编码 INSERT_BLOCK）——与 `dsh plugin --profile web add` 官方路径一致
- **新增 `tests/compliance.test.ts`** — 机械合规门禁（B1/B2/B3/E4/F1/F2/F3 七项）

**测试：** 150/150（+compliance 7 项）

## v1.14.3 — 2026-08-08（loop 无超时：每轮等待可永续）

**Scope:** 用户要求：loop 本身不应有超时时间，可永续。

**主要变化：**

- **loop.ts**：`waitIdle` 移除 600s 硬超时——每轮等待 agent 空闲**无时限**（loop 永续：agent 工作多久等多久，不被超时打断）；删除 reject 路径（等待不再失败）
- maxRounds 默认 100 保留（轮数上限仍是用户可配置的终止条件；停止标记优先）

**测试：** 149/149（未部署，待下次发布）

## v1.14.2 — 2026-08-08（死锁根治：acc_msm exec 异步化 + restrict 挂载修复）

**Scope:** 用户诊断确认死锁：spawnSync 同步阻塞事件循环 → MSM 自请求 3080 永不响应（最长 10 分钟/次）。

**主要变化：**

- **msm-ops.ts**：`prepareExec`（校验/协议 flag 分流）+ `runMsmAsync`（execFile + promisify + timeout kill，**不阻塞事件循环**）；`runMsm` 同步版保留（session 委派）；协议 flag（--list/--schema）兼容
- **context.ts**：pre-step 每步无条件 `syncSafeModeRestriction`（原只在首次注入分支，safe-mode 切换后 restrict 永不同步）
- **guards.ts**：restrict 诊断（lastSuccess/lastError/activeKeys）→ status API + `AGENT_SESSIONS/.restrict-diag.json` 文件通道
- **dsh-develop**：api-status（node http）、sys（白名单命令，curl 强制 --max-time 5）、read-dsh 绝对路径、restart-web 端口轮询等待
- **机制确认（DSH 源码级）**：模型 tools = assemble().toolProviders → wireSchemas(scope) → view(scope).visible（restrict-aware）；preStep 顺序 = assemble 先于 pre-step → restrict 下一 step 生效

**测试：** 149/149

## v1.14.1 — 2026-08-08（safe-mode 语义修正：只隐藏 bash + 治理文件写保护 + 版本漂移修复）

**Scope:** 用户反馈修正（v1.14.0 后）：safe-mode 只隐藏 bash（write/edit 保留）；safe-mode 是**用户能力**——agent 不可见、不可自开关；loop 工具补 task 参数 + 使用自述。

**主要变化：**

- **guards.ts**：`SAFE_MODE_DENY_TOOLS = ['bash']`（v1.14.0 曾将 write/edit 一并 restrict，修正为标准语义）；新增 **CCC 治理文件写保护**——`.serenity` / `.serenity-safe-on` 对 agent 永远 deny（safe-mode 是用户能力，agent 不能篡改/自开关）
- **system-prompt.ts**：`sanitizeSkillContent` 过滤入口 skill 原文中的"安全模式/safe-mode/.serenity-safe-on"提及——safe-mode 对 agent 不可见
- **context.ts**：身份注入文本不再提及 safe mode（同步修正）
- **api.ts**：POST 开关要求 `x-serenity-ui: 1` 头（仅 WebUI 客户端可切换；agent 侧无此能力）
- **loop.ts**：`task` 参数（调用方显式任务目标）+ 结果返回 `usage` 使用自述（供调用 agent 理解循环协议）
- **客户端 SafeModePanel.tsx**：POST 携带 `x-serenity-ui: 1`；字号 14；loop 模型标签 `loop:<model>`

**测试：** 91/91（guards 新增治理文件 3 用例；修正 restrict 断言仅含 bash）

## v1.14.0 — 2026-08-08（loop task 参数 + 使用自述；safe-mode 隐藏 bash/write/edit）

**主要变化：**

- loop 工具：`task` 参数（必填语义：告诉 loop agent 做什么）+ 每轮 `usage` 使用自述返回（调用 agent 可理解循环协议与续跑方式）
- safe-mode：开启时 restrict deny bash/write/edit（后于 v1.14.1 修正为仅 bash）
- loop lastAssistantText 读取 `data.message.content`（新版事件结构；M3 冒烟实测通过）

**测试：** 88/88

## v1.13.0 — 2026-08-08（acc_loop 工具：廉价模型 M3 牛马循环）

**Scope:** 用户需求：廉价模型 M3（MiniMax-M3）牛马循环（老 loop 等效）。

**主要变化：**

- **`src/tools/loop.ts`**：`loop` 工具（label/maxRounds/model/task/session 参数），`agentLoop.create(id,{provider,model},{cwd})` + waitIdle（`agent/status` payload 判 idle）；每轮全新 agent、无对话种子、进度文件 `AGENT_SESSIONS/loop-<label>.md/.json` 续跑
- **`src/loop-ops.ts`**：轮次提示构建（`buildRoundPrompt`）、`splitModel`、`newStopToken`；M3 provider（OpenAI-compatible `api.minimaxi.com/v1/chat/completions`）
- **profile patch**：llm-pi-ai id-targeted override（`opencode-fixed`：`api: openai-completions` + `models: [MiniMax-M3, MiniMax-Text-01]` + baseURL + 字面 apiKey）
- **`src/seams/env.ts`**：bashEnv 注入 DSH_SERENITY_ROOT/CCC/VERSION
- LOOP-DESIGN.md 调研文档（老 loop 等效性、M3 验证）

**测试：** 81/81

## v1.12.1 — 2026-08-08（WebUI 面板细节）

- SafeModePanel 字号 14；loop 模型标签 `loop:<model>` 清晰化

## v1.12.0 — 2026-08-08（cce 工具补齐：eap/neat/cce 知识工具 ACC 级完整）

- **`src/tools/acc-extras.ts`**：`eap` / `neat` / `cce` 三个知识工具（渐进式披露：无 section 返回完整框架，指定 section 聚焦）；EAP 三变量/自检清单、Neat 四铁律/五层、CCE 容器/熵/生命周期
- 工具模板技能（acc-eap/acc-neat/cce 的 SKILL.md）降级为 fallback

**测试：** 78/78

## v1.11.1 — 2026-08-08（session 委派失败回退内置 + 版本同步）

- `session` 工具：`{delegated:true, exit:1}` 时回退内置实现（其他 CCC 的 legacy session-tool MSM 委派失败不再空输出）
- 版本统一 1.11.0 → 1.11.1

## v1.11.0 — 2026-08-08（顶层 xx-serenity 入口 skill 原文 → 系统提示词 section 加强版）

**Scope:** 用户要求："顶层 xx-serenity skill 原文必须作为系统提示词注入"。

- **`src/seams/system-prompt.ts`**：`entrySkillSectionText(root)` 拼接入口 skill 原文（acc-serenity + home-serenity，dedup）；`registerEntrySkillSection(agent, root)` 经 `agent.ctx.systemPrompt.section({name:'serenity-entry', order:-50})` 注入——agent 作用域、CCC 根闭包
- 与身份注入（session-start seed + pre-step）双轨并存

## v1.10.0 — 2026-08-08（opencode skill 标准兼容）

- **`src/seams/opencode-skills.ts`** + **`src/skills/opencode-scan.ts`**：`ctx.skills.registerProvider` 扫描 `.opencode/skills/*/SKILL.md`（frontmatter name/description/whenToUse），rank 250，resourceBase = skill 目录
- opencode skill 标准的 SKILL.md 直接可被 DSH agent 加载

## v1.9.0 — 2026-08-08（ACC 标准补齐：除 loop/resident 全实现 + 版本漂移修复）

**Scope:** 对照 ACC 标准（opencode-serenity-plugin）除 loop/resident 外全部实现。

- **acc_msm**：guide 子命令 + 协议 flags（--list/--schema/--format=json）+ path 参数 type:"path" 校验（逃逸阻断）
- **session**：委派 + 全周期（create/list/show/health/qa/archive/summary）
- **eap/neat** 知识工具；**Phase 2** 访谈（session-start seed）；**shell.env**（bashEnv 注入）
- **修复**：ACC_VERSION 自动从 package.json 派生（消除与 CHANGELOG 漂移）

## v1.8.0 — 2026-08-07（CCC 入口 skill 自动注入系统提示 + WebUI 完成）

**Scope:** 用户需求：ACC 自动发现 CCC 顶级入口 skill 并注入系统提示（对应 opencode system.transform 全量注入）。

**主要变化：**

- **`src/skills-discovery.ts`**（纯逻辑）：入口 skill 发现——`.dsh/entry-skill` 指针文件（内容=skill 名）优先，回退约定 `.dsh/skills/acc-serenity/SKILL.md` → `.opencode/skills/home-serenity/SKILL.md`；`truncateContent` 超限截断
- **context.ts**：身份注入消息并入入口 skill 全文（默认上限 30000 字符，Config `entrySkillMaxChars` 可调/0 关闭）
- **WebUI 完成**：SafeModePanel 改挂 `conversation.session.header.actions`（加性 list 槽，位置满意）；客户端按 `sessionId` 查询，服务端经 `ctx.sessions.get(id).header.cwd` 解析 workspace（修复"非 CCC"误判）
- home-serenity 已建 `.dsh/entry-skill` 指针（→ acc-serenity）

**测试：** 65/65（新增 skills-discovery 5 用例）

## v1.7.0 — 2026-08-07（DSH 升级适配 + WebUI client half）

**Scope:** 适配 DSH 升级（staging-20260807T001421Z）破坏性变更 + 完成 WebUI 阶段 2（client bundle）。

**DSH 升级适配（服务端）：**
- `agent/prompt-submit` **被移除** → 迁移到 `agent/pre-step`（step 级准入，payload 对象 + PreStepDecision `enter{messages}/reject`）；ACC 身份注入改为前置消息到 `messages`
- `agent/session-start` / `agent/turn-stopping` 签名改 **payload 对象**（`{agent, ...}`）
- `PromptDecision` → `PreStepDecision`（类型）
- guards/keeper/api/工具层经新版本 typecheck 无改动（事件缝兼容）

**WebUI 阶段 2（client half）：**
- package.json：`dshClient {platform:'web', inject:[runtime]}` + `exports["./client"]`
- `src/client/`：`SafeModePanel.tsx`（输入停靠栏：ACC 版本/CCC 状态/safe-mode 开关，经 `/api/serenity/status`）+ `client/index.ts`（注册 `conversation.input.dock` 槽）
- `tsdown.config.ts`：双 bundle（node + browser），平台模块 external，`__ModuleLoader__.load` 包装
- 构建：harness tsdown 0.22.2（本仓 0.7.5 与 rolldown 1.2.3 不兼容）；产物 `lib/client.js` 3.8kB + `lib/index.js`

**测试：** 60/60（服务端）；客户端 typecheck 过新版本类型契约

## v1.6.0 — 2026-08-06（WebUI 阶段 1：状态接口 + safe-mode 开关后端）

**Scope:** WebUI safe-mode 实时开关 + 插件实时状态显示（需求：直接 WebUI 操作，非斜杠命令）。

**主要变化：**

- **`src/status.ts`**（纯逻辑）：`getStatus(cwd)`（ACC 版本/CCC 根/safeModeOn/黑名单/keeper 阈值/loop 模型）、`setSafeMode(root, on)`（写/删 `.serenity-safe-on`，守卫实时读取→写即生效）
- **`src/api.ts`**：`ctx.httpServer` 路由 `/api/serenity/status`（GET 状态 / POST 切换），同源调用无信任围栏问题
- 插件 Config 新增 `api` 开关（缺省 true），`inject` 增 `httpServer`
- `ACC_VERSION` 抽到 `src/constants.ts`（纯模块）
- **`docs/WEBUI.md`**：架构 / 服务端阶段 1 ✅ / 客户端阶段 2 计划 / 部署 / 验证清单
- 测试：`tests/status.test.ts` 5 用例；全仓 60/60

## v1.5.1 — 2026-08-06（激活门控修复：keeper 只在 .serenity 目录生效） — 2026-08-06（激活门控修复：keeper 只在 .serenity 目录生效）

**Scope:** 用户核查"只在 .serenity 存在的目录激活"——发现 session-keeper 缺口并修复。

**主要变化：**

- **keeper 激活门控**：`tools/post-execute` 先查 `findSerenityRoot(agent cwd)`，无 `.serenity` 直接放行（不计分、不提醒）。此前 keeper 在任何目录都会计分触发提醒——与"CCC 外零干预"约定不符
- 新增 `tests/gate.test.ts`：非 CCC 目录原样放行（无提醒）/ CCC 目录达阈值注入提醒——2 个用例

**激活门控全景（.serenity 门控，其余零干预）**：守卫 ✅ / 上下文注入 ✅ / 回合落盘 ✅ / **keeper ✅（本次修复）** / 工具（全局注册，CCC 外调用报错降级）

**测试：** hooks 53/53 + 根层 54/54 = 107

## v1.5.0 — 2026-08-06（知识技能对齐 native 插件现实 + DEPLOYMENT.md 运维指南）

**主要变化：**

- `acc-serenity` 入口技能更新：工具与约束改由 Native 插件提供（5 个真实工具 + 拦截缝机械守卫），知识层只承载 EAP/Neat/纪律；已重装到 home-serenity `.dsh/skills/`
- `docs/DEPLOYMENT.md`：部署步骤 / 验证清单 / 回滚 / 升级 / 常见问题

## v1.4.0 — 2026-08-06（加载机制端到端预检通过）

**Scope:** 加载路径实证 + 部署脚本修正（复制而非 symlink + schemastery shim + 预检步骤）。

**主要变化：**

- **解析链源码实证**：`boot()` 设 `ctx.baseUrl = apps/cli/config/`；workspace 链接在 `apps/cli/node_modules`（含 cordis + 全部 @deepseek-ai/*），**根 node_modules 无 cordis/schemastery**
- **symlink 陷阱确认**：symlink 插件会让 Node 按 realpath（本仓）解析内部导入 → cordis/schemastery 不可达 → **必须复制**
- **schemastery shim**：apps/cli/node_modules 无 schemastery → 插件包自身 node_modules 补链接（vendor/schemastery）
- **load-plugin.sh 重写**：构建 → 复制（保留 package.json/lib）→ shim → 预检导入 → config.yaml insert → 重启提示
- **端到端预检通过**：/tmp 模拟真实部署结构（复制插件 + 顶层 cordis/@deepseek-ai + 包内 schemastery），从 config 目录动态导入 → `插件加载成功: dsh-serenity-hooks | inject: ["tools"]`

## v1.2.0 — 2026-08-06（ACC 上下文注入缝 + 加载脚本）

**Scope:** 补齐目标中的最后两个拦截缝（session-start / prompt-submit）+ 加载就绪。

**主要变化：**

- **`src/seams/context.ts`** — ACC 上下文注入：
  - `agent/session-start`（emit）：CCC 内新会话一次性播种 ACC 身份（`agent.inject`，含 CCC 根/版本/约束摘要/loop 模型/Phase 2 提示）
  - `agent/prompt-submit`（waterfall）：每 agent 首次进入 CCC 时附加身份到 additionalContexts（Set 去重防 token 膨胀；context-only 严格 `next()` 委托）
- **`scripts/load-plugin.sh`** — 加载脚本（dry-run 支持）：构建 → 包符号链接入 DSH node_modules（--no-save 不改 git）→ `~/.dsh/config.yaml` insert 行（自动备份）→ 重启提示。边界操作已就绪，待用户批准执行
- loop.ts turn-stopping 签名对齐（turn/signal 参数）

**测试：** 51/51 vitest + typecheck 过真实 DSH 类型契约

## v1.1.0 — 2026-08-06（全量工具 + session-keeper DCP）

**Scope:** M3 非侵入部分完成——5 个真实 DSH 工具 + 4 组拦截缝。

**主要变化：**

- **新增 3 个真实工具**：`acc_kit`（health/time/wait）、`cc_git`（status/commit/push/log + 非快进建议）、`acc_msm`（list/exec/register/deregister/check + mech-registry）
- **session-keeper DCP**（`src/seams/keeper.ts`）— 照 dsh-external/tool-failure-guard 的 observe-and-enrich 模式：`tools/post-execute` 计分（write/edit=3, task=10, read/msm=1, +1 分/分钟），达阈值向 additionalContexts 折叠 `[SESSION-KEEPER-recorded-{code}]` 提醒；阈值读 `.dsh/serenity.json sessionKeeper.threshold`（缺省 150）；纯跟踪器 `KeeperTracker` 可单测
- 插件现注册 5 工具 + 4 缝：pre-execute/guard（守卫）、turn-stopping（落盘）、post-execute（keeper）
- dsh.plugin.json contributes.tools 同步 5 工具；invariant REGISTERED_TOOLS 一致

**测试：** 48/48 vitest + typecheck 过真实 DSH 类型契约

## v1.0.0 — 2026-08-06（方向修正：Native Cordis Plugin）

**Scope:** 按用户要求把实现方向修正为 **native Cordis plugin**。新增 `hooks/dsh-serenity-hooks/` 独立包——真实 DSH 工具注册 + 拦截缝机械约束。参考 `dsh-external` 组织（用户授权）已写插件校准：dsh-tool-calculator（defineTool 金标准）、dsh-my-rsi（creating-a-plugin 规范：invariant.ts + dsh.plugin.json + exec.arguments + post-execute observe-and-enrich 模式）。

**主要变化：**

- **`hooks/dsh-serenity-hooks/`**（新主产物，独立 npm 包 `@shgroup/dsh-serenity-hooks`）：
  - 插件契约：`name` / `inject: ['tools']` / `Config`（schemastery）/ `apply`，无 default export
  - **真实 DSH 工具**（`ctx.tools.register(defineTool(...))`）：`cc_fs`（14 子命令，进程内，取代 bash spawn runner）、`session`（7 子命令，AGENT_SESSIONS 全周期）
  - **拦截缝机械约束**：`tools/pre-execute` + `ctx.tools.guard`（safe-mode 写工具禁用/黑名单/路径逃逸）、`agent/turn-stopping`（活动会话心跳落盘，`.dsh/active-session` 标记）
  - `src/invariant.ts` 伴生 + `dsh.plugin.json` 清单（contributes.tools 与代码一致校验）
  - 纯逻辑层（ccc/fs-ops/session-ops）零 DSH 依赖，可独立单测
  - **typecheck 通过真实 DSH 类型契约**（tsconfig paths → staging checkout lib/types）+ **37/37 vitest**
- 技能模板层（src/templates/*）标记为**知识层（legacy，M4 收敛）**：工具技能由插件工具取代，保留 eap/neat/入口
- 参考仓库本地副本：`AI_LAB/dsh-external-refs/`（gitignored，不提交）

## v0.3.0 — 2026-08-06（native 插件设计：改核心 loop）

**Scope:** 设计里程碑。回应需求"改动核心 dsh loop 的行为"——输出 `docs/dsh-serenity-hooks-design.md`：Native Cordis 插件方案（订阅 interception seams，把 ACC 约束从 advisory 升级为机械执行）。

**主要变化：**

- **`docs/dsh-serenity-hooks-design.md`** — 完整设计：
  - 插件形态（name/inject/Config/apply，无 default export）
  - 6 个拦截缝订阅 + listener 形状（取自 DSH interception.spec.ts 官方工作示例）：
    `agent/prompt-submit`（注入/准入）、`tools/pre-execute`（安全模式/黑名单 deny）、
    `ctx.tools.guard()`（终局 deny）、`tools/post-execute`（session-keeper DCP）、
    `agent/turn-stopping`（会话强制落盘）、`agent/session-start`（Phase 2 播种）
  - 决策类型契约（PromptDecision/PreToolDecision/GuardDecision/PostToolDecision）
  - 配置对齐 `.dsh/serenity.json`（hooks 开关组）
  - 集成路径（dsh-customize 流程 + config.yaml 可行性待验证）
- 里程碑：M1 设计 ✅ → M2 最小插件验证 → M3 全 seam → M4 staging 集成

## v0.2.0 — 2026-08-06（safe-mode 协议 + init Phase 2 + 守卫映射）

**Scope:** 补全守卫层（acc-safe-mode）+ init 向导两阶段化 + 架构文档新增"守卫映射"章节（Route 1：约束映射平台机制）。

**主要变化：**

- **acc-safe-mode** — `scripts/safe-mode.ts`：on/off/status/check 控制 `.serenity-safe-on` 标记；黑名单支持前缀匹配与 `regex:` 前缀（读 `.dsh/serenity.json` / `.opencode/serenity.json`）；check 命中黑名单或根外路径返回 2
- **init 两阶段（D1 对齐）** — `src/init/init-wizard.ts`：Phase 1 骨架（git init + .serenity + 目录 + 技能安装）+ Phase 2 生成 `.dsh/PHASE2-PROMPT.md`（EAP 5 Topic 访谈：目的/Git/工作项/约束/边界）
- **守卫映射文档** — `docs/architecture-v0.md` §4：P3=fs 沙箱、审批=approval、安全模式=会话权限降级+协议、loop/resident=goal/subagent
- 安装器默认技能新增 acc-safe-mode（9 个）

**测试：** 54/54 vitest 通过（新增 safe-mode 8 项 + init-wizard 3 项）

## v0.1.0 — 2026-08-06（全量工具技能）

**Scope:** 实现全部 7 个 acc-* 工具技能（模板 + 自包含 runner），安装支持 CCC 级 + 用户级双目标。

**主要变化：**

- **acc-fs** — `scripts/cc-fs.ts`：14 子命令（root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/info/find），路径逃逸阻断 + symlink 防御 + 根保护，`regex:` find 支持
- **acc-git** — `scripts/cc-git.ts`：status/commit/push/log，非快进推送输出操作建议（绝不自动 force）
- **acc-msm** — `scripts/msm.ts`：list/exec/admin(register/deregister/check)，mech-registry.json v1+数组格式，type:"path" flag 逃逸校验，600s 超时，bun 优先/npx tsx 回退
- **acc-session** — `scripts/session-tool.ts`：list/show/create/health/qa/archive/summary，AGENT_SESSIONS/ 全周期，S### 自动分配
- **acc-kit** — `scripts/acc-kit.ts`：health（P1/P2/配置）/time/wait
- **acc-eap / acc-neat** — 知识技能（质量框架 + 协作协议）
- 安装器支持 `--scope ccc|user`（修复 user 路径 → `~/.dsh/skills`），`--force` 覆盖
- 实测：home-serenity 冒烟通过（acc-msm 读到真实 51 MSM；acc-session 读到 116 会话；路径逃逸被阻断）

**测试：** 43/43 vitest 通过（6 文件：activation/installer/cc-fs/cc-git/msm/session-tool/acc-kit）

## v0.0.1 — 2026-08-06（立项 + 骨架）

**Scope:** 仿照 opencode-serenity-plugin 开发方式，从零创建 DSH 运行时的宁静号 ACC harness。独立实现（不复用 opencode-serenity-plugin 源码），远程暂存家里私有 GitLab。

**主要变化：**

- 仓库骨架：package.json / tsconfig / vitest / bin / src / docs / tests
- CLI（`bin/dsh-serenity-plugin.js`，bun 或 node+tsx 执行）：`install` / `init` / `list` / `status`
- 激活层 `src/activation.ts`：CCC 三原则 P1（.serenity）/ P2（git）/ P3（路径二分，由 DSH fs 沙箱执行）
- 错误类 `src/errors.ts`：13 错误类（serenityCode + impact）
- 配置 schema `src/config-schema.ts`：`.dsh/serenity.json`（loop.defaultModel / sessionKeeper.threshold / safeMode.blacklist）
- 技能安装器 `src/skills/`：template-loader（{{prefix}}/{{ccc_name}}/{{date}} 占位符）+ install-skill（幂等）
- 入口技能模板 `src/templates/acc-serenity/SKILL.md`：身份/激活检测/工具映射/协作纪律

**测试：** 起步（activation + 安装器），后续随工具技能补齐。

**未决：**

- v0.1 工具集范围（acc-fs / acc-git / acc-msm / acc-session / acc-eap / acc-neat / acc-kit）— 待用户确认
- 安装目标策略（仅 CCC 级 vs 用户级全局）
