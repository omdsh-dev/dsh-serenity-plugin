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
  readActiveSessionMd,
  getActiveSessionInfo,
  resetActiveSessionStore,
  parseSessionContextFromEvents,
  findLatestActiveSessionMd,
  sessionEvents,
  SESSION_CONTEXT_MARKER,
  DEFAULT_SESSION_SCOPE,
} from '../src/session-ops.js'

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

  it('create 目录名脱敏（Windows 审计问题 10：非法字符/保留名）', () => {
    const r = createSession({ root: dir, desc: 'feat: x/y', dryRun: false })
    expect(r.dirName).not.toContain(':')
    expect(r.dirName).not.toContain('/')
    // 保留名 CON → _CON
    const con = createSession({ root: dir, desc: 'CON', dryRun: false })
    expect(con.dirName).toContain('_CON')
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
  it('use 写内存 Map（不落盘）：getActiveSessionInfo + readActiveSessionMd 可读', () => {
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
    expect(readActiveSessionMd(dir)).toBe(md)
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
    expect(readActiveSessionMd(dir, 'agent-A')).toBe(join(a.sessionPath, 'SESSION.md'))
    expect(readActiveSessionMd(dir, 'agent-B')).toBe(join(b.sessionPath, 'SESSION.md'))
    expect(readActiveSessionMd(dir)).toBeNull() // 默认 scope 未 use
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
    expect(readActiveSessionMd(dir, 'agent-A')).not.toBeNull()
    // confirm 后：标记完成 + 清 scope
    expect(closeSession(dir, 'S001', true, 'agent-A')).toContain('closed')
    expect(readFileSync(join(c.sessionPath, 'SESSION.md'), 'utf-8')).toContain('[x] 已完成')
    expect(readActiveSessionMd(dir, 'agent-A')).toBeNull()
    expect(readActiveSessionMd(dir, 'agent-B')).not.toBeNull()
    expect(existsSync(join(dir, '.dsh'))).toBe(false)
  })
})

describe('session-ops: 进程重启恢复（parseSessionContextFromEvents，只扫自己会话）', () => {
  it('events 含 [SESSION CONTEXT] 标记 → 解析出活跃会话', () => {
    const r = mk('recover-me')
    const mdPath = join(r.sessionPath, 'SESSION.md')
    const marker = `${SESSION_CONTEXT_MARKER} ${r.dirName}\nSESSION.md path: ${mdPath}`
    const events = [{ type: 'tool/call' }, { type: 'tool/result', data: { output: marker } }]
    const info = parseSessionContextFromEvents(events)
    expect(info).toEqual({ sessionId: 'S001', dirName: r.dirName, mdPath })
  })

  it('会话目录名含空格 → mdPath 完整解析（\S+ 截断回归，S142 v1.23.4）', () => {
    const dirName = '2026-08-24--S142--dsh-serenity-plugin 长期维护'
    const mdPath = join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md')
    const marker = `${SESSION_CONTEXT_MARKER} ${dirName}\nSESSION.md path: ${mdPath}`
    const info = parseSessionContextFromEvents([{ data: { output: marker } }])
    expect(info).not.toBeNull()
    expect(info!.mdPath).toBe(mdPath)
    expect(info!.dirName).toBe(dirName)
    expect(info!.sessionId).toBe('S142')
  })

  it('取最后一条标记（最新优先）', () => {
    const a = mk('first')
    const b = mk('second')
    const m1 = `${SESSION_CONTEXT_MARKER} ${a.dirName}\nSESSION.md path: ${join(a.sessionPath, 'SESSION.md')}`
    const m2 = `${SESSION_CONTEXT_MARKER} ${b.dirName}\nSESSION.md path: ${join(b.sessionPath, 'SESSION.md')}`
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

describe('session-ops: v1.24.11 恢复稳固化（路径规范行即可，无需 [SESSION CONTEXT] 标记）', () => {
  it('重建锚点格式（无标记）→ 从路径行恢复（仅靠锚点的会话可恢复）', () => {
    const dirName = '2026-08-24--S142--dsh-serenity-plugin 长期维护'
    const anchor = [
      '[TRAJECTORY-REBUILD] The conversation has been cleared and rebuilt.',
      'Continue the work of S142.',
      `- Persistent trajectory — SESSION.md path: AGENT_SESSIONS/${dirName}/SESSION.md (the trajectory's persistent body)`,
    ].join('\n')
    const info = parseSessionContextFromEvents([
      { type: 'user/message', data: { content: [{ type: 'text', text: anchor }] } },
    ])
    expect(info).not.toBeNull()
    expect(info!.sessionId).toBe('S142')
    expect(info!.dirName).toBe(dirName)
    expect(info!.mdPath).toBe(`AGENT_SESSIONS/${dirName}/SESSION.md`)
  })

  it('旧 use 标记 + 新重建锚点 → 最后一条路径胜出（时间序最新）', () => {
    const a = mk('old-active')
    const b = mk('newer')
    const m1 = `${SESSION_CONTEXT_MARKER} ${a.dirName}\nSESSION.md path: ${join(a.sessionPath, 'SESSION.md')}`
    const m2 = `- Persistent trajectory — SESSION.md path: AGENT_SESSIONS/${b.dirName}/SESSION.md`
    const info = parseSessionContextFromEvents([{ data: { text: m1 } }, { data: { text: m2 } }])
    expect(info!.sessionId).toBe('S002')
    expect(info!.dirName).toBe(b.dirName)
  })

  it('findLatestActiveSessionMd：最新未完成会话胜出；已完成跳过（约定回退）', () => {
    const old = mk('old-done')
    const active = mk('active')
    // 关闭 old（标记完成）→ 只返回 active（SESSION.md 文件路径）
    closeSession(dir, old.sessionId, true)
    expect(findLatestActiveSessionMd(dir)).toBe(join(active.sessionPath, 'SESSION.md'))
  })

  it('findLatestActiveSessionMd：全部完成 → null', () => {
    const a = mk('only-done')
    closeSession(dir, a.sessionId, true)
    expect(findLatestActiveSessionMd(dir)).toBeNull()
  })
})

describe('session-ops: sessionEvents（v1.28.1 适配 0.1.2-rc.1——rc.1 起 Session 无 .events 属性，snapshotEvents() 方法）', () => {
  it('snapshotEvents() 优先（真实 rc.1 Session 形态）', () => {
    const events = [{ type: 'user/message', seq: 1 }]
    const session = { snapshotEvents: () => events, events: [{ type: 'old' }] }
    expect(sessionEvents(session)).toEqual(events)
  })

  it('.events 兜底（测试替身/旧运行时形态）', () => {
    const events = [{ type: 'user/message', seq: 1 }]
    expect(sessionEvents({ events })).toEqual(events)
  })

  it('snapshotEvents 抛错 → events 兜底', () => {
    const events = [{ type: 'user/message' }]
    const session = {
      snapshotEvents: () => { throw new Error('boom') },
      events,
    }
    expect(sessionEvents(session)).toEqual(events)
  })

  it('两者皆无 / null / undefined → []（绝不抛错）', () => {
    expect(sessionEvents({})).toEqual([])
    expect(sessionEvents(null)).toEqual([])
    expect(sessionEvents(undefined)).toEqual([])
    expect(sessionEvents('string')).toEqual([])
  })

  it('snapshotEvents 返回 null → []', () => {
    expect(sessionEvents({ snapshotEvents: () => null })).toEqual([])
  })
})
