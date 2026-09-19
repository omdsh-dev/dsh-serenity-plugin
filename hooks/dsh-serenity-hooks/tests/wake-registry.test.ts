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
import { buildWakeText, deliverWake, registerWakeScheduler, resolveWakeTarget, sendToTrajectory, wakeSchedulerState, __resetWakeSchedulerStateForTest } from '../src/wake-scheduler.js'
import { CRO_FILENAME } from '../src/cro.js'
import { __resetCroTurnsForTest } from '../src/cro-turns.js'
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

/**
 * 轮询等待（CRO 集成用例用）：CRO 阶段要**起子进程**，耗时不确定 ⇒ 固定 sleep 会 flaky。
 * @param pred 判据
 * @param ms 上限
 */
async function waitFor(pred: () => boolean, ms = 8_000): Promise<void> {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
}

/** 往轨迹目录里写一份 CRO 程序（`continuous-re-occurrence.ts` = 启用判据） */
function writeCro(dirName: string, source: string): void {
  writeFileSync(join(root, 'AGENT_SESSIONS', dirName, CRO_FILENAME), source, 'utf-8')
}

/** 一份"吐固定决策"的 CRO 程序（**纯 JS 写在 .ts 里**：多 runner 下都能跑，同 `cro.test.ts` 手法） */
function croProgram(decisionJson: string): string {
  return (
    "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{const o=JSON.parse(s);" +
    `const d=${decisionJson};d.reason=(d.reason||'')+' dir='+o.identity.dirName;` +
    'process.stdout.write(JSON.stringify(d))})'
  )
}

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

  it('newWakeId 形态：w-<当地到分钟>-<4 hex>（D67：UTC → 当地，2026-09-17）', () => {
    const ms = Date.parse('2026-09-13T12:34:56Z')
    const id = newWakeId(ms, () => 0.5)
    expect(id).toMatch(/^w-\d{8}-\d{4}-[0-9a-f]{4}$/)

    // 期望值**独立重推**（不经 `localIdStamp` —— 调它就是把断言写成自证）：由该时刻的当地钟面直接构造
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    const localStamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    expect(id).toBe(`w-${localStamp}-8000`)

    // 🔴 旧版本把期望值**硬编码成 UTC 戳**（`w-20260913-1234-…`）⇒ 本机 +08:00 下必红。
    //    改为"由当地钟面推"，既钉住"已从 UTC 改为当地"，又**不依赖机器时区**（UTC 机器上同样通过）；
    //    非 UTC 机器再补一条**负向断言**，钉死"不再是 UTC 戳"。
    if (d.getTimezoneOffset() !== 0) {
      const utcStamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
      expect(id).not.toContain(`-${utcStamp}-`)
    }
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
    // 🔴 v1.39.3（S142 §0t，2026-09-17 实测缺陷）：这一情形是**环境未就绪**，不是投递失败
    //    ⇒ 必须带 `notReady`，否则调用方（tick）会把它当失败写进条目 ——
    //    每次 `restart-web` 都给"到点条目"伪造一条"失败的投递"（假告警发生器）。
    expect(res.notReady).toBe(true)
    // 文案**不得再猜成因**：旧文写「（headless profile？）」，而真因**常常是重启窗口**
    // —— 假陈述把维护者引偏过一次（所有者 2026-09-17 就是被这条假失败引来的）。
    expect(res.detail).not.toContain('headless profile？')
    expect(res.detail).toContain('宿主尚未就绪')
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
 * 即时投递（`container_trajectory send-now`；2026-09-16 所有者裁决，**2026-09-17 由 `send-message` 更名**）。
 *
 * **钉住的不变量**：与 `send-later`（原 `wake-later`）**共用取用通路**（live 优先 → 冷载入），
 * 区别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）。
 * 设计稿 = `docs/trajectory-send-message-design.md`（v0.2 定稿）。
 */
describe('sendToTrajectory（即时投递：与 wake 共用取用通路）', () => {
  it('live 命中 ⇒ followup 收到**即时消息**正文（不是唤醒正文）', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const sent: string[] = []
    const fakeAgent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    const ctx = { agents: { get: (id: string) => (id === 'sess-live' ? fakeAgent : undefined) } }

    const res = await sendToTrajectory(ctx as never, root, DIR_NAME, '现在就做这件事', 'S142')
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('live(bound sess-live)')
    expect(sent).toHaveLength(1)
    // 正文要点：来自谁 / 是**即时消息** / 原样带上 message / 身份锚定到目标
    expect(sent[0]).toContain('[即时消息]')
    expect(sent[0]).toContain('S142')
    expect(sent[0]).toContain('现在就做这件事')
    expect(sent[0]).toContain(DIR_NAME)
    // 🔴 关键区分：**不得**把它说成"到点唤醒"（那是错的事实）。
    // ⚠️ 判据形态订正（本轮实测踩到）：**不能用 `not.toContain('到点')`** —— 本正文里那句
    //    "（**不是**到点唤醒）"自身就含"到点" ⇒ 该断言是**假阳性**，会把我方措辞当违规。
    //    ⇒ 改用**精确判别符**：唤醒正文的头部标识 `[trajectory 唤醒]`（`buildWakeText` 第一行）。
    expect(sent[0]).not.toContain('[trajectory 唤醒]')
    expect(sent[0]).not.toContain('登记于')
  })

  it('非 live ⇒ 走 sessionController 冷载入（**等效于直接 wake**，但不等 tick）', async () => {
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
    const res = await sendToTrajectory(ctx as never, root, 'S999', '给冷会话的一句话', 'S142')
    expect(res.ok).toBe(true)
    expect(asked).toBe('sess-cold')
    expect(res.detail).toContain('cold-resume(sess-cold)')
    expect(sent[0]).toContain('给冷会话的一句话')
  })

  it('冷会话 + sessionController 缺席 ⇒ 响亮报错（不静默、不误报成功）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('sessionController')
  })

  it('无绑定记录 ⇒ 报错说明需先 container_trajectory use', async () => {
    writeSessionDir()
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('.bindings.json')
  })

  it('目标未命中 ⇒ 报错', async () => {
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToTrajectory(ctx as never, root, 'S404', 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未命中')
  })

  it('followup 抛错 ⇒ ok:false 且留原因（不静默吞掉）', async () => {
    writeSessionDir()
    writeBinding('sess-boom')
    const ctx = {
      agents: {
        get: (id: string) => (id === 'sess-boom'
          ? { followup: () => { throw new Error('driver down') } }
          : undefined),
      },
    }
    const res = await sendToTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('投递失败')
    expect(res.detail).toContain('driver down')
  })

  it('🔴 **不落注册表**（所有者 2026-09-16 裁 (A)）—— 唤醒注册表保持"未来时刻表"单一语义', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const ctx = {
      agents: { get: (id: string) => (id === 'sess-live' ? { followup: () => {} } : undefined) },
    }
    const before = listWakes(root).entries.length
    const res = await sendToTrajectory(ctx as never, root, DIR_NAME, '不留痕的一句话', 'S142')
    expect(res.ok).toBe(true)
    expect(listWakes(root).entries.length).toBe(before)
  })
})

