/**
 * session-bound.test.ts — SESSION 绑定持久化模块（serenity/bound 事件）
 *
 * v1.0（S142）：绑定 = dsh 会话日志中的持久化事件（append-only，latest-wins 权威）。
 * 覆盖：appendBound 写入 / readLastBound 读取 / hasAnyBound / 编码无关（dirName 锚，
 * sessionId 仅展示）/ 失败不阻断（无 append 的会话返回 false）。
 */
import { describe, it, expect } from 'vitest'
import { appendBound, readLastBound, hasAnyBound } from '../src/session-bound.js'

/** 构造最小可测 dsh 会话（append 记录 + snapshotEvents 可读） */
function makeSession(seed: unknown[] = []) {
  const events: unknown[] = [...seed]
  return {
    snapshotEvents: () => events,
    append: (type: string, data: unknown) => {
      const ev = { type, seq: events.length, time: Date.now(), data }
      events.push(ev)
      return ev
    },
    _events: events,
  }
}

describe('session-bound: appendBound', () => {
  it('写入一条 serenity/bound 事件（含 dirName/mdPath/sessionId/action/at）', () => {
    const s = makeSession()
    const ok = appendBound(s as never, 'activate', {
      dirName: '2026-09-05--S142--dsp 维护',
      mdPath: '/root/AGENT_SESSIONS/2026-09-05--S142--dsp 维护/SESSION.md',
      sessionId: 'S142',
    })
    expect(ok).toBe(true)
    const last = s._events[s._events.length - 1] as { type: string; data: Record<string, unknown> }
    expect(last.type).toBe('serenity/bound')
    expect(last.data.dirName).toBe('2026-09-05--S142--dsp 维护')
    expect(last.data.mdPath).toContain('SESSION.md')
    expect(last.data.sessionId).toBe('S142')
    expect(last.data.action).toBe('activate')
    expect(typeof last.data.at).toBe('number')
    // log-only：append 无 surfaceOp（无第三参 opts）
  })

  it('无 append 方法的会话 → 返回 false 不抛错（绑定失败不阻断主流程）', () => {
    const ok = appendBound(null as never, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })
    expect(ok).toBe(false)
    const ok2 = appendBound({} as never, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })
    expect(ok2).toBe(false)
  })
})

describe('session-bound: readLastBound / hasAnyBound', () => {
  it('readLastBound：多条 bound → 最后一条胜出（append-only latest-wins）', () => {
    const s = makeSession()
    appendBound(s as never, 'activate', { dirName: '2026-08-01--S100--a', mdPath: '/r/A/SESSION.md', sessionId: 'S100' })
    appendBound(s as never, 'switch', { dirName: '2026-08-24--S142--b', mdPath: '/r/B/SESSION.md', sessionId: 'S142' })
    const last = readLastBound(s as never)
    expect(last?.dirName).toBe('2026-08-24--S142--b')
    expect(last?.sessionId).toBe('S142')
    expect(last?.action).toBe('switch')
  })

  it('readLastBound：无 bound 事件 → null（跳过非 bound 事件）', () => {
    const s = makeSession([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'session/title', data: { title: 'S142-2026-08-24' } },
    ])
    expect(readLastBound(s as never)).toBeNull()
  })

  it('readLastBound：snapshotEvents 缺失但有 events 兜底（旧形态）', () => {
    const events = [
      { type: 'serenity/bound', data: { dirName: '2026-09-01--S151--auto--auto', mdPath: '/r/C/SESSION.md', action: 'activate', at: 1 } },
    ]
    const legacy = { events } // 无 snapshotEvents → 走 .events 兜底
    const b = readLastBound(legacy)
    expect(b?.dirName).toBe('2026-09-01--S151--auto--auto')
  })

  it('readLastBound：事件 data 非对象/缺字段 → 跳过（宽容）', () => {
    const s = makeSession([
      { type: 'serenity/bound', data: 'garbage' },
      { type: 'serenity/bound', data: { dirName: '2026-09-05--apaas-26116', mdPath: '/r/D/SESSION.md', action: 'activate', at: 2 } },
    ])
    const b = readLastBound(s as never)
    expect(b?.dirName).toBe('2026-09-05--apaas-26116') // 坏数据跳过，好的胜出
  })

  it('hasAnyBound：有 bound → true；无 → false', () => {
    const s = makeSession()
    expect(hasAnyBound(s as never)).toBe(false)
    appendBound(s as never, 'reconcile', { dirName: 'd', mdPath: '/r/SESSION.md', note: 'auto from title' })
    expect(hasAnyBound(s as never)).toBe(true)
  })
})

describe('session-bound: 编码无关（U4）', () => {
  it('issue 会话（无 S 前缀）同样可绑定——dirName 是唯一硬锚', () => {
    const s = makeSession()
    const ok = appendBound(s as never, 'activate', {
      dirName: '2026-09-04--apaas-26116',
      mdPath: '/root/AGENT_SESSIONS/2026-09-04--apaas-26116/SESSION.md',
      // sessionId 缺省——编码未知时不依赖
    })
    expect(ok).toBe(true)
    const b = readLastBound(s as never)
    expect(b?.dirName).toBe('2026-09-04--apaas-26116')
    expect(b?.sessionId).toBeUndefined()
  })

  it('autopilot 变体（--auto 尾缀）目录同样可绑定', () => {
    const s = makeSession()
    appendBound(s as never, 'activate', {
      dirName: '2026-09-01--S151--autopilot-daily-housekeeping--auto',
      mdPath: '/root/AGENT_SESSIONS/2026-09-01--S151--autopilot-daily-housekeeping--auto/SESSION.md',
      sessionId: 'S151',
    })
    const b = readLastBound(s as never)
    expect(b?.dirName).toBe('2026-09-01--S151--autopilot-daily-housekeeping--auto')
  })
})
