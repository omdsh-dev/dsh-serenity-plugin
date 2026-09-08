/**
 * agent-idle.test.ts — 等待 agent 空闲（S142 review F-08：销毁竞速）
 *
 * 此前 skiff/handyman 各自复制了一份"只等 agent/status → idle"的实现，agent 先销毁
 * 就永久挂起。本测试钉死三条结算通道 + 订阅后状态兜底。
 */
import { describe, it, expect, vi } from 'vitest'
import { waitAgentIdle } from '../src/agent-idle.js'

type Handler = (payload: unknown) => void

/** 极简事件通道替身：记录订阅、可主动触发、返回退订函数 */
function fakeCtx() {
  const handlers = new Map<string, Set<Handler>>()
  const unsubscribed: string[] = []
  const ctx = {
    on(name: string, cb: Handler) {
      const set = handlers.get(name) ?? new Set<Handler>()
      set.add(cb)
      handlers.set(name, set)
      return () => {
        set.delete(cb)
        unsubscribed.push(name)
      }
    },
    emit(name: string, payload: unknown) {
      for (const cb of [...(handlers.get(name) ?? [])]) cb(payload)
    },
    count(name: string) {
      return handlers.get(name)?.size ?? 0
    },
  }
  return { ctx, unsubscribed }
}

const agent = { id: 'a1', session: { id: 's1' } } as never

describe('agent-idle: 三条结算通道', () => {
  it('agent/status idle（同一 agent）→ 结算并退订全部通道', async () => {
    const { ctx, unsubscribed } = fakeCtx()
    const p = waitAgentIdle(ctx as never, agent)
    ctx.emit('agent/status', { agent, status: 'running' }) // 无关转换不结算
    ctx.emit('agent/status', { agent: { id: 'other' }, status: 'idle' }) // 别的 agent 不结算
    ctx.emit('agent/status', { agent, status: 'idle' })
    await expect(p).resolves.toBeUndefined()
    expect(unsubscribed.sort()).toEqual(['agent/disposed', 'agent/status', 'session/disposed'])
    expect(ctx.count('agent/status')).toBe(0)
  })

  it('agent/disposed（同一 agent）→ 结算（销毁竞速，此前永久挂死）', async () => {
    const { ctx } = fakeCtx()
    const p = waitAgentIdle(ctx as never, agent)
    ctx.emit('agent/disposed', { agent: { id: 'other' } }) // 别的 agent 不结算
    ctx.emit('agent/disposed', { agent })
    await expect(p).resolves.toBeUndefined()
  })

  it('session/disposed（同一会话）→ 结算', async () => {
    const { ctx } = fakeCtx()
    const p = waitAgentIdle(ctx as never, agent)
    ctx.emit('session/disposed', { id: 'other-session' })
    ctx.emit('session/disposed', { id: 's1' })
    await expect(p).resolves.toBeUndefined()
  })

  it('订阅后已是 idle（唤醒在订阅前收敛）→ 立即结算，不漏事件挂死', async () => {
    const { ctx } = fakeCtx()
    const idleAgent = { id: 'a2', status: 'idle', session: { id: 's2' } } as never
    await expect(waitAgentIdle(ctx as never, idleAgent)).resolves.toBeUndefined()
  })

  it('事件通道缺失（ctx.on 抛错）→ 不抛错；后续无事件则保持未结算', async () => {
    const ctx = {
      on: vi.fn(() => {
        throw new Error('no event channel')
      }),
    }
    const p = waitAgentIdle(ctx as never, agent)
    expect(() => ctx.on('x', () => {})).toThrow() // 替身自证
    // 未结算（无任何通道）：用微任务竞速确认 promise 仍 pending
    const state = await Promise.race([p.then(() => 'settled'), Promise.resolve('pending')])
    expect(state).toBe('pending')
  })

  it('退订函数抛错 → 不影响结算（宿主回收后重复退订）', async () => {
    const handlers = new Set<Handler>()
    const ctx = {
      on(_name: string, cb: Handler) {
        handlers.add(cb)
        return () => {
          throw new Error('already disposed')
        }
      },
    }
    const p = waitAgentIdle(ctx as never, agent)
    for (const cb of [...handlers]) cb({ agent, status: 'idle' })
    await expect(p).resolves.toBeUndefined()
  })
})
