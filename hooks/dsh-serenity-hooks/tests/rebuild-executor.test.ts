/**
 * rebuild-executor.test.ts — 超限重建的**执行面与失败面**（⑤ 第 22 件）
 *
 * 挑靶依据 = **分支覆盖率**（`rebuild.ts` 68.75%，已退役/已满的靶之外最低）。
 * 靶的性质 = **破坏性能力**（清空对话历史 ＋ 自动继续）⇒ 本件刻意只测**失败与边界**，
 * 而既有 `tests/rebuild.test.ts` 已覆盖顺利路径（排队 → replace → steer 自动继续）。
 *
 * 🔴 **本件补的正是"出错时用户看到什么"**：
 *   · `queueRebuild` 的两道门 ⇒ **总闸关**（rebuild.enabled=false）／**会话定位失败**（可能已关闭）
 *   · 会话名的**回落派生**（无内存活跃信息 ⇒ 由 mdPath 目录名派生）＋ 非 `S###` 目录名 ⇒ 绑定行**不编造 S 号**
 *   · turn 钩子：**无 agent** ／ **陈旧队列超 TTL**（丢弃 ＋ 记 `ttl-dropped`）／
 *     **meter 三态**（缺失退化 ／ 有 `estimateMessage` ⇒ 真走 shadow-price 包装 ／ 有服务但无该方法 ⇒ 同样退化）
 *   · **surface 空 / 只剩系统提示节点**（⇒ 记 `empty-surface`，不 replace）
 *   · **宿主拒绝 replace**（⇒ 记 `failed` ＋ warn，**不打断 turn**）
 *   · **诊断写盘失败**（⇒ 吞掉，**rebuild 主流程照跑**）
 *   · **重建后重命名三态**（成功 ／ 服务不可用 ⇒ 跳过 ／ 抛错 ⇒ warn 不阻断）
 *   · **诊断根回落**（agent 无 `header.cwd` ⇒ `?? process.cwd()`；⚠️ 用 spy 钉住，绝不写进真仓库）
 *
 * 🔵 **纪律**：① 断言取**诊断文件的内容**（`.rebuild-diag.json`）＝ 用户/agent 能看到的那一面，
 * 而不是"函数返回了什么"；② 破坏性动作的判据是**盘上／队列状态**；③ 时间敏感用例用
 * `vi.useFakeTimers()` ＋ `setSystemTime`（TTL 是 10 分钟，不能真等）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
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
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { queueRebuild, registerRebuildTurnHook, pendingRebuildSnapshot } from '../src/rebuild.js'
import { readLastBound, appendBound } from '../src/trajectory-bound.js'
import { resetActiveSessionStore } from '../src/trajectory-ops.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

let dir: string
let altRoot: string | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuildexec-'))
  altRoot = null
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
  __setSimpleSourceForTest(null) // 恢复默认源（默认 rebuildEnabled = true）
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetActiveSessionStore()
  rmSync(dir, { recursive: true, force: true })
  if (altRoot) {
    rmSync(altRoot, { recursive: true, force: true })
    altRoot = null
  }
})

// ── 夹具（与 tests/rebuild.test.ts 同形状；此处按需加"可注入故障"） ────────────────

function fakeSession(nodes: number[], opts: { appendThrows?: boolean; events?: unknown[] } = {}) {
  const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
  return {
    header: { id: 'session-x', cwd: dir },
    surface: { nodes, replaceGeneration: 0 },
    ...(opts.events ? { events: opts.events } : {}),
    append: (type: string, data: unknown, o?: unknown) => {
      if (opts.appendThrows === true) throw new Error('surface replace rejected by host')
      calls.push({ type, data, opts: o })
      return { type, data, opts: o }
    },
    _calls: calls,
  }
}

/** `withCwd:false` ⇒ session 无 header ⇒ 覆盖诊断根的 `?? process.cwd()` 回落 */
function fakeAgent(id: string, session: { header?: unknown } & Record<string, unknown>, opts: { withCwd?: boolean } = {}) {
  const steers: unknown[] = []
  const s = opts.withCwd === false ? { ...session, header: undefined } : session
  return {
    id,
    session: s,
    steer: (m: unknown) => { steers.push(m) },
    _steers: steers,
  }
}

function mkSessionDir(dirName: string): string {
  const md = join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md')
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, `# SESSION ${dirName}`)
  return md
}

