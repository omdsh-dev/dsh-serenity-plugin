---
title: trajectory 调度 — 机制、模型与时间轴（总览 v1.0）
status: 现行总览（单一入口；接口规格见 trajectory-wake-registry-design.md）
session: S142
date: 2026-09-13
decisions: D58 / D59 / D60
---

# trajectory 调度 — 机制、模型与时间轴（总览 v1.0）

> **真相源分工（避免双份真相）**
> - 本文 = **总览**：概念模型 / 两条唤醒线 / 结构全景 / 时间轴语义 / 边界 / 决策账 / 验证状态 / 概念前沿。
> - 接口与行为规格 = [`trajectory-wake-registry-design.md`](./trajectory-wake-registry-design.md)。
> - 实现 = `hooks/dsh-serenity-hooks/src/wake-registry.ts`（注册表）、`wake-scheduler.ts`（调度+投递）、`autopilot-trajectory.ts`（autopilot 周期线）。
> - 决策原始记录 = S142 `SESSION.md` §5（D58/D59/D60）与 §30（侦察 F1~F11、P-1、裁决、验证）。

## 1. 一句话

**在宁静号里，trajectory 是一等的、可并行的认知轨迹；"唤醒"就是把「未来某时刻 + 一条 message」投给某条 trajectory——可以给自己，也可以给别人；autopilot 只是"周期自唤醒"的特例。**

## 2. 概念模型

```
trajectory    一等的、可并行的、任意形态的工作轨迹（身份 = AGENT_SESSIONS/<dir>；身体 = SESSION.md）
wake          在「未来某时刻」把「一条 message」投给某条 trajectory（自唤醒 / 跨轨迹）
autopilot     周期自唤醒的特例（每 CCC **单例**）
scheduler     一个中心调度器（5min tick）负责所有注册表条目的到期投递
carrier       承载 trajectory 的 dsh 会话（可弃——Ship of Theseus，身份不随载体）
```

**五条硬约束（D58 原文推论，机制必须照此实现）**

| # | 约束 | 含义 / 后果 |
|---|------|-----------|
| C1 | **trajectory 互相可见** | 可见性用现成的 `AGENT_SESSIONS/` 目录 + `.bindings.json` 绑定，**不另建名册** |
| C2 | **唤醒 = 未来时刻 + 一条 message** | 没有别的载荷：不带依赖、不带回调、不带结果引用 |
| C3 | **无阻塞、无等待** | ⇒ **无回执语义**：发起方不 await；调度器只保证"消息已入队并被记录"，**不保证模型成功** |
| C4 | **冷热等价** | 目标可以是已加载会话（live），也可以是冷会话（自动载入）——对发起方是同一个动作 |
| C5 | **人类始终可介入** | 投递后**维持 live**（不 dispose）；且**不打断**正在跑的轮次（排队语义） |

## 3. 两条唤醒线（互不干扰，各自独立）

| | **autopilot 线** | **唤醒注册表线（新）** |
|---|---|---|
| 形态 | 周期自唤醒（interval 驱动） | 一次性（绝对时刻）+ 可自唤醒、可跨轨迹 |
| 目标 | **只能是自己**（每 CCC 单例，配置 `session` 必填） | **任意 trajectory**（`S###` 或目录名） |
| 状态存哪 | CCC 配置 `.opencode/serenity.json` → `trajectory.autopilot` | CCC 文件 `AGENT_SESSIONS/wake-registry.json` |
| 到点判据 | 距 SESSION.md 上次活动 ≥ intervalHours（+ 窗口 + `--auto` 标志） | `now ≥ at`（+ 补跑窗口） |
| 投递语 | `steer`（插入最近一步） | **`followup`**（"成为它自己那一轮"） |
| 载荷 | 四段式：轨迹焦点 / 身份锚定 / 先验偏见（自生动机 + 偏见脚本）/ 任务 | 身份锚定 + **唤醒 message** + 任务 |
| 守卫 | 全局闸 + `enabled` + 避开窗口 + `--auto` 标志 + 偏见脚本必须存在 | 全局闸（**同一条闸**） |
| 资格栅 | 有（`--auto`） | **无**（D60：任何 trajectory 均可被唤醒） |
| 实现 | `autopilot-trajectory.ts` `registerAutopilot` | `wake-registry.ts` + `wake-scheduler.ts` |
| 决策 | D59：**独立单例，不进注册表** | D58/D60 |

