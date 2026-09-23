/**
 * cro-turns.test.ts — 「这条轨迹是否正在跑轮次」的镜像测试（S142 §7.8，2026-09-19）
 *
 * ## 这个模块为什么必须有测试（它自己就是"病族成员"）
 *
 * `cro-turns.ts` 是 CRO 唯一需要 ACC 新增的状态，而它的头号风险是
 * **"只增不清"**（本容器栽过 5 次：wake-registry / keeper 三表 / pendingRebuilds …）。
 * ⇒ 本文件的重点**不是**"表能存能取"，而是**清理真的发生了**：
 *   · TTL 过期 ⇒ 项**被删掉**（不是只跳过）——用 `croTurnTableSize()` 断言**表变小了**；
 *   · 载体销毁（disposed）⇒ 项被删；
 *   · 插件拆卸 ⇒ 表清空。
 *
 * ## 第二条重点：**订阅的事件名真的存在**（"接口 200 ≠ 内容到了"）
 *
 * 宿主事件是**字符串键**：名字写错**不会报错**，只会**静默不订阅**——正是本模块注释里
 * 自己点出的风险。⇒ 本文件把"装配时实际订阅的 5 个名字"抓下来，与宿主契约表
 * `HOST_EVENTS`（单一真相源）**逐个比对**。这条能机械挡住未来的一次改名/笔误。
 *
 * ## 第三条：失败不抛（`apply` 不可成为启动单点）
 *
 * 事件通道缺失 / `ctx.effect` 缺失 ⇒ **响亮降级，不抛**（否则一个测试替身或极旧宿主
 * 会让整个 dsh 启动失败）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_EVENTS } from '../src/host/contract.js'
import {
  __resetCroTurnsForTest,
  clearTurnRunning,
  croTurnTableSize,
  listRunningSessionIds,
  markTurnRunning,
  registerCroTurnTracking,
  runningCarriersOf,
  TURN_TTL_MS,
} from '../src/cro-turns.js'

const NOW = 1_789_800_000_000
const A = 'session-aaa'
const B = 'session-bbb'
const C = 'session-ccc'

/** 事件 payload 的形状（照 `host/contract.ts` / `agent-idle.ts` 实测） */
const agentPayload = (id: string): unknown => ({ agent: { session: { id } } })

/** `registerCroTurnTracking` 实际订阅的事件名（装配期抓取；见文件头第二条重点） */
let subscribed: string[] = []

/** 测试替身 ctx：记录事件处理器 + `ctx.effect` 的清理回调 */
function fakeCtx(opts: { withOn?: boolean; withEffect?: boolean; onThrows?: boolean } = {}) {
  const handlers = new Map<string, Array<(p: unknown) => void>>()
  const cleanups: Array<() => void> = []
  const ctx: Record<string, unknown> = {}
  if (opts.withOn !== false) {
    ctx.on = (event: string, handler: (p: unknown) => void): void => {
      if (opts.onThrows) throw new Error('事件通道不可用')
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    }
  }
  if (opts.withEffect !== false) {
    ctx.effect = (cb: () => () => void): void => {
      cleanups.push(cb())
    }
  }
  const emit = (event: string, payload: unknown): void => {
    for (const h of handlers.get(event) ?? []) h(payload)
  }
  return { ctx, handlers, cleanups, emit }
}

/** 装配 + 抓取订阅名（所有用例共用；顺带钉住"订阅了哪 5 个"） */
function install(opts: Parameters<typeof fakeCtx>[0] = {}) {
  const fake = fakeCtx(opts)
  subscribed = []
  const originalOn = fake.ctx.on as ((e: string, h: (p: unknown) => void) => void) | undefined
  if (originalOn) {
    fake.ctx.on = (e: string, h: (p: unknown) => void): void => {
      subscribed.push(e)
      originalOn(e, h)
    }
  }
  registerCroTurnTracking(fake.ctx as never)
  return fake
}

beforeEach(() => {
  __resetCroTurnsForTest()
})

afterEach(() => {
  __resetCroTurnsForTest()
  subscribed = []
})

