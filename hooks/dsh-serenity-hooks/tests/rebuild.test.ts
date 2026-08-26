import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

import { buildRebuildAnchor, executeRebuild } from '../src/rebuild.js'
import { rebuildReminderText, readContextPressure } from '../src/seams/keeper.js'
import { defaultSimpleSettings } from '../src/settings-section.js'

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

describe('轨迹跟踪器 rebuild（v1.22.1 原地重建语义，用户拍板）', () => {
  it('buildRebuildAnchor：SESSION.md 持久轨迹原位 + 重建指令（不归档）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const anchor = buildRebuildAnchor(dir, mdPath, '继续 x 任务')
    expect(anchor).toContain('[TRAJECTORY-REBUILD]')
    expect(anchor).toContain('持久轨迹（SESSION.md，未移动）')
    expect(anchor).toContain('AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    expect(anchor).toContain('继续 x 任务')
    expect(anchor).toContain('读取该 SESSION.md')
    // 不包含"归档/移动"语义
    expect(anchor).not.toContain('_archived')
  })

  it('无 note 时不含背景行', () => {
    const anchor = buildRebuildAnchor(dir, join(dir, 'AGENT_SESSIONS', 'a', 'SESSION.md'), undefined)
    expect(anchor).not.toContain('重建背景')
  })

  it('executeRebuild：同一会话 surface replace 覆盖全部节点（不建新会话/不归档 SESSION）', async () => {
    const session = fakeSession([10, 11, 12, 13])
    const ctx = { sessions: { get: () => session } } as never
    const result = await executeRebuild(ctx, {
      root: dir,
      note: '上下文超限',
      agentCwd: dir,
      dshSessionId: 'session-x',
    })
    expect(result.rebuilt).toBe(true)
    expect(result.replacedNodes).toBe(4)
    expect(session._calls).toHaveLength(1)
    const call = session._calls[0]!
    expect(call.type).toBe('user/message')
    // surfaceOp replace：start=首个节点 end=末节点
    const op = (call.opts as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp
    expect(op.op).toBe('replace')
    expect(op.start).toBe(10)
    expect(op.end).toBe(13)
    // sourceEventSeqs 覆盖全部被 shadow 节点（surface 硬校验）
    const sourceEventSeqs = (call.opts as { sourceEventSeqs: number[] }).sourceEventSeqs
    expect(sourceEventSeqs).toEqual([10, 11, 12, 13])
    // 锚点含 SESSION.md 路径
    const text = (call.data as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('[TRAJECTORY-REBUILD]')
    expect(result.anchor).toBe(text)
  })

  it('executeRebuild：会话不存在 → 抛错', async () => {
    const ctx = { sessions: { get: () => undefined } } as never
    await expect(executeRebuild(ctx, {
      root: dir,
      agentCwd: dir,
      dshSessionId: 'session-gone',
    })).rejects.toThrow(/无法定位 dsh 会话/)
  })

  it('executeRebuild：surface 为空 → 抛错', async () => {
    const session = fakeSession([])
    const ctx = { sessions: { get: () => session } } as never
    await expect(executeRebuild(ctx, {
      root: dir,
      agentCwd: dir,
      dshSessionId: 'session-x',
    })).rejects.toThrow(/surface 为空/)
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
