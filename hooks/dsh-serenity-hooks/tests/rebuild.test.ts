import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
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
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import {
  buildRebuildAnchor,
  queueRebuild,
  performRebuild,
  registerRebuildTurnHook,
  pendingRebuildSnapshot,
  stripAckSuffix,
  resolveSessionMdPath,
} from '../src/rebuild.js'
import { rebuildReminderText, readContextPressure } from '../src/seams/keeper.js'
import { setActiveSessionInfo, resetActiveSessionStore } from '../src/session-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuild-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 构造最小可测 dsh 会话（surface nodes 可读 + append 记录调用） */
function fakeSession(nodes: number[]) {
  const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
  return {
    surface: { nodes, replaceGeneration: 0 },
    append: (type: string, data: unknown, opts?: unknown) => {
      calls.push({ type, data, opts })
      return { type, data, opts }
    },
    _calls: calls,
  }
}

/** 写一个活动会话目录（约定回退可解析；v1.24.11 测试夹具） */
function mkActiveSession(desc: string, mtimeBump = false): string {
  const md = join(dir, 'AGENT_SESSIONS', `2026-08-28--S200--${desc}`, 'SESSION.md')
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, `# SESSION ${desc}`)
  if (mtimeBump) utimesSync(md, new Date(), new Date(Date.now() + 60_000))
  return md
}

/** 构造最小可测 agent（session + steer 记录调用） */
function fakeAgent(id: string, session: unknown) {
  const steers: unknown[] = []
  return {
    id,
    session,
    steer: (msg: unknown) => { steers.push(msg) },
    _steers: steers,
  }
}

