/**
 * wake-registry.test.ts — trajectory 唤醒注册表 + 投递路径（D58，S142 2026-09-13）
 *
 * 覆盖（设计文档 §11 验收 2）：
 *  - 注册表纯逻辑：时刻解析 / 登记校验 / 到期切分（due vs expired）/ 状态推进 / 移除 / 排序
 *  - 目标定位：S### → AGENT_SESSIONS 目录 + SESSION.md
 *  - 投递路径：live 命中（`.bindings.json` 反查 + `agents.get`）→ `followup` 收到唤醒正文；
 *    冷会话且 `sessionController` 缺席 → **响亮报错**（不得静默）；
 *    冷会话且有 `sessionController` → `resolveAgent` 载入后投递（P-1 的冷唤醒正门）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addWake,
  listWakes,
  loadWakeRegistry,
  newWakeId,
  parseWakeAt,
  removeWake,
  splitDueWakes,
  updateWake,
  wakeRegistryPath,
  WAKE_CATCH_UP_MS,
  type WakeEntry,
} from '../src/wake-registry.js'
import { buildWakeText, deliverWake, registerWakeScheduler, resolveWakeTarget, wakeSchedulerState, __resetWakeSchedulerStateForTest } from '../src/wake-scheduler.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

const HOUR = 3_600_000
const DIR_NAME = '2026-09-13--S999--wake-target--auto'

let root: string

function writeSessionDir(dirName = DIR_NAME): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  return dir
}

function writeBinding(sessionId: string, dirName = DIR_NAME, at = Date.now()): void {
  const path = join(root, 'AGENT_SESSIONS', '.bindings.json')
  let sessions: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { sessions?: Record<string, unknown> }
    sessions = parsed.sessions ?? {}
  } catch {
    sessions = {}
  }
  sessions[sessionId] = { dirName, mdPath: join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'), action: 'activate', at }
  writeFileSync(path, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsp-wake-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseWakeAt（RFC3339 或 +Nm/+Nh/+Nd）', () => {
  it('相对写法按单位换算', () => {
    const now = 1_700_000_000_000
    expect(parseWakeAt('+30m', now)).toEqual({ ok: true, ms: now + 30 * 60_000 })
    expect(parseWakeAt('+2h', now)).toEqual({ ok: true, ms: now + 2 * HOUR })
    expect(parseWakeAt('+1d', now)).toEqual({ ok: true, ms: now + 24 * HOUR })
  })

  it('RFC3339 带时区偏移可解析', () => {
    const r = parseWakeAt('2026-09-14T09:00:00+08:00', 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(new Date(r.ms).toISOString()).toBe('2026-09-14T01:00:00.000Z')
  })

  it('空串/乱串 → 稳定错误（不抛）', () => {
    expect(parseWakeAt('  ', 0).ok).toBe(false)
    expect(parseWakeAt('明天早上', 0).ok).toBe(false)
  })
})

describe('addWake（登记校验 + 落盘）', () => {
  it('正常登记：写文件 + state=pending + id 可读', () => {
    const now = Date.now()
    const res = addWake(root, { target: DIR_NAME, at: '+1h', message: '继续 §30', createdBy: 'S142', nowMs: now })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.state).toBe('pending')
    expect(res.entry.target).toBe(DIR_NAME)
    expect(res.entry.createdBy).toBe('S142')
    const onDisk = loadWakeRegistry(root)
    expect(onDisk.error).toBeNull()
    expect(onDisk.registry.entries).toHaveLength(1)
    expect(wakeRegistryPath(root)).toContain('wake-registry.json')
  })

  it('target / message 为空 → 拒绝', () => {
    expect(addWake(root, { target: '', at: '+1h', message: 'x', createdBy: '', nowMs: Date.now() }).ok).toBe(false)
    expect(addWake(root, { target: DIR_NAME, at: '+1h', message: '  ', createdBy: '', nowMs: Date.now() }).ok).toBe(false)
  })

  it('过去的时刻 → 拒绝（唤醒只允许可预期的未来）', () => {
    const now = Date.now()
    const res = addWake(root, { target: DIR_NAME, at: new Date(now - HOUR).toISOString(), message: 'x', createdBy: '', nowMs: now })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('未来')
  })
})

describe('splitDueWakes（到期切分：due vs expired）', () => {
  const entry = (over: Partial<WakeEntry>): WakeEntry => ({
    id: 'w-x', target: DIR_NAME, at: new Date(0).toISOString(), message: 'm', state: 'pending',
    createdBy: '', createdAt: new Date(0).toISOString(), attempts: 0, lastResult: null, deliveredAt: null,
    ...over,
  })

  it('未到点 → 都不出', () => {
    const now = 1000
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now + HOUR).toISOString() })] }, now)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(0)
  })

  it('到点且在补跑窗口内 → due', () => {
    const now = 10 * HOUR
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now - HOUR).toISOString() })] }, now, WAKE_CATCH_UP_MS)
    expect(r.due).toHaveLength(1)
    expect(r.expired).toHaveLength(0)
  })

  it('迟到超过补跑窗口 → expired（不投递，置 missed）', () => {
    const now = 10 * HOUR
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now - 3 * HOUR).toISOString() })] }, now, WAKE_CATCH_UP_MS)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(1)
  })

  it('非 pending（已投递/已错过）不参与', () => {
    const now = 10 * HOUR
    const at = new Date(now - HOUR).toISOString()
    const r = splitDueWakes({ version: 1, entries: [entry({ at, state: 'delivered' }), entry({ at, state: 'missed' })] }, now)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(0)
  })
})

describe('updateWake / removeWake / listWakes', () => {
  it('状态推进 + 移除 + 按 at 升序', () => {
    const now = Date.now()
    const a = addWake(root, { target: DIR_NAME, at: '+2h', message: 'A', createdBy: 'S1', nowMs: now })
    const b = addWake(root, { target: DIR_NAME, at: '+1h', message: 'B', createdBy: 'S2', nowMs: now })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(listWakes(root).entries.map((e) => e.message)).toEqual(['B', 'A'])

    expect(updateWake(root, a.entry.id, { state: 'delivered', attempts: 1, lastResult: '已投递', deliveredAt: new Date().toISOString() }).ok).toBe(true)
    const after = listWakes(root, { pendingOnly: true }).entries
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(b.entry.id)

    expect(removeWake(root, b.entry.id).ok).toBe(true)
    expect(removeWake(root, 'w-none').ok).toBe(false)
    expect(listWakes(root).entries).toHaveLength(1)
  })

  it('newWakeId 形态：w-<UTC 到分钟>-<4 hex>', () => {
    expect(newWakeId(Date.parse('2026-09-13T12:34:56Z'), () => 0.5)).toMatch(/^w-20260913-1234-[0-9a-f]{4}$/)
  })
})

describe('resolveWakeTarget（S### → 目录）', () => {
  it('按 S### 与完整目录名都能命中；无 SESSION.md → null', () => {
    writeSessionDir()
    expect(resolveWakeTarget(root, 'S999')?.dirName).toBe(DIR_NAME)
    expect(resolveWakeTarget(root, DIR_NAME)?.dirName).toBe(DIR_NAME)
    expect(resolveWakeTarget(root, 'S404')).toBeNull()
  })
})

describe('deliverWake（live 优先 → 冷唤醒正门）', () => {
  const makeEntry = (): WakeEntry => ({
    id: 'w-1', target: DIR_NAME, at: new Date().toISOString(), message: '继续 §30 实现',
    state: 'pending', createdBy: 'S142', createdAt: new Date().toISOString(),
    attempts: 0, lastResult: null, deliveredAt: null,
  })

  it('live 命中：`.bindings.json` 反查会话 id → agents.get → followup 收到唤醒正文', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const sent: string[] = []
    const fakeAgent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    const ctx = { agents: { get: (id: string) => (id === 'sess-live' ? fakeAgent : undefined) } }

    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('live(bound sess-live)')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('继续 §30 实现')
    expect(sent[0]).toContain(DIR_NAME)
  })

  it('冷会话 + sessionController 缺席 → 响亮报错（不静默、不误报成功）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('sessionController')
  })

  it('冷会话 + sessionController 可用 → resolveAgent 载入后投递（P-1 冷唤醒路径）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const sent: string[] = []
    const resumed = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    let asked: string | null = null
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? { resolveAgent: async (id: string) => { asked = id; return { agent: resumed } } }
        : undefined),
    }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(true)
    expect(asked).toBe('sess-cold')
    expect(res.detail).toContain('cold-resume(sess-cold)')
    expect(sent[0]).toContain('继续 §30 实现')
  })

  it('无绑定记录 → 报错说明需先 container_trajectory use（目标轨迹无载体）', async () => {
    writeSessionDir()
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('.bindings.json')
  })

  it('目标未命中 → 报错', async () => {
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, { ...makeEntry(), target: 'S404' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未命中')
  })
})

describe('buildWakeText（投递正文：身份锚定 + 唤醒信息 + 任务）', () => {
  it('含 target 目录、SESSION.md 路径、message 与发起者', () => {
    const entry: WakeEntry = {
      id: 'w-1', target: DIR_NAME, at: 'x', message: '做 A', state: 'pending', createdBy: 'S142',
      createdAt: 'y', attempts: 0, lastResult: null, deliveredAt: null,
    }
    const text = buildWakeText(entry, { dirName: DIR_NAME, mdPath: '/x/SESSION.md' })
    expect(text).toContain(DIR_NAME)
    expect(text).toContain('/x/SESSION.md')
    expect(text).toContain('做 A')
    expect(text).toContain('S142')
  })
})

/**
 * 时钟武装门（**F 段缺陷回归钉**，2026-09-14）。
 *
 * 缺陷（实测）：CCC 根只能从 live 会话反推，而宿主刚重启时 live 会话必为空；
 * 旧实现把"有 live CCC"当**武装前置条件** ⇒ 启动瞬间落空即**永久不武装**
 * （`session/created` 只覆盖"新建会话"，不覆盖"浏览器恢复旧会话"）。
 * 实测证据：2026-09-14T16:30Z 重启后零 tick 达 6.6h，注册表条目超窗仍 `pending`。
 * ⇒ 修复：**全局闸开即武装**；"有无 live CCC"降级为 tick 内的廉价判定。
 */