// ── 标记与清除（语义层）──

describe('CRO turn 追踪: 标记与清除', () => {
  it('标记后进入"在跑"集合', () => {
    markTurnRunning(A, NOW)
    expect(listRunningSessionIds(NOW)).toEqual([A])
    expect(croTurnTableSize()).toBe(1)
  })

  it('清除后离开集合', () => {
    markTurnRunning(A, NOW)
    clearTurnRunning(A)
    expect(listRunningSessionIds(NOW)).toEqual([])
    expect(croTurnTableSize()).toBe(0)
  })

  it('重复标记同一载体 ⇒ 只有一项（以载体为键，不按轮次堆积）', () => {
    markTurnRunning(A, NOW)
    markTurnRunning(A, NOW + 1000, 2)
    expect(croTurnTableSize()).toBe(1)
  })

  it('🔴 空 id 一律忽略（不制造无名项）', () => {
    markTurnRunning('', NOW)
    clearTurnRunning('')
    expect(croTurnTableSize()).toBe(0)
  })

  it('清除一个不存在的项 ⇒ 不抛', () => {
    expect(() => clearTurnRunning('session-nope')).not.toThrow()
  })
})

// ── TTL 兜底（🔴 本模块的头号风险：只增不清）──

describe('CRO turn 追踪: TTL 兜底（异常路径的唯一执行点）', () => {
  it('TTL 内 ⇒ 仍在跑', () => {
    markTurnRunning(A, NOW)
    expect(listRunningSessionIds(NOW + TURN_TTL_MS)).toEqual([A]) // 边界：等于 TTL ⇒ 未过期
  })

  it('🔴 超 TTL ⇒ 视为不在跑，**且顺手把项删掉**（不是只跳过）', () => {
    markTurnRunning(A, NOW)
    expect(listRunningSessionIds(NOW + TURN_TTL_MS + 1)).toEqual([])
    // 🔴 这一条才是本模块的核心断言：表必须**变小**，否则就是"只增不清"病复发
    expect(croTurnTableSize()).toBe(0)
  })

  it('过期清理只删过期的，不碰新鲜的', () => {
    markTurnRunning(A, NOW - TURN_TTL_MS - 1) // 已过期
    markTurnRunning(B, NOW) // 新鲜
    expect(listRunningSessionIds(NOW)).toEqual([B])
    expect(croTurnTableSize()).toBe(1)
  })

  it('TTL 可注入（门限取值见文件头的方向性判据）', () => {
    markTurnRunning(A, NOW)
    expect(listRunningSessionIds(NOW + 5_000, 1_000)).toEqual([])
    expect(croTurnTableSize()).toBe(0)
  })

  it('TTL 缺省 = 30 分钟（**不确定时宁可报"没跑"**那个便宜的方向）', () => {
    expect(TURN_TTL_MS).toBe(30 * 60 * 1000)
  })
})

// ── 按轨迹聚合 ──

describe('CRO turn 追踪: 按轨迹聚合（runningCarriersOf）', () => {
  it('取绑定集与在跑集的交集', () => {
    markTurnRunning(A, NOW)
    markTurnRunning(C, NOW)
    expect(runningCarriersOf([A, B, C], NOW)).toEqual([A, C])
    expect(runningCarriersOf([B], NOW)).toEqual([])
  })

  it('🔴 多载体轨迹：**任一在跑**即算在跑（S142 曾挂 4 条载体）', () => {
    markTurnRunning(C, NOW)
    expect(runningCarriersOf([A, B, C], NOW)).toEqual([C])
  })

  it('在跑但与**本轨迹无关**的载体不算数', () => {
    markTurnRunning('session-other', NOW)
    expect(runningCarriersOf([A, B], NOW)).toEqual([])
  })

  it('无绑定载体 ⇒ 空（且不抛）', () => {
    markTurnRunning(A, NOW)
    expect(runningCarriersOf([], NOW)).toEqual([])
  })

  it('聚合时同样执行 TTL 清理', () => {
    markTurnRunning(A, NOW - TURN_TTL_MS - 1)
    expect(runningCarriersOf([A], NOW)).toEqual([])
    expect(croTurnTableSize()).toBe(0)
  })
})

