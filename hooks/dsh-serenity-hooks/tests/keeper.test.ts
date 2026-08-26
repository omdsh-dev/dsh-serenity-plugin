import { describe, it, expect, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { KeeperTracker, scoreTool, reminderText, rebuildReminderText, readContextPressure } from '../src/seams/keeper.js'

describe('keeper: 纯跟踪器', () => {
  it('计分表：write=3, task=10, read=1', () => {
    expect(scoreTool('write')).toBe(3)
    expect(scoreTool('task')).toBe(10)
    expect(scoreTool('read')).toBe(1)
    expect(scoreTool('unknown-tool')).toBe(0)
  })

  it('达到阈值触发提醒，ack 后清零', () => {
    let now = 0
    const t = new KeeperTracker(10, () => now)
    expect(t.step('write')).toBe(false) // 3
    expect(t.step('write')).toBe(false) // 6
    expect(t.step('write')).toBe(false) // 9
    expect(t.step('write')).toBe(true) // 12 ≥ 10
    const code = t.ack()
    expect(code).toBe('K1')
    expect(t.currentScore).toBe(0)
    expect(t.step('read')).toBe(false) // 1
  })

  it('经过时间计分：+1 分/分钟', () => {
    let now = 0
    const t = new KeeperTracker(5, () => now)
    t.step('read') // 1, now=0
    now = 120_000 // +2 分钟
    expect(t.step('read')).toBe(false) // 1+2+1 = 4
    now = 240_000
    expect(t.step('read')).toBe(true) // 4+2+1 = 7 ≥ 5
  })

  it('reminderText 含确认码', () => {
    expect(reminderText('K1', 150)).toContain('[SESSION-KEEPER-recorded-K1]')
  })
})

describe('轨迹跟踪器（Trajectory Tracker）— v1.22.1 概念命名', () => {
  it('rebuildReminderText：SESSION.md=持久轨迹，会话=临时可重建工作副本', () => {
    const text = rebuildReminderText(0.91)
    expect(text).toContain('[TRAJECTORY]')
    expect(text).toContain('91%')
    expect(text).toContain('SESSION.md 是持久轨迹')
    expect(text).toContain('临时可重建')
    expect(text).toContain('session_rebuild')
  })

  it('readContextPressure：sessionProjections 装配时读取投影', () => {
    const session = { id: 's1' }
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
        : undefined,
    }
    const pressure = readContextPressure(ctx as never, session)
    expect(pressure).toEqual({ projectedTokens: 9000, contextWindow: 10000 })
  })

  it('readContextPressure：未装配 / 无压力值 → null（不抛错）', () => {
    const session = { id: 's1' }
    const noService = { get: () => undefined }
    expect(readContextPressure(noService as never, session)).toBeNull()
    const noPressure = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: {} }) }
        : undefined,
    }
    expect(readContextPressure(noPressure as never, session)).toBeNull()
  })
})