两条线**各自独立开关**（v1.34 S-1 解耦，用户 2026-09-15 裁决）：周期自唤醒 = `autopilotWakeEnabled`（缺省**关**）；一次性唤醒调度器 = `wakeSchedulerEnabled`（缺省**开**）。**关掉前者不再连带关掉后者**——旧实现共用一闸（`trajectoryEnabled || autopilotEnabled`）是缺陷：所有者关掉 auto-trajectory 后 wake-later 一并失效，条目静默滞留。

## 4. 结构全景

| 层 | 位置 | 说明 |
|---|---|---|
| 注册表（数据） | `AGENT_SESSIONS/wake-registry.json` | 随 CCC git；条目 `{id, target, at, message, state, createdBy, createdAt, attempts, lastResult, deliveredAt}`；原子写（tmp+rename）；**投递即终结**（一次性，不重投） |
| 调度器 | `wake-scheduler.ts` `registerWakeScheduler` | 5min tick（复用 autopilot 的 `TICK_MS`）；遍历 **live CCC**；串行投递；生命周期 disposer；`session/created` + `settings-changed` 热启动 |
| 目标定位 | `trajectory-bound.ts` `listBoundSessionIds` | `.bindings.json` **值侧反查**：目录名 → dsh 会话 id（最新绑定在前）——冷唤醒的唯一权威来源 |
| 投递 | `acquireWakeAgent` → `deliverWake` | **live 优先**（`ctx.agents.get`）→ 冷会话 `ctx.sessionController.resolveAgent`（宿主负责 preset 恢复）→ **`followup`** |
| 降级 | 同上 | `sessionController` 缺席 ⇒ 仅投递 live 目标 + **响亮诊断**（禁静默）。<br>🔴 **v1.39.3 更正（2026-09-17 实测）**：这一情形归 **「环境未就绪」** 而非「投递失败」（`notReady`）——<br>典型成因**不是** headless profile，而是 **`dsh web` 刚重启**：时钟武装时**立刻跑一次 tick**，那一拍早于懒服务就绪、也早于会话恢复 ⇒ **每次 restart 都会命中**。<br>旧实现把它当失败写进条目 ⇒ 条目被记 `attempts+1` + 一条**误导性** `lastResult`（猜"headless profile？"）= **假告警发生器**（消息实际一个没丢，下个 tick 就投成功）。<br>现行：tick **不改该条目的任何字段**（state/attempts/lastResult 全不动），只记一行 tick 日志「跳过（宿主服务未就绪）」。超窗仍由**时间**判据（2h）落 `missed`。 |
| 工具面 | `tools/trajectory.ts`（**工具名 `container_trajectory`**；v1.33 起 logbook 并入 `trajectory`，v1.34 工具名硬切为 `container_trajectory`，实现文件同步更名） | 动作 `wake-later`（**进程内**直改注册表，不 exec 脚本）；**无 list/rm**——不可回收（D60 替代控制只剩"不打断在跑轮次"+ 文件可读） |
| 配置 | `.opencode/serenity.json` | `trajectory.autopilot` → 旧 `autopilotTrajectory` → 旧 `autotrajectory`（逐级回退，**不回写**） |
| 全局开关 | 插件设置（宿主 settings） | **两条线各一个**（v1.34 S-1）：周期自唤醒 `autopilotWakeEnabled`（缺省关；迁移期回退旧键 `autopilotEnabled`，**用 `??`** 保证新键显式 false 能覆盖旧键 true）｜一次性唤醒 `wakeSchedulerEnabled`（缺省开，**无** autopilot 回退） |
| 端点 | `GET/POST /serenity/trajectory` | GET 返回 `{status, wakes}`（`wakes` = 注册表全量条目）；面板新增「唤醒注册表」只读块 |
| 契约登记 | `host/contract.ts` | `sessionController.resolveAgent`（lazy，required=false）——**冷唤醒能力的可达性探针** |

## 5. 时间轴语义（这套机制的"时间法则"）

| 项 | 取值 | 理由 |
|---|---|---|
| 精度 | **5 分钟 tick** | 用户："精度不需要很高" |
| 补跑窗口 | **≤2h 补投**；超过 → `missed` 留痕 | 停机期间的到期项既不能白丢，也不能"早上连环补跑" |
| 过期条目 | 状态推进为 `missed`，**不投递** | 一次性唤醒的语义是"那个时刻"，不是"尽快" |
| 回执 | **无** | C3；`lastResult` 只记"投递/失败"事实，不代表模型完成 |
| 失败重试 | 同一条目下个 tick 重试，直到超窗 | 失败必须写 `lastResult`（禁静默） |
| 并发 | 同 tick **串行**（跨 CCC 依次）；单条 fire-and-forget | 防模型并发挤兑 |
| live 处置 | 投递后**维持 live** | C5（人类可随时接管；同 autopilot 前台语义） |
| 打断 | **不打断**在跑的轮次 | `followup` 是排队语义 |
| 循环感知 | 无（A 唤醒 B、B 唤醒 A 是允许的） | C2/C3 决定它只是两条 message，不构成死锁也未定义"等待" |

