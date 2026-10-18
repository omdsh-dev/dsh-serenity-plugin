import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listSessions,
  createSession,
  showSession,
  useSession,
  summarize,
  readActiveSessionMd,
  getActiveSessionInfo,
  resetActiveSessionStore,
  parseSessionContextFromEvents,
  resolveSessionByTitle,
  sessionsRoot,
  sessionEvents,
  SESSION_CONTEXT_MARKER,
  DEFAULT_SESSION_SCOPE,
} from '../src/cognitive-trajectory-ops.js'

/**
 * cognitive-trajectory-ops 单元测试（S136 对齐 osp spec；v1.33 按 cognitive trajectory 六动作收敛）：
 * - create：--desc/--issue 二选一；返回 {message, dirName, sessionPath, sessionId}
 * - list/show/summary：文本输出（对齐 osp）
 * - **close / archive / health / qa 四个动作已于 v1.33 删除**（S142 §32 用户裁决），
 *   其函数与用例同批移除——「完成」由 SESSION.md 的 `[x]` 表达，归档走 `container_fs mv`
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

/**
 * 把状态行改写成"已完成"形态。
 *
 * 🔴 **2026-10-18 起它不再是"标记完成"**（轨迹永存，没有生命周期）。保留本函数只为**证明**：
 * 即使状态行写成已完成形态，**也不会**改变任何行为（`list` 不换标记、`summarize` 不计阶段、
 * `readAllSessions` 排序不变）—— 即"状态行已降为惰性文本"。这个反证比删掉它更有价值。
 */
function markDone(r: ReturnType<typeof createSession>): void {
  const md = join(r.sessionPath, 'SESSION.md')
  writeFileSync(md, readFileSync(md, 'utf-8').replace('- 状态: [ ] 进行中', '- 状态: [x] 已完成'), 'utf-8')
}

describe('cognitive-trajectory-ops: 生命周期（对齐 osp spec）', () => {
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

  it('create 模板 = 固定格式契约（状态行标记 ＋ 七个固定段按序 ＋ 全模板无 [x]）', () => {
    const r = mk('format-contract')
    const md = readFileSync(join(r.sessionPath, 'SESSION.md'), 'utf-8')
    // ① 状态行是**被解析的机器契约**（completed 由出现 `[x]` 推导）⇒ 未完成形态必须带 `[ ]` 标记
    expect(md).toContain('- 状态: [ ] 进行中')
    // ② 且模板里**不得出现任何 `[x]`** —— 否则新会话一出生就被判 completed
    expect(md).not.toMatch(/\[\s*x\s*\]/i)
    // ③ 固定段集合与顺序（owner 2026-09-25 裁决：格式在 ACC harness 固定）
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual([
      '## 身份与边界',
      '## 权威锚点',
      '## 工作纪律',
      '## 决策',
      '## 日志',
      '## 当前状态',
      '## 待 owner 裁决',
    ])
  })

  it('show 按 id / 关键词（返回文本）', () => {
    mk('alpha', { goal: '阿尔法' })
    expect(showSession(dir, 'S001')).toContain('阿尔法')
    expect(showSession(dir, 'alpha')).toContain('阿尔法')
  })

  it('🔥 反证：状态行写成已完成形态，**行为零变化**（状态行已降为惰性文本）', () => {
    // owner 2026-10-18 裁决：保留状态行，但不再被解析 ⇒ 轨迹永存、没有终态。
    // 这条用例就是那个判据的钉子：`[x]` 不能再影响任何读数。
    const a = mk('lifecycle-gone')
    const before = listSessions(dir)
    markDone(a)
    const after = listSessions(dir)
    // ① 清单标记不变（旧实现在这里会从 ○ 变 ✓）
    expect(after).toBe(before)
    expect(after).not.toContain('✓')
    // ② 统计里不再有任何阶段计数（旧实现会打印 Completed: 1）
    const s = summarize(dir)
    expect(s).not.toContain('Completed')
    expect(s).not.toContain('Stale')
    expect(s).not.toContain('Ghost')
    // ③ 活跃数不因 `[x]` 而减少 —— 它仍然在活跃清单里
    expect(s).toContain('Active (not archived): 1')
  })

  it('summary 计数（文本仪表盘）', () => {
    mk('a')
    const s = summarize(dir)
    // 唯一的总数 = 活跃轨迹数（四项生命周期计数已删）
    expect(s).toContain('Active (not archived): 1')
    expect(s).not.toContain('Completed')
  })
})

describe('cognitive-trajectory-ops: 活跃会话（内存化，S134 v1.16.14）', () => {
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
})

