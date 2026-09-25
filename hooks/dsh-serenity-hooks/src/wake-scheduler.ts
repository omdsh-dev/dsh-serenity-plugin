/**
 * wake-scheduler.ts — trajectory 唤醒调度器（D58/D59/D60；S142 2026-09-13）
 *
 * 一个**中心调度器**（5min tick，复用 autopilot 的节律常量），处理 CCC 唤醒注册表里
 * 到期的条目：把「未来时刻 + 一条 message」投递给目标 trajectory，**fire-and-forget**
 * （无阻塞、无等待、无回执——发起方不 await，调度器不替模型结果负责）。
 *
 * 与 autopilot 的关系（D59）：**两个 tick 各自独立**。autopilot 是每 CCC 单例的
 * 周期自唤醒，逻辑一行不碰；本模块只处理注册表的一次性唤醒条目。
 *
 * 投递路径（P-1 证据链见 SESSION.md §30.6）：
 *  1. target（S### / 目录名）→ 目录名 + SESSION.md
 *  2. 目标 dsh 会话 id：`.bindings.json` 里绑定该目录名的会话（按绑定时间倒序，权威）
 *     → 回退：live 会话标题匹配
 *  3. agent：**live 优先**（`ctx.agents.get`）→ 冷会话走 `ctx.sessionController.resolveAgent`
 *     （宿主实现：live 优先 + resume 去重 + 由会话元数据恢复 preset）
 *     → `sessionController` 缺席 ⇒ 仅投递 live 目标，**不静默**（v1.39.3：**归为"环境未就绪"**
 *       而非"投递失败"，见 `WakeDeliveryResult.notReady` —— 启动那一拍早于懒服务就绪是常态）
 *  4. 投递：`agent.followup(...)`（"Queue an ordinary follow-up turn and wake the driver"）
 *
 * 守卫（2026-09-21 起**本钟无闸**）：🔴 **恒武装**——原 `wakeSchedulerEnabled` 已砍，
 * 本钟不再有「可被误关的开关」；旧配置残留该键**静默忽略**，且**不**回退 `autopilotEnabled`｜
 * CRO 阶段另有**独立**总闸 `croEnabled`（只停 CRO，**不影响**本注册表投递）｜
 * 补跑窗口 2h（超窗置 missed 留痕）｜同 tick 串行｜唤起后维持 live（人类可介入）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { findSession, sessionsRoot } from './trajectory-ops.js'
import { listBoundSessionIds } from './trajectory-bound.js'
import { evaluateCro, listCroTrajectories, readCroSnapshotInput, renderCroOutcome } from './cro.js'
import { runningCarriersOf } from './cro-turns.js'
import { appendCroWakeLog } from './cro-log.js'
import { hostAgents, hostService } from './host/access.js'
import { registerDisposer } from './host/effect.js'
import { readSimpleSettings } from './settings-section.js'
import { createClock, type ClockOptions, type ClockRuntime } from './clock-runtime.js'
import { listCccs } from './ccc-roots.js'
import { isoLocal, localHuman } from './time.js'
import {
  finalizeWake,
  loadWakeRegistry,
  purgeFinalizedWakes,
  splitDueWakes,
  updateWake,
  WAKE_CATCH_UP_MS,
  type WakeEntry,
} from './wake-registry.js'
import { PLUGIN_SOURCE } from './message-source.js'

/**
 * ── 🔴 2026-09-25 I2 收敛（约束文档 §2.7 违反清单，L1 违反之一）────────────────
 * **`Context`（cordis）import 已清除**，本文件全部 `ctx` 参数类型 → `unknown`。
 *
 * 🔴 **本处是本清单上第三次「按文件整档」判错的实例**（前两次见 `ccc-roots.ts`
 * 与 `cro-turns.ts`）。本文件原被并进"**真依赖档**"，理由是"它用了 `Agent` 的
 * `followup`/`steer`"—— 但那证明的是 **`Agent` 是真依赖**，**不能顺带证明
 * `Context` 也是**。逐符号查证后：
 *   · `Agent` ⇒ ✅ **真依赖**（`followup`/`steer` **真被调用**；参与返回类型）⇒ **保留**。
 *   · `Context` ⇒ ❌ **纯透传档** —— 本文件 `ctx` 的**全部**去向是交给 L0 取数口
 *     （`hostAgents(ctx)` ／ `hostService(ctx,…)` ／ `listCccs(ctx)` ／
 *     `registerDisposer(ctx,…)`）或**转发给同文件内的其它函数**；
 *     🔵 **证据（可重跑）**：`ctx.` 在本文件**代码中 0 命中**（唯一命中在 :15 的注释里）。
 *     而上述四个被调方的签名**本就写作 `ctx: unknown`**（`host/access.ts` ／
 *     `host/effect.ts` ／ `ccc-roots.ts`）⇒ 该 import **未参与任何类型检查**。
 *   · 顺带化简 :145 的 `clockOpts.ctx as Context`（`ClockOptions.ctx` 本就声明 `unknown`）
 *     与 :322 的签名 —— 那两处 cast 都是**为了迁就一个没人需要的类型**。
 * ⇒ 🆕 **判据（第三次印证）**：**分档必须逐符号做**；"用了某个宿主类型"**不能**推出
 *   "这个文件的所有宿主 import 都是真依赖"。
 */

/** 宿主 sessionController 的最小形态（`resolveAgent`：live 优先，否则 resume） */
interface HostSessionController {
  resolveAgent?: (sessionId: string) => Promise<{ agent?: Agent; error?: unknown }>
}

