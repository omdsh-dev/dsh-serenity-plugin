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
 *     → `sessionController` 缺席（headless profile）⇒ 仅投递 live 目标，**不静默**
 *  4. 投递：`agent.followup(...)`（"Queue an ordinary follow-up turn and wake the driver"）
 *
 * 守卫（I-4 默认 + v1.34 S-1 解耦）：全局 `wakeSchedulerEnabled`（**缺省开**；**不再**回退旧键
 * `autopilotEnabled`——关周期自唤醒不得连带关一次性唤醒）｜
 * 补跑窗口 2h（超窗置 missed 留痕）｜同 tick 串行｜唤起后维持 live（人类可介入）。
 */

import type { Context } from 'cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { findSession, sessionsRoot } from './trajectory-ops.js'
import { listBoundSessionIds } from './trajectory-bound.js'
import { hostAgents, hostService } from './host/access.js'
import { registerDisposer } from './host/effect.js'
import { readSimpleSettings } from './settings-section.js'
import { createClock, type ClockOptions, type ClockRuntime } from './clock-runtime.js'
import { listCccs } from './ccc-roots.js'
import { isoLocal, localHuman } from './time.js'
import {
  loadWakeRegistry,
  splitDueWakes,
  updateWake,
  WAKE_CATCH_UP_MS,
  type WakeEntry,
} from './wake-registry.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 宿主 sessionController 的最小形态（`resolveAgent`：live 优先，否则 resume） */
interface HostSessionController {
  resolveAgent?: (sessionId: string) => Promise<{ agent?: Agent; error?: unknown }>
}

/** 投递结果（写回条目的 lastResult；人读） */
interface WakeDeliveryResult {
  ok: boolean
  detail: string
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
export type WakeSchedulerRuntime = ClockRuntime & { lastTickLog: string[] }

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
 * 全局闸：**只看 `wakeSchedulerEnabled`**（缺省**开**；显式 `false` 才关）。
 *
 * ⚠️ 2026-09-15 用户裁决（S-1 **解耦**）：「auto-trajectory 的开关**只关闭 auto-trajectory 唤醒**」。
 * ⇒ 本函数**不得**再把 `autopilotEnabled`（周期自唤醒闸）作为回退键 —— 旧实现是
 * `trajectoryEnabled === true || autopilotEnabled === true`，后果实测：所有者关掉 auto-trajectory 后，
 * **一次性唤醒 `wake-later`（今 `send-later`）被连带关掉**，注册表条目静默滞留（当日 6.6h 零 tick）。
 * 缺省由 false 改 true 的理由：唤醒注册表已是一等机制（D58），条目**全部由人类/agent 显式登记**
 * 未来时刻（无环境自主性），不需要"默认关"的实验保护；代价 = 一个 unref 的 5min 空检查。
 *
 * 设置服务不可用 → 关（保守；异常由日志与 `dashboard health` 响亮暴露，不静默）。
 */
function wakeSchedulerEnabled(): boolean {
  try {
    return readSimpleSettings().wakeSchedulerEnabled !== false
  } catch {
    return false
  }
}

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
  gate: wakeSchedulerEnabled,
  gateOffReason: '唤醒调度器闸关闭（wakeSchedulerEnabled=false）',
  body: () => runWakeTick(clockOpts.ctx as Context),
  // `countBeforeBody` 缺省 false：本钟 `ticks` = **真跑完**的 tick 数（既有语义，勿改）
  logFrom: { prefix: '[serenity-hooks] trajectory 唤醒 ', lines: (lines) => lines },
  startLog: () => '[serenity-hooks] ✓ trajectory 唤醒调度器启动（5min tick）',
}
const clock = createClock(clockOpts)

/** 调度器进程态快照（只读；`enabled` = 全局闸**当前**值，便于区分"未武装"与"闸关"） */
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
 */
async function acquireWakeAgent(
  ctx: Context,
  root: string,
  dirName: string,
): Promise<{ agent: Agent; how: string } | { error: string }> {
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
      return { error: `目标会话未加载且 sessionController 不可用（headless profile？）——绑定 id: ${ids[0]}` }
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
export async function deliverWake(ctx: Context, root: string, entry: WakeEntry): Promise<WakeDeliveryResult> {
  const target = resolveWakeTarget(root, entry.target)
  if (!target) return { ok: false, detail: `目标 trajectory 未命中（${entry.target}）` }
  const acquired = await acquireWakeAgent(ctx, root, target.dirName)
  if ('error' in acquired) return { ok: false, detail: acquired.error }
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
  ctx: Context,
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
async function collectWakeCccs(ctx: Context): Promise<string[]> {
  return (await listCccs(ctx)).map((e) => e.root)
}

/** 一次调度 tick：遍历已知 CCC → 到期项串行投递 / 超窗项置 missed；返回人读摘要 */
async function runWakeTick(ctx: Context): Promise<string[]> {
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
    const { registry, error } = loadWakeRegistry(root)
    if (error) {
      log.push(`✗ ${root}: ${error}`)
      continue
    }
    const { due, expired } = splitDueWakes(registry, Date.now(), WAKE_CATCH_UP_MS)
    for (const e of expired) {
      updateWake(root, e.id, { state: 'missed', lastResult: `超过补跑窗口（${WAKE_CATCH_UP_MS / 3_600_000}h）未投递` })
      log.push(`· ${root}: ${e.id} → missed（超补跑窗口）`)
    }
    // 串行投递：同 tick 多目标依次进行（防模型并发挤兑）——fire-and-forget 指不等结果，不是并行
    for (const e of due) {
      const res = await deliverWake(ctx, root, e)
      updateWake(root, e.id, {
        state: res.ok ? 'delivered' : 'pending',
        attempts: e.attempts + 1,
        lastResult: res.detail,
        deliveredAt: res.ok ? isoLocal() : null,
      })
      log.push(`· ${root}: ${e.id} → ${res.ok ? 'delivered' : `重试（${res.detail}）`}`)
    }
  }
  return log
}

/**
 * 装配调度器（index.ts apply 调用）：5min tick + 生命周期 disposer +
 * 会话出现/settings 变化时热启动（与 autopilot 同款触发面，互不干扰）。
 * @param ctx 插件上下文
 */
export function registerWakeScheduler(ctx: Context): void {
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
  //   🔒 C6b（2026-09-15）该门已收进 `clock-runtime.createClock` 的 `start()`（硬约束二），
  //      本文件只传 `gate: wakeSchedulerEnabled`——语义**未变**，改动只是位置。
  //   ⚠️ 同一条链上的另一条约束：tick **不预判"有无 CCC"**（C2 起 CCC 枚举为**并集**），
  //      "无 CCC 可扫"的廉价跳过下沉到 runWakeTick 内部并写 lastSkipReason 供 acc-diag 判读。
  clockOpts.ctx = ctx
  clock.start()
  registerDisposer(ctx, 'trajectory 唤醒调度器', () => clock.dispose())
}