function bindSession(session: unknown, mdPath: string): void {
  appendBound(session, 'activate', { dirName: basename(dirname(mdPath)), mdPath })
}

function qctx(session: unknown): never {
  return { sessions: { get: () => session } } as never
}

/** 只提供 `on` 与 `get`（`hostService` 走 `ctx.get` ⇒ 服务有无由 services 决定） */
function hookCtx(services: Record<string, unknown> = {}) {
  const listeners: Array<(p: unknown) => void> = []
  const ctx = {
    on: (name: string, fn: (p: unknown) => void) => {
      if (name === 'agent/turn-stopping') listeners.push(fn)
    },
    get: (name: string) => services[name],
  }
  registerRebuildTurnHook(ctx as never)
  return { listeners, fire: (p: unknown) => listeners[0]!(p), ctx }
}

function readDiag(root = dir): { lastEvent: string; lastSessionId: string; queueCount: number; rebuiltCount: number; droppedCount: number; failedCount: number; detail?: string } {
  return JSON.parse(readFileSync(join(root, 'AGENT_SESSIONS', '.rebuild-diag.json'), 'utf-8'))
}

/** 标准排队（绑定 ⇒ 可解析 SESSION） */
async function queueFor(session: unknown, o: { summary?: string; dirName?: string } = {}): Promise<void> {
  const md = mkSessionDir(o.dirName ?? '2026-08-28--S200--exec')
  bindSession(session, md)
  await queueRebuild(qctx(session), { root: dir, summary: o.summary ?? 'exec 重建', agentCwd: dir, dshSessionId: 's1' })
}

// ── queueRebuild 的两道门 ＋ 会话名回落 ─────────────────────────────────────────

describe('rebuild-executor：queueRebuild 的门与回落', () => {
  it('🔴 总闸关闭（rebuildEnabled=false）⇒ 响亮抛错且**不排队**', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), rebuildEnabled: false }))
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-08-28--S200--disabled')
    bindSession(session, md)

    await expect(
      queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' }),
    ).rejects.toThrow(/rebuild is disabled/)
    expect(pendingRebuildSnapshot().size).toBe(0) // 队列未被写入
    expect(session._calls).toHaveLength(0) // surface 零改动
  })

  it('会话定位失败（可能已关闭）⇒ 抛错说明是哪个 id，不静默', async () => {
    await expect(
      queueRebuild({ sessions: { get: () => undefined } } as never, { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 'gone-1' }),
    ).rejects.toThrow(/Unable to locate dsh session gone-1/)
  })

  it('无内存活跃信息 ⇒ 会话名**由目录名派生**；非 `S###` 目录 ⇒ 绑定行 sessionId=undefined（不编造 S 号）', async () => {
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-08-28--no-id-here')
    bindSession(session, md)
    const r = await queueRebuild(qctx(session), { root: dir, summary: '匿名轨迹', agentCwd: dir, dshSessionId: 's1' })

    expect(r.queued).toBe(true)
    expect(r.sessionMdPath).toBe(md)
    const bound = readLastBound(session)
    expect(bound?.action).toBe('rebuild')
    expect(bound?.sessionId).toBeUndefined() // 目录名不含 S### ⇒ 不编造
    expect(bound?.note).toBe('rebuild queued')
  })
})

// ── turn 钩子：入口守卫 ／ TTL ／ meter 三态 ─────────────────────────────────────

