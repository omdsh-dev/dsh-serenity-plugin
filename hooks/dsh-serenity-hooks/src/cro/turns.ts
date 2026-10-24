/**
 * cro/turns.ts — 「这条轨迹是否正在跑轮次」的追踪（设计 §3.2，2026-09-19 S142）
 *
 * ## 为什么需要这个模块（CRO 唯一需要 ACC 新增的状态）
 *
 * CRO 程序要能回答「**已经在工作则停止**」这类问题 ⇒ 输入快照里必须有
 * 「**哪些载体正在跑轮次**」。而这件事**今天判不出来**：
 * 调度器只掌握**会话 live 与否**，而 **`live ≠ 在跑`**——
 * 一条会话可以 live 而空闲（本会话此刻就是活的反例）。
 *
 * ## 怎么夹出来（用**既有的**契约事件，不需要新宿主能力）
 *
 * | 事件 | 动作 | 出处 |
 * |---|---|---|
 * | `agent/status` = `running` | **置位**「在跑」 | 宿主 `AgentLoop.setPhase`：`emit("agent/status", { status })`，**只在状态真的变化时发** |
 * | `agent/status` = `idle` | **清位** | 同上；`kick()` 的 `finally` 一定 `setPhase({kind:'idle'})` |
 * | `agent/disposed` | **清该载体的项** | `host/contract.ts` |
 * | `session/disposed` | **清该载体的项** | `host/contract.ts` |
 *
 * 🔴 **`agent/turn-stopping` 刻意不订阅** —— 它是「轮末暂停点」不是「轮结束」，见下方 D244 段。
 *
 * ## 🔴🔴 D243（2026-10-24）：**⛔ 不许用 `agent/created` 标记「在跑」**
 *
 * **修前**：`agent/created` 也 `markTurnRunning(...)`。**为什么这是错的** —— 该事件是
 * `AgentRegistry.announce(agent, source)` 发的，而 `source` 明确包含 **`resume`**：
 * 宿主**每次重启**都会把 persisted 会话重新载入并 announce ⇒ 每个被**载入**的会话都被打成"在跑"，
 * 而**它那一轮早随旧进程死掉了** ⇒ `turn-stopping` 永不到达 ⇒ 该假标记活满 `TURN_TTL_MS`（30 min）。
 *
 * **代价（两个面，都已实测）**：
 * - **面一**：CRO 守卫拿它否决唤起 ⇒ **重启后聋 30 分钟**（guard 已在自己域绕开）。
 * - **面二**：`cognitive_trajectory interrupted` 拿它当排除集 ⇒ **把最该被接走的会话藏起来**
 *   （实测：判据命中 5 条，生产入口报「检查 5 · 命中 0」）。
 *
 * **判据**：`agent/created` 证明的是「**载体被发布了**」，**不是**「有轮次在跑」。
 * 「载入」与「在跑」互不蕴含（与 D225 同族：*字段名/字面形态不是语义*）。
 * ⇒ **唯一权威 = `agent/status`**（宿主 `status` getter：`phase.kind === 'idle' | 'maintenance'`
 * 才是 idle，其余皆 running），且它在**每次真实状态跃迁**时发 —— 正是我们要的粒度。
 *
 * **代价与兜底**：删掉 `agent/created` 后，本表在"宿主重启后、某会话真正开跑之前"为空
 * ⇒ 落到文件尾那条**便宜**的误判方向（报"没跑"），不会被拿来藏会话。
 *
 * ## 🔴🔴 D244（2026-10-24）：**⛔ `agent/turn-stopping` 不得清表**
 *
 * **它看起来最像"收轮"，其实不是。** 宿主 `AgentLoop.turn()` 原文：
 *
 * ```js
 * if (turnEnds && this.inbox.nextStep.length === 0) {
 *     await this.dispatch.serial("agent/turn-stopping", { turn, signal })  // 暂停点
 *     signal.throwIfAborted()
 * }
 * if (turnEnds && this.inbox.nextStep.length === 0) break                  // 只有 nextStep 空才真结束
 * target = "next-step"                                                     // 否则同轮继续
 * ```
 *
 * ⇒ 任何监听者在 `turn-stopping` 回调里 `steer`（往 `next-step` 塞消息）⇒ **同一轮继续跑**，
 *   而 `turn/start` **不重发**、`agent/status` 也**不重发**（状态没变，还是 running）。
 *
 * 🔴 **实测代价**（真机 2026-10-24 18:1x）：`trajectory/rebuild.ts` 的 auto-continue 正是
 *   在 `turn-stopping` 里 `agent.steer(...)` ⇒ 一条轮**连跑 9 分钟**
 *   （`turn/start(32)` 18:12:00 → `turn/end(32)` 18:21:27），而本表**整段时间都是空的**
 *   ⇒ `interrupted` 的排除失效 ⇒ `steer` 被塞进**正在跑的那一轮**（对它是误导）。
 *   ⚠️ D243 之前这一格被 `agent/created` 的假置位**掩盖**；D243 删掉它 ⇒ 洞才暴露。
 *   ⇒ **D243 的方向是对的，它只是揭开了一个更老的语义误解**。
 *
 * ⇒ **清理只认 `agent/status = idle`**（`kick()` 的 `finally` 一定 `setPhase({kind:'idle'})`）。
 * ⚠️ **已知窄代价**：`runMaintenance` 期间 `status` 也是 `idle` ⇒ 压缩等内部工作时不置位。
 *   判可接受：那时没有 CRO 该救的轮；方向落到那条**便宜**的误判（报"没跑"）。
 * ⛔ **不要把 `clearTurnRunning` 加回 `turn-stopping`** —— 等于重新打开那个 9 分钟的洞。
 *
 * ## 🔴 清理设计（**这是本模块最容易被做坏的地方**）
 *
 * ⚠️ 本容器栽过 **5 次**「只增不清」的病（wake-registry / keeper 三表 / pendingRebuilds …），
 * 而 `agent/disposed` 在 `HOST_EVENTS` 里的 impact 原文**恰好就是**
 * 「*per-会话内存态不清理（**长跑泄漏**）*」⇒ **本模块属于该已登记病族，必须在设计期就带清理**。
 *
 * **三层清理**（D244 起第 1 层已从 `turn-stopping` 换成 `status=idle`）：
 * 1. **正常路径**：`agent/status = idle` ⇒ 清除该项；
 * 2. **载体销毁**：`agent/disposed` / `session/disposed` ⇒ 清除该项；
 * 3. 🔴 **异常路径（前两层都漏掉的兜底）**：读取时按 **TTL** 过滤——
 *    超过 `TURN_TTL_MS` 未刷新的项**视为不在跑**（并顺手清除）。
 *    触发场景：进程被 kill / 卡死 / 事件丢失（这些情况下 `idle` 永远不会来）。
 *
 * ## TTL 取值的**方向性判据**（R↓，别用"感觉合适"）
 *
 * 两种误判的代价**不对称**：
 * · **误报"在跑"**（实际没跑）⇒ CRO 可能**不唤起** ⇒ **漏排 = 硬故障**（链停滞）；
 * · **误报"没跑"**（实际在跑）⇒ CRO 可能**多唤起**一次 ⇒ **多排 = 常态成本**（既有纪律：
 *   「漏排是硬故障、多排是常态成本」）。
 *
 * ⇒ **不确定时宁可报"没跑"**（选便宜的那种错）⇒ **TTL 不宜过长**。
 * 取 **30 分钟**：单轮静默超过 30 分钟仍无 `idle` 的情形罕见；
 * 而真发生了，代价只是一次可能多余的唤起（5min tick 限制频率，且 CRO 程序自己还能看
 * `pendingWakes` / `lastWakeAt` 二次判）。
 *
 * ## 键的选择
 *
 * **以载体（dsh 会话 id）为键**——因为事件本身就以 agent/session 为主语，直接映射最省。
 * **查询时按轨迹聚合**（`listBoundSessionIds` → 「任一载体在跑」⇒ 该轨迹在跑）。
 * ⚠️ 这也天然处理了「同一轨迹多载体」（S142 曾挂 4 条）的情形。
 */

