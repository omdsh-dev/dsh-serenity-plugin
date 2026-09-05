/**
 * trajectory-assistant.test.ts — 关卡化注入统一命名模块（v0.3，S142）
 *
 * 覆盖：token 常量单一真相源（eventToken / EVENT_LABEL）/ ACK 前缀 /
 * 风格门面（plain 默认 + metaphor 变体——仅前缀措辞，D8 无 game 档）/
 * 结算 seam 契约（OP-1 预留，无调用者）。
 */
import { describe, it, expect } from 'vitest'
import {
  ASSISTANT_PREFIX,
  EVENT_LABEL,
  ACK_PREFIX,
  ACK_SKIP_PREFIX,
  eventToken,
  styledToken,
  onSettlement,
} from '../src/trajectory-assistant.js'

describe('trajectory-assistant: token 常量（单一真相源）', () => {
  it('家族标识 + 可见用词（自然跨领域词，无游戏黑话 D8）', () => {
    expect(ASSISTANT_PREFIX).toBe('TRAJECTORY-ASSISTANT')
    expect(EVENT_LABEL.checkpoint).toBe('CHECKPOINT')
    expect(EVENT_LABEL.limit).toBe('LIMIT') // 上下文极限（非 BOSS——D8）
    expect(EVENT_LABEL.limitMandatory).toBe('LIMIT · MANDATORY')
    expect(EVENT_LABEL.rebuild).toBe('REBUILD')
    expect(EVENT_LABEL.guard).toBe('BOUNDARY GUARD')
    // D8：无任何游戏黑话
    const all = Object.values(EVENT_LABEL).join(' ')
    expect(all).not.toMatch(/BOSS|XP|level|respawn/i)
  })

  it('eventToken 组装完整前缀', () => {
    expect(eventToken('checkpoint')).toBe('[TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(eventToken('limit')).toBe('[TRAJECTORY-ASSISTANT · LIMIT]')
    expect(eventToken('limitMandatory')).toBe('[TRAJECTORY-ASSISTANT · LIMIT · MANDATORY]')
    expect(eventToken('rebuild')).toBe('[TRAJECTORY-ASSISTANT · REBUILD]')
    expect(eventToken('guard')).toBe('[TRAJECTORY-ASSISTANT · BOUNDARY GUARD]')
  })

  it('ACK 前缀（recorded/skipped 语义不变，家族名更新）', () => {
    expect(ACK_PREFIX).toBe('TRAJECTORY-ASSISTANT-recorded')
    expect(ACK_SKIP_PREFIX).toBe('TRAJECTORY-ASSISTANT-skipped')
  })
})

describe('trajectory-assistant: 风格门面（plain 默认 / metaphor 变体）', () => {
  it('缺省 = plain（与 eventToken 一致）', () => {
    expect(styledToken('checkpoint')).toBe(eventToken('checkpoint'))
    expect(styledToken('limit')).toBe('[TRAJECTORY-ASSISTANT · LIMIT]')
  })

  it('metaphor 档：仅前缀措辞变体（无 game 档——D8）', () => {
    expect(styledToken('limit', 'metaphor')).toBe('[TRAJECTORY-ASSISTANT · CONTEXT LIMIT]')
    expect(styledToken('limitMandatory', 'metaphor')).toBe('[TRAJECTORY-ASSISTANT · CONTEXT LIMIT · MANDATORY]')
    // 无 metaphor 变体的事件 → 回退 plain（措辞一致）
    expect(styledToken('checkpoint', 'metaphor')).toBe('[TRAJECTORY-ASSISTANT · CHECKPOINT]')
  })
})

describe('trajectory-assistant: 结算 seam（OP-1/D6 预留契约）', () => {
  it('onSettlement 可安全调用（当前无调用者，无触发器——D2 记录未解）', () => {
    let fired = 0
    onSettlement((id) => {
      fired += 1
      expect(id).toBe('S999')
    })
    // 结算触发器尚未实现 → 注册不立即触发（契约：未来仪式接入后触发）
    expect(fired).toBe(0)
  })
})
