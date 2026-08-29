import { describe, it, expect } from 'vitest'
import {
  createEpochPromotion,
  resolveBootstrapSettings,
  DEFAULT_BOOTSTRAP_TOOLS,
  DEFAULT_SUPPRESSED_SOURCES,
  DEFAULT_COMPACTION_TOOLS,
  DEFAULT_ANCHOR_MESSAGES,
} from '../src/seams/bootstrap.js'

/** 构造最小 agent（子 agent 模拟） */
function mkAgent(session: unknown): unknown {
  return { session }
}

function mkSession(id: string, events: unknown[] = [], header: Record<string, unknown> = {}): unknown {
  return { id, events, header }
}

function ev(type: string, seq = 0): unknown {
  return { type, seq }
}

describe('bootstrap: createEpochPromotion 阶段机（对齐 anchored compaction-epoch）', () => {
  it('无事件 → 未晋升（boundary -1）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const agent = mkAgent(mkSession('s1'))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: false })
  })

  it('tool/call 事件 → 晋升（tool-call 模式）', () => {
    const p = createEpochPromotion(new Set(['tool/call']))
    const agent = mkAgent(mkSession('s1', [ev('tool/call', 1)]))
    expect(p.status(agent as never).promoted).toBe(true)
  })

  it('either 模式：assistant/message 或 tool/call 先到者晋升', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    expect(p.status(mkAgent(mkSession('s1', [ev('assistant/message', 1)])) as never).promoted).toBe(true)
    expect(p.status(mkAgent(mkSession('s2', [ev('tool/call', 1)])) as never).promoted).toBe(true)
  })

  it('observe 增量：事件到达后晋升（无需重新 scan）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const session = mkSession('s1')
    p.status(mkAgent(session) as never) // 冷启动 scan 建条目
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('tool/call', 1))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('compaction/end 后回落未晋升，需新的晋升信号（epoch 感知）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 晋升后压缩
    const session = mkSession('s1', [ev('tool/call', 1), ev('compaction/end', 5)])
    const status = p.status(mkAgent(session) as never)
    expect(status.promoted).toBe(false)
    expect(status.boundary).toBe(5)
    // 压缩后新 tool/call → 重新晋升
    p.observe(session, ev('tool/call', 6))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('压缩前的事件不算晋升（boundary 前）', () => {
    const p = createEpochPromotion(new Set(['tool/call']))
    const session = mkSession('s1', [ev('tool/call', 1), ev('compaction/end', 5), ev('assistant/message', 6)])
    // either 模式：boundary 后 assistant/message → 晋升
    const p2 = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    expect(p2.status(mkAgent(session) as never).promoted).toBe(true)
    // tool-call 模式：boundary 后无 tool/call → 未晋升
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
  })

  it('子 agent（delegationDepth > 0）恒晋升（完整目录）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const agent = mkAgent(mkSession('sub', [], { delegationDepth: 1 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('handyman agent（sessionId `handyman-` 前缀）恒晋升（完整目录，对齐 S140 修复）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // handyman agent 经 ctx.agents.create 直接创建，delegationDepth 为 0（非 delegation 路径），
    // 但 sessionId 固定 `handyman-` 前缀 → 必须恒判 promoted（否则 zeroTools 配置下拿到 0 工具）
    const agent = mkAgent(mkSession('handyman-sqc-scan-9f3a2b', [], { delegationDepth: 0 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('handyman agent 即使有历史事件也恒晋升（不回落 bootstrap 阶段）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 即便含 compaction/end，handyman agent 仍恒 promoted（autonomous worker 不需 epoch 收窄）
    const session = mkSession('handyman-x-1', [ev('compaction/end', 5), ev('tool/call', 6)])
    expect(p.status(mkAgent(session) as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('Skiff agent（sessionId `skiff-` 前缀）恒晋升（角色 CCC 提示词全替换，无锚定轮，F4b 旁路）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const agent = mkAgent(mkSession('skiff-qa-readonly-uuid', [], { delegationDepth: 0 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
    // 有历史事件也恒晋升
    const session = mkSession('skiff-review-1', [ev('compaction/end', 5), ev('tool/call', 6)])
    expect(p.status(mkAgent(session) as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('resume：从持久 events 重建阶段（不依赖进程内存）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 模拟重启：新 tracker + 有历史的 session
    const agent = mkAgent(mkSession('s1', [ev('assistant/message', 3)]))
    expect(p.status(agent as never).promoted).toBe(true)
  })

  it('requiredSignals=2：两轮锚定——第 2 条 assistant/message 才晋升（v4 多轮递进）', () => {
    const p = createEpochPromotion(new Set(['assistant/message']), 2)
    // 第一条锚定回复 → 未晋升
    const session = mkSession('s1', [ev('assistant/message', 1)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第二条锚定回复 → 晋升
    p.observe(session, ev('assistant/message', 2))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：晋升信号缺失时，step/start 达 maxRoundsFallback（3）强制晋升（responses API 兼容）', () => {
    // 模拟 responses API 模型：promoteEvents 不含 assistant/message（如 tool-call 模式）
    // 或信号永不到达——3 步后必须解锁完整工具，不能永久卡 0 工具
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    const session = mkSession('s-resp', [])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第 1、2 步 step/start → 仍未晋升（兜底未到）
    p.observe(session, ev('step/start', 1))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('step/start', 2))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第 3 步 step/start → 兜底强制晋升
    p.observe(session, ev('step/start', 3))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：scan 路径同样生效（resume 会话，step/start 计数）', () => {
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    // 3 条 step/start（无 tool/call）→ scan 时即 promoted
    const session = mkSession('s-resp-resume', [ev('step/start', 1), ev('step/start', 2), ev('step/start', 3)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：compaction 后回落，需重新计数（epoch 感知）', () => {
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    const session = mkSession('s-resp-epoch', [ev('step/start', 1), ev('step/start', 2), ev('step/start', 3), ev('compaction/end', 5)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 压缩后 3 步 step/start → 重新兜底晋升
    p.observe(session, ev('step/start', 6))
    p.observe(session, ev('step/start', 7))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('step/start', 8))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('requiredSignals=2：压缩后计数重置，需重新累计 2 条', () => {
    const p = createEpochPromotion(new Set(['assistant/message']), 2)
    const session = mkSession('s1', [ev('assistant/message', 1), ev('assistant/message', 2), ev('compaction/end', 5)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('assistant/message', 6))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('assistant/message', 7))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })
})

describe('bootstrap: resolveBootstrapSettings 协议固有默认值（零配置面，S142）', () => {
  it('无参返回唯一固化设置：zeroTools + 两条协议锚定消息', () => {
    const s = resolveBootstrapSettings()
    expect(s.bootstrapTools).toEqual(DEFAULT_BOOTSTRAP_TOOLS)
    expect(s.promoteEvents.has('assistant/message')).toBe(true)
    expect(s.promoteEvents.has('tool/call')).toBe(false) // zeroTools 变体：仅 assistant/message
    expect([...s.suppressedSources]).toEqual(DEFAULT_SUPPRESSED_SOURCES)
    expect(s.compactionTools).toEqual(DEFAULT_COMPACTION_TOOLS)
    expect(s.anchorMessages).toEqual(DEFAULT_ANCHOR_MESSAGES)
    expect(s.anchorMessages).toHaveLength(2)
    expect(s.requiredSignals).toBe(2) // 两轮锚定：每条回复计一次，第 2 条回复后晋升
    expect(s.zeroTools).toBe(true)
  })

  it('协议锚定消息内容不可配置：含 ACC 身份 + acknowledge 要求（S142 用户确认固化）', () => {
    const [first, second] = DEFAULT_ANCHOR_MESSAGES
    expect(first).toContain('Abstract Cognitive Container (ACC) protocol')
    expect(first).toContain('Explicit Abstraction Principle')
    expect(first).toContain('The personal pronoun is us/we.')
    expect(first).toContain('We anchor first, then act: the abstract layer precedes the concrete.')
    expect(first).toContain('Please simply reply "acknowledge" — no action needed.')
    expect(second).toContain('Before we proceed, align on how we work')
    expect(second).toContain('SESSION.md')
    expect(second).toContain('Please simply reply "acknowledge" — no action needed.')
  })
})