/** 投递结果（写回条目的 lastResult；人读） */
interface WakeDeliveryResult {
  ok: boolean
  detail: string
  /**
   * 🔴 **环境未就绪**（不是投递失败）——只有一种情形：目标需要**冷载入**，而宿主此刻**还没把
   * 懒服务 `sessionController` 供上来**（典型 = `dsh web` 刚重启：时钟武装时**立刻跑一次 tick**，
   * 那一拍早于懒服务就绪、也早于会话恢复）。
   *
   * 为什么要把它和"真失败"分开（2026-09-17 实测，S142 §0t）：
   * 旧实现把这一情形当成投递失败写进条目 ⇒ ① `attempts` 无端 +1 ② `lastResult` 留下一条
   * **误导性错误**（原文猜"headless profile？"，而真因是**重启窗口**，属**假陈述**）
   * ③ 注册表/面板里出现"失败的投递"，**每次 restart 都必然复现**——一个**假告警发生器**
   * （所有者 2026-09-17 就是被它引来的）。而消息**从未丢失**：下一个 tick 就投成功了。
   * ⇒ 判据：**"宿主服务还没起来"不是投递结果**，不得计入条目。
   */
  notReady?: boolean
}

/**
 * 调度器**进程态**（诊断用，模块级 = 进程级，正是诊断对象）。
 *
 * 为什么需要它（R↓，2026-09-14 F 段缺陷）：调度器此前**没有任何可观测面**——
 * "条目为何一直是 pending" 只能靠反推。有了这几个字段，`acc-diag` 一次调用即可回答
 * "时钟是否武装 / 上次 tick 何时 / 为何跳过"。
 *
 * C6b（P2）：字段由 {@link ClockRuntime} 提供（**工厂那份**，字段名与语义一个字未改）；
 * 此处只把 `lastTickLog` 收为**必需**（本钟独有，autopilot 没有它——现状稿 §2.4）。
 */
type WakeSchedulerRuntime = ClockRuntime & { lastTickLog: string[] }

/** 目标定位：目录名 + SESSION.md 绝对路径 */
interface WakeTarget {
  dirName: string
  mdPath: string
}

/**
 * 解析条目的 target（`S###` 或完整目录名）→ 目录名 + SESSION.md 路径。
 * @param root CCC 根
 * @param target 条目里的目标标识
 * @returns 命中返回目录信息，未命中 null
 */
export function resolveWakeTarget(root: string, target: string): WakeTarget | null {
  const found = findSession(sessionsRoot(root), target)
  if (!found) return null
  const mdPath = join(found.path, 'SESSION.md')
  if (!existsSync(mdPath)) return null
  return { dirName: basename(found.path), mdPath }
}

/**
 * 🔴 **本钟的全局闸已于 2026-09-21 砍掉**（所有者令逐字：「**send-later 的开关不再重要了，砍掉**」）。
 *
 * **为什么砍**（R↓）：唤醒已从"可选实验能力"长成**全容器的续接绳**（🔵 **术语说明，2026-09-23 补**：
 * **"绳" = 我们对自己用 `send-later` 给自己排的"定时叫醒"条目的俗称** —— 一条链每轮给自己排下一根，
 * 链才不断。本仓注释与 SESSION.md 沿用此说法，**它不是产品名、也不是宿主概念**）——S142/S151/S185 的链、
 * 跨轨迹投递、`send-now`/`send-later` 都走它。留一个"能被误关的开关"的**代价**是
 * "整条链静默停摆且无人告警"（本仓已实测过同族事故：闸关 6.6h 零 tick、断链 1 天 14 小时）；
 * 而**收益**只剩"关掉一个 5min unref 空检查"。⇒ **收益 < 代价，故删闸**（不是改为缺省开——是**没有这个键了**）。
 *
 * ⚠️ **兼容**：旧配置文件里残留的 `wakeSchedulerEnabled` **静默忽略**（无回退键、无告警噪声；
 * 与旧 `bootstrap` 段的处置先例一致）。**机制本身一行未动**（所有者："我说的只是开关"）。
 *
 * 历史（勿误读）：v1.34 S-1 曾把两闸解耦（周期自唤醒 `autopilotWakeEnabled` / 本钟 `wakeSchedulerEnabled`），
 * 理由是"关 auto-trajectory 不得连带关一次性唤醒"；随 ACC 侧 autopilot 于 v1.35.0 整段退场，
 * 两闸只剩本钟一座 ⇒ 现已整座移除。详见 `docs/trajectory-scheduling.md` §S-1 与 v1.44 CHANGELOG。
 */

/**
 * 🔴 **本钟的串行域**（C6b 硬约束）：`clock.chain` 是**本实例私有**的——
 * 与 autopilot 的串行链**零共享**。autopilot 每轮跑 CCC 偏见脚本可能阻塞数十秒，
 * 共用链会把一次性唤醒一起卡住（这正是 P1 被否、取 P2 的理由，见 SESSION §12.8②）。
 *
 * **为什么这里是模块级常量**（而不是 `registerWakeScheduler` 的局部量）：本钟的进程态是
 * **进程级可观测面**（`acc-diag` ①b / `containerClocks` 在读），且 `wakeSchedulerState()` /
 * `__resetWakeSchedulerStateForTest()` 是**公开导出**、可在未装配时被调用 ⇒ 实例必须**恒在**
 * （旧实现的 `schedulerRuntime` 也正是模块级常量）。装配只做 `clock.start()`。
 */
