/**
 * session-bound.test.ts — SESSION 绑定持久化模块
 *
 * v1.30.6（S142 review F-01）：绑定从「dsh 会话日志事件」迁移为「CCC 内
 * `AGENT_SESSIONS/.bindings.json` 文件」——宿主读路径拒绝未知且非 ignorable 的
 * 会话事件（`Session.append` 无法写 `ignorable`），故不再向会话日志写自定义事件。
 * 覆盖：文件写入/读取（latest-wins）/ 编码无关（dirName 锚）/ 旧事件形态回落 /
 * 无 header 不阻断 / 损坏文件容忍 / 无临时文件残留。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendBound, readLastBound, hasAnyBound, bindingsPathFor, BINDINGS_REL_PATH } from '../src/session-bound.js'

let ccc: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'bound-'))
  writeFileSync(join(ccc, '.serenity'), '')
  mkdirSync(join(ccc, 'AGENT_SESSIONS'), { recursive: true })
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
})

/** 最小可测 dsh 会话：header（id + cwd 定位 CCC）+ snapshotEvents（旧事件回落用） */
function makeSession(id = 'sess-1', events: unknown[] = [], cwd = ccc) {
  return { header: { id, cwd }, snapshotEvents: () => events }
}

describe('session-bound: appendBound（文件持久化）', () => {
  it('写入 AGENT_SESSIONS/.bindings.json（含 dirName/mdPath/sessionId/action/at）', () => {
    const s = makeSession()
    const ok = appendBound(s, 'activate', {
      dirName: '2026-09-05--S142--dsp 维护',
      mdPath: '/root/AGENT_SESSIONS/2026-09-05--S142--dsp 维护/SESSION.md',
      sessionId: 'S142',
    })
    expect(ok).toBe(true)
    const file = JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      version: number; sessions: Record<string, { dirName: string; action: string; at: number }>
    }
    expect(file.version).toBe(1)
    const rec = file.sessions['sess-1']
    expect(rec?.dirName).toBe('2026-09-05--S142--dsp 维护')
    expect(rec?.action).toBe('activate')
    expect(typeof rec?.at).toBe('number')
    // 原子写：无 .tmp 残留
    expect(existsSync(`${join(ccc, BINDINGS_REL_PATH)}.tmp`)).toBe(false)
  })

  it('无 header / 无法定位 CCC 根 → false 不抛错（绑定失败不阻断主流程）', () => {
    expect(appendBound(null, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
    expect(appendBound({}, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
    const outside = { header: { id: 's', cwd: tmpdir() } } // 无 .serenity
    expect(appendBound(outside, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
  })

  it('同一会话多次写入 → latest-wins 覆盖（不追加）', () => {
    const s = makeSession()
    appendBound(s, 'activate', { dirName: '2026-08-01--S100--a', mdPath: '/r/A/SESSION.md', sessionId: 'S100' })
    appendBound(s, 'switch', { dirName: '2026-08-24--S142--b', mdPath: '/r/B/SESSION.md', sessionId: 'S142' })
    const file = JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      sessions: Record<string, unknown>
    }
    expect(Object.keys(file.sessions)).toEqual(['sess-1']) // 单条记录
    expect(readLastBound(s)?.dirName).toBe('2026-08-24--S142--b')
  })

  it('不同会话各自独立记录（scope 隔离）', () => {
    const a = makeSession('sess-a')
    const b = makeSession('sess-b')
    appendBound(a, 'activate', { dirName: '2026-09-07--S160--zhaocai skiff', mdPath: '/r/A/SESSION.md' })
    appendBound(b, 'activate', { dirName: '2026-09-05--S142--dsp', mdPath: '/r/B/SESSION.md' })
    expect(readLastBound(a)?.dirName).toBe('2026-09-07--S160--zhaocai skiff')
    expect(readLastBound(b)?.dirName).toBe('2026-09-05--S142--dsp')
  })
})

describe('session-bound: readLastBound / hasAnyBound', () => {
  it('无记录 → null', () => {
    expect(readLastBound(makeSession())).toBeNull()
    expect(hasAnyBound(makeSession())).toBe(false)
  })

  it('写入后 hasAnyBound → true', () => {
    const s = makeSession()
    appendBound(s, 'reconcile', { dirName: 'd', mdPath: '/r/SESSION.md', note: 'auto from title' })
    expect(hasAnyBound(s)).toBe(true)
  })

  it('文件损坏 → 视为空，不抛错（下次写入重建）', () => {
    const s = makeSession()
    writeFileSync(join(ccc, BINDINGS_REL_PATH), '{ not json')
    expect(readLastBound(s)).toBeNull()
    expect(appendBound(s, 'activate', { dirName: 'd', mdPath: '/r/SESSION.md' })).toBe(true)
    expect(readLastBound(s)?.dirName).toBe('d')
  })

  it('记录缺 dirName/mdPath → 跳过（宽容），回落旧事件形态', () => {
    const s = makeSession('sess-1', [
      { type: 'serenity/bound', data: { dirName: '2026-09-05--apaas-26116', mdPath: '/r/D/SESSION.md', action: 'activate', at: 2 } },
    ])
    writeFileSync(join(ccc, BINDINGS_REL_PATH), JSON.stringify({ version: 1, sessions: { 'sess-1': { action: 'activate' } } }))
    expect(readLastBound(s)?.dirName).toBe('2026-09-05--apaas-26116')
  })
})

describe('session-bound: 旧事件形态回落（v1.29.1~v1.30.5 存量绑定）', () => {
  it('文件中无记录 → 回落扫描会话日志中的 serenity/bound（最后一条胜出）', () => {
    const events = [
      { type: 'user/message', data: { content: [] } },
      { type: 'serenity/bound', data: { dirName: '2026-09-01--S151--auto--auto', mdPath: '/r/C/SESSION.md', action: 'activate', at: 1 } },
      { type: 'serenity/bound', data: { dirName: '2026-09-05--S142--dsp', mdPath: '/r/E/SESSION.md', action: 'reconcile', at: 2 } },
    ]
    expect(readLastBound(makeSession('sess-1', events))?.dirName).toBe('2026-09-05--S142--dsp')
  })

  it('旧形态坏数据跳过；文件记录优先于事件', () => {
    const events = [
      { type: 'serenity/bound', data: 'garbage' },
      { type: 'serenity/bound', data: { dirName: 'legacy', mdPath: '/r/L/SESSION.md', action: 'activate', at: 3 } },
    ]
    const s = makeSession('sess-1', events)
    expect(readLastBound(s)?.dirName).toBe('legacy')
    appendBound(s, 'activate', { dirName: 'file-wins', mdPath: '/r/F/SESSION.md' })
    expect(readLastBound(s)?.dirName).toBe('file-wins')
  })
})

describe('session-bound: 编码无关（U4）', () => {
  it('issue 会话（无 S 前缀）同样可绑定——dirName 是唯一硬锚', () => {
    const s = makeSession()
    const ok = appendBound(s, 'activate', {
      dirName: '2026-09-04--apaas-26116',
      mdPath: '/root/AGENT_SESSIONS/2026-09-04--apaas-26116/SESSION.md',
    })
    expect(ok).toBe(true)
    const b = readLastBound(s)
    expect(b?.dirName).toBe('2026-09-04--apaas-26116')
    expect(b?.sessionId).toBeUndefined()
  })

  it('autopilot 变体（--auto 尾缀）目录同样可绑定', () => {
    const s = makeSession()
    appendBound(s, 'activate', {
      dirName: '2026-09-01--S151--autopilot-daily-housekeeping--auto',
      mdPath: '/root/AGENT_SESSIONS/2026-09-01--S151--autopilot-daily-housekeeping--auto/SESSION.md',
      sessionId: 'S151',
    })
    expect(readLastBound(s)?.dirName).toBe('2026-09-01--S151--autopilot-daily-housekeeping--auto')
  })

  it('bindingsPathFor：由 cwd 上溯 .serenity 定位（子目录 cwd 同样正确）', () => {
    const sub = join(ccc, 'AI_LAB', 'dsh-serenity-plugin')
    mkdirSync(sub, { recursive: true })
    expect(bindingsPathFor({ header: { id: 's', cwd: sub } })).toBe(join(ccc, BINDINGS_REL_PATH))
  })
})
