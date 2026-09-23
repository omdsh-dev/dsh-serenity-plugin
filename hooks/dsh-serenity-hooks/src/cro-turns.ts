/**
 * cro-turns.ts — 「这条轨迹是否正在跑轮次」的追踪（设计 §3.2，2026-09-19 S142）
 *
 * ## 为什么需要这个模块（CRO 唯一需要 ACC 新增的状态）
 *
 * CRO 程序要能回答「**已经在工作则停止**」这类问题 ⇒ 输入快照里必须有
 * 「**哪些载体正在跑轮次**」。而这件事**今天判不出来**：
 * 调度器只掌握**会话 live 与否**，而 **`live ≠ 在跑`**——
 * 一条会话可以 live 而空闲（本会话此刻就是活的反例）。
 *
 * ## 怎么夹出来（用**既有的**两个契约事件，不需要新宿主能力）
 *
 * | 事件 | 动作 | 出处 |
 * |---|---|---|
 * | `agent/created` | 标记「在跑」 | `host/contract.ts`（dsp 已在 `seams/context.ts` 订阅）。⚠️ v0.1.7 前名为 `agent/session-start`；新事件 `@mode = serial` ⇒ 处理函数须快速返回 |
 * | `agent/turn-stopping` | 清除标记 | `host/contract.ts:277`（dsp 已在 `rebuild.ts:442` 等 4 处订阅） |
 * | `agent/disposed` | **清该载体的项** | `host/contract.ts:280` |
 * | `session/disposed` | **清该载体的项** | `host/contract.ts:283` |
 *
 * ## 🔴 清理设计（**这是本模块最容易被做坏的地方**）
 *
 * ⚠️ 本容器栽过 **5 次**「只增不清」的病（wake-registry / keeper 三表 / pendingRebuilds …），
 * 而 `agent/disposed` 在 `HOST_EVENTS` 里的 impact 原文**恰好就是**
 * 「*per-会话内存态不清理（**长跑泄漏**）*」⇒ **本模块属于该已登记病族，必须在设计期就带清理**。
 *
 * **三层清理**：
 * 1. **正常路径**：`turn-stopping` ⇒ 清除该项；
 * 2. **载体销毁**：`agent/disposed` / `session/disposed` ⇒ 清除该项；
 * 3. 🔴 **异常路径（前两层都漏掉的兜底）**：读取时按 **TTL** 过滤——
 *    超过 `TURN_TTL_MS` 未收到 `turn-stopping` 的项**视为不在跑**（并顺手清除）。
 *    触发场景：进程被 kill / 卡死 / 事件丢失。
 *
 * ## TTL 取值的**方向性判据**（R↓，别用"感觉合适"）
 *
 * 两种误判的代价**不对称**：
 * · **误报"在跑"**（实际没跑）⇒ CRO 可能**不唤起** ⇒ **漏排 = 硬故障**（链停滞）；
 * · **误报"没跑"**（实际在跑）⇒ CRO 可能**多唤起**一次 ⇒ **多排 = 常态成本**（既有纪律：
 *   「漏排是硬故障、多排是常态成本」）。
 *
 * ⇒ **不确定时宁可报"没跑"**（选便宜的那种错）⇒ **TTL 不宜过长**。
 * 取 **30 分钟**：单轮静默超过 30 分钟仍无 `turn-stopping` 的情形罕见；
 * 而真发生了，代价只是一次可能多余的唤起（5min tick 限制频率，且 CRO 程序自己还能看
 * `pendingWakes` / `lastWakeAt` 二次判）。
 *
 * ## 键的选择
 *
 * **以载体（dsh 会话 id）为键**——因为事件本身就以 agent/session 为主语，直接映射最省。
 * **查询时按轨迹聚合**（`listBoundSessionIds` → 「任一载体在跑」⇒ 该轨迹在跑）。
 * ⚠️ 这也天然处理了「同一轨迹多载体」（S142 曾挂 4 条）的情形。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerDisposer } from './host/effect.js'

/** 一次「在跑」记录的 TTL（见文件头的方向性判据） */
export const TURN_TTL_MS = 30 * 60 * 1000

interface TurnRecord {
  /** 最近一次确认「在跑」的时刻（epoch ms） */
  at: number
  /** 该轮序号（诊断用；宿主 payload 里有 `turn`） */
  turn: number | null
}

/**
 * 进程内的「正在跑」表（键 = 载体 dsh 会话 id）。
 *
 * ⚠️ **仅内存**：进程重启即空 —— 这是**可接受的**，因为重启后宿主会重发
 * `agent/created`（或至少下一次 `turn-stopping` 会清掉残留），且空表 = "没有在跑"，
 * 落到上面那条**便宜**的误判方向。
 */
const runningBySession = new Map<string, TurnRecord>()