describe('cognitive-trajectory-ops: 进程重启恢复（parseSessionContextFromEvents，只扫自己会话）', () => {
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

describe('cognitive-trajectory-ops: v1.24.11 恢复稳固化（路径规范行即可，无需 [SESSION CONTEXT] 标记）', () => {
  it('重建锚点格式（无标记）→ 从路径行恢复（仅靠锚点的会话可恢复）', () => {
    const dirName = '2026-08-24--S142--dsh-serenity-plugin 长期维护'
    const anchor = [
      '[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD] The conversation has been cleared and rebuilt (Ship of Theseus: the carrier is replaced, the cognitive trajectory continues).',
      'Continue the work of S142.',
      `- Persistent cognitive trajectory — SESSION.md path: AGENT_SESSIONS/${dirName}/SESSION.md (the cognitive trajectory's persistent body)`,
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
    const m2 = `- Persistent cognitive trajectory — SESSION.md path: AGENT_SESSIONS/${b.dirName}/SESSION.md`
    const info = parseSessionContextFromEvents([{ data: { text: m1 } }, { data: { text: m2 } }])
    expect(info!.sessionId).toBe('S002')
    expect(info!.dirName).toBe(b.dirName)
  })

  // 🔴 2026-10-18：原两条用例测的是 `findLatestActiveSessionMd`（"最新的**未完成**轨迹"）。
  // 该函数已**删除**：它在 `src/` 里零消费者（最后一个消费方 v1.30.13 已移除，见 rebuild.ts:188-194），
  // 而其语义前提正是"未完成"这个生命周期概念 —— 前提既不存在，就该删而不是改写成语义不同的第二个东西。
  // ⇒ 用例保留为**回归钉**：它若回来，说明有人又往生命周期方向加了东西。
  it('🔴 `findLatestActiveSessionMd` 已随生命周期一起删除（不得复活）', async () => {
    const mod = await import('../src/cognitive-trajectory-ops.js')
    expect('findLatestActiveSessionMd' in mod, '该符号必须不存在——它的语义是"最新的未完成轨迹"').toBe(false)
  })

  /**
   * ⑤ 第 38 件：`resolveSessionByTitle`（标题 → 轨迹目录，U3/U4 编码无关 best-match）
   *
   * 🔴 **为何此前零执行**：本文件**一条用例都没有** import 过它；唯一调用点是
   * `src/seams/context.ts` 的「③ 标题 reconcile」分支，而那需要**真 dsh 会话标题**才走得到。
   * 🔴 **可达性取证**：`resolveSessionByTitle(title, sessionsRoot(root))` 是活路径
   * （重启恢复链的第三条回退），不是死代码 ⇒ 值得补。
   *
   * **三级优先序逐条钉住**（注释里写了优先级，本组把"注释"变成"断言"）：
   *   ① 标题即完整目录名 → 精确命中
   *   ② 标题首 token 作 code 段匹配（`--<code>--` 或尾段 `--<code>`）→ **唯一才返回，歧义返回 null**
   *   ③ 唯一模糊子串 → 返回；**多个则返回 null 防误猜**
   */
  it('resolveSessionByTitle：三级优先序（精确目录名 / code 段唯一 / 模糊唯一）', () => {
    const a = mk('alpha')
    const b = mk('beta')

    // ① 标题即完整目录名 ⇒ 精确命中（即使它不是最新）
    expect(resolveSessionByTitle(a.dirName, sessionsRoot(dir))).toBe(join(a.sessionPath, 'SESSION.md'))

    // ② code 段：标题首 token `-` 前 = S001 / S002 ⇒ 各唯一命中
    expect(resolveSessionByTitle('S001-2026-01-01-任意概括', sessionsRoot(dir))).toBe(join(a.sessionPath, 'SESSION.md'))
    expect(resolveSessionByTitle('S002-别的概括', sessionsRoot(dir))).toBe(join(b.sessionPath, 'SESSION.md'))

    // ③ 模糊子串：全体目录名里唯一包含该串者
    expect(resolveSessionByTitle('alph', sessionsRoot(dir))).toBe(join(a.sessionPath, 'SESSION.md'))
  })

  it('resolveSessionByTitle：歧义不猜 + 空标题 + 空目录（三条边界都要返回 null）', () => {
    // 多个目录都含该子串 ⇒ 必须 null（防误猜，这是本函数的立意）
    mk('dup-one')
    mk('dup-two')
    expect(resolveSessionByTitle('dup', sessionsRoot(dir))).toBeNull()

    // 空 / 空白标题
    expect(resolveSessionByTitle('', sessionsRoot(dir))).toBeNull()
    expect(resolveSessionByTitle('   ', sessionsRoot(dir))).toBeNull()

    // 无任何会话的目录
    const empty = mkdtempSync(join(tmpdir(), 'ops-empty-'))
    mkdirSync(join(empty, 'AGENT_SESSIONS'), { recursive: true })
    expect(resolveSessionByTitle('anything', sessionsRoot(empty))).toBeNull()
    rmSync(empty, { recursive: true, force: true })
  })

  it('resolveSessionByTitle：code 段歧义 ⇒ null（S00 同时前缀命中 S001/S002）', () => {
    mk('one')
    mk('two')
    // 首 token = 'S0' ⇒ 两个目录的 `--S00N--` 都不等于 'S0'，但 includes('--S0') 两边都真 ⇒ 歧义
    expect(resolveSessionByTitle('S0-x', sessionsRoot(dir))).toBeNull()
  })
})

describe('cognitive-trajectory-ops: sessionEvents（v1.28.1 适配 0.1.2-rc.1——rc.1 起 Session 无 .events 属性，snapshotEvents() 方法）', () => {
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