// ── 事件接缝（registerCroTurnTracking）──

describe('CRO turn 追踪: 事件接缝', () => {
  it('🔴 订阅的 5 个事件名**全部**在宿主契约表里（防"名字写错 ⇒ 静默不订阅"）', () => {
    install()
    expect(subscribed.sort()).toEqual(
      ['agent/created', 'agent/disposed', 'agent/status', 'agent/turn-stopping', 'session/disposed'].sort(),
    )
    const contract = new Set(HOST_EVENTS.map((e) => e.name))
    for (const name of subscribed) {
      expect(contract.has(name), `事件 ${name} 不在 HOST_EVENTS 白名单里`).toBe(true)
    }
  })

  it('`agent/created`（v0.1.7 前名 `agent/session-start`）⇒ 标记在跑', () => {
    const f = install()
    f.emit('agent/created', agentPayload(A))
    expect(listRunningSessionIds(NOW)).toEqual([A])
  })

  it('`agent/status=running` ⇒ 标记在跑；`=idle` ⇒ 清除（status 是轮次状态的权威）', () => {
    const f = install()
    f.emit('agent/status', { agent: { session: { id: A } }, status: 'running', turn: 3 })
    expect(listRunningSessionIds(NOW)).toEqual([A])
    f.emit('agent/status', { agent: { session: { id: A } }, status: 'idle' })
    expect(listRunningSessionIds(NOW)).toEqual([])
  })

  it('`agent/turn-stopping` ⇒ 清除（正常收轮路径）', () => {
    const f = install()
    f.emit('agent/created', agentPayload(A))
    f.emit('agent/turn-stopping', agentPayload(A))
    expect(listRunningSessionIds(NOW)).toEqual([])
    expect(croTurnTableSize()).toBe(0)
  })

  it('🔴 `agent/disposed`（payload `{ agent }`）⇒ 清除', () => {
    const f = install()
    f.emit('agent/created', agentPayload(A))
    f.emit('agent/disposed', agentPayload(A))
    expect(croTurnTableSize()).toBe(0)
  })

  it('🔴 `session/disposed` 的 payload **本身就是那个 session**（形状与上一条不同）⇒ 清除', () => {
    const f = install()
    f.emit('agent/created', agentPayload(A))
    f.emit('session/disposed', { id: A }) // 直接有 .id，没有 .agent
    expect(croTurnTableSize()).toBe(0)
  })

  it('畸形 payload ⇒ 不抛、也不误标（不制造无名项）', () => {
    const f = install()
    for (const bad of [undefined, null, {}, { agent: {} }, { agent: { session: {} } }, { id: 42 }]) {
      expect(() => f.emit('agent/created', bad)).not.toThrow()
      expect(() => f.emit('session/disposed', bad)).not.toThrow()
    }
    expect(croTurnTableSize()).toBe(0)
  })

  it('🔴 拆卸 ⇒ 表清空（内存态不留残余）', () => {
    const f = install()
    f.emit('agent/created', agentPayload(A))
    expect(croTurnTableSize()).toBe(1)
    for (const cleanup of f.cleanups) cleanup()
    expect(croTurnTableSize()).toBe(0)
  })
})

// ── 失败不抛（apply 不可成为启动单点）──

describe('CRO turn 追踪: 装配失败不抛（apply 不可成为启动单点）', () => {
  it('ctx.on 抛错 ⇒ 不抛（响亮降级，装载继续）', () => {
    expect(() => registerCroTurnTracking(fakeCtx({ onThrows: true }).ctx as never)).not.toThrow()
  })

  it('ctx 没有 on ⇒ 不抛', () => {
    expect(() => registerCroTurnTracking(fakeCtx({ withOn: false }).ctx as never)).not.toThrow()
  })

  it('ctx 没有 effect ⇒ 不抛（disposer 缺失只告警）', () => {
    expect(() => registerCroTurnTracking(fakeCtx({ withEffect: false }).ctx as never)).not.toThrow()
  })
})
