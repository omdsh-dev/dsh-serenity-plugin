/**
 * tests/trajectory-alive.test.ts — 存活判据（owner 2026-10-20 裁决）
 *
 * ## 被测的原话
 *
 * > 「死应该包含归档判断；只有 ① 或者 ②且不在归档集 才算活」
 * > 「use 只要被调用了，可以无条件覆盖绑定到当前会话（这说明当前会话肯定活着啊）」
 *
 * ## 这一组用例防的是什么（每条都对应一次真实误判）
 *
 * | 用例 | 防的错误形态 |
 * |---|---|
 * | 归档 ∧ 日志在 ⇒ **死** | 旧实现只看日志 ⇒ 已归档会话被当活载体（S196 现场） |
 * | 归档 ∧ **loaded** ⇒ 死 | owner ① 未附"不在归档集"，本仓按"归档是处置声明"收紧 |
 * | loaded 非归档 ⇒ 活 | 冷/热两个方向都要成立，别把热会话判死 |
 * | 日志在且未归档 ⇒ 活 | ② 的正向（冷会话仍可用） |
 * | 什么都没有 ⇒ 死 | 两维皆空 |
 * | 空 id ⇒ 死 | 形状守卫 |
 *
 * ## 变异检验（做完即删回）
 *
 * 把 `isSessionAlive` 里 `if (facts.archivedIds.has(...)) return false` 删掉 ⇒
 * 前两条用例必须当场红；其余仍绿。**若删掉之后测试还全绿，说明用例没咬住实现。**
 */

import { describe, it, expect } from 'vitest'
import { isSessionAlive, type SessionAliveFacts } from '../src/trajectory/alive.js'

/** 造一份事实：默认"日志不存在、没归档、没加载" = 死 */
function facts(opts: Partial<{
  live: string[]
  archived: string[]
  logs: string[]
}> = {}): SessionAliveFacts {
  const liveIds = new Set(opts.live ?? [])
  const archivedIds = new Set(opts.archived ?? [])
  const logIds = new Set(opts.logs ?? [])
  return { liveIds, archivedIds, hasLog: (id: string) => logIds.has(id) }
}

describe('存活判据：活 ⟺ ① ∨ (② ∧ 不在归档集)', () => {
  it('🔴 归档 ＋ 日志在 ⇒ **死**（这条就是 S196 的 52d680ae）', () => {
    // 现场取值：session-52d680ae 同时满足"日志在磁盘"与"在 archivedSessionIds 里"。
    const f = facts({ logs: ['session-52d680ae'], archived: ['session-52d680ae'] })
    expect(isSessionAlive('session-52d680ae', f)).toBe(false)
  })

  it('🔴 归档 ＋ **仍然 loaded** ⇒ 死（归档是处置声明，优先于"字节还在内存里"）', () => {
    const f = facts({ live: ['session-x'], archived: ['session-x'] })
    expect(isSessionAlive('session-x', f)).toBe(false)
  })

  it('① loaded 且未归档 ⇒ 活', () => {
    expect(isSessionAlive('session-x', facts({ live: ['session-x'] }))).toBe(true)
  })

  it('② 日志在且未归档 ⇒ 活（冷会话仍可用）', () => {
    expect(isSessionAlive('session-x', facts({ logs: ['session-x'] }))).toBe(true)
  })

  it('两维皆空 ⇒ 死', () => {
    expect(isSessionAlive('session-x', facts())).toBe(false)
  })

  it('空 id ⇒ 死（形状守卫，不抛）', () => {
    expect(isSessionAlive('', facts({ live: [''], logs: [''] }))).toBe(false)
  })

  it('只判据自己给的 id：集合里别的 id 不影响', () => {
    const f = facts({ live: ['other'], logs: ['other'] })
    expect(isSessionAlive('session-x', f)).toBe(false)
    expect(isSessionAlive('other', f)).toBe(true)
  })
})
