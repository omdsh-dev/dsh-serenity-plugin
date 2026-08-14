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
  ACTIVE_SESSIONS_DIR,
  LEGACY_ACTIVE_SESSION_MARKER,
  activeSessionMarker,
  readActiveSessionMd,
  listActiveMarkers,
  restoreActiveSession,
  DEFAULT_SESSION_SCOPE,
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

  it('use 写活动会话标记（默认 scope）→ resolveActiveSession 可读（Session 块生效）', () => {
    const r = createSession(dir, 'active-use', 'active-use')
    const used = useSession(dir, 'S001')
    expect(used.dir).toContain('S001')
    const marker = activeSessionMarker(dir, DEFAULT_SESSION_SCOPE)
    expect(existsSync(marker)).toBe(true)
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
    expect(readActiveSessionMd(dir)).toBe(r.sessionMd)
  })

  it('use 按 scope 隔离：不同 dsh 会话各自活跃，互不覆盖', () => {
    const a = createSession(dir, 'scope-a', 'scope-a')
    const b = createSession(dir, 'scope-b', 'scope-b')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    // 各自 scope 读到各自的活跃会话
    expect(resolveActiveSession(dir, 'agent-A')).toBe(a.sessionMd)
    expect(resolveActiveSession(dir, 'agent-B')).toBe(b.sessionMd)
    // 无 scope 回退默认 → null（未在默认 scope use）
    expect(resolveActiveSession(dir)).toBeNull()
  })

  it('use 清理旧全局标记（迁移）：legacy active-session 被删除', () => {
    const r = createSession(dir, 'migrate', 'migrate')
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, LEGACY_ACTIVE_SESSION_MARKER), r.sessionMd.replace(dir + '/', ''))
    useSession(dir, 'S001', 'agent-X')
    expect(existsSync(join(dir, LEGACY_ACTIVE_SESSION_MARKER))).toBe(false)
  })

  it('use 未找到会话抛错', () => {
    expect(() => useSession(dir, 'nope')).toThrow(/未找到会话/)
  })

  it('close 删除指定 scope 的活动会话标记（不影响其他 scope）', () => {
    createSession(dir, 'c', 'c')
    createSession(dir, 'd', 'd')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    expect(resolveActiveSession(dir, 'agent-A')).not.toBeNull()
    closeSession(dir, 'agent-A')
    expect(resolveActiveSession(dir, 'agent-A')).toBeNull()
    // 其他 scope 不受影响
    expect(resolveActiveSession(dir, 'agent-B')).not.toBeNull()
  })

  it('close 清理旧全局标记', () => {
    createSession(dir, 'c', 'c')
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, LEGACY_ACTIVE_SESSION_MARKER), 'AGENT_SESSIONS/x/SESSION.md')
    closeSession(dir)
    expect(existsSync(join(dir, LEGACY_ACTIVE_SESSION_MARKER))).toBe(false)
  })

  it('ACTIVE_SESSIONS_DIR 为 .dsh/active-sessions；scope 文件名安全清洗', () => {
    expect(ACTIVE_SESSIONS_DIR).toBe(join('.dsh', 'active-sessions'))
    expect(activeSessionMarker(dir, 'cm-abc/../../x')).toBe(join(dir, '.dsh', 'active-sessions', 'cm-abc_______x'))
    expect(activeSessionMarker(dir, '')).toBe(join(dir, '.dsh', 'active-sessions', DEFAULT_SESSION_SCOPE))
  })
})

describe('session-ops: 重启自动恢复（restoreActiveSession）', () => {
  it('listActiveMarkers 列出全部标记（scope/mdRel/mtime）', () => {
    expect(listActiveMarkers(dir)).toEqual([])
    const r = createSession(dir, 'mk', 'mk')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S001', 'agent-B')
    const markers = listActiveMarkers(dir)
    expect(markers).toHaveLength(2)
    expect(markers.map((m) => m.scope).sort()).toEqual(['agent-A', 'agent-B'])
    expect(markers.every((m) => m.mdRel === r.sessionMd.replace(dir + '/', ''))).toBe(true)
  })

  it('新 scope 无标记 → 恢复最近激活的会话（mtime 最新者胜出）', () => {
    const a = createSession(dir, 'rec-a', 'rec-a')
    const b = createSession(dir, 'rec-b', 'rec-b')
    useSession(dir, 'S001', 'old-agent')
    useSession(dir, 'S002', 'new-agent') // 更新 → mtime 最新
    const restored = restoreActiveSession(dir, 'restarted-session')
    expect(restored).not.toBeNull()
    expect(restored!.dir).toContain('S002')
    expect(restored!.id).toBe('S002')
    expect(restored!.restored).toBe(true)
    // 恢复 = 复制标记 → 新 scope 可读
    expect(readActiveSessionMd(dir, 'restarted-session')).toBe(b.sessionMd)
  })

  it('当前 scope 已有标记 → 不覆盖（返回 null）', () => {
    createSession(dir, 'keep', 'keep')
    useSession(dir, 'S001', 'mine')
    expect(restoreActiveSession(dir, 'mine')).toBeNull()
  })

  it('无任何候选标记 → 返回 null', () => {
    createSession(dir, 'none', 'none')
    expect(restoreActiveSession(dir, 'fresh')).toBeNull()
  })

  it('越界标记（内容指向根外）被过滤，不恢复', () => {
    createSession(dir, 'ok', 'ok')
    useSession(dir, 'S001', 'good')
    mkdirSync(join(dir, '.dsh', 'active-sessions'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-sessions', 'evil'), '../escape.md')
    const restored = restoreActiveSession(dir, 'fresh')
    expect(restored).not.toBeNull() // 仅 good 候选
    expect(readActiveSessionMd(dir, 'fresh')).toBe(join(dir, 'AGENT_SESSIONS', listSessions(dir)[0]!.dir, 'SESSION.md'))
  })

  it('全部候选越界 → 返回 null（不注入根外内容）', () => {
    createSession(dir, 'x', 'x')
    mkdirSync(join(dir, '.dsh', 'active-sessions'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-sessions', 'evil'), '../escape.md')
    expect(restoreActiveSession(dir, 'fresh')).toBeNull()
  })

  it('restore 后再 close：删除当前 scope 标记，恢复状态解除', () => {
    createSession(dir, 'c', 'c')
    useSession(dir, 'S001', 'old-agent')
    restoreActiveSession(dir, 'new-agent')
    expect(readActiveSessionMd(dir, 'new-agent')).not.toBeNull()
    closeSession(dir, 'new-agent')
    expect(readActiveSessionMd(dir, 'new-agent')).toBeNull()
    // 旧 scope 标记保留（隔离语义：close 只清自身 scope）
    expect(readActiveSessionMd(dir, 'old-agent')).not.toBeNull()
  })
})

describe('loop: 活动会话心跳', () => {
  it('无标记返回 null；有标记追加心跳（默认 scope）', () => {
    expect(resolveActiveSession(dir)).toBeNull()
    const r = createSession(dir, 'active', 'active')
    mkdirSync(join(dir, '.dsh', 'active-sessions'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-sessions', 'default'), r.sessionMd.replace(dir + '/', ''))
    expect(resolveActiveSession(dir)).toBe(r.sessionMd)
    expect(appendHeartbeat(r.sessionMd)).toBe(true)
    const content = readFileSync(r.sessionMd, 'utf-8')
    expect(content).toContain('heartbeat')
  })

  it('标记越界返回 null', () => {
    mkdirSync(join(dir, '.dsh', 'active-sessions'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-sessions', 'default'), '../escape.md')
    expect(resolveActiveSession(dir)).toBeNull()
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