## 6. 边界（与谁不重叠）

| 邻居 | 关系 |
|---|---|
| **宿主 `@deepseek-ai/dsh-schedule`** | **不复用**。它是"会话内提醒"（投递给用户看）、明确**不唤醒冷会话**、状态在会话日志；本机制是"轨迹自续"（投给模型继续干活）、**冷唤醒是核心**、状态在 CCC 文件。理由详见设计文档 §8 |
| `handyman` / `subagent` | 都是"**现在**派一个子 agent 干活并**等结果**"；本机制是"**未来**投一条消息并且**不等**"（正交） |
| `container_trajectory rebuild` | rebuild 解决"载体重置"；本机制解决"载体何时被唤醒"（互补；v1.33 起 rebuild 与 wake-later 同属 `container_trajectory` 工具） |
| keeper / compaction | 解决上下文预算；本机制不感知上下文，投递即入队 |
| CCE 连续性 | 本机制是**时间轴上的连续性工具**：轨迹在没人看着的时候也能被自己的安排推动（见 §9） |

## 7. 决策账（原始记录在 S142 SESSION.md）

| # | 决策 |
|---|---|
| **D58** | trajectory 一等；`autopilot-trajectory` → `trajectory`；唤醒 = 一条 message；无阻塞无等待；一个中心调度器 |
| **D59** | autopilot **独立单例**，不进注册表（用户："autopilot 只允许一个"） |
| **D60** | **不设资格栅**：任何 trajectory 均可被写入并被唤醒（不用 `--auto` 把关）⇒ 以"可审计 + 可回收 + 不打断在跑轮次"替代入口栅 |
| I-1 | 命名与配置按默认：工具硬切、`trajectory.autopilot`、端点 `/serenity/trajectory`｜⚠️ 原 `trajectoryEnabled` 键 **v1.34 已被 S-1 解耦取代**（见下行） |
| I-4 | 守卫按默认：≤2h 补投 / 串行 / 维持 live｜⚠️ 原"**共用全局闸**"**v1.34 已废**（S-1：两条线各一个闸） |
| **S-1** | **闸解耦 + 更名**（用户 2026-09-15）：`autopilotEnabled` → `autopilotWakeEnabled`（只管周期自唤醒，缺省关）｜`trajectoryEnabled` → `wakeSchedulerEnabled`（缺省开）｜面板拆两行。**根因**：共用一闸导致"关 auto-trajectory 连带关 wake-later" |
| P-1 | 冷唤醒路径验证（见 §8） |

## 8. 验证状态（诚实账）

**P-1（读码+契约+生产先例）**

| 待证项 | 状态 |
|---|---|
| ① 冷持久化会话 `resume` 能重建 agent 并保留历史 | ✅ 生产已证（dsp 微信桥固定 id resume-or-create；宿主 `resume.e2e.ts` 同型） |
| ② 对 idle agent 投递一条消息会起一轮 | ✅ 契约已证（`followup`："wake the driver"；`steer`："an idle driver starts a turn"）+ 生产在用 |
| ③ live/resume 双所有权 | ✅ 机制已证（`sessionController.resolve` live 优先 + resume 去重；skiff v1.27.3 亦按此修好） |
| ④ 插件侧能否取到 `sessionController` | ✅ **本次 dev 部署实测通过**：`dashboard health` → `hostContract ok / checked:40 / issues:[]` |
| ⑤ WebUI 创建的会话冷唤醒后能否正确续号/渲染 | ⏳ 待端到端实测 |
| ⑥ 用户同时打开同一会话时 | ⏳ 待实测（设计上由 live 优先化解） |

**门禁**：`typecheck`（node+client）✓ ｜ `typecheck-host 0.1.5-rc.2` ✓ ｜ `test` 82 files / 1213 tests ✓ ｜ `build` ✓ ｜ `pack-check` ✓（98 文件）

## 9. 概念前沿：**trajectory 序列 × 时间序列**（假说，待检验）

> 用户 2026-09-13：「我在考虑 trajectory 序列和时间序列之间的关系」。本节把它做成**可检验**的表述，明确标注为假说。

### 9.1 观察

一条 trajectory 在时间轴上的存在形态是 **S(t)**：它在时刻 t 的状态（SESSION.md 的内容 + 会话语境）。唤醒事件 {t₁, t₂, …} 是**采样时刻**。于是**一条 trajectory 天然就是一条序列**。

