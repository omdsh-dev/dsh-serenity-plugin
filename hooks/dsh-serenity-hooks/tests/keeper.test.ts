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

import { KeeperTracker, scoreTool, reminderText } from '../src/seams/keeper.js'

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
