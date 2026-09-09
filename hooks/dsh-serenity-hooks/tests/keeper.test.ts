import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

import {
  KeeperTracker,
  scoreTool,
  reminderText,
  rebuildReminderText,
  readContextPressure,
  registerKeeper,
  logbookCompactionReminderText,
  readSessionMdMaxKB,
  readFileSize,
  resolveActiveSessionMdPath,
  compactionStateSnapshot,
  forgetLogbookCompactionState,
  __resetLogbookCompactionForTest,
  DEFAULT_SESSION_MD_MAX_KB,
} from '../src/seams/keeper.js'
import { registerSkiffSession, unregisterSkiffSession } from '../src/skiff-core.js'
import { setActiveSessionInfo, clearActiveSessionInfo } from '../src/session-ops.js'

describe('keeper: 纯跟踪器', () => {
  it('计分表：write=3, task=10, read=1', () => {
    expect(scoreTool('write')).toBe(3)
    expect(scoreTool('task')).toBe(10)
    expect(scoreTool('read')).toBe(1)
    expect(scoreTool('unknown-tool')).toBe(0)
  })

  it('达到阈值触发提醒，ack 后清零', () => {
    let now = 0
    const t = new KeeperTracker(10, () => now)
    expect(t.step('write')).toBe(false) // 3
    expect(t.step('write')).toBe(false) // 6
    expect(t.step('write')).toBe(false) // 9
    expect(t.step('write')).toBe(true) // 12 ≥ 10
    const code = t.ack()
    expect(code).toBe('K1')
    expect(t.currentScore).toBe(0)
    expect(t.step('read')).toBe(false) // 1
  })

  it('经过时间计分：+1 分/分钟', () => {
    let now = 0
    const t = new KeeperTracker(5, () => now)
    t.step('read') // 1, now=0
    now = 120_000 // +2 分钟
    expect(t.step('read')).toBe(false) // 1+2+1 = 4
    now = 240_000
    expect(t.step('read')).toBe(true) // 4+2+1 = 7 ≥ 5
  })

  it('reminderText 含确认码（trajectory-assistant checkpoint 前缀）', () => {
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-ASSISTANT-recorded-K1]')
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(reminderText('K1', 150)).not.toContain('SESSION-KEEPER')
    expect(reminderText('K1', 150)).not.toContain('[TRAJECTORY-STEWARD]')
  })
})