/** 取载体 id（事件 payload 的 `agent` 面；取不到 ⇒ null） */
function sessionIdOf(agent: unknown): string | null {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 标记「在跑」（`agent/created` + `agent/status=running` 调用） */
export function markTurnRunning(sessionId: string, nowMs: number, turn: number | null = null): void {
  if (!sessionId) return
  runningBySession.set(sessionId, { at: nowMs, turn })
}

/** 清除「在跑」（`turn-stopping` / disposed 调用） */
export function clearTurnRunning(sessionId: string): void {
  if (!sessionId) return
  runningBySession.delete(sessionId)
}

/**
 * 列出**当前在跑**的载体 id（按 TTL 过滤 + **顺手清除过期项**）。
 *
 * 🔴 **本函数带副作用（清理）是刻意的**：它是"异常路径兜底"的唯一执行点——
 * 只过滤不清除会让表留下永不过期的僵尸项（正是"只增不清"病）。
 * @param nowMs 当前时刻
 * @param ttlMs TTL（缺省 {@link TURN_TTL_MS}）
 * @returns 在跑的载体 id 列表（顺序不保证）
 */
export function listRunningSessionIds(nowMs: number, ttlMs: number = TURN_TTL_MS): string[] {
  const out: string[] = []
  for (const [id, rec] of runningBySession) {
    if (nowMs - rec.at > ttlMs) {
      runningBySession.delete(id) // 🔴 过期即清除（不是只跳过）
      continue
    }
    out.push(id)
  }
  return out
}

/**
 * 按轨迹聚合：该轨迹**是否有载体在跑**（`listBoundSessionIds` 给候选，再与在跑集求交）。
 * @param boundSessionIds 绑定该轨迹的载体 id
 * @param nowMs 当前时刻
 * @param ttlMs TTL
 * @returns 在跑的载体 id（**可能多条**；空数组 = 没有在跑）
 */
export function runningCarriersOf(boundSessionIds: readonly string[], nowMs: number, ttlMs: number = TURN_TTL_MS): string[] {
  const running = new Set(listRunningSessionIds(nowMs, ttlMs))
  return boundSessionIds.filter((id) => running.has(id))
}

/** 当前表大小（**诊断/测试用**；用于证明"清理真的发生了"） */
export function croTurnTableSize(): number {
  return runningBySession.size
}

/** 测试用：复位（避免用例间串味） */
export function __resetCroTurnsForTest(): void {
  runningBySession.clear()
}

/**
 * 装配追踪（`index.ts` apply 调用）：订阅四个既有事件 + 拆卸。
 *
 * **为什么订阅四个而不是两个**（R↓）：
 * · 前两个（`agent/created` / `turn-stopping`）负责**语义**——"在不在跑"；
 * · 后两个（`agent/disposed` / `session/disposed`）负责**生命周期**——
 *   载体没了必须清项，否则表按载体只增（本模块的头号风险）。
 *
 * ⚠️ **失败不抛**：任一事件通道缺失 ⇒ 响亮日志 + 该订阅跳过（**apply 不可成为启动单点**，
 * 与 `registerDeepseekVisionPatch` 等既有装配同款纪律）。
 * @param ctx 插件上下文
 */
export function registerCroTurnTracking(ctx: Context): void {
  const on = (event: string, handler: (payload: unknown) => void): void => {
    try {
      // 宿主事件为字符串键，写错只会静默不订阅 ⇒ 名字取自 HOST_EVENTS 白名单（编译期已钉）
      ;(ctx as unknown as { on: (e: string, h: (p: unknown) => void) => void }).on(event, handler)
    } catch (err) {
      console.log(`[serenity-hooks] ✗ CRO turn 追踪未装配（${event} 不可用）: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // ① 开轮：agent/created（新会话首次进入；v0.1.7 前名 session-start）+ status=running（每次开轮都会发）
  on('agent/created', (payload) => {
    const id = sessionIdOf((payload as { agent?: unknown })?.agent)
    if (id) markTurnRunning(id, Date.now())
  })
  on('agent/status', (payload) => {
    const p = payload as { agent?: unknown; status?: unknown; turn?: unknown }
    const id = sessionIdOf(p?.agent)
    if (!id) return
    const turn = typeof p.turn === 'number' ? p.turn : null
    // 只在 running 时报"在跑"；idle ⇒ 清（status 是轮次状态的权威）
    if (p.status === 'running') markTurnRunning(id, Date.now(), turn)
    else if (p.status === 'idle') clearTurnRunning(id)
  })

  // ② 收轮：turn-stopping（宿主在每个 turn 结束前 serial 触发）
  on('agent/turn-stopping', (payload) => {
    const id = sessionIdOf((payload as { agent?: unknown })?.agent)
    if (id) clearTurnRunning(id)
  })

  // ③ 生命周期清理：载体销毁 ⇒ 清项（防"按载体只增"）
  // ⚠️ 两个事件的 **payload 形状不同**（照 `agent-idle.ts:57-64` 实证）：
  //    · `agent/disposed`   → `{ agent }`
  //    · `session/disposed` → **payload 本身就是那个 session**（直接有 `.id`）
  on('agent/disposed', (payload) => {
    const id = sessionIdOf((payload as { agent?: unknown })?.agent)
    if (id) clearTurnRunning(id)
  })
  on('session/disposed', (payload) => {
    const id = (payload as { id?: unknown })?.id
    if (typeof id === 'string' && id !== '') clearTurnRunning(id)
  })

  // ④ 拆卸：进程/插件销毁 ⇒ 清表（内存态不留残余）
  registerDisposer(ctx, 'cro turn tracking', () => {
    runningBySession.clear()
  })
}

/** 类型再导出（调用方少一处 import） */
export type { Agent as CroAgent }
