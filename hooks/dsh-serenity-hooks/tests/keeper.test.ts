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

  it('reminderText 含确认码（v1.23.0 steward 前缀）', () => {
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-STEWARD-recorded-K1]')
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-STEWARD]')
    expect(reminderText('K1', 150)).not.toContain('SESSION-KEEPER')
  })
})

describe('轨迹跟踪器（Trajectory Tracker）— v1.22.1 概念命名', () => {
  it('rebuildReminderText：SESSION.md=持久轨迹，会话=临时可重建工作副本（v1.23.0 英化 + v1.23.3 行动指令化）', () => {
    const text = rebuildReminderText(0.91, 0.9)
    expect(text).toContain('[TRAJECTORY]')
    expect(text).toContain('91%')
    expect(text).toContain('threshold 90%')
    expect(text).toContain('persistent body')
    expect(text).toContain('rebuildable carrier')
    expect(text).toContain('ACT NOW')
    expect(text).toContain('session_rebuild')
    expect(text).toContain('not an option')
    // v1.24.12 沉淀协议：rebuild 前修订现有 skill（eap 结构化）；新建 skill 写 SESSION 提案不自行创建
    expect(text).toContain('revise the relevant existing skill of this CCC')
    expect(text).toContain('write a short proposal into SESSION.md')
    expect(text).toContain('do not create it yourself')
    // v1.23.3：不向 LLM 植入阈值建议（设定是用户自由）
    expect(text).not.toContain('0.75~0.9')
  })

  it('rebuildReminderText 升级语气（escalated=true，v1.23.3）', () => {
    const text = rebuildReminderText(0.93, 0.9, true)
    expect(text).toContain('[TRAJECTORY-ESCALATED]')
    expect(text).toContain('mandatory')
    expect(text).toContain('STOP')
    expect(text).toContain('session_rebuild')
    expect(text).toContain('persists until you call session_rebuild')
    // v1.24.12：升级版同样带紧凑沉淀指令（修订 skill / 新建 skill 提案进 SESSION）
    expect(text).toContain('preserve valuable cognition')
    expect(text).toContain('new-skill proposal into SESSION.md')
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