describe('🔴 回归钉：即时投递**不得**靠放宽 addWake 来实现（两者语义分界不许被抹平）', () => {
  it('addWake 仍然拒绝 at ≤ now（"时刻必须在未来"）', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    // 过去的绝对时刻
    expect(addWake(root, { target: DIR_NAME, at: '2026-09-16T11:00:00Z', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(false)
    // 恰好现在
    expect(addWake(root, { target: DIR_NAME, at: '2026-09-16T12:00:00Z', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(false)
    // 拒绝理由必须点名"未来"（不是含糊的解析失败）
    const r = addWake(root, { target: DIR_NAME, at: '2026-09-16T11:00:00Z', message: 'x', createdBy: 'S142', nowMs: now })
    expect(r.ok === false && r.error).toContain('未来')
    // 正控：真正未来的仍可登记（证明上面的 false 不是解析器坏了）
    expect(addWake(root, { target: DIR_NAME, at: '+1h', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(true)
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

  it('🔴 全局闸开 + **零 live 会话** → 仍武装（修复前此处永久不武装）', async () => {
    registerWakeScheduler(makeCtx() as never) // liveSessions = []
    expect(timer).not.toBeNull()
    const st0 = wakeSchedulerState()
    expect(st0.armed).toBe(true)
    expect(st0.armedAt).not.toBeNull()
    // v1.35（C2 块 C1）：CCC 枚举改**并集**（含持久来源），故"无 CCC 可扫"的判定下沉到
    // runWakeTick 内部 ⇒ 这次 tick **真执行了**（计 ticks），只是提前 return 并把原因留痕。
    // 语义澄清：`ticks` = "真执行过的 tick"，不是"真投递过的 tick"。
    await new Promise((r) => setTimeout(r, 20)) // runWakeTick 为 async（并集枚举含 await）
    const st = wakeSchedulerState()
    expect(st.ticks).toBe(1)
    expect(st.lastSkipReason).toContain('无已知 CCC 可扫')
  })

  it('live 会话出现后 tick 真执行并清空 skip 原因（末次 tick 状态）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    const ctx = makeCtx()
    registerWakeScheduler(ctx as never) // 启动即 tick 一次（此时无 live ⇒ skip，ticks=1）
    liveSessions = [{ id: 's1', header: { cwd: root } }]
    ;(timer as unknown as { fn: () => void }).fn()
    await new Promise((r) => setTimeout(r, 20))
    const st = wakeSchedulerState()
    // 两次 tick：启动那次（空转，留痕）+ 本次（有 CCC，清空 skip 原因）
    expect(st.ticks).toBe(2)
    expect(st.lastTickAt).not.toBeNull()
    expect(st.lastSkipReason).toBeNull()
  })

  it('🔴 到期条目被真投递 → 收到正文，且**投递后条目被清除**（owner 2026-09-19 裁「直接删」）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    // 把条目改成"已到期"（不改系统时钟）
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() })
    // 投递前：确实在表里（否则下面的"清除了"就没有对照）
    expect(listWakes(root).entries.map((e) => e.id)).toContain(added.entry.id)
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
    // 🔴 行为变更钉（§0Q 甲案）：终态条目**不再留在表里** ⇒ 注册表只保在办项（表不再只增）
    expect(listWakes(root).entries, '投递成功后该条应已被清除').toHaveLength(0)
  })

  it('🔴 超窗条目 → 置 missed 后**同样被清除**（终态一律不留行）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '过期活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    // 拨到**超出补跑窗口**（2h + 1m）
    updateWake(root, added.entry.id, { at: new Date(Date.now() - (WAKE_CATCH_UP_MS + 60_000)).toISOString() })
    // ⚠️ 必须让本 CCC **可被发现**（tick 只扫"已知 CCC"——来源是 live 会话/工作区）：
    //    否则 roots 为空 ⇒ 整个 tick 空转，本用例会假红（首跑即踩此坑）。
    const ctx = {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: () => undefined },
      get: () => undefined,
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(listWakes(root).entries, '超窗结案后该条应已被清除').toHaveLength(0)
  })

  it('🔴 启动窗口（宿主服务未就绪）⇒ 条目**不被记失败**：state/attempts/lastResult 全不动', async () => {
    // 复现 2026-09-17 21:09 的真实现场：`dsh web` 刚重启 ⇒ 时钟武装时**立刻跑一次 tick**，
    // 而那一拍早于懒服务 `sessionController` 就绪、也早于会话恢复。
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-cold')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() }) // 改成已到期
    const ctx = {
      // CCC 可被发现（另有 live 会话在同 CCC 里）——但**目标**会话没加载，且懒服务缺席：
      sessions: { list: () => [{ id: 'sess-other', header: { cwd: root } }] },
      agents: { get: () => undefined },
      get: () => undefined, // ← sessionController 缺席（启动窗口的实况）
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never) // 启动即 tick 一次
    await new Promise((r) => setTimeout(r, 30))
    const e = listWakes(root).entries[0]!
    expect(e.state).toBe('pending') // 仍待投（不是"投失败"）
    expect(e.attempts).toBe(0) // 🔴 不计次 —— 修复前这里会被加成 1（假失败）
    expect(e.lastResult).toBeNull() // 🔴 不留假陈述 —— 修复前会写入"sessionController 不可用"
    expect(e.deliveredAt).toBeNull()
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

/**
 * CRO 与调度器的**集成**（S142 §7.9，设计 §5/§6）——
 * 这里测的不是"CRO 逻辑对不对"（`cro.test.ts` 已测），而是**它与既有链路的关系**：
 *   · 🔴 设计 §5 的机械判据：**故意报错的 CRO 程序，不得影响既有投递**
 *   · 设计 §6.1：CRO 判定为真 ⇒ 走投递（真起子进程 + 真投递 → 收到 CRO 正文）
 *   · 设计 §6.3：**CRO 不写唤醒表**（判定为真也不给表增加/清除任何一行）
 *
 * ⚠️ 每个用例都必须让本 CCC **可被发现**（`sessions.list` 给 cwd = root），
 *    否则 `roots` 为空 ⇒ 整个 tick 空转，用例会**假红**（本仓已踩过此坑，见上文同款注释）。
 */
describe('🔴 CRO 与调度器集成（设计 §5 铁律 / §6.3 不落表）', () => {
  let disposers: Array<() => void>
  let timer: { fn: () => void } | null

  beforeEach(() => {
    disposers = []
    timer = null
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), wakeSchedulerEnabled: true }))
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {
      timer = null
    })
  })

  afterEach(() => {
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  /** 一个"CCC 可被发现 + 目标会话 live + 收集投递正文"的 ctx */
  function croCtx(sent: string[]): unknown {
    const agent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    return {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: (id: string) => (id === 'sess-live' ? agent : undefined) },
      get: () => undefined,
      on: () => undefined,
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  it('🔴 铁律：**故意报错**的 CRO 程序 ⇒ 既有投递链路一切正常（设计 §5 的机械判据）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, "throw new Error('cro boom')\n") // 🔴 半成品：跑起来就报错
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() }) // 改成已到期
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never) // 启动即 tick 一次
    await waitFor(() => sent.length > 0)
    // ① 既有链路**照常工作**：到点条目仍被投递
    expect(sent, 'CRO 报错绝不能让到点唤醒投不出去').toHaveLength(1)
    expect(sent[0]).toContain('到点干活')
    // ② 条目照常结案清除（既有语义不受影响）
    expect(listWakes(root).entries).toHaveLength(0)
    // ③ CRO 的失败**被看见**（不是静默吞掉）——留痕在 tick 日志里
    const log = (wakeSchedulerState().lastTickLog ?? []).join('\n')
    expect(log).toContain('CRO')
    expect(log).toContain('跳过本轮')
  }, 20_000)

  it('🟢 CRO 判定为真 ⇒ 真起子进程并投递 CRO 正文（快照确实经 stdin 到达程序）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    // reason 里回填 `dir=o.identity.dirName` ⇒ 若 stdin 没送到，这一条就取不到值
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"你的 SESSION.md 已很大，请先压缩再继续。"}'))
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => sent.length > 0)
    expect(sent, 'CRO 判定为真应投递一条').toHaveLength(1)
    expect(sent[0]).toContain('CRO 唤起') // 正文**自我表明**来源（不是唤醒正文、不是即时消息）
    expect(sent[0]).toContain('你的 SESSION.md 已很大') // 提示词透传
    expect(sent[0]).toContain(`dir=${DIR_NAME}`) // 🔴 快照经 stdin 真到达了程序
    expect(sent[0]).not.toContain('[trajectory 唤醒]') // 不得冒充"到点唤醒"
  }, 20_000)

  it('🔴 CRO **不写唤醒表**（设计 §6.3）：判定为真 ⇒ 投递，但表里一行都不增不减', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"该干活了"}'))
    // 一条**未到期**的在办条目：它是"表内容"的对照物（既不该被 CRO 清掉，也不该被 CRO 补写）
    const keep = addWake(root, { target: DIR_NAME, at: '+5m', message: '稍后再干', createdBy: 'S142', nowMs: Date.now() })
    expect(keep.ok).toBe(true)
    if (!keep.ok) return
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => sent.length > 0)
    expect(sent).toHaveLength(1) // CRO 的投递发生了
    const entries = listWakes(root).entries
    expect(entries.map((e) => e.id)).toEqual([keep.entry.id]) // 表内容**逐字未变**
    expect(entries[0]!.state).toBe('pending')
    expect(entries[0]!.attempts).toBe(0) // 也没被 CRO 误记为"投过"
  }, 20_000)

  it('不唤起（wake:false）⇒ 不投递任何消息（**常态是不打扰**）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":false,"reason":"天还没亮"}'))
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 8_000)
    expect(sent).toHaveLength(0)
    // 汇总行仍如实报告"评估了 1 条、唤起 0"
    const log = (wakeSchedulerState().lastTickLog ?? []).join('\n')
    expect(log).toContain('CRO 评估 1 条（唤起 0')
  }, 20_000)
})