describe('轨迹跟踪器（Trajectory Tracker）— v1.22.1 概念命名', () => {
  it('rebuildReminderText：SESSION.md=持久轨迹，会话=临时可重建工作副本（需求① K 数值化）', () => {
    // 需求①：参数从 (ratio, threshold 比例) 改为 (tokensK, thresholdK 千 token)
    const text = rebuildReminderText(412, 400)
    expect(text).toContain('[TRAJECTORY-ASSISTANT · LIMIT]')
    expect(text).toContain('412K')
    expect(text).toContain('threshold 400K')
    expect(text).toContain('persistent body')
    expect(text).toContain('rebuildable carrier')
    expect(text).toContain('ACT NOW')
    expect(text).toContain('logbook rebuild')
    expect(text).toContain('not an option')
    // v1.24.12 沉淀协议：rebuild 前修订现有 skill（eap 结构化）；新建 skill 写 SESSION 提案不自行创建
    expect(text).toContain('revise the relevant existing skill of this CCC')
    expect(text).toContain('write a short proposal into SESSION.md')
    expect(text).toContain('do not create it yourself')
    // v1.28.0 需求②（P0-1 审计补断言）：文案必须指导带 --summary（重建后标题重命名）——
    // 若删指引，模型裸调 logbook rebuild 会被 summary 必填拒绝（2026-09-05 rebuild bug 教训）
    expect(text).toContain('--summary')
    expect(text).toContain('≤20 chars')
    expect(text).toContain('renamed to S###-YYYY-MM-DD-<summary>')
    // v1.31.1 交接协议（写侧）：要求把手头事项写在 SESSION.md 末尾的固定英文标题下
    expect(text).toContain('## In-flight (rebuild handover)')
    expect(text).toContain('current in-flight items')
    expect(text).toContain('at the very end of SESSION.md')
    // v1.23.3：不向 LLM 植入阈值建议（设定是用户自由）
    expect(text).not.toContain('0.75~0.9')
  })

  it('rebuildReminderText 升级语气（escalated=true，需求① K 数值化）', () => {
    const text = rebuildReminderText(460, 400, true)
    expect(text).toContain('[TRAJECTORY-ASSISTANT · LIMIT · MANDATORY]')
    expect(text).toContain('460K')
    expect(text).toContain('threshold 400K')
    expect(text).toContain('mandatory')
    expect(text).toContain('STOP')
    expect(text).toContain('logbook rebuild')
    expect(text).toContain('persists until you call logbook rebuild')
    // v1.24.12：升级版同样带紧凑沉淀指令（修订 skill / 新建 skill 提案进 SESSION）
    expect(text).toContain('preserve valuable cognition')
    expect(text).toContain('new-skill proposal into SESSION.md')
    // v1.28.0 需求②（P0-1 审计补断言）：升级版同样指导带 --summary
    expect(text).toContain('--summary')
    expect(text).toContain('renamed to S###-YYYY-MM-DD-<summary>')
    // v1.31.1 交接协议：升级版同样要求写 in-flight 区块
    expect(text).toContain('## In-flight (rebuild handover)')
    expect(text).toContain('at the very end of SESSION.md')
  })

  it('readContextPressure：sessionProjections 装配时读取投影', () => {
    const session = { id: 's1' }
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
        : undefined,
    }
    const pressure = readContextPressure(ctx as never, session)
    expect(pressure).toEqual({ projectedTokens: 9000, contextWindow: 10000 })
  })

  it('readContextPressure：未装配 / 无压力值 → null（不抛错）', () => {
    const session = { id: 's1' }
    const noService = { get: () => undefined }
    expect(readContextPressure(noService as never, session)).toBeNull()
    const noPressure = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: {} }) }
        : undefined,
    }
    expect(readContextPressure(noPressure as never, session)).toBeNull()
  })
})

