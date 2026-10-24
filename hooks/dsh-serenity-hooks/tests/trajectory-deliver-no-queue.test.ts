/**
 * deliverToTrajectory —— 🔴 **owner 2026-10-24 令「正在跑就直接进，不排队」**
 *
 * owner 原话：「当用户消息进来，且绑定轨迹正在活动时，消息是排队而不是直接进入，
 * 应当改为直接进入，这样确保来回通信的流畅性」。
 *
 * ## 钉什么（D174：两种假设必须产生不同观测）
 * | 假设 | 观测 |
 * |---|---|
 * | 在跑 ⇒ **steer**（当场进当前轮） | `steer` 被调用、`followup` 没被调用 |
 * | 在跑 ⇒ **followup**（排队，修前形态） | `followup` 被调用 —— 本条会红 |
 *
 * ## ⚠️ 为什么必须单独有这条（而不是靠既有用例兜住）
 * 我把入站路径从 `askTrajectory` 换成 `deliverToTrajectory` 之后，
 * **全量 3196 例一条都没红** ⇒ 说明旧用例**没有任何一条钉住"入站怎么投递"**。
 * ⇒ 那条路径此前是**无保护**的：谁把它改回排队，都不会有测试报警。
 */
import { describe, it, expect } from 'vitest'
import { deliverToTrajectory } from '../src/trajectory/session.js'

/** 最小 agent 替身：只记录 steer / followup 有没有被调、以及消息内容 */
function fakeAgent(opts: { status?: string; hasSteer?: boolean; hasFollowup?: boolean } = {}) {
  const calls: Array<{ kind: 'steer' | 'followup'; text: string }> = []
  const textOf = (m: unknown): string => {
    const content = (m as { content?: Array<{ text?: string }> })?.content ?? []
    return content.map((c) => c.text ?? '').join('')
  }
  const agent: Record<string, unknown> = { status: opts.status ?? 'idle' }
  if (opts.hasSteer !== false) {
    agent.steer = (m: unknown) => calls.push({ kind: 'steer', text: textOf(m) })
  }
  if (opts.hasFollowup !== false) {
    agent.followup = (m: unknown) => calls.push({ kind: 'followup', text: textOf(m) })
  }
  return { agent: agent as never, calls }
}

describe('deliverToTrajectory：在跑就直接进（不排队）', () => {
  it('🔴 在跑 ＋ 有 steer ⇒ 走 steer（当场进当前轮），且**不**走 followup', () => {
    const { agent, calls } = fakeAgent({ status: 'running' })
    const r = deliverToTrajectory(agent, '你好')
    expect(r.how).toBe('steer')
    expect(calls.map((c) => c.kind)).toEqual(['steer'])
    expect(calls[0]?.text).toBe('你好')
  })

  it('🔴 反向钉：在跑时**不得**走 followup（修前形态就是 followup=排队）', () => {
    const { agent, calls } = fakeAgent({ status: 'running' })
    deliverToTrajectory(agent, 'q')
    expect(
      calls.some((c) => c.kind === 'followup'),
      '在跑却用 followup ⇒ 消息被排到下一轮 ⇒ 正是 owner 报的"排队"',
    ).toBe(false)
  })

  it('空闲 ⇒ followup（立刻起一轮；此时没有"当前轮"可进）', () => {
    const { agent, calls } = fakeAgent({ status: 'idle' })
    const r = deliverToTrajectory(agent, 'q')
    expect(r.how).toBe('followup')
    expect(calls.map((c) => c.kind)).toEqual(['followup'])
  })

  it('在跑但宿主没给 steer ⇒ 退回 followup（排队也比丢掉好）', () => {
    const { agent, calls } = fakeAgent({ status: 'running', hasSteer: false })
    const r = deliverToTrajectory(agent, 'q')
    expect(r.how).toBe('followup')
    expect(calls.map((c) => c.kind)).toEqual(['followup'])
  })

  it('两个通道都没有 ⇒ how=none（调用方据此出声，不静默丢消息）', () => {
    const { agent, calls } = fakeAgent({ hasSteer: false, hasFollowup: false })
    const r = deliverToTrajectory(agent, 'q')
    expect(r.how).toBe('none')
    expect(calls).toEqual([])
  })

  it('消息正文原样带过去（不被改写/截断）', () => {
    const { agent, calls } = fakeAgent({ status: 'running' })
    const body = '[即时消息] 来自 owner\n多行\n正文'
    deliverToTrajectory(agent, body)
    expect(calls[0]?.text).toBe(body)
  })
})
