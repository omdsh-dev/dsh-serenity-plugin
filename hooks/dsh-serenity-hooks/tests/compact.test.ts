import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { registerCompactRetention } from '../src/seams/compact.js'
import { ACC_VERSION } from '../src/constants.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-compact-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 捕获注册的 session/event 监听器 + fake agents 注册表 */
function captureListener(): {
  emit: (session: { id: string }, event: { type: string; data?: unknown }) => void
  injected: Array<Record<string, unknown>>
} {
  let handler: ((session: { id: string }, event: { type: string; data?: unknown }) => void) | null = null
  const injected: Array<Record<string, unknown>> = []
  const agents = new Map<string, unknown>()

  const fakeCtx = {
    on: (name: string, fn: unknown) => {
      if (name === 'session/event') handler = fn as typeof handler
    },
    agents: {
      get: (id: string) => agents.get(id),
    },
  }

  registerCompactRetention(fakeCtx as never)

  return {
    emit: (session, event) => {
      // 注册一个 agent（cwd 在 CCC 内）供 agents.get 解析
      const agent = {
        session: { header: { cwd: dir } },
        inject: vi.fn((msg: Record<string, unknown>) => injected.push(msg)),
      }
      agents.set(session.id, agent)
      handler?.(session, event)
    },
    injected,
  }
}

describe('compact: 压缩保留（P2）', () => {
  it('compaction/end 成功 → 重注入 ACC 身份（含 CCC 根与版本）', () => {
    const { emit, injected } = captureListener()
    emit({ id: 'sess-1' }, { type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } })
    expect(injected.length).toBe(1)
    const content = injected[0] as { content: Array<{ text: string }> }
    expect(content.content[0].text).toContain(dir)
    expect(content.content[0].text).toContain(ACC_VERSION)
  })

  it('compaction/end 带 error → 不重注入', () => {
    const { emit, injected } = captureListener()
    emit({ id: 'sess-1' }, { type: 'compaction/end', data: { compactionId: 'c2', turn: 3, error: 'summarization failed' } })
    expect(injected.length).toBe(0)
  })

  it('非 compaction/end 事件 → 不重注入', () => {
    const { emit, injected } = captureListener()
    emit({ id: 'sess-1' }, { type: 'compaction/start', data: { compactionId: 'c3', turn: 3 } })
    emit({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'done' } } })
    expect(injected.length).toBe(0)
  })

  it('重复压缩 → 每次都重注入（恢复性注入，不依赖计数）', () => {
    const { emit, injected } = captureListener()
    emit({ id: 'sess-1' }, { type: 'compaction/end', data: { compactionId: 'c4', turn: 1 } })
    emit({ id: 'sess-1' }, { type: 'compaction/end', data: { compactionId: 'c5', turn: 2 } })
    expect(injected.length).toBe(2)
  })

  it('Skiff 会话（id `skiff-` 前缀）→ 不重注入 ACC 身份（F4b 旁路：角色 CCC 提示词全替换）', () => {
    const { emit, injected } = captureListener()
    emit({ id: 'skiff-qa-readonly-uuid' }, { type: 'compaction/end', data: { compactionId: 'c6', turn: 1 } })
    expect(injected.length).toBe(0)
  })
})