describe('轨迹跟踪器 rebuild（v1.22.4 定稿：复用旧会话 + turn 结束清空；v1.22.5：自动继续 + 保留 first-anchor）', () => {
  it('stripAckSuffix：去掉 acknowledge 尾句（保留协议正文）', () => {
    const text = 'We anchor first, then act.\nPlease simply reply "acknowledge" — no action needed.'
    expect(stripAckSuffix(text)).toBe('We anchor first, then act.')
  })

  it('stripAckSuffix：无尾句 → 原样返回', () => {
    expect(stripAckSuffix('plain text')).toBe('plain text')
  })

  it('buildRebuildAnchor：Continue {SESSION name} + persistent trajectory path + first-anchor protocol body（ack 剥离）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    expect(a).toContain('[TRAJECTORY-REBUILD]')
    expect(a).toContain('Continue the work of S142')
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    expect(a).toContain('Persistent trajectory')
    // v1.24.11 规范行：SESSION.md path: 与 use 上下文同格式（恢复机制可解析，无需 [SESSION CONTEXT] 标记）
    expect(a).toContain('SESSION.md path: AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    // v1.22.5：保留 first-anchor 协议正文（ACC 身份/EAP/协作协议）
    expect(a).toContain('Abstract Cognitive Container')
    expect(a).toContain('Explicit Abstraction Principle')
    expect(a).toContain('We anchor first, then act')
    expect(a).toContain('Before we proceed')
    // 去掉 acknowledge 尾句（重建后不重走确认轮）
    expect(a).not.toContain('acknowledge')
    expect(a).not.toContain('no action needed')
  })

  it('buildRebuildAnchor：会话目录名含空格 → 完整目录名行 + 完整相对路径（S142 v1.23.4 定位回归）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsh-serenity-plugin 长期维护', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    // 完整目录名（含空格）明确写入锚点——重建后直接定位 SESSION
    expect(a).toContain('Serenity session: S142 (2026-08-24--S142--dsh-serenity-plugin 长期维护)')
    // 相对路径完整（不再截断在空格处）
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/SESSION.md')
  })

  it('无激活会话名 → 通用指令', () => {
    const a = buildRebuildAnchor(dir, '', join(dir, 'AGENT_SESSIONS', 'SESSION.md'))
    expect(a).toContain('Continue the current work')
    expect(a).not.toContain('Continue the work of S')
  })

  it('queueRebuild：排队不立即改 surface（pending 记录 + 返回锚点 + 规范路径；v1.24.11 约定回退解析）', async () => {
    const md = mkActiveSession('test')
    const session = fakeSession([10, 11, 12])
    const ctx = { sessions: { get: () => session } } as never
    const result = await queueRebuild(ctx, {
      root: dir,
      summary: '排队测试',
      agentCwd: dir,
      dshSessionId: 'session-x',
    })
    expect(result.queued).toBe(true)
    expect(result.anchor).toContain('Continue the work of S200')
    // 锚点含规范路径行（真实存在的会话目录，非虚假 AGENT_SESSIONS/SESSION.md）
    expect(result.anchor).toContain(`SESSION.md path: AGENT_SESSIONS/2026-08-28--S200--test/SESSION.md`)
    expect(result.sessionMdPath).toBe(md)
    // 排队不 append（surface 未动）
    expect(session._calls).toHaveLength(0)
    // pending 队列有记录
    const snap = pendingRebuildSnapshot()
    expect(snap.has('session-x')).toBe(true)
  })

  it('queueRebuild：无任何会话上下文 → 抛错引导 session use（v1.24.11 绝不写虚假路径）', async () => {
    const session = fakeSession([10])
    const ctx = { sessions: { get: () => session } } as never
    await expect(
      queueRebuild(ctx, { root: dir, summary: '无上下文', agentCwd: dir, dshSessionId: 'solo' }),
    ).rejects.toThrow(/session use/)
    expect(pendingRebuildSnapshot().has('solo')).toBe(false)
  })

  it('resolveSessionMdPath：① 内存活跃会话优先（存在校验通过）', () => {
    const memMd = mkActiveSession('mem')
    setActiveSessionInfo('s1', { sessionId: 'S200', dirName: '2026-08-28--S200--mem', mdPath: memMd })
    const session = fakeSession([])
    expect(resolveSessionMdPath(dir, 's1', session as never)).toBe(memMd)
  })

  it('resolveSessionMdPath：② 内存候选不存在（陈旧）→ 跳过 → ③ surface 锚点解析命中', () => {
    const anchorMd = mkActiveSession('anch')
    // 内存指向不存在路径（陈旧标记）
    setActiveSessionInfo('s2', {
      sessionId: 'S999',
      dirName: '2026-08-28--S999--gone',
      mdPath: join(dir, 'AGENT_SESSIONS', '2026-08-28--S999--gone', 'SESSION.md'),
    })
    // surface 首条 user 消息 = 重建锚点（含规范路径行）
    const anchorText = [
      '[TRAJECTORY-REBUILD] The conversation has been cleared and rebuilt.',
      'Continue the work of S200.',
      '- Persistent trajectory — SESSION.md path: AGENT_SESSIONS/2026-08-28--S200--anch/SESSION.md (the trajectory\'s persistent body)',
    ].join('\n')
    const session = fakeSession([7])
    const events: unknown[] = Array.from({ length: 7 }, () => undefined)
    events.push({
      type: 'user/message',
      seq: 7,
      data: { message: { role: 'user', content: [{ type: 'text', text: anchorText }] } },
    })
    ;(session as { events?: unknown[] }).events = events
    expect(resolveSessionMdPath(dir, 's2', session as never)).toBe(anchorMd)
  })

  it('resolveSessionMdPath：④ 全部候选缺失 → null（约定回退也无）', () => {
    const session = fakeSession([])
    expect(resolveSessionMdPath(dir, 'nobody', session as never)).toBeNull()
  })

  it('performRebuild：turn 结束时同一会话 surface replace 覆盖全部节点（含 source）', () => {
    const session = fakeSession([10, 11, 12, 13])
    const pending = { anchor: 'Continue the work of S142.', queuedAt: Date.now() }
    const done = performRebuild(session as never, pending)
    expect(done).toBe(true)
    expect(session._calls).toHaveLength(1)
    const call = session._calls[0]!
    expect(call.type).toBe('user/message')
    const data = call.data as { content: Array<{ text: string }>; source?: { kind: string } }
    expect(data.content[0]!.text).toContain('Continue the work of S142')
    expect(data.source).toEqual({ kind: 'user' }) // UserMessage 契约必填
    const op = (call.opts as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp
    expect(op.op).toBe('replace')
    expect(op.start).toBe(10)
    expect(op.end).toBe(13)
    const sourceEventSeqs = (call.opts as { sourceEventSeqs: number[] }).sourceEventSeqs
    expect(sourceEventSeqs).toEqual([10, 11, 12, 13])
  })

  it('performRebuild：带 meter → 先 append compaction/prune 定价（shadow-price 协议，v1.23.5）', () => {
    const session = fakeSession([10, 11])
    // events 提供被替换节点（deriveEventMessage 需要 data.message）
    ;(session as { events?: unknown[] }).events = [
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { type: 'user/message', seq: 10, data: { message: { role: 'user', content: [{ type: 'text', text: 'a' }] } } },
      { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } } },
    ]
    const meter = { estimateMessage: vi.fn((m: { role: string }) => (m.role === 'user' ? 3 : 7)) }
    const pending = { anchor: 'Continue the work of S142.', queuedAt: Date.now() }
    const done = performRebuild(session as never, pending, meter)
    expect(done).toBe(true)
    // 两次 append：compaction/prune + user/message
    expect(session._calls).toHaveLength(2)
    const prune = session._calls[0]!
    expect(prune.type).toBe('compaction/prune')
    const pd = prune.data as { shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; shadowedTokenCount: number }
    expect(pd.shadowedRange).toEqual({ start: 10, end: 11 })
    expect(pd.shadowedSeqs).toEqual([10, 11])
    expect(pd.shadowedTokenCount).toBe(10) // 3 (user) + 7 (assistant)
    // meter 对每个被替换节点定价
    expect(meter.estimateMessage).toHaveBeenCalledTimes(2)
    // 紧随其后的 replace（锚点消息）
    const replace = session._calls[1]!
    expect(replace.type).toBe('user/message')
    expect((replace.opts as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp).toEqual({ op: 'replace', start: 10, end: 11 })
  })

  it('performRebuild：surface 为空 → false（无历史可清）', () => {
    const session = fakeSession([])
    const done = performRebuild(session as never, { anchor: 'x', queuedAt: Date.now() })
    expect(done).toBe(false)
    expect(session._calls).toHaveLength(0)
  })

  it('registerRebuildTurnHook：有 pending → turn 结束时执行 replace + steer 自动继续并清队列', async () => {
    const session = fakeSession([10, 11])
    const agent = fakeAgent('s1', session)
    const listeners: Array<(p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void }; turn?: number }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void }; turn?: number }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    expect(listeners).toHaveLength(1)
    // 先排队（需可解析的会话上下文 → 约定回退）
    mkActiveSession('hook')
    const qctx = { sessions: { get: () => session } } as never
    await queueRebuild(qctx, { root: dir, summary: 'hook 重建', agentCwd: dir, dshSessionId: 's1' })
    // 触发 turn-stopping
    listeners[0]!({ agent, turn: 3 })
    expect(session._calls).toHaveLength(1)
    expect(pendingRebuildSnapshot().has('s1')).toBe(false)
    // v1.22.5：steer 自动继续（next-step 队列 → turn 不 break → 模型自动读 SESSION.md 继续）
    expect(agent._steers).toHaveLength(1)
    const steered = agent._steers[0] as { content?: Array<{ text?: string }>; source?: { kind?: string } }
    expect(steered.content?.[0]?.text).toContain('[TRAJECTORY-REBUILD]')
    expect(steered.content?.[0]?.text).toContain('cleared and rebuilt')
    expect(steered.source?.kind).toBe('plugin')
  })

  it('registerRebuildTurnHook：无 pending → 零开销', () => {
    const listeners: Array<(p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void } }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void } }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    const session = fakeSession([10])
    const agent = fakeAgent('nobody', session)
    listeners[0]!({ agent })
    expect(session._calls).toHaveLength(0)
    expect(agent._steers).toHaveLength(0)
  })
})

describe('F2: rebuildReminderText（轨迹跟踪器提示，v1.22.1 命名）', () => {
  it('含占用比例 + 持久轨迹/临时副本语义 + session_rebuild 引导（v1.23.0 英化）', () => {
    const t = rebuildReminderText(0.93)
    expect(t).toContain('[TRAJECTORY]')
    expect(t).toContain('93%')
    expect(t).toContain('persistent body')
    expect(t).toContain('rebuildable carrier')
    expect(t).toContain('session_rebuild')
    // v1.24.12 沉淀协议（S142 用户需求）：rebuild 前修订 skill / 新建 skill 写 SESSION 提案
    expect(t).toContain('revise the relevant existing skill')
    expect(t).toContain('SESSION.md')
  })
})

describe('F2: readContextPressure（投影读取）', () => {
  it('sessionProjections 未装配 → null', () => {
    const ctx = { get: () => undefined } as never
    expect(readContextPressure(ctx, { id: 's' })).toBeNull()
  })

  it('装配且有 contextPressure → 读取值', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900, contextWindow: 1000 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: 1000 })
  })

  it('无 contextWindow → 返回 { projectedTokens, contextWindow: undefined }（调用方判窗口）', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: undefined })
  })
})
