/**
 * trajectory-assistant.test.ts — `cognitive-trajectory-assistant.ts` 的镜像测试（v0.3，S142）
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
} from '../src/cognitive-trajectory-assistant.js'

describe('cognitive-trajectory-assistant: token 常量（单一真相源）', () => {
  it('家族标识 + 可见用词（自然跨领域词，无游戏黑话 D8）', () => {
    expect(ASSISTANT_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT')
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
    expect(eventToken('checkpoint')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(eventToken('limit')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · LIMIT]')
    expect(eventToken('limitMandatory')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · LIMIT · MANDATORY]')
    expect(eventToken('rebuild')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD]')
    expect(eventToken('guard')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · BOUNDARY GUARD]')
  })

  it('ACK 前缀（recorded/skipped 语义不变，家族名更新）', () => {
    expect(ACK_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT-recorded')
    expect(ACK_SKIP_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT-skipped')
  })
})

describe('cognitive-trajectory-assistant: 风格门面（plain 默认 / metaphor 变体）', () => {
  it('缺省 = plain（与 eventToken 一致）', () => {
    expect(styledToken('checkpoint')).toBe(eventToken('checkpoint'))
    expect(styledToken('limit')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · LIMIT]')
  })

  it('metaphor 档：仅前缀措辞变体（无 game 档——D8）', () => {
    expect(styledToken('limit', 'metaphor')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CONTEXT LIMIT]')
    expect(styledToken('limitMandatory', 'metaphor')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CONTEXT LIMIT · MANDATORY]')
    // 无 metaphor 变体的事件 → 回退 plain（措辞一致）
    expect(styledToken('checkpoint', 'metaphor')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
  })
})