describe('rebuild-executor：turn-stopping 的守卫与 meter 三态', () => {
  it('payload 无 agent ⇒ 直接 return（不抛、不动队列）', async () => {
    const session = fakeSession([10, 11])
    await queueFor(session)
    const { fire } = hookCtx()
    expect(() => fire({})).not.toThrow()
    expect(pendingRebuildSnapshot().has('s1')).toBe(true) // 队列原样保留
    expect(session._calls).toHaveLength(0)
  })

  it('🔴 陈旧队列（超 10min TTL）⇒ 丢弃 ＋ 记 ttl-dropped ＋ **不 replace**', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T00:00:00+08:00'))
    const session = fakeSession([10, 11])
    await queueFor(session, { summary: 'ttl' })
    const { fire } = hookCtx()

    vi.setSystemTime(new Date('2026-09-25T00:20:00+08:00')) // +20min > TTL
    const before = readDiag() // 计数是进程级的 ⇒ 断言"增量"而不是绝对值（免用例顺序耦合）
    fire({ agent: fakeAgent('s1', session), turn: 1 })

    expect(session._calls).toHaveLength(0) // 绝不误清空
    expect(pendingRebuildSnapshot().has('s1')).toBe(false) // 队列已清（不留悬挂）
    const diag = readDiag()
    expect(diag.lastEvent).toBe('ttl-dropped')
    expect(diag.droppedCount).toBe(before.droppedCount + 1)
    expect(diag.detail).toContain('TTL')
  })

  it('meter 三态：无服务 ⇒ 退化（只 replace）／有 estimateMessage ⇒ **真走包装**（先 prune 定价）／有服务但无该方法 ⇒ 同样退化', async () => {
    const EVENTS = [
      undefined, undefined, undefined, undefined, undefined, // 0-4
      undefined, undefined, undefined, undefined, undefined, // 5-9
      undefined, // 10（node 0..10 无事件；node 11 才有被替换的消息）
      { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } } },
    ]
    // ① 无 tokenMeter
    const s1 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s1, { dirName: '2026-08-28--S201--meter-a' })
    hookCtx().fire({ agent: fakeAgent('s1', s1), turn: 1 })
    expect(s1._calls.map((c) => c.type)).toEqual(['user/message'])

    // ② 有 estimateMessage ⇒ 覆盖钩子里那个包装箭头（fstat-no）＋ shadow-price 真定价
    const s2 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s2, { dirName: '2026-08-28--S202--meter-b' })
    const estimate = vi.fn(() => 7)
    hookCtx({ tokenMeter: { estimateMessage: estimate } }).fire({ agent: fakeAgent('s1', s2), turn: 2 })
    expect(s2._calls.map((c) => c.type)).toEqual(['compaction/prune', 'user/message'])
    expect(estimate).toHaveBeenCalledTimes(1)
    expect((s2._calls[0]!.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(7)

    // ③ 有 tokenMeter 但 estimateMessage 不是函数 ⇒ 退化（不炸、不 append prune）
    const s3 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s3, { dirName: '2026-08-28--S203--meter-c' })
    hookCtx({ tokenMeter: { estimateMessage: 'nope' } }).fire({ agent: fakeAgent('s1', s3), turn: 3 })
    expect(s3._calls.map((c) => c.type)).toEqual(['user/message'])
  })
})

// ── surface 空 ／ 宿主拒绝 ／ 诊断写盘失败 ──────────────────────────────────────