但与我们熟悉的时间序列相比，它有一个**反常的性质**：

> **采样网格是内生的（endogenous sampling）**——采样时刻由被观测系统自己安排（`container_trajectory wake-later`），而不是由外部观察者给定（autopilot 的 `intervalHours` 是半内生：由 CCC 配置，但节奏固定）。

经典时间序列的采样是外生的（仪器定时采集）；我们这里**被观测者就是采样器**。

### 9.2 由此得到的四个可检验预言

| # | 预言 | 检验方式 |
|---|------|---------|
| **H2-a 混叠** | 若唤醒间隔长于"环境事件的特征时间尺度"，轨迹看到的世界会**失真**（遗漏/错序：待办过期、状态被别的轨迹改过而它不知道） | 把某条自治轨迹的 cadence 从 2h 调到 12h，统计其处理项中"已被外部改动/已过期"的比例是否上升 |
| **H2-b 自采样漂移** | **连续无外部输入的唤醒**（= 梦）产生的状态是上一状态的函数 ⇒ 序列自相关上升、新增信息量下降 | 统计自主轮：连续轮次下 `SESSION.md` 新增内容的"新信息比例"（新实体/新决策 vs 复述）随轮数递减 |
| **H2-c 跨轨迹脉冲** | 一次跨轨迹唤醒 = 对**另一条序列**的脉冲；其影响可观察（脉冲响应） | 唤醒 S151 并立即给另一条轨迹登记跨轨迹唤醒，比较该轨迹随后 N 轮的产出量与基线 |
| **H2-d 异构采样率陷阱** | CCC 内多条轨迹各有 cadence ⇒ 在它们之间做因果/因果性推断极易犯**时间聚合谬误** | 用"某轨迹在第 k 轮看到的状态"去解释"另一轨迹第 j 轮的行为"时必须先对时（align），否则结论不可靠 |

### 9.3 与既有讨论的接口

- **H2-b 与"梦"**：无外部输入的自主轮 = 自采样 = 梦。这独立地印证了 S142 §12 的 **E-判据**（离线循环必须声明**取料入口**与**回锚出口**）——在时间序列语言里，E-判据就是"**这条序列有没有外生输入项**"。
- **H2-a 与 H1（§11.2 消化带宽）**：H1 说自改进的转速上限 = 人类消化带宽；H2-a 说的是**采样下限**——低于环境特征尺度就会失真。两者一起给出一个"可用区间"：**采样太快浪费（无新信息 + 烧 token），太慢失真（混叠）**。
- **与 CCE**：时间序列要有意义，前提是**被测系统在各采样点上是同一个系统**。载体可弃（Ship of Theseus）+ SESSION.md 为身体 + rebuild = **维持序列的身份同一性**。⇒ CCE 的连续性正是"trajectory 能成为一条序列"的**先决条件**。

### 9.4 术语提案（供裁决）

| 词 | 含义 |
|---|---|
| **trajectory 序列** | 一条 trajectory 的状态在时间上的有序集合 S(t)（不含外部时钟约定） |
| **时间序列** | 采样网格**外生且均匀**的序列（经典意义） |
| **自采样序列**（提案新词） | 采样时刻由系统自身安排的序列——宁静号的 trajectory 即此形态 |

### 9.5 诚实边界

以上是**形式化类比 + 可检验预言**，不是已证结论。其中 H2-a/H2-b 只需现有账目（SESSION.md、autopilot-todo、weixin 日志）即可做首次统计，**不需要新机制**；H2-c/H2-d 需要设计一次对照实验。

## 10. 未决与下一步

| # | 事项 | 状态 |
|---|------|------|
| V-1 | ⑤ 冷唤醒端到端（WebUI 建的会话）+ ⑥ 并发打开 | ⏳ 用户正在测试 |
| N-1 | CCC 自身配置迁移 `autopilotTrajectory` → `trajectory.autopilot` | 未做（回退读已就绪，随时可迁；迁移属 CCC 侧变更） |
| N-2 | 文档扫描（README/docs/模板/MSM 帮助） | 已完成（只改现行文档；CHANGELOG 与 `docs/review/*` 保持原样） |
| N-3 | 发布（version bump + CHANGELOG + npm/GitHub） | **待用户显式下令**（D14） |
| N-4 | §9 的 H2-a/H2-b 首次统计（零新机制） | 待裁决 |
| N-5 | 循环唤醒（A↔B）是否需要防环 | 未定义即不限制（C2/C3 下不构成死锁）；如需要应作为独立决策 |