describe('registerWakeScheduler（时钟武装门 + 进程态可观测）', () => {
  let listeners: Record<string, Array<() => void>>
  let disposers: Array<() => void>
  let timer: { fn: () => void } | null
  let liveSessions: unknown[]

  beforeEach(() => {
    listeners = {}
    disposers = []
    timer = null
    liveSessions = []
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), wakeSchedulerEnabled: true }))
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => { timer = null })
  })

  afterEach(() => {
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  function makeCtx(): unknown {
    return {
      sessions: { list: () => liveSessions },
      agents: { get: () => undefined },
      get: () => undefined,
      on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) },
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  it('唤醒调度器闸显式关 → 不武装（零资源占用语义保留），且进程态如实报告 enabled=false', () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), wakeSchedulerEnabled: false }))
    registerWakeScheduler(makeCtx() as never)
    expect(timer).toBeNull()
    const st = wakeSchedulerState()
    expect(st.armed).toBe(false)
    expect(st.enabled).toBe(false)
  })

  it('🔴 解耦回归钉（用户 2026-09-15 裁决 S-1）：关掉周期自唤醒 **不**关掉唤醒调度器', () => {
    // 旧实现（v1.33）：`trajectoryEnabled === true || autopilotEnabled === true` ⇒ 关 autopilot 连带关本调度器
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotEnabled: false, autopilotWakeEnabled: false }))
    registerWakeScheduler(makeCtx() as never)
    expect(timer).not.toBeNull() // 仍武装
    expect(wakeSchedulerState().enabled).toBe(true) // 缺省开
  })

  it('🔴 解耦回归钉之二：旧键 autopilotEnabled=true 也 **不**是本闸的依据（缺省即开）', () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotEnabled: true }))
    registerWakeScheduler(makeCtx() as never)
    expect(timer).not.toBeNull()
    expect(wakeSchedulerState().enabled).toBe(true)
  })

  it('缺省（未设任何键）→ 默认开（条目全由显式登记，不需要“默认关”保护）', () => {
    __setSimpleSourceForTest(() => defaultSimpleSettings())
    registerWakeScheduler(makeCtx() as never)
    expect(timer).not.toBeNull()
    expect(wakeSchedulerState().enabled).toBe(true)
  })

  it('🔴 全局闸开 + **零 live 会话** → 仍武装（修复前此处永久不武装）', () => {
    registerWakeScheduler(makeCtx() as never) // liveSessions = []
    expect(timer).not.toBeNull()
    const st = wakeSchedulerState()
    expect(st.armed).toBe(true)
    expect(st.armedAt).not.toBeNull()
    // 零 live CCC ⇒ 启动时那次 tick 被跳过，并**留痕原因**（可观测，不静默）
    expect(st.ticks).toBe(0)
    expect(st.lastSkipReason).toContain('无 live 会话')
  })

  it('live 会话出现后 tick 真执行（ticks / lastTickAt 推进，skip 原因清空）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    const ctx = makeCtx()
    registerWakeScheduler(ctx as never)
    liveSessions = [{ id: 's1', header: { cwd: root } }]
    ;(timer as unknown as { fn: () => void }).fn()
    await new Promise((r) => setTimeout(r, 20))
    const st = wakeSchedulerState()
    expect(st.ticks).toBe(1)
    expect(st.lastTickAt).not.toBeNull()
    expect(st.lastSkipReason).toBeNull()
  })

  it('到期条目被真投递（live 命中 → followup 收到正文；条目推进为 delivered）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    // 把条目改成"已到期"（不改系统时钟）
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() })
    const sent: string[] = []
    const ctx = {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: (id: string) => (id === 'sess-live' ? { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } } : undefined) },
      get: () => undefined,
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never) // 启动即 tick 一次
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('到点干活')
    expect(listWakes(root).entries[0]!.state).toBe('delivered')
    expect(listWakes(root).entries[0]!.lastResult).toContain('live(bound sess-live)')
  })

  it('卸载（disposer）→ 时钟停止且进程态复位（不留"看着还在跑"的假象）', () => {
    registerWakeScheduler(makeCtx() as never)
    expect(wakeSchedulerState().armed).toBe(true)
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    expect(timer).toBeNull()
    expect(wakeSchedulerState().armed).toBe(false)
    expect(wakeSchedulerState().armedAt).toBeNull()
  })
})
