import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listSessions,
  createSession,
  showSession,
  useSession,
  closeSession,
  archiveSessions,
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
 * session-ops 单元测试（S136 对齐 osp spec）：
 * - create：--desc/--issue 二选一；返回 {message, dirName, sessionPath, sessionId}
 * - list/show/health/summary/qa：文本输出（对齐 osp）
 * - archive：_archived/ 移动（需 completed + ≥7 天）
 * - 活跃会话：内存 Map（scope = dsh 会话 id）+ events 恢复（S134 保留）
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

function mk(desc: string, extra: Parameters<typeof createSession>[0] = {}): ReturnType<typeof createSession> {
  return createSession({ root: dir, desc, dryRun: false, ...extra })
}

describe('session-ops: 生命周期（对齐 osp spec）', () => {
  it('create desc 模式自动分配 S001 + 递增', () => {
    expect(listSessions(dir)).toBe('(no sessions in AGENT_SESSIONS/)')
    const a = mk('first')
    expect(a.sessionId).toBe('S001')
    expect(a.dirName).toContain('--S001--first')
    expect(existsSync(a.sessionPath)).toBe(true)
    expect(existsSync(join(a.sessionPath, 'SESSION.md'))).toBe(true)
    const b = mk('second')
    expect(b.sessionId).toBe('S002')
  })

  it('create issue 模式：目录 YYYY-MM-DD--<issue>（无 S###，sessionId=issue）', () => {
    const r = createSession({ root: dir, issue: 'apaas-26116', dryRun: false })
    expect(r.sessionId).toBe('apaas-26116')
    expect(r.dirName).toMatch(/^\d{4}-\d{2}-\d{2}--apaas-26116$/)
    expect(r.dirName).not.toContain('S0')
  })

  it('create 缺 desc/issue 报错；desc+issue 互斥报错；dry-run 不写盘', () => {
    expect(() => createSession({ root: dir, dryRun: false })).toThrow(/requires either --desc or --issue/)
    expect(() => createSession({ root: dir, desc: 'x', issue: 'apaas-1', dryRun: false })).toThrow(/mutually exclusive/)
    const r = createSession({ root: dir, desc: 'dry', dryRun: true })
    expect(r.message).toContain('[dry-run]')
    expect(existsSync(r.sessionPath)).toBe(false)
  })

  it('create goal 写入目标段', () => {
    const r = mk('goal', { goal: '完成对照' })
    expect(readFileSync(join(r.sessionPath, 'SESSION.md'), 'utf-8')).toContain('完成对照')
  })

  it('show 按 id / 关键词（返回文本）', () => {
    mk('alpha', { goal: '阿尔法' })
    expect(showSession(dir, 'S001')).toContain('阿尔法')
    expect(showSession(dir, 'alpha')).toContain('阿尔法')
  })

  it('archive：未完成会话拒绝；标记完成 + 7 天后移动到 _archived/', () => {
    const r = mk('x')
    // 未完成 → skipping
    expect(archiveSessions(dir, { name: 'S001', dryRun: false })).toContain('not completed')
    // 标记完成 + 改 mtime 到 7 天前
    const md = join(r.sessionPath, 'SESSION.md')
    const content = readFileSync(md, 'utf-8').replace('## 状态\n- [ ] 进行中', '## 状态\n- [x] 已完成')
    writeFileSync(md, content, 'utf-8')
    const past = new Date(Date.now() - 8 * 86400000)
    utimesSync(r.sessionPath, past, past)
    utimesSync(md, past, past)
    expect(archiveSessions(dir, { name: 'S001', dryRun: false })).toContain('Archived')
    expect(existsSync(r.sessionPath)).toBe(false)
    expect(existsSync(join(dir, 'AGENT_SESSIONS', '_archived', r.dirName))).toBe(true)
  })

  it('health 报告 stale（文本，>7 天未更新）', () => {
    expect(healthCheck(dir)).toBe('No sessions found — nothing to check.')
    const r = mk('old')
    const past = new Date(Date.now() - 20 * 86400000)
    utimesSync(r.sessionPath, past, past)
    utimesSync(join(r.sessionPath, 'SESSION.md'), past, past)
    const h = healthCheck(dir)
    expect(h).toContain('[STALE]')
  })

  it('summary 计数（文本仪表盘）', () => {
    mk('a')
    const s = summarize(dir)
    expect(s).toContain('Total:    1')
    expect(s).toContain('Active:   1')
    expect(s).toContain('Completed: 0')
  })

  it('qa 核对产出物（文本报告）', () => {
    const r = mk('w')
    const qa = qaCheck(dir, 'S001')
    expect(qa).toContain('QA Report:')
    expect(qa).toContain('outputs')
  })
})