describe('keeper: LOGBOOK COMPACTION（SESSION.md 体积超限重写提醒，v1.31.1）', () => {
  let dir: string
  let handler: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null
  const SCOPE = 'md-size-1'

  /** 写 CCC 配置（阈值设很大 → 屏蔽计分提醒噪音，只观察体积提醒） */
  function writeConfig(sessionKeeper: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 99999, ...sessionKeeper } }),
    )
  }

  /** 建 SESSION.md 并绑定为活跃会话；返回其绝对路径 */
  function bindSession(sizeBytes: number): string {
    const sessionDir = join(dir, 'AGENT_SESSIONS', '2026-01-01--S001--size-test')
    mkdirSync(sessionDir, { recursive: true })
    const mdPath = join(sessionDir, 'SESSION.md')
    writeFileSync(mdPath, 'x'.repeat(sizeBytes))
    setActiveSessionInfo(SCOPE, { sessionId: 'S001', dirName: '2026-01-01--S001--size-test', mdPath })
    return mdPath
  }

  async function fire(): Promise<string[]> {
    const exec = { name: 'read', agent: { session: { id: SCOPE, header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as {
      additionalContexts?: Array<{ content?: Array<{ text?: string }> }>
    }
    return (result.additionalContexts ?? []).map((m) => m.content?.[0]?.text ?? '')
  }

  beforeEach(() => {
    __resetLogbookCompactionForTest()
    dir = mkdtempSync(join(tmpdir(), 'keeper-compaction-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeConfig({ sessionMdMaxKB: 1 })
    handler = null
    registerKeeper({ on: (name: string, fn: unknown) => { if (name === 'tools/post-execute') handler = fn as typeof handler } } as never)
  })

  afterEach(() => {
    clearActiveSessionInfo(SCOPE)
    __resetLogbookCompactionForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('超限 → 注入提醒（含 token / 体积 / 阈值 / 路径 / 4 条原则）', async () => {
    bindSession(2048) // 2 KB > 1 KB
    const texts = await fire()
    expect(texts).toHaveLength(1)
    const t = texts[0]!
    expect(t).toContain('[TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]')
    expect(t).toContain('2 KB')
    expect(t).toContain('limit 1 KB')
    expect(t).toContain('SESSION.md')
    expect(t).toContain('praxis eap')
    expect(t).toContain('EAP layered skeleton')
    expect(t).toContain('references/')
    expect(t).toContain('merge or drop')
    expect(t).toContain('full discretion')
    expect(t).toContain('reconstruction over preservation')
  })

  it('未超限 → 零注入；重写后（文件变小）提醒自动停止', async () => {
    const mdPath = bindSession(512) // 0.5 KB < 1 KB
    expect(await fire()).toHaveLength(0)
    writeFileSync(mdPath, 'y'.repeat(4096))
    expect(await fire()).toHaveLength(1)
    writeFileSync(mdPath, 'z'.repeat(100))
    expect(await fire()).toHaveLength(0)
  })

  it('连续 3 轮超限 → 第 3 轮升级强制语气（mandatory + STOP）', async () => {
    bindSession(4096)
    const first = (await fire())[0]!
    const second = (await fire())[0]!
    const third = (await fire())[0]!
    expect(first).not.toContain('mandatory')
    expect(second).not.toContain('mandatory')
    expect(third).toContain('mandatory')
    expect(third).toContain('STOP')
  })

  it('CCC 配置 sessionMdMaxKB=0 → 关闭提醒', async () => {
    writeConfig({ sessionMdMaxKB: 0 })
    __resetLogbookCompactionForTest()
    bindSession(8192)
    expect(await fire()).toHaveLength(0)
  })

  it('活跃会话未绑定 / SESSION.md 不存在 → 不提醒且不抛错（不猜别的轨迹）', async () => {
    expect(await fire()).toHaveLength(0)
    setActiveSessionInfo(SCOPE, { sessionId: 'S002', dirName: 'ghost', mdPath: join(dir, 'nope', 'SESSION.md') })
    expect(await fire()).toHaveLength(0)
  })

  it('skiff 会话（trajectory.session 关）→ 不提醒（角色子集控权）', async () => {
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 99999, sessionMdMaxKB: 1 }, skiff: { roles: { quiet: { msms: [] } } } }),
    )
    __resetLogbookCompactionForTest()
    registerSkiffSession('skiff-quiet-1', 'quiet', dir, { session: { id: 'skiff-quiet-1' } } as never)
    bindSession(4096)
    const exec = { name: 'read', agent: { session: { id: 'skiff-quiet-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(0)
    unregisterSkiffSession('skiff-quiet-1')
  })
})

describe('keeper: LOGBOOK COMPACTION 纯逻辑', () => {
  afterEach(() => { __resetLogbookCompactionForTest() })

  it('提醒文案：非升级版含行动指令 + 4 条原则；升级版含 mandatory/STOP', () => {
    const base = logbookCompactionReminderText({ sizeKB: 285, limitKB: 100, mdPath: '/ccc/SESSION.md' })
    expect(base).toContain('[TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]')
    expect(base).toContain('285 KB')
    expect(base).toContain('limit 100 KB')
    expect(base).toContain('/ccc/SESSION.md')
    expect(base).toContain('Pause the current work')
    expect(base).toContain('H_op')
    expect(base).toContain('resume the paused work')
    const esc = logbookCompactionReminderText({ sizeKB: 285, limitKB: 100, mdPath: '/ccc/SESSION.md', escalated: true })
    expect(esc).toContain('mandatory')
    expect(esc).toContain('STOP')
    expect(esc).toContain('persists until the file is under the limit')
  })

  it('阈值：未配置 → 缺省 200KB（v1.31.2 由 100 上调）；配置生效；0 生效（关闭）；坏值回落缺省', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-limit-'))
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    const cfg = join(dir, '.opencode', 'serenity.json')
    // v1.31.2（S142 用户"默认阈值设定在200kb吧"）：缺省值硬断言——防再次静默漂移
    expect(DEFAULT_SESSION_MD_MAX_KB).toBe(200)
    expect(readSessionMdMaxKB(dir)).toBe(DEFAULT_SESSION_MD_MAX_KB)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 250 } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(250)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 0 } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(0)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 'huge' } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(DEFAULT_SESSION_MD_MAX_KB)
    rmSync(dir, { recursive: true, force: true })
  })

  it('路径解析：活跃会话信息优先；文件缺失 → null；缓存命中（TTL 内不重解析）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-path-'))
    mkdirSync(join(dir, 'AGENT_SESSIONS', 'S1'), { recursive: true })
    const mdPath = join(dir, 'AGENT_SESSIONS', 'S1', 'SESSION.md')
    writeFileSync(mdPath, 'hi')
    setActiveSessionInfo('p1', { sessionId: 'S1', dirName: 'S1', mdPath })
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBe(mdPath)
    // 缓存命中：改活跃指向也不重解析（TTL 内）
    setActiveSessionInfo('p1', { sessionId: 'S2', dirName: 'S2', mdPath: join(dir, 'missing.md') })
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBe(mdPath)
    // 清理后重新解析 → 文件不存在 → null
    forgetLogbookCompactionState('p1')
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBeNull()
    clearActiveSessionInfo('p1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('readFileSize：存在 → 字节数；缺失 → null（不抛错）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-size-'))
    const f = join(dir, 'a.md')
    writeFileSync(f, 'abcd')
    expect(readFileSize(f)).toBe(4)
    expect(readFileSize(join(dir, 'nope.md'))).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('状态快照与清理：超限计数可观测，清理后归零', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-state-'))
    writeFileSync(join(dir, '.serenity'), 'x')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ sessionKeeper: { threshold: 99999, sessionMdMaxKB: 1 } }))
    const sessionDir = join(dir, 'AGENT_SESSIONS', 'S1')
    mkdirSync(sessionDir, { recursive: true })
    const mdPath = join(sessionDir, 'SESSION.md')
    writeFileSync(mdPath, 'x'.repeat(2048))
    setActiveSessionInfo('st-1', { sessionId: 'S1', dirName: 'S1', mdPath })
    let h: ((e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>) | null = null
    registerKeeper({ on: (name: string, fn: unknown) => { if (name === 'tools/post-execute') h = fn as typeof h } } as never)
    await h!({ name: 'read', agent: { session: { id: 'st-1', header: { cwd: dir } } } }, {}, async () => ({ kind: 'enter' }))
    expect(compactionStateSnapshot().get('st-1')?.consecutive).toBe(1)
    forgetLogbookCompactionState('st-1')
    expect(compactionStateSnapshot().has('st-1')).toBe(false)
    clearActiveSessionInfo('st-1')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('keeper: Skiff 轨迹纪律子集旁路（F4b ⑩）', () => {
  let dir: string
  let handler: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-skiff-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 1 }, skiff: { roles: { qa: { msms: ['x'] }, tracked: { msms: ['y'], trajectory: { keeper: true } } } } }),
    )
    handler = null
    const fakeCtx = {
      on: (name: string, fn: unknown) => {
        if (name === 'tools/post-execute') handler = fn as typeof handler
      },
    }
    registerKeeper(fakeCtx as never, { defaultThreshold: 1 })
  })

  afterEach(() => {
    unregisterSkiffSession('skiff-qa-1')
    unregisterSkiffSession('skiff-tracked-1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Skiff 会话（keeper 子集关）→ 计分不触发提醒（完全独立）', async () => {
    registerSkiffSession('skiff-qa-1', 'qa', dir, { session: { id: 'skiff-qa-1' } } as never)
    const exec = { name: 'read', agent: { session: { id: 'skiff-qa-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(0)
  })

  it('Skiff 会话（keeper 子集开）→ 计分提醒生效（按角色配置）', async () => {
    registerSkiffSession('skiff-tracked-1', 'tracked', dir, { session: { id: 'skiff-tracked-1' } } as never)
    const exec = { name: 'read', agent: { session: { id: 'skiff-tracked-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })

  it('非 skiff 会话 → 计分提醒正常（不受影响）', async () => {
    const exec = { name: 'read', agent: { session: { id: 'normal-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })
})
