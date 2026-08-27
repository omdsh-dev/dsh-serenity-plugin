import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

import {
  buildRebuildAnchor,
  queueRebuild,
  performRebuild,
  registerRebuildTurnHook,
  pendingRebuildSnapshot,
} from '../src/rebuild.js'
import { rebuildReminderText, readContextPressure } from '../src/seams/keeper.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuild-'))
  writeFileSync(join(dir, '.serenity'), 'test')
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

describe('轨迹跟踪器 rebuild（v1.22.4 定稿：复用旧会话 + turn 结束清空，用户拍板）', () => {
  it('buildRebuildAnchor：继续 {SESSION 名} + 持久轨迹路径', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    expect(a).toContain('继续 S142 的工作')
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    expect(a).toContain('读取该 SESSION.md')
  })

  it('无激活会话名 → 通用指令', () => {
    const a = buildRebuildAnchor(dir, '', join(dir, 'AGENT_SESSIONS', 'SESSION.md'))
    expect(a).toContain('继续当前工作')
    expect(a).not.toContain('继续 S')
  })

  it('queueRebuild：排队不立即改 surface（pending 记录 + 返回锚点）', async () => {
    const session = fakeSession([10, 11, 12])
    const ctx = { sessions: { get: () => session } } as never
    const result = await queueRebuild(ctx, {
      root: dir,
      agentCwd: dir,
      dshSessionId: 'session-x',
    })
    expect(result.queued).toBe(true)
    expect(result.anchor).toContain('继续')
    // 排队不 append（surface 未动）
    expect(session._calls).toHaveLength(0)
    // pending 队列有记录
    const snap = pendingRebuildSnapshot()
    expect(snap.has('session-x')).toBe(true)
  })

  it('performRebuild：turn 结束时同一会话 surface replace 覆盖全部节点（含 source）', () => {
    const session = fakeSession([10, 11, 12, 13])
    const pending = { anchor: '继续 S142 的工作。', queuedAt: Date.now() }
    const done = performRebuild(session as never, pending)
    expect(done).toBe(true)
    expect(session._calls).toHaveLength(1)
    const call = session._calls[0]!
    expect(call.type).toBe('user/message')
    const data = call.data as { content: Array<{ text: string }>; source?: { kind: string } }
    expect(data.content[0]!.text).toContain('继续 S142 的工作')
    expect(data.source).toEqual({ kind: 'user' }) // UserMessage 契约必填
    const op = (call.opts as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp
    expect(op.op).toBe('replace')
    expect(op.start).toBe(10)
    expect(op.end).toBe(13)
    const sourceEventSeqs = (call.opts as { sourceEventSeqs: number[] }).sourceEventSeqs
    expect(sourceEventSeqs).toEqual([10, 11, 12, 13])
  })

  it('performRebuild：surface 为空 → false（无历史可清）', () => {
    const session = fakeSession([])
    const done = performRebuild(session as never, { anchor: 'x', queuedAt: Date.now() })
    expect(done).toBe(false)
    expect(session._calls).toHaveLength(0)
  })

  it('registerRebuildTurnHook：有 pending → turn 结束时执行 replace 并清队列', async () => {
    const session = fakeSession([10, 11])
    const listeners: Array<(p: { agent?: { id: string; session: unknown } }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown } }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    expect(listeners).toHaveLength(1)
    // 先排队
    const qctx = { sessions: { get: () => session } } as never
    await queueRebuild(qctx, { root: dir, agentCwd: dir, dshSessionId: 's1' })
    // 触发 turn-stopping
    listeners[0]!({ agent: { id: 's1', session } })
    expect(session._calls).toHaveLength(1)
    expect(pendingRebuildSnapshot().has('s1')).toBe(false)
  })

  it('registerRebuildTurnHook：无 pending → 零开销', () => {
    const listeners: Array<(p: { agent?: { id: string; session: unknown } }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown } }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    const session = fakeSession([10])
    listeners[0]!({ agent: { id: 'nobody', session } })
    expect(session._calls).toHaveLength(0)
  })
})

describe('F2: rebuildReminderText（轨迹跟踪器提示，v1.22.1 命名）', () => {
  it('含占用比例 + 持久轨迹/临时副本语义 + session_rebuild 引导', () => {
    const t = rebuildReminderText(0.93)
    expect(t).toContain('[TRAJECTORY]')
    expect(t).toContain('93%')
    expect(t).toContain('SESSION.md 是持久轨迹')
    expect(t).toContain('临时可重建')
    expect(t).toContain('session_rebuild')
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