describe('session-ops: 活跃会话（内存化，S134 v1.16.14）', () => {
  it('use 写内存 Map（不落盘）：getActiveSessionInfo + readActiveSessionMd + resolveActiveSession 可读', () => {
    const r = mk('active-use')
    const used = useSession(dir, 'S001')
    const md = join(r.sessionPath, 'SESSION.md')
    expect(used.dir).toContain('S001')
    // 不产生任何 .dsh 文件
    expect(existsSync(join(dir, '.dsh'))).toBe(false)
    expect(getActiveSessionInfo(DEFAULT_SESSION_SCOPE)).toEqual({
      sessionId: 'S001', dirName: used.dir, mdPath: md,
    })
    expect(readActiveSessionMd(dir)).toBe(md)
    expect(resolveActiveSession(dir)).toBe(md)
  })

  it('use 返回 context 含 [SESSION CONTEXT] 标记 + todowrite 指令（events 恢复源）', () => {
    const r = mk('ctx-marker')
    const used = useSession(dir, 'S001')
    expect(used.context).toContain(`${SESSION_CONTEXT_MARKER} ${used.dir}`)
    expect(used.context).toContain(`SESSION.md path: ${r.sessionPath}`)
    expect(used.context).toContain('todowrite') // 对齐 osp use 输出
  })

  it('use 按 scope 隔离：并行多会话各自活跃，互不覆盖', () => {
    const a = mk('scope-a')
    const b = mk('scope-b')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    expect(resolveActiveSession(dir, 'agent-A')).toBe(join(a.sessionPath, 'SESSION.md'))
    expect(resolveActiveSession(dir, 'agent-B')).toBe(join(b.sessionPath, 'SESSION.md'))
    expect(resolveActiveSession(dir)).toBeNull() // 默认 scope 未 use
  })

  it('use 未找到会话抛错', () => {
    expect(() => useSession(dir, 'nope')).toThrow(/Session not found/)
  })

  it('close 需 confirm（对齐 osp）；confirm 后标记完成 + 清 scope', () => {
    const c = mk('c')
    const d = mk('d')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    // 无 confirm → 拒绝
    expect(closeSession(dir, 'S001', false, 'agent-A')).toContain('requires explicit confirmation')
    expect(resolveActiveSession(dir, 'agent-A')).not.toBeNull()
    // confirm 后：标记完成 + 清 scope
    expect(closeSession(dir, 'S001', true, 'agent-A')).toContain('closed')
    expect(readFileSync(join(c.sessionPath, 'SESSION.md'), 'utf-8')).toContain('[x] 已完成')
    expect(resolveActiveSession(dir, 'agent-A')).toBeNull()
    expect(resolveActiveSession(dir, 'agent-B')).not.toBeNull()
    expect(existsSync(join(dir, '.dsh'))).toBe(false)
  })
})

describe('session-ops: 进程重启恢复（parseSessionContextFromEvents，只扫自己会话）', () => {
  it('events 含 [SESSION CONTEXT] 标记 → 解析出活跃会话', () => {
    const r = mk('recover-me')
    const marker = `${SESSION_CONTEXT_MARKER} ${r.dirName}\nSESSION.md path: ${r.sessionPath}`
    const events = [{ type: 'tool/call' }, { type: 'tool/result', data: { output: marker } }]
    const info = parseSessionContextFromEvents(events)
    expect(info).toEqual({ sessionId: 'S001', dirName: r.dirName, mdPath: r.sessionPath })
  })

  it('取最后一条标记（最新优先）', () => {
    const a = mk('first')
    const b = mk('second')
    const m1 = `${SESSION_CONTEXT_MARKER} ${a.dirName}\nSESSION.md path: ${a.sessionPath}`
    const m2 = `${SESSION_CONTEXT_MARKER} ${b.dirName}\nSESSION.md path: ${b.sessionPath}`
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
    const r = mk('active')
    useSession(dir, 'S001')
    expect(resolveActiveSession(dir)).toBe(join(r.sessionPath, 'SESSION.md'))
    expect(appendHeartbeat(join(r.sessionPath, 'SESSION.md'))).toBe(true)
    expect(readFileSync(join(r.sessionPath, 'SESSION.md'), 'utf-8')).toContain('heartbeat')
  })

  it('按 scope 隔离心跳：只写当前 dsh 会话的活跃会话', () => {
    const a = mk('h-a')
    const b = mk('h-b')
    useSession(dir, 'S001', 'agent-A')
    useSession(dir, 'S002', 'agent-B')
    const mdA = join(a.sessionPath, 'SESSION.md')
    const mdB = join(b.sessionPath, 'SESSION.md')
    expect(resolveActiveSession(dir, 'agent-A')).toBe(mdA)
    expect(resolveActiveSession(dir, 'agent-B')).toBe(mdB)
    expect(appendHeartbeat(mdA)).toBe(true)
    expect(readFileSync(mdA, 'utf-8')).toContain('heartbeat')
    expect(readFileSync(mdB, 'utf-8')).not.toContain('heartbeat')
  })
})