describe('rebuild-executor：surface 与失败的诊断面', () => {
  it('surface 空 或**只剩系统提示节点** ⇒ 不 replace ＋ 记 empty-surface（两种形态）', async () => {
    // ① 完全空
    const empty = fakeSession([])
    await queueFor(empty, { dirName: '2026-08-28--S210--empty' })
    hookCtx().fire({ agent: fakeAgent('s1', empty), turn: 1 })
    expect(empty._calls).toHaveLength(0)
    expect(readDiag().lastEvent).toBe('empty-surface')

    // ② 只剩 node 0（系统提示，宿主保护 ⇒ 无历史可清）
    const onlySystem = fakeSession([10])
    await queueFor(onlySystem, { dirName: '2026-08-28--S211--onlysys' })
    hookCtx().fire({ agent: fakeAgent('s1', onlySystem), turn: 1 })
    expect(onlySystem._calls).toHaveLength(0)
    expect(readDiag().lastEvent).toBe('empty-surface')
  })

  it('🔴 宿主拒绝 replace（append 抛错）⇒ 记 failed ＋ warn ＋ **不打断 turn**；队列已清不留悬挂', async () => {
    const session = fakeSession([10, 11], { appendThrows: true })
    await queueFor(session, { dirName: '2026-08-28--S212--hostreject' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = readDiag() // 增量断言（计数进程级）
      expect(() => hookCtx().fire({ agent: fakeAgent('s1', session), turn: 1 })).not.toThrow()
      const diag = readDiag()
      expect(diag.lastEvent).toBe('failed')
      expect(diag.failedCount).toBe(before.failedCount + 1)
      expect(diag.detail).toContain('surface replace rejected')
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('container_trajectory rebuild failed')
      expect(pendingRebuildSnapshot().has('s1')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('诊断**写盘失败** ⇒ 吞掉且 **rebuild 主流程照跑**（先排队 → 再破坏 AGENT_SESSIONS 目录）', async () => {
    const session = fakeSession([10, 11])
    await queueFor(session, { dirName: '2026-08-28--S213--diagfail' })
    // 真实故障形态：把 AGENT_SESSIONS 从目录换成**同名文件** ⇒ writeRebuildDiag 的 mkdirSync 必抛
    rmSync(join(dir, 'AGENT_SESSIONS'), { recursive: true, force: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS'), 'not a directory')

    const agent = fakeAgent('s1', session)
    expect(() => hookCtx().fire({ agent, turn: 1 })).not.toThrow()
    expect(session._calls.map((c) => c.type)).toEqual(['user/message']) // replace 照做
    expect(agent._steers).toHaveLength(1) // 自动继续照发
  })
})

// ── 重建后重命名三态 ─────────────────────────────────────────────────────────

describe('rebuild-executor：重建后重命名（三态，均不阻断重建）', () => {
  it('sessionTitle 可用 ⇒ rename 收到 (session, S###-日期-概括)；不可用 ⇒ 跳过；抛错 ⇒ warn 不阻断', async () => {
    // ① 可用
    const s1 = fakeSession([10, 11])
    await queueFor(s1, { summary: '阶段概括', dirName: '2026-08-28--S200--rename-ok' })
    const rename = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    hookCtx({ sessionTitle: { rename } }).fire({ agent: fakeAgent('s1', s1), turn: 1 })
    expect(rename).toHaveBeenCalledTimes(1)
    const [sessArg, title] = rename.mock.calls[0] as [unknown, string]
    expect(sessArg).toBe(s1) // 传的是真实 session 对象（不是拷贝）
    expect(title).toContain('S200')
    expect(title).toContain('阶段概括')
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('rebuild 后会话重命名')
    log.mockRestore()

    // ② 服务缺失 ⇒ 跳过（warn）但重建已完成
    const s2 = fakeSession([10, 11])
    await queueFor(s2, { dirName: '2026-08-28--S200--rename-skip' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a2 = fakeAgent('s1', s2)
    hookCtx({ sessionTitle: {} }).fire({ agent: a2, turn: 1 })
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('重命名跳过')
    expect(s2._calls.map((c) => c.type)).toEqual(['user/message'])
    expect(a2._steers).toHaveLength(1)
    warn.mockRestore()

    // ③ rename 抛错 ⇒ warn「不阻断」＋ 重建与自动继续都照做
    const s3 = fakeSession([10, 11])
    await queueFor(s3, { dirName: '2026-08-28--S200--rename-throw' })
    const warn3 = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a3 = fakeAgent('s1', s3)
    hookCtx({ sessionTitle: { rename: () => { throw new Error('rename boom') } } }).fire({ agent: a3, turn: 1 })
    expect(warn3.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('重命名失败（不阻断）')
    expect(s3._calls.map((c) => c.type)).toEqual(['user/message'])
    expect(a3._steers).toHaveLength(1)
    warn3.mockRestore()
  })
})

// ── 诊断根回落（⚠️ 用 spy 钉住，绝不写进真仓库） ────────────────────────────────

describe('rebuild-executor：诊断根的回落', () => {
  it('agent 无 `header.cwd` ⇒ 诊断回落到 `process.cwd()`（spy 钉在临时目录 ⇒ 真仓库零污染）', async () => {
    altRoot = mkdtempSync(join(tmpdir(), 'hooks-rebuildexec-cwd-'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(altRoot)

    const session = fakeSession([10, 11])
    await queueFor(session, { dirName: '2026-08-28--S200--nocwd' })
    const agent = fakeAgent('s1', session, { withCwd: false })
    hookCtx().fire({ agent, turn: 1 })

    expect(cwd).toHaveBeenCalled()
    const diag = readDiag(altRoot) // 落在回落根，而不是 CCC 夹具根
    expect(diag.lastEvent).toBe('rebuilt')
    // ⚠️ 计数是**进程级**的（`diagState` 模块单例，源码 P3 已注明"不可跨重启累加比较"）
    // ⇒ 同一进程内多个用例会累加，故此处只能断言"≥1"，不能断言"恰好 1"（那是用例顺序耦合）
    expect(diag.rebuiltCount).toBeGreaterThanOrEqual(1)
  })
})