import { registerDisposer } from '../host/effect.js'

/** 一次「在跑」记录的 TTL（见文件头的方向性判据） */
export const TURN_TTL_MS = 30 * 60 * 1000

interface TurnRecord {
  /** 最近一次确认「在跑」的时刻（epoch ms） */
  at: number
  /** 该轮序号（诊断用；**来自 `markTurnRunning` 的显式入参**，事件 payload 里没有它） */
  turn: number | null
}

/**
 * 进程内的「正在跑」表（键 = 载体 dsh 会话 id）。
 *
 * ⚠️ **仅内存**：进程重启即空 —— 这是**可接受的，且是刻意选的**：
 * 空表 = "没有在跑" ⇒ 落到上面那条**便宜**的误判方向（漏排是硬故障、多排是常态成本）。
 * 🔴 **D243**：刻意**不**在重启后用 `agent/created` 去"补"这张表 —— 那会把「载入」当「在跑」。
 */
const runningBySession = new Map<string, TurnRecord>()

/** 取载体 id（事件 payload 的 `agent` 面；取不到 ⇒ null） */
function sessionIdOf(agent: unknown): string | null {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 标记「在跑」（**唯一**生产调用点 = `agent/status=running`；另供测试与 CRO 自检置位） */
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
 * · 前两个（`agent/status` / `turn-stopping`）负责**语义**——"在不在跑"；
 * · 后两个（`agent/disposed` / `session/disposed`）负责**生命周期**——
 *   载体没了必须清项，否则表按载体只增（本模块的头号风险）。
 *
 * 🔴 **D243：`agent/created` 已于 2026-10-24 从订阅清单中移除**（原先共 5 个）。
 *    理由与代价见**文件头 D243 段**；一句话：它是「载体被发布」的信，不是「轮次在跑」的信。
 *
 * ⚠️ **失败不抛**：任一事件通道缺失 ⇒ 响亮日志 + 该订阅跳过（**apply 不可成为启动单点**，
 * 与 `registerDeepseekVisionPatch` 等既有装配同款纪律）。
 *
 * ── 🔴 2026-09-25 I2 收敛（约束文档 §2.7 违反清单，L1 违反之一）────────────────
 * **两个宿主 import 全部清除**（`Context`（cordis）＋ `Agent`（`@deepseek-ai/dsh-agent`）），
 * `ctx` 参数类型 → `unknown`。
 *
 * 🔴 **本处顺带更正 §2.7 的一处分档**：本文件原被列在"剩余 3 个属**真依赖**档"里，
 * 但**逐符号查证后与那个判断不符** ——
 *   · `Context`：`ctx` 只被**结构化访问**（原码本就写着 `ctx as unknown as { on: … }`）
 *     ⇒ 该注解未提供任何类型保证（与 `trajectory/carrier.ts` 同档）。
 *   · `Agent`：**导入后从未使用** —— 事件 payload 一律按 `{ agent?: unknown }` 解构，
 *     再交给 `sessionIdOf(...)`（它收 `unknown`）。⇒ **纯粹是死 import**。
 * ⇒ **判据（本件再证一次，且比上一件更硬）**：分档**必须逐符号看"它有没有参与类型检查"**，
 *   **不能按文件整档划分** —— 同一个文件里可以并存"真依赖符号"与"纯名义符号"。
 * 🔵 **剩余 2 个文件**才是真依赖档：`trajectory/rebuild.ts` 用 `Session`/`SessionEvent`/
 *   `deriveEventMessage`/`Agent` 等**真调用**的类型；`wake/scheduler.ts` 用 `Agent` 的
 *   `followup`/`steer`（**真调用**）⇒ 它们走 §2.7-③ **选项 (b)** 或把中立接口下沉到 L0，
 *   **另立一件**（D85 一次只改一件事）。
 * @param ctx 插件上下文（**结构化访问** `on`，故类型为 `unknown`，见下方 I2 说明）
 */
export function registerCroTurnTracking(ctx: unknown): void {
  const on = (event: string, handler: (payload: unknown) => void): void => {
    try {
      // 宿主事件为字符串键，写错只会静默不订阅 ⇒ 名字取自 HOST_EVENTS 白名单（编译期已钉）
      // 🔵 I2 收敛后 `ctx` 本就是 `unknown` ⇒ 原 `as unknown as` 双重断言已冗余，化简为单次。
      ;(ctx as { on: (e: string, h: (p: unknown) => void) => void }).on(event, handler)
    } catch (err) {
      console.log(`[serenity-hooks] ✗ CRO turn 追踪未装配（${event} 不可用）: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // ① 开轮：**只认** `agent/status=running`（见下方 D243 段，⛔ 不要把 `agent/created` 加回来）
  on('agent/status', (payload) => {
    const p = payload as { agent?: unknown; status?: unknown }
    const id = sessionIdOf(p?.agent)
    if (!id) return
    // 只在 running 时报"在跑"；idle ⇒ 清（status 是轮次状态的权威）
    // ⚠️ payload **只有 `status`**（宿主 `AgentLoop.setPhase` 原文：`emit("agent/status", { status })`）
    //    ⇒ 不再读不存在的 `turn`；轮次序号仍可由 `markTurnRunning` 第三参传（其它调用方用）。
    if (p.status === 'running') markTurnRunning(id, Date.now())
    else if (p.status === 'idle') clearTurnRunning(id)
  })

  // ② 收轮：🔴🔴 **D244（2026-10-24）：`agent/turn-stopping` ⛔ 不再清表** ————
  //
  // **为什么**（宿主原文 `AgentLoop.turn()`，`dsh-agent-loop/lib/index.js`）：
  // ```js
  // if (turnEnds && this.inbox.nextStep.length === 0) {
  //     await this.dispatch.serial("agent/turn-stopping", { turn, signal })   // ← 暂停点
  //     signal.throwIfAborted()
  // }
  // if (turnEnds && this.inbox.nextStep.length === 0) break                   // ← 只有 nextStep 空才真结束
  // target = "next-step"                                                      // ← 否则同轮继续！
  // ```
  // ⇒ **`turn-stopping` 是「轮末暂停点」，不是「轮结束」**：任何监听者在回调里往
  //   `next-step` 塞消息（`steer`），**同一轮就继续跑** —— `turn/start` 不重发、
  //   `agent/status` 也不重发（状态没变，还是 running）。
  //
  // 🔴 **实测代价**（2026-10-24 18:1x，真机）：`trajectory/rebuild.ts` 的 auto-continue
  //   在 `turn-stopping` 里 `agent.steer(...)` ⇒ 同轮继续 ⇒ 而本表已被这里清空
  //   ⇒ 一条**连跑 9 分钟**（18:12:00 `turn/start(32)` → 18:21:27 `turn/end(32)`）的轮
  //   **在整段时间里都不在「在跑」表里** ⇒ `interrupted` 的排除失效 ⇒ 把 `steer`
  //   塞进了**正在跑的那一轮**（对它是误导：它没被打断）。
  //
  // ⇒ **唯一知道「轮真的结束了」的地方** = `agent/status = idle`
  //   （`kick()` 的 `finally` 一定 `setPhase({kind:'idle'})`）⇒ 清理只认它。
  // ⚠️ **已知窄代价**：`runMaintenance` 期间 `status` 也是 `idle` ⇒ 压缩等内部工作时不置位。
  //   判可接受：那时没有 CRO 该救的轮；且方向落到本模块头那条**便宜**的误判（报"没跑"）。
  //
  // ⛔ **不要把 `clearTurnRunning` 加回 `turn-stopping`** —— 加了就等于把上面那条 9 分钟的洞
  //   重新打开，而**没有任何一条用例会红**（除非同批加反向钉，见 `tests/cro-turns.test.ts`）。

  // ③ 生命周期清理：载体销毁 ⇒ 清项（防"按载体只增"）
  // ⚠️ 两个事件的 **payload 形状不同**（照 `trajectory/carrier.ts:57-64` 实证）：
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