/** 本钟的装配项（`ctx` 由 {@link registerWakeScheduler} 在装配点填入） */
const clockOpts: ClockOptions<string[]> = {
  label: 'trajectory 唤醒调度器',
  ctx: undefined,
  events: ['session/created', 'serenity/settings-changed'],
  // 🔴 无闸（2026-09-21 砍掉 `wakeSchedulerEnabled`）：**恒武装**。工厂的 `gate` 是可选能力，
  //    本钟不再使用它 ⇒ 永不因闸跳过（`lastSkipReason` 只由 tick 内的真实原因写，如"无 CCC 可扫"）。
  body: () => runWakeTick(clockOpts.ctx),
  // `countBeforeBody` 缺省 false：本钟 `ticks` = **真跑完**的 tick 数（既有语义，勿改）
  logFrom: { prefix: '[serenity-hooks] trajectory 唤醒 ', lines: (lines) => lines },
  startLog: () => '[serenity-hooks] ✓ trajectory 唤醒调度器启动（5min tick）',
}
const clock = createClock(clockOpts)

/** 调度器进程态快照（只读）。
 *  ⚠️ `enabled` 对**本钟已无意义**（2026-09-21 起无闸 ⇒ 恒 `true`）；保留字段只为沿用工厂快照形状。
 *  "这轮为什么没被唤起"现在看 `armed` / `lastSkipReason`（tick 内真实原因）+ **CRO 闸**（见 `croEnabled`）。 */
export function wakeSchedulerState(): WakeSchedulerRuntime & { enabled: boolean } {
  return clock.snapshot() as WakeSchedulerRuntime & { enabled: boolean }
}

/** 测试用：复位进程态（避免用例间串味） */
export function __resetWakeSchedulerStateForTest(): void {
  clock.reset()
}

/**
 * 取目标 agent：live 优先 → 冷会话走 sessionController.resolveAgent → 标题回退。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param dirName 目标 trajectory 目录名
 * @returns 命中返回 agent 与取得方式（how 进 lastResult，便于诊断）；未命中返回原因
 *   （原因带 `notReady` = **环境未就绪**而非投递失败，调用方**不得**据此记一次失败）
 *
 * 🔴 **前置条件：本轨迹名下必须有一条「未取代」的绑定记录**（2026-09-20 回源码答复 S151 实测）：
 * 选人是**遍历 `listBoundSessionIds(root, dirName)` 给出的 id**（按绑定时间倒序），**live 只是这条
 * 记录的一个加分项**——「绑定里的那条恰好 live ⇒ 直接注入」，否则走冷载入。
 * ⇒ **「有 live 会话」≠「有绑定」**：会话活着但该轨迹**零条未取代绑定**时，本函数**直接返回
 * `无绑定会话记录…`**（`send-now` / `send-later` 到点投递同此判据）。
 * 实证（2026-09-20）：S142 三条旧绑定于 **08:03** 被 `supersededAt` 取代（D69「同轨迹只留一条」），
 * 而当前载体的绑定**直到 17:05 那次 rebuild 才写入**（`queueRebuild` 内的 `appendBound(action:'rebuild')`）
 * ⇒ **10:42 的 `send-now` 落在这个窗口里** ⇒ 报"无绑定会话记录"（当时确有 live 会话）。
 * ⚠️ 已知**注释漂移**：本行上方"→ 标题回退"在函数体内**没有对应分支**（标题回退属 v1.29.2 R2，
 * 现行实现已只认绑定）；**仅登记，未改**（改它属 ACC 代码改动，须具名令）。
 */
async function acquireWakeAgent(
  ctx: unknown,
  root: string,
  dirName: string,
): Promise<{ agent: Agent; how: string } | { error: string; notReady?: boolean }> {
  const agents = hostAgents(ctx)
  const ids = listBoundSessionIds(root, dirName)
  for (const id of ids) {
    const live = agents?.get?.(id) as Agent | undefined
    if (live) return { agent: live, how: `live(bound ${id})` }
  }
  if (ids.length > 0) {
    const sc = hostService<HostSessionController>(ctx, 'sessionController')
    const resolved = sc?.resolveAgent
    if (typeof resolved !== 'function') {
      // 🔴 这是**环境未就绪**，不是投递失败（见 `WakeDeliveryResult.notReady` 的说明）：
      //    典型成因 = `dsh web` 刚重启，启动那一拍早于懒服务就绪 / 早于会话恢复。
      //    ⚠️ 文案必须**说真话**：旧文猜"headless profile？"是错的猜测（真因常常是重启窗口），
      //    实测把维护者都引偏过一次 ⇒ 两种成因都要说，并点明"下个 tick 会重试"。
      return {
        error:
          `宿主尚未就绪：目标会话未加载，且 sessionController 服务此刻不可用` +
          `（重启后的启动窗口，或本进程确实无该服务）——绑定 id: ${ids[0]}`,
        notReady: true,
      }
    }
    const id = ids[0] as string
    try {
      const out = await resolved.call(sc, id)
      if (out?.agent) return { agent: out.agent, how: `cold-resume(${id})` }
      return { error: `sessionController.resolveAgent 未返回 agent（${id}）: ${String(out?.error ?? '未知原因')}` }
    } catch (err) {
      return { error: `冷会话载入失败（${id}）: ${String((err as Error)?.message ?? err)}` }
    }
  }
  return { error: `无绑定会话记录（AGENT_SESSIONS/.bindings.json 中无 ${dirName}）——目标轨迹需先被 container_trajectory use 激活过` }
}

