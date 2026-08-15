import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listSessions,
  nextSessionId,
  createSession,
  showSession,
  useSession,
  closeSession,
  archiveSession,
  healthCheck,
  summarize,
  qaCheck,
  appendHeartbeat,
  readActiveSessionMd,
  getActiveSessionInfo,
  resetActiveSessionStore,
  parseSessionContextFromEvents,
  SESSION_CONTEXT_MARKER,
  DEFAULT_SESSION_SCOPE,
} from '../src/session-ops.js'
import { resolveActiveSession } from '../src/seams/loop.js'

/**
 * session-ops 单元测试（S134 v1.16.14 内存化）：活跃会话跟踪**不落盘**——
 * 内存 Map（scope = dsh 会话 id）+ use 时注入 [SESSION CONTEXT] 标记（events 恢复源）。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-sess-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('session-ops: 生命周期', () => {
  it('create 自动分配 S001 + 递增', () => {
    expect(listSessions(dir)).toHaveLength(0)
    const a = createSession(dir, 'first', '第一个')
    expect(a.id).toBe('S001')
    expect(existsSync(a.sessionMd)).toBe(true)
    expect(nextSessionId(listSessions(dir))).toBe('S002')
  })

  it('show 按 id / 关键词', () => {
    createSession(dir, 'alpha', '阿尔法')
    expect(showSession(dir, 'S001').content).toContain('阿尔法')
    expect(showSession(dir, '阿尔法').dir).toContain('S001')
  })

  it('archive 标记完成', () => {
    createSession(dir, 'x', 'x')
    expect(listSessions(dir)[0]!.status).toBe('open')
    archiveSession(dir, 'S001')
    expect(listSessions(dir)[0]!.status).toBe('done')
  })

  it('health 报告 stale', () => {
    expect(healthCheck(dir)).toHaveLength(0)
    createSession(dir, 'old', 'old')
    const d = join(dir, 'AGENT_SESSIONS', listSessions(dir)[0]!.dir)
    const past = new Date(Date.now() - 20 * 86400000)
    utimesSync(d, past, past)
    utimesSync(join(d, 'SESSION.md'), past, past)
    expect(healthCheck(dir)).toHaveLength(1)
    expect(healthCheck(dir)[0]!.kind).toBe('stale')
  })

  it('summary 计数', () => {
    createSession(dir, 'a', 'a')
    const s = summarize(dir)
    expect(s.total).toBe(1)
    expect(s.open).toBe(1)
    expect(s.done).toBe(0)
  })

  it('qa 核对产出物', () => {
    const r = createSession(dir, 'w', 'w')
    writeFileSync(r.sessionMd.replace('SESSION.md', 'notes.md'), '')
    const qa = qaCheck(dir, 'S001')
    expect(qa.issues.length).toBeGreaterThan(0)
  })
})

describe('session-ops: 活跃会话（内存化，S134 v1.16.14）', () => {
  it('use 写内存 Map（不落盘）：getActiveSessionInfo + readActiveSessionMd + resolveActiveSession 可读', () => {
    const r = createSession(dir, 'active-use', 'active-use')
    const used = useSession(dir, 'S001')
    expect(used.dir).toContain('S001')
    // 不产生任何 .dsh 文件
    expect(existsSync(join(dir, '.dsh'))).toBe(false)
    expect(getActiveSessionInfo(DEFAULT_SESSION_SCOPE)).toEqual({
      sessionId: 'S001', dirName: used.dir, mdPath: r.sessionMd,
    })
    expect(readActiveSessionMd(dir)).toBe(r.sessionMd)
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
  })

  it('use 返回 context 含 [SESSION CONTEXT] 标记（events 恢复源）', () => {
    const r = createSession(dir, 'ctx-marker', 'ctx-marker')
    const used = useSession(dir, 'S001')
    expect(used.context).toContain(`${SESSION_CONTEXT_MARKER} ${used.dir}`)
    expect(used.context).toContain(`SESSION.md path: ${r.sessionMd}`)
  })

  it('use 按 scope 隔离：并行多会话各自活跃，互不覆盖', () => {
    const a = createSession(dir, 'scope-a', 'scope-a')
    const b = createSession(dir, 'scope-b', 'scope-b')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    expect(resolveActiveSession(dir, 'agent-A')).toBe(a.sessionMd)
    expect(resolveActiveSession(dir, 'agent-B')).toBe(b.sessionMd)
    expect(resolveActiveSession(dir)).toBeNull() // 默认 scope 未 use
  })

  it('use 未找到会话抛错', () => {
    expect(() => useSession(dir, 'nope')).toThrow(/未找到会话/)
  })

  it('close 清指定 scope 的内存条目（不影响其他 scope；不落盘无文件残留）', () => {
    createSession(dir, 'c', 'c')
    createSession(dir, 'd', 'd')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    expect(resolveActiveSession(dir, 'agent-A')).not.toBeNull()
    closeSession(dir, 'agent-A')
    expect(resolveActiveSession(dir, 'agent-A')).toBeNull()
    expect(resolveActiveSession(dir, 'agent-B')).not.toBeNull()
    expect(existsSync(join(dir, '.dsh'))).toBe(false)
  })
})

describe('session-ops: 进程重启恢复（parseSessionContextFromEvents，只扫自己会话）', () => {
  it('events 含 [SESSION CONTEXT] 标记 → 解析出活跃会话', () => {
    const r = createSession(dir, 'recover-me', 'recover-me')
    const marker = `${SESSION_CONTEXT_MARKER} ${r.dir}\nSESSION.md path: ${r.sessionMd}`
    const events = [{ type: 'tool/call' }, { type: 'tool/result', data: { output: marker } }]
    const info = parseSessionContextFromEvents(events)
    expect(info).toEqual({ sessionId: 'S001', dirName: r.dir, mdPath: r.sessionMd })
  })

  it('取最后一条标记（最新优先）', () => {
    const a = createSession(dir, 'first', 'first')
    const b = createSession(dir, 'second', 'second')
    const m1 = `${SESSION_CONTEXT_MARKER} ${a.dir}\nSESSION.md path: ${a.sessionMd}`
    const m2 = `${SESSION_CONTEXT_MARKER} ${b.dir}\nSESSION.md path: ${b.sessionMd}`
    expect(parseSessionContextFromEvents([{ data: { text: m1 } }, { data: { text: m2 } }])!.dirName).toContain('S002')
  })

  it('无标记 / 空 events → null（全新会话不恢复）', () => {
    expect(parseSessionContextFromEvents([])).toBeNull()
    expect(parseSessionContextFromEvents([{ type: 'user/message', data: { text: 'hello' } }])).toBeNull()
  })

  it('标记格式非法（目录名不符合 YYYY-MM-DD-- 前缀）→ 跳过', () => {
    const events = [{ data: { text: `${SESSION_CONTEXT_MARKER} not-a-session\nSESSION.md path: /tmp/x.md` } }]
    expect(parseSessionContextFromEvents(events)).toBeNull()
  })
})

describe('loop: 活动会话心跳（内存读）', () => {
  it('无激活返回 null；use 后追加心跳（默认 scope）', () => {
    expect(resolveActiveSession(dir)).toBeNull()
    const r = createSession(dir, 'active', 'active')
    useSession(dir, 'S001')
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
    expect(appendHeartbeat(r.sessionMd)).toBe(true)
    expect(readFileSync(r.sessionMd, 'utf-8')).toContain('heartbeat')
  })

  it('按 scope 隔离心跳：只写当前 dsh 会话的活跃会话', () => {
    const a = createSession(dir, 'h-a', 'h-a')
    const b = createSession(dir, 'h-b', 'h-b')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    expect(resolveActiveSession(dir, 'agent-A')).toBe(a.sessionMd)
    expect(resolveActiveSession(dir, 'agent-B')).toBe(b.sessionMd)
    expect(appendHeartbeat(resolveActiveSession(dir, 'agent-A')!)).toBe(true)
    expect(readFileSync(a.sessionMd, 'utf-8')).toContain('heartbeat')
    expect(readFileSync(b.sessionMd, 'utf-8')).not.toContain('heartbeat')
  })
})
