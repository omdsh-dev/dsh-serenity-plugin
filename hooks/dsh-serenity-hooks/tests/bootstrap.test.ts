import { describe, it, expect } from 'vitest'
import {
  createEpochPromotion,
  resolveBootstrapSettings,
  DEFAULT_BOOTSTRAP_TOOLS,
  DEFAULT_SUPPRESSED_SOURCES,
  DEFAULT_COMPACTION_TOOLS,
  DEFAULT_ANCHOR_MESSAGES,
  hasUserMessageHistory,
  appendAnchorHistory,
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

  it('cheap-worker agent（sessionId `cheap-worker-` 前缀）恒晋升（完整目录，对齐 S140 修复）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // cheap-worker agent 经 ctx.agents.create 直接创建，delegationDepth 为 0（非 delegation 路径），
    // 但 sessionId 固定 `cheap-worker-` 前缀 → 必须恒判 promoted（否则 zeroTools 配置下拿到 0 工具）
    const agent = mkAgent(mkSession('cheap-worker-sqc-scan-9f3a2b', [], { delegationDepth: 0 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('cheap-worker agent 即使有历史事件也恒晋升（不回落 bootstrap 阶段）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 即便含 compaction/end，cheap-worker agent 仍恒 promoted（autonomous worker 不需 epoch 收窄）
    const session = mkSession('cheap-worker-x-1', [ev('compaction/end', 5), ev('tool/call', 6)])
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

describe('bootstrap: hasUserMessageHistory（v1.28.1 根会话重锚判定——0.1.2-rc.1 适配回归）', () => {
  it('有 user/message 事件 → true（resume/续跑不重锚）', () => {
    const session = mkSession('resume', [ev('user/message', 1), ev('assistant/message', 2)])
    expect(hasUserMessageHistory(session)).toBe(true)
  })

  it('snapshotEvents() 形态同样生效（rc.1 Session 无 .events 属性——bug 2 根因回归）', () => {
    const events = [{ type: 'user/message', seq: 1 }]
    const session = { id: 'resume-snap', header: {}, snapshotEvents: () => events }
    // 旧实现裸读 .events → undefined → 误判"无历史"→ 每条消息都重插锚定（bug 2）
    expect(hasUserMessageHistory(session)).toBe(true)
  })

  it('无 user/message（仅 assistant/工具事件）→ false（仍首轮锚定）', () => {
    const session = mkSession('first', [ev('assistant/message', 1)])
    expect(hasUserMessageHistory(session)).toBe(false)
  })

  it('无事件 / 空会话 → false', () => {
    expect(hasUserMessageHistory(mkSession('empty'))).toBe(false)
    expect(hasUserMessageHistory(null)).toBe(false)
    expect(hasUserMessageHistory(undefined)).toBe(false)
  })
})

describe('bootstrap: resolveBootstrapSettings 协议固有默认值（零配置面，S142）', () => {
  it('无参返回唯一固化设置：zeroTools=false（v1.60 造历史后不再需要 0 工具首请求）+ 两条协议锚定消息', () => {    const s = resolveBootstrapSettings()
    expect(s.bootstrapTools).toEqual(DEFAULT_BOOTSTRAP_TOOLS)
    expect(s.promoteEvents.has('assistant/message')).toBe(true)
    expect(s.promoteEvents.has('tool/call')).toBe(false) // zeroTools 变体：仅 assistant/message
    expect([...s.suppressedSources]).toEqual(DEFAULT_SUPPRESSED_SOURCES)
    expect(s.compactionTools).toEqual(DEFAULT_COMPACTION_TOOLS)
    expect(s.anchorMessages).toEqual(DEFAULT_ANCHOR_MESSAGES)
    expect(s.anchorMessages).toHaveLength(2)
    expect(s.requiredSignals).toBe(2) // 两轮锚定：每条回复计一次，第 2 条回复后晋升
    // v1.60（owner 令 2026-10-17）：锚定历史改为**直接造进日志** ⇒ 晋升信号在首请求前
    // 已满足 ⇒ 不再需要「首请求 0 工具」。显式关掉，避免依赖"恰好满足"这个副作用。
    expect(s.zeroTools).toBe(false)
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

// ── 回归钉：锚定历史「造」而非「跑」（v1.60，owner 令 2026-10-17）──────────────
//
// 🔴 这组用例钉的是**行为契约**，不是实现细节：若有人把它改回"往 inbox prepend
//    两条消息、让模型真跑两轮"，下面第 1 条就会红（append 次数对不上），
//    第 2 条也会红（没有占位 system ⇒ 宿主会把 system 追加到末尾，与 P2 实测同形）。

describe('bootstrap: appendAnchorHistory —— 造历史而非真跑', () => {
  /** 记录 append 调用（替身与真身同形：session.append(type, data, opts)） */
  function recorder(): {
    session: { append: (t: string, d: unknown, o?: unknown) => { seq: number } }
    calls: Array<{ type: string; data: Record<string, unknown>; opts: Record<string, unknown> }>
  } {
    const calls: Array<{ type: string; data: Record<string, unknown>; opts: Record<string, unknown> }> = []
    return {
      calls,
      session: {
        append: (type: string, data: unknown, opts?: unknown) => {
          calls.push({ type, data: data as Record<string, unknown>, opts: (opts ?? {}) as Record<string, unknown> })
          return { seq: calls.length }
        },
      },
    }
  }

  it('写入 1 条占位 system + 两轮 (user, assistant)，共 5 条，且全部 surfaceOp=append', () => {
    const { session, calls } = recorder()
    expect(appendAnchorHistory(session, 'prov-x', 'model-y')).toBe(true)

    expect(calls.map((c) => c.type)).toEqual([
      'system/message',
      'user/message', 'assistant/message',
      'user/message', 'assistant/message',
    ])
    // 全部走 append（不是 replace）—— replace 会让 contentGeneration 涨，本轨已验它无害，
    // 但**没有理由**在这里制造它。
    expect(calls.every((c) => c.opts.surfaceOp === 'append')).toBe(true)
  })

  it('🔴 占位 system 必须**先**写：它是 surface node 0 的唯一保证', () => {
    const { session, calls } = recorder()
    appendAnchorHistory(session, 'p', 'm')
    // 顺序判据：第一条必须是 system/message。若被挪到后面，宿主会把真 system
    // 追加到末尾（探针 P2 实测：systemAtIndex=4，且**不报错**）。
    expect(calls[0]!.type).toBe('system/message')
  })

  it('两条锚定消息按正序写入，assistant 回复固定为 acknowledge', () => {
    const { session, calls } = recorder()
    appendAnchorHistory(session, 'p', 'm')
    const userTexts = calls
      .filter((c) => c.type === 'user/message')
      .map((c) => (c.data.content as Array<{ text: string }>)[0]!.text)
    expect(userTexts).toEqual([...DEFAULT_ANCHOR_MESSAGES])

    const assistants = calls.filter((c) => c.type === 'assistant/message')
    expect(assistants.map((c) => (c.data.message as { content: Array<{ text: string }> }).content[0]!.text))
      .toEqual(['acknowledge', 'acknowledge'])
    // stream 是宿主必填字段；空数组通过校验（探针 P3）
    expect(assistants.every((c) => Array.isArray((c.data as { stream?: unknown }).stream))).toBe(true)
  })

  it('两轮各打独立的 turn 标签（owner 令「搞两个」）', () => {
    const { session, calls } = recorder()
    appendAnchorHistory(session, 'p', 'm')
    const assistants = calls.filter((c) => c.type === 'assistant/message')
    expect(assistants.map((c) => (c.data as { turn?: number }).turn)).toEqual([1, 2])
  })

  it('无 append 能力的 session ⇒ 返回 false，不抛（降级不阻断会话）', () => {
    expect(appendAnchorHistory(undefined, 'p', 'm')).toBe(false)
    expect(appendAnchorHistory({}, 'p', 'm')).toBe(false)
    expect(appendAnchorHistory({ append: 123 }, 'p', 'm')).toBe(false)
  })
})