/** 唤醒消息（唤起即投递正文：身份锚定 + 唤醒信息 + 任务） */
export function buildWakeText(entry: WakeEntry, target: WakeTarget): string {
  return [
    `[trajectory 唤醒] 到点（登记于 ${entry.createdAt}，发起者 ${entry.createdBy || '未知'}，id ${entry.id}）。`,
    // v1.39.2（S142 §0r，所有者令「注入时除了内容再带上当前时间」）：目标据此判断"现在几点"，
    // 不必去翻系统提示或自己算——尤其是**冷载入**的目标，它的上下文里没有任何近期时间锚。
    `当前时间：${localHuman()}（当地时区）。`,
    '',
    `身份锚定：继续 ${target.dirName} 的 trajectory（SESSION.md: ${target.mdPath}）。`,
    '',
    '唤醒信息：',
    entry.message,
    '',
    '任务：按上述唤醒信息继续本轨迹的工作；完成后把进展写入 SESSION.md。',
  ].join('\n')
}

/**
 * 投递一条唤醒（fire-and-forget：`followup` 入队即返回，不等模型结果）。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param entry 唤醒条目
 * @returns 投递结果（写回 lastResult）
 */
export async function deliverWake(ctx: unknown, root: string, entry: WakeEntry): Promise<WakeDeliveryResult> {
  const target = resolveWakeTarget(root, entry.target)
  if (!target) return { ok: false, detail: `目标 trajectory 未命中（${entry.target}）` }
  const acquired = await acquireWakeAgent(ctx, root, target.dirName)
  if ('error' in acquired) return { ok: false, detail: acquired.error, notReady: acquired.notReady === true }
  try {
    acquired.agent.followup(createUserMessage({ content: [{ type: 'text', text: buildWakeText(entry, target) }], source: PLUGIN_SOURCE }))
  } catch (err) {
    return { ok: false, detail: `投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
  }
  return { ok: true, detail: `已投递 ${target.dirName}（${acquired.how}）` }
}

/**
 * 即时消息正文（**刻意不复用** {@link buildWakeText}）：唤醒文本以「**到点**（登记于…）」开头，
 * 对即时投递那是**错的事实**。本函数显式区分"这是即时消息、不是到点唤醒"。
 *
 * ⚠️ **v1.39.2 起"已入队"这句话必须删掉**（S142 §0r，所有者令「不排队、直接即时注入」）：
 * 旧文案写"消息已进入你的队列；你此前若正在跑轮次，它在本轮结束后生效"——
 * 那是**旧的 followup 语义**；现在在跑的目标走 `steer`（当场注入当前轮），
 * 留着这句话就是**注入一条假陈述**（比没有更坏：目标会误判自己看到它的时机）。
 * @param target 目标轨迹（目录名 + SESSION.md）
 * @param message 递送正文
 * @param sender 发起者轨迹标识（供目标与人类识别来源）
 */
export function buildSendText(target: WakeTarget, message: string, sender: string): string {
  return [
    `[即时消息] 来自 ${sender || '未知轨迹'}。当前时间：${localHuman()}（当地时区）。`,
    '',
    `身份锚定：继续 ${target.dirName} 的 trajectory（SESSION.md: ${target.mdPath}）。`,
    '',
    '消息：',
    message,
    '',
    '说明：这是**即时投递**（不是到点唤醒）——它**不排队**：目标正在跑轮次就**当场注入当前轮**，' +
      '目标空闲则立即起一轮。处理完照常把进展写入 SESSION.md。',
  ].join('\n')
}

/**
 * 即时投递（`container_trajectory send-now`）——与 `send-later`（预约）**共用取用通路**（`acquireWakeAgent`），
 * 区别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）：
 *   · `send-later`（原 `wake-later`）：未来时刻 + 一条 message → 落注册表 → 本文件的调度器到点投递（**fire-and-forget，无回执**）
 *   · `send-now`（原 `send-message`）：**此刻**把一条 message 递给目标 → **同步回执** → **不落注册表**
 *
 * **为什么冷路径落在这里（R↓，2026-09-16 所有者裁决）**：`addWake` 显式拒绝 `at ≤ now`
 * （"时刻必须在未来"——那是"**预约**"语义的地基，不许放宽）⇒ 即时投递**不能**靠一条
 * `at=now` 的注册表条目实现（那还会让调度器把一次性即时投递当 `pending` **每 tick 重试**）。
 * 必须直接走 {@link acquireWakeAgent}（live 优先 → `sessionController.resolveAgent` 冷载入）。
 * 这正对应所有者要的「**会话不活跃则等效于直接 wake**」：**同一条冷载入通路**，只是**不等 tick**。
 *
 * ⚠️ **承诺边界（不许含糊）**：回执只到「**已注入 / 已起轮**」（宿主调用未抛错），
 * **到不了**"目标已执行/已答复" —— 与 `deliverWake` 同一层。
 * 判"目标真的动了"必须用**文件级判据**（它自己的 SESSION.md），
 * **不得凭回执结案**（§12.B 的 `delivered ≠ 跑了一轮`）。
 *
 * 🔴 **v1.39.2 语义变更（S142 §0r，所有者 2026-09-17 令：「希望 send message 时不排队，
 * 可以直接作为提示词即时注入进去」）**：
 * 旧实现一律 `followup`（宿主注释：*Queue an ordinary follow-up turn*）⇒ 目标**正在跑轮次**时
 * 消息**排在轮次边界**（即旧文案的"不打断当前轮"）。现按宿主 `agent.status` 分流：
 *   · `status === 'idle'` ⇒ `followup`（宿主**同步**把 status 置 running ⇒ **立即起轮**，本就不排队）
 *   · 否则（在跑）      ⇒ **`steer`** —— **当场注入当前轮**，这才是"不排队"的关键路径
 * ⚠️ **fail-safe**：`steer` 抛错 ⇒ **退回 `followup`**：**宁可排队，不可静默丢消息**。
 * ⚠️ **只改 `send-now`**：`send-later`（{@link deliverWake}）**保持 `followup`** ——
 * 预约的本职是"到点唤起"，且在跑时排队不打断是它被实证验收过的行为，不顺手动它。
 *
 * **归属**：本函数放在调度器侧而非工具侧 —— "怎么把一句话送到一条轨迹"是**调度器的知识**，
 * 工具只该知道"有这个动作"。这样 `trajectory.ts` 完全不碰调度器内部（v1.35.0 硬约束①：
 * `send-later` 链路**一行为不动**，本次改动 = **纯新增**）。
 *
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param target `S###` 或 AGENT_SESSIONS 目录名
 * @param message 递送正文
 * @param sender 发起者轨迹标识
 * @returns 投递结果（**同步**返回给调用方）
 */
export async function sendToTrajectory(
  ctx: unknown,
  root: string,
  target: string,
  message: string,
  sender: string,
): Promise<WakeDeliveryResult> {
  const t = resolveWakeTarget(root, target)
  if (!t) return { ok: false, detail: `目标 trajectory 未命中（${target}）` }
  const acquired = await acquireWakeAgent(ctx, root, t.dirName)
  if ('error' in acquired) return { ok: false, detail: acquired.error }
  const agent = acquired.agent
  const make = (): ReturnType<typeof createUserMessage> =>
    createUserMessage({ content: [{ type: 'text', text: buildSendText(t, message, sender) }], source: PLUGIN_SOURCE })
  // 🔴 v1.39.2（S142 §0r，所有者令「不排队、直接即时注入」）：见函数头部的语义变更说明。
  // 判据 = 宿主 agent 的 `status`（`agent-idle.ts` 同款读法：`followup`/`steer` 会**同步**置 running）。
  const idle = (agent as { status?: string }).status === 'idle'
  if (idle) {
    try {
      agent.followup(make())
    } catch (err) {
      return { ok: false, detail: `投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
    }
    return { ok: true, detail: `已即时投递 ${t.dirName}（${acquired.how}；目标空闲 ⇒ followup 立即起轮）` }
  }
  try {
    agent.steer(make())
    return { ok: true, detail: `已即时注入 ${t.dirName}（${acquired.how}；目标在跑 ⇒ steer 当场注入当前轮）` }
  } catch (err) {
    // fail-safe：宁可排队，不可静默丢消息
    try {
      agent.followup(make())
    } catch (err2) {
      return {
        ok: false,
        detail: `投递失败（${acquired.how}）: steer 与 followup 均失败: ${String((err as Error)?.message ?? err)} / ${String((err2 as Error)?.message ?? err2)}`,
      }
    }
    return {
      ok: true,
      detail: `已投递 ${t.dirName}（${acquired.how}；steer 不可用 ⇒ 退回 followup）: ${String((err as Error)?.message ?? err)}`,
    }
  }
}

/**
 * 本 tick 要扫的 CCC 根集合（**并集**）。
 *
 * C2（S142 2026-09-15 Q5）：原实现是 `collectLiveCccs`——**只认 live 会话** ⇒
 * "完全冷掉的 CCC 不能自唤醒自己"（已知边界）。现改为 `ccc-roots.listCccs` 的并集枚举
 * （工作区注册表 ∪ 持久化会话 ∪ live 会话）：**没有 live 会话的 CCC 也会被扫到**。
 *
 * ⚠️ 边界（本步**只**改"枚举哪些 CCC"，**不改**"怎么找到要交付的 agent"）：
 * 把 message 交给某条 trajectory 仍必须靠 **live 会话**解析（见本文件
 * `acquireWakeAgent`）；无 live 会话时该 CCC 只是**被扫到、
 * 无交付对象** ⇒ `deliverWake` 返回 `无绑定会话记录…`，条目回 `pending` 并留痕。
 * 因此本函数**不得**让 tick 抛错（异常一律由调用方 tick 兜住，见 `runWakeTick` 的 try）。
 * @param ctx 插件上下文
 * @returns CCC 根列表（无任何来源 → `[]`）
 */
async function collectWakeCccs(ctx: unknown): Promise<string[]> {
  return (await listCccs(ctx)).map((e) => e.root)
}

// ── CRO（Continuous Re-Occurrence · 持续再发生；设计 `docs/cro-design.md`，S142 §7.8）──
//
// 归属（所有者 2026-09-19 定）：**机制属 ACC，程序属 CCC**。本文件持有"调度"那一面：
// 每 tick 对**每条启用了 CRO 的轨迹**跑它自带的 `continuous-re-occurrence.ts`，
// 按它的判定投递。**ACC 只 spawn，从不 import** 用户的 TS（设计 §2.3 B 案）。

/**
 * CRO 唤起消息正文（**刻意不复用** {@link buildWakeText} / {@link buildSendText}）。
 *
 * 三种唤起各有自己的**事实**；混用 = 注入一条假陈述（本容器栽过：`buildSendText` 里
 * 那句"消息已入队"就是一条假陈述，见该函数注释）：
 * · `buildWakeText` —— 「**到点**了」（登记过的未来时刻，人/agent 算好的）
 * · `buildSendText` —— 「**有人此刻给我发了一条消息**」
 * · 本函数         —— 「**我自己的程序**看情况判定该叫我了」（**没有到点、也没有人发消息**）
 *
 * 🔴 `reason` 的呈现（设计 §4.2）：**程序没写就明说没写**，不留空白 ——
 * 改成程序判定后，"当时为什么叫了"**不再能从时间表重建**（原因在程序肚子里）；
 * 留空白 = 连"丢在哪一环"都看不出来。写明"未提供"至少把缺口标出来了（CCE：重建 > 保存）。
 * @param dirName 目标轨迹目录名
 * @param mdPath 目标 SESSION.md 绝对路径
 * @param prompt 程序给的唤起提示词
 * @param reason 程序给的判定理由（可为 null）
 * @returns 投递正文
 */
export function buildCroWakeText(dirName: string, mdPath: string, prompt: string, reason: string | null): string {
  return [
    `[CRO 唤起] ${dirName} 自带的 continuous-re-occurrence.ts 判定：现在该唤起。`,
    `当前时间：${localHuman()}（当地时区）。`,
    '',
    `身份锚定：继续 ${dirName} 的 trajectory（SESSION.md: ${mdPath}）。`,
    '',
    `判定理由：${reason ?? '（程序未提供 reason —— 见 CRO 编写指南 §7 坑 3）'}`,
    '',
    '唤起提示词：',
    prompt,
    '',
    '说明：这是由**本轨迹自己的 CRO 程序**按当时情况做的判定（**不是**定时唤醒，**也不是**别人发的消息）。' +
      '处理完照常把进展写入 SESSION.md。',
  ].join('\n')
}

/**
 * 投递一条 CRO 唤起（**fire-and-forget**，与 {@link deliverWake} 同层）。
 *
 * · **取用通路复用** {@link acquireWakeAgent}（live 优先 → 冷载入）：这是调度器侧唯一的
 *   "怎么把一句话送到一条轨迹"的知识 ⇒ 不另立第二条（设计 §9-2 的倾向：复用投递面）。
 * · 🔴 **不落唤醒表**（设计 §6.3）：CRO 是"**持续判定**"，不是"**某个未来时刻**"。
 *   落表会给 §0Q（投递即删、表只保在办）**增加一个新的写入源**。
 * · 用 `followup`（不用 `steer`）：CRO 由**调度器**发起，与 `send-later` 同层；
 *   `steer`（当场注入当前轮）是 `send-now` 的语义 —— 那是人类/agent 的**即时动作**。
 * · 🔴 **失败不回滚、不重试**（与条目投递不同）：下一 tick 会**重新判定**——
 *   CRO 的判据是"情况"，不是"这条消息还没送出去" ⇒ 自愈来自**重判**，不来自重投。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param dirName 目标轨迹目录名（= CRO 只能唤起**自己**，设计 §9-8 的倾向）
 * @param prompt 唤起提示词
 * @param reason 判定理由
 * @returns 投递结果（进 tick 日志；**不写注册表**）
 */
async function deliverCroWake(
  ctx: unknown,
  root: string,
  dirName: string,
  prompt: string,
  reason: string | null,
): Promise<WakeDeliveryResult> {
  const mdPath = join(sessionsRoot(root), dirName, 'SESSION.md')
  const acquired = await acquireWakeAgent(ctx, root, dirName)
  if ('error' in acquired) return { ok: false, detail: acquired.error, notReady: acquired.notReady === true }
  try {
    acquired.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: buildCroWakeText(dirName, mdPath, prompt, reason) }],
        source: PLUGIN_SOURCE,
      }),
    )
  } catch (err) {
    return { ok: false, detail: `CRO 投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
  }
  return { ok: true, detail: `已投递（${acquired.how}）` }
}

/**
 * CRO 阶段：本 tick 对**每条启用了 CRO 的轨迹**跑一次它自带的程序，按判定投递。
 *
 * ## 为什么放在既有投递**之后**（R↓）
 * · 既有条目（`send-later`）**有到点承诺** ⇒ 优先级天然更高；
 * · CRO 是"看着情况叫"，**晚一拍无成本**（tick 粒度本就是 5min）；
 * · ⇒ 铁律（设计 §5）：**CRO 的任何失败都不影响既有链路** —— 整段由调用方兜住，
 *   且**每条轨迹各自 try/catch**（一条坏程序不得连累同 tick 的其它轨迹）。
 *
 * ## 日志口径（刻意与既有投递不同）
 * "每 tick × 每条轨迹"都写一行 ⇒ 对"**常态是不唤起**"的 CRO 就是刷屏。
 * ⇒ 逐条只记 **唤起**（`reason` 进日志 —— 设计 §4.2 要求可重建）与 **跳过**（异常，必须看见）；
 *   **不唤起只进汇总行**（`唤起 x，不唤起 y，跳过 z`）。
 * ⚠️ **诚实标注**：因此"某条轨迹当轮**为何没叫**"**不进 tick 日志**（它在程序肚子里）。
 *    要完整的逐次判定审计，须**程序自己**写状态文件（设计 §3.3）——ACC 给不了。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param registry 本 tick 已载入的唤醒注册表条目（供快照的 `pendingWakes`；读坏时传 `[]`）
 * @param log 本 tick 的人读摘要（就地追加）
 */
async function runCroPhase(ctx: unknown, root: string, registry: WakeEntry[], log: string[]): Promise<void> {
  // 🔴 CRO 闸（2026-09-21 所有者令新增，缺省**开**）：关掉只影响**本阶段** ——
  //    `send-later` / `send-now` / 唤醒表投递**照常**（`cro.ts` 头注的承诺）。
  //    跳过**记一行**（否则"关掉 CRO 后轨迹不再被自编程唤起"这件事在 tick 日志里不可见 —— 同族缺口：
  //    "为什么这轮没唤起"必须可答）。
  if (readSimpleSettings().croEnabled === false) {
    log.push('CRO 阶段：已关闭（croEnabled=false）——既有唤醒投递不受影响')
    return
  }
  let dirs: string[]
  try {
    dirs = listCroTrajectories(root)
  } catch {
    return // 扫描失败 ⇒ 静默跳过本 tick 的 CRO（不影响既有链路）
  }
  if (dirs.length === 0) return // 常态（还没有轨迹写 CRO 程序）：代价 = 一次 readdir
  const nowMs = Date.now()
  const s = wakeSchedulerState()
  const scheduler = { armed: s.armed, enabled: s.enabled, ticks: s.ticks, lastSkipReason: s.lastSkipReason }
  const agents = hostAgents(ctx)
  let wakes = 0
  let quiet = 0
  let skips = 0
  for (const dirName of dirs) {
    try {
      const bound = listBoundSessionIds(root, dirName)
      // 🔴 `running ≠ live`（设计 §3.2）：running 来自 `cro-turns` 的事件夹取 + TTL 兜底
      const running = runningCarriersOf(bound, nowMs)
      const live = bound.filter((id) => Boolean(agents?.get?.(id)))
      // 本轨迹在办的唤醒条目 —— **只给摘要**（id/at/createdAt/createdBy），
      // **不给 message 正文**（设计 §9-7 的有界空间倾向：一条轨迹不该能读遍全容器）
      const pendingWakes = registry
        .filter((e) => e.state === 'pending' && resolveWakeTarget(root, e.target)?.dirName === dirName)
        .map((e) => ({ id: e.id, at: e.at, createdAt: e.createdAt, createdBy: e.createdBy }))
      const input = readCroSnapshotInput(root, dirName, nowMs, {
        boundSessionIds: bound,
        liveSessionIds: live,
        runningSessionIds: running,
        pendingWakes,
        scheduler,
      })
      const outcome = await evaluateCro(root, dirName, input)
      if (outcome.status === 'wake') {
        wakes += 1
        const res = await deliverCroWake(ctx, root, dirName, outcome.prompt, outcome.decision.reason)
        log.push(`· ${root}: ${renderCroOutcome(dirName, outcome)} → ${res.ok ? '已投递' : `投递未成功：${res.detail}`}`)
        // 🔴 ACC 侧流水（所有者令 2026-09-20「ACC 有必要进行 CRO 唤醒的日志记录」「失败成功都记录」）：
        // 落点 = **该轨迹目录**下的固定名文件（`cro-log.ts`），只留两日、写入时按窗裁剪。
        // ⚠️ 两条硬约束：
        //   ① **`notReady` 不记**（`:171` 既定语义：环境未就绪 ≠ 投递失败 ⇒ 记了就是**假失败**）；
        //   ② **写流水失败绝不影响投递与既有链路**（设计 §5 铁律）⇒ 失败只进 tick 日志一行。
        if (!res.notReady) {
          const rec = appendCroWakeLog(
            root,
            dirName,
            { ok: res.ok, detail: res.detail, tick: s.ticks, reason: outcome.decision.reason ?? null, prompt: outcome.prompt },
            nowMs,
          )
          if (!rec.ok) {
            log.push(`· ${root}: ${dirName}: CRO 流水写入失败（已忽略，不影响投递）: ${rec.error}`)
          }
        }
      } else if (outcome.status === 'skipped') {
        skips += 1
        log.push(`· ${root}: ${renderCroOutcome(dirName, outcome)}`)
      } else if (outcome.status === 'no-wake') {
        quiet += 1
      }
      // `disabled`：本不该出现（`dirs` 已按"文件在"筛过）⇒ 只可能是扫描后被删的竞态 ⇒ 静默
    } catch (err) {
      skips += 1
      log.push(`· ${root}: ${dirName}: CRO 内部异常（已忽略，不影响既有链路）: ${String((err as Error)?.message ?? err)}`)
    }
  }
  log.push(`· ${root}: CRO 评估 ${dirs.length} 条（唤起 ${wakes}，不唤起 ${quiet}，跳过 ${skips}）`)
}

/** 一次调度 tick：遍历已知 CCC → 到期项串行投递 / 超窗项置 missed；返回人读摘要 */
async function runWakeTick(ctx: unknown): Promise<string[]> {
  const log: string[] = []
  // 无 CCC 可扫：廉价空转（**不**改变"全局闸开即武装"的语义：武装在 startTimer，
  // 与有无 CCC 无关；此处只是本 tick 无事可做）
  const roots = await collectWakeCccs(ctx).catch((): string[] => [])
  if (roots.length === 0) {
    clock.noteSkipReason('无已知 CCC 可扫（等某个会话/工作区出现）')
    return log
  }
  clock.noteSkipReason(null)
  for (const root of roots) {
    // 🔴 存量清理（owner 2026-09-19 裁「直接删」，S142 §0Q 甲案）：
    //   本版上线前表里积压了 143+ 条**终态**记录（308 KB）。只改行为不清存量 ⇒ 文件不再涨但仍臃肿。
    //   **幂等**（无终态时空转不写盘）⇒ 放在每 tick 开头，天然自愈；不依赖"跑一次迁移"。
    const purged = purgeFinalizedWakes(root)
    if (purged.ok && purged.purged > 0) {
      log.push(`· ${root}: 清除 ${purged.purged} 条已结案记录（存量首清）`)
    }
    const { registry, error } = loadWakeRegistry(root)
    if (error) {
      log.push(`✗ ${root}: ${error}`)
      // 🔴 注册表读坏**不连带停掉 CRO**（两者是**并列**的唤起来源，设计 §6.2）：
      //   以空表（= "无在办条目"）继续 CRO 阶段，否则一个坏 JSON 会让 CRO 也一起静默。
      await runCroPhase(ctx, root, [], log)
      continue
    }
    const { due, expired } = splitDueWakes(registry, Date.now(), WAKE_CATCH_UP_MS)
    for (const e of expired) {
      // 🔴 owner 2026-09-19 裁「直接删」（S142 §0Q 甲案）：超窗 = 已结案 ⇒ **写终态后同一笔事务删掉**
      //    （原实现只置 `missed` 而**永不删** ⇒ 本表只增到 308 KB）。
      finalizeWake(root, e.id, 'missed', `超过补跑窗口（${WAKE_CATCH_UP_MS / 3_600_000}h）未投递`)
      log.push(`· ${root}: ${e.id} → missed（超补跑窗口，已清除）`)
    }
    // 串行投递：同 tick 多目标依次进行（防模型并发挤兑）——fire-and-forget 指不等结果，不是并行
    for (const e of due) {
      const res = await deliverWake(ctx, root, e)
      // 🔴 环境未就绪（`notReady`）**不计入条目**（2026-09-17 实测缺陷修复，S142 §0t）：
      //   不改 state、不动 attempts、**不写 lastResult**——因为这条"结果"不是投递的结果，
      //   而是"这次没轮到投递"。典型场景：`dsh web` 刚重启，启动那一拍跑在懒服务
      //   `sessionController` 就绪**之前** ⇒ 旧实现每次重启都给"到点条目"盖一条假失败，
      //   制造假告警（消息其实一个都没丢，下个 tick 就投成功了）。
      //   代价 = 该条目在本 tick 无痕迹；但**不丢信息**：真正超窗的条目仍由上面的
      //   `expired` 分支落 `missed` 留痕（那是**时间**判据，与「试过几次」无关）。
      if (res.notReady) {
        log.push(`· ${root}: ${e.id} → 跳过（宿主服务未就绪，下个 tick 再试；不计失败）`)
        continue
      }
      if (res.ok) {
        // 🔴 owner 2026-09-19 裁「直接删」：投递成功 = 结案 ⇒ 同一笔事务写终态 + 移除。
        //    审计由 SESSION.md / 工具输出承担（`wake-registry.ts` 既有注释承诺，本次做实）。
        finalizeWake(root, e.id, 'delivered', res.detail)
        log.push(`· ${root}: ${e.id} → delivered（已清除）`)
      } else {
        // 失败 ⇒ **仍在办**：保留行、记 attempts 与原因（不能删——否则等于静默丢唤醒）
        updateWake(root, e.id, { state: 'pending', attempts: e.attempts + 1, lastResult: res.detail })
        log.push(`· ${root}: ${e.id} → 重试（${res.detail}）`)
      }
    }
    // CRO 阶段（设计 §6.1：执行者 = 本调度器）：既有投递**之后**（见 `runCroPhase` 的排序理由）
    await runCroPhase(ctx, root, registry.entries, log)
  }
  return log
}

/**
 * 装配调度器（index.ts apply 调用）：5min tick + 生命周期 disposer +
 * 会话出现/settings 变化时热启动（与 autopilot 同款触发面，互不干扰）。
 * @param ctx 插件上下文
 */
export function registerWakeScheduler(ctx: unknown): void {
  // ⚠️ 此处**不得**再判"有无 live CCC"（F 段缺陷修复，2026-09-14）：
  //   CCC 根当时**只能从 live 会话的 cwd 反推**（collectLiveCccs），而宿主刚重启时 live 会话
  //   必然为空（浏览器尚未重连）；更关键的是——**"恢复旧会话"不触发 `session/created`**
  //   （只有**新建**会话才触发），所以启动瞬间的这一次判定一旦落空，时钟就**永久不武装**，
  //   要等人类**新建**一个会话才恢复。
  //   实测证据（2026-09-14）：16:30Z 重启 → 次日 23:13Z 查得注册表条目超窗 6.6h 仍为
  //   `pending` / `attempts=0`（真跑过 tick 的条目必为 delivered 或 missed）⇒ 6.6h 零 tick。
  //   现改为「**全局闸开即武装**」：定时器恒在，每 tick 自行判定（无可扫 CCC 时廉价跳过）。
  //   代价 = 一个 unref 的 5min 空检查，远小于"时钟静默"的代价。
  //   🔒 C2（2026-09-15）**不许回退**这一条：源侧的"无 live 会话"已由并集枚举（ccc-roots）
  //   消掉一部分，但**武装门本身必须继续只判全局闸**——否则"恢复旧会话不触发事件"那条
  //   路径会再次让时钟永不武装。武装与"本次有无目标"是两件事，不得耦合。
  //   🔒 C6b（2026-09-15）该门已收进 `clock-runtime.createClock` 的 `start()`（硬约束二）。
  //   🔴 2026-09-21 更新：本钟**已不传 `gate`** —— `wakeSchedulerEnabled` 被砍 ⇒ **无闸恒武装**；
  //      上面那条"武装门只判全局闸"的原则因此**自动满足**（没有闸可判），但**理由不变**：
  //      武装**不得**与"本次有无目标"耦合。⚠️ CRO 的 `croEnabled` 是**另一层**（在 `runCroPhase`
  //      入口，不在时钟武装门）——**不得**混进本门。
  //   ⚠️ 同一条链上的另一条约束：tick **不预判"有无 CCC"**（C2 起 CCC 枚举为**并集**），
  //      "无 CCC 可扫"的廉价跳过下沉到 runWakeTick 内部并写 lastSkipReason 供 acc-diag 判读。
  clockOpts.ctx = ctx
  clock.start()
  registerDisposer(ctx, 'trajectory 唤醒调度器', () => clock.dispose())
}
