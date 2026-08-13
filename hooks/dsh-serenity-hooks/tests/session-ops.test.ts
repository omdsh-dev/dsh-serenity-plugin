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
  ACTIVE_SESSION_MARKER,
} from '../src/session-ops.js'
import { resolveActiveSession } from '../src/seams/loop.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-sess-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
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

  it('use 写活动会话标记 → resolveActiveSession 可读（Session 块生效）', () => {
    const r = createSession(dir, 'active-use', 'active-use')
    const used = useSession(dir, 'S001')
    expect(used.dir).toContain('S001')
    const marker = join(dir, ACTIVE_SESSION_MARKER)
    expect(existsSync(marker)).toBe(true)
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
  })

  it('use 未找到会话抛错', () => {
    expect(() => useSession(dir, 'nope')).toThrow(/未找到会话/)
  })

  it('close 删除活动会话标记', () => {
    createSession(dir, 'c', 'c')
    useSession(dir, 'S001')
    expect(resolveActiveSession(dir)).not.toBeNull()
    closeSession(dir)
    expect(resolveActiveSession(dir)).toBeNull()
  })
})

describe('loop: 活动会话心跳', () => {
  it('无标记返回 null；有标记追加心跳', () => {
    expect(resolveActiveSession(dir)).toBeNull()
    const r = createSession(dir, 'active', 'active')
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-session'), r.sessionMd.replace(dir + '/', ''))
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
    expect(appendHeartbeat(r.sessionMd)).toBe(true)
    const content = readFileSync(r.sessionMd, 'utf-8')
    expect(content).toContain('heartbeat')
  })

  it('标记越界返回 null', () => {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-session'), '../escape.md')
    expect(resolveActiveSession(dir)).toBeNull()
  })
})
