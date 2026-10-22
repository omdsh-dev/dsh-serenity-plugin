/**
 * tests/trajectory/interrupted.test.ts — 「以 interrupted 结尾」的会话发现
 *
 * 钉四件事（每条都是真日志形态，不用替身）：
 * ① **只有末条 = end-seed 且其前 turn/end 是 interrupted** 才命中；
 * ② **"曾经中断过"不算** —— 后面已有新事件的会话必须**不命中**（这是最危险的误报面）；
 * ③ **多帧 zstd 能正确回扫**（DSH 日志就是多帧追加；只解第一帧会漏）；
 * ④ **回看窗口**真的过滤（窗口外的不扫，`scanned` 不涨）。
 *
 * 🔴 ③ 是本文件的核心：宿主按帧追加写，单会话实测 2.4 万帧。若实现只解第一帧，
 * 所有用例都会"通过"（因为夹具小），但真机上永远读不到末事件 —— 正是那种
 * "跑绿也照样炸"的形态。故夹具**必须多帧**。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as nodeZlib from 'node:zlib'

import {
  detectInterruptedEnd,
  projectDirNameForCwd,
  scanInterruptedSessions,
} from '../../src/trajectory/interrupted.js'

const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined = (
  nodeZlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }
).zstdCompressSync

let dir: string

/** 把一组事件写成 DSH 形态：**每帧一个事件 + 换行**（真机就是多帧追加） */
function writeSession(sessionId: string, events: Array<Record<string, unknown>>): string {
  const sessionDir = join(dir, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  if (zstdCompressSync === undefined) throw new Error('本机 Node 无 zstdCompressSync，无法构造夹具')
  const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return sessionDir
}

/** 一次"正常完成"的轮次 */
function turnEvents(turn: number, kind: string): Array<Record<string, unknown>> {
  return [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn } },
    { type: 'step/start', seq: 2, time: 1001, data: { turn, step: 1 } },
    { type: 'turn/end', seq: 3, time: 1002, data: { turn, reason: { kind } } },
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interrupted-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('detectInterruptedEnd（纯判定）', () => {
  it('末条 end-seed + 其前 turn/end=interrupted ⇒ 命中', () => {
    const events = [
      ...turnEvents(7, 'interrupted'),
      { type: 'step/end', data: { turn: 7, step: 1 } },
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toEqual({ turn: 7, pendingTools: [] })
  })

  it('🔴 末条 end-seed 但其前 turn/end=completed ⇒ 不命中（正常结束）', () => {
    const events = [
      ...turnEvents(7, 'completed'),
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('🔴 曾经 interrupted 但之后又有新事件 ⇒ 不命中（已恢复，不得当待续）', () => {
    const events = [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
      { type: 'turn/start', data: { turn: 6 } },
      { type: 'user/message', data: { content: 'later work' } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('末条不是 end-seed（会话仍在写）⇒ 不命中', () => {
    const events = [{ type: 'turn/start', data: { turn: 9 } }]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('空事件 ⇒ 不命中（不抛错）', () => {
    expect(detectInterruptedEnd([])).toBeNull()
  })

  it('报出"有 call 无 result"的工具名（副作用未知清单）', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 3 } },
      { type: 'tool/call', data: { turn: 3, callId: 'c1', name: 'edit' } },
      { type: 'tool/result', data: { turn: 3, callId: 'c1' } },
      { type: 'tool/call', data: { turn: 3, callId: 'c2', name: 'im-bridge' } },
      { type: 'turn/end', time: 2, data: { turn: 3, reason: { kind: 'interrupted' } } },
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)?.pendingTools).toEqual(['im-bridge'])
  })
})

describe('scanInterruptedSessions（真日志 + 多帧）', () => {
  it('🔴 多帧 zstd 里能读到末事件（只解第一帧的实现会在这里红）', () => {
    writeSession('session-ok', [
      ...turnEvents(1, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-ok'])
    expect(r.sessions[0]?.turn).toBe(1)
  })

  it('完成的不命中，进 skipped 而不是 sessions', () => {
    writeSession('session-done', [
      ...turnEvents(2, 'completed'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions).toEqual([])
    expect(r.scanned).toBe(1)
    expect(r.skipped).toBe(1)
  })

  it('无日志文件的目录被忽略（不算 scanned）', () => {
    mkdirSync(join(dir, 'empty-dir'), { recursive: true })
    const r = scanInterruptedSessions(dir)
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  it('🔴 回看窗口生效：窗口外的会话不被检查', () => {
    const sessionDir = writeSession('session-old', [
      ...turnEvents(4, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    utimesSync(logPath, longAgo, longAgo)

    const r = scanInterruptedSessions(dir, { lookbackMs: 8 * 3600 * 1000 })
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  it('liveIds 的会话被跳过（正在跑的不算待续）', () => {
    writeSession('session-live', [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir, { liveIds: new Set(['session-live']) })
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  it('不存在的根目录 ⇒ 空结果（非错误）', () => {
    const r = scanInterruptedSessions(join(dir, 'does-not-exist'))
    expect(r.sessions).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('多条命中按时间倒序（最新在前）', () => {
    writeSession('session-a', [
      ...turnEvents(1, 'interrupted'),
      { type: 'session/end-seed', time: 5_000, data: {} },
    ])
    writeSession('session-b', [
      ...turnEvents(2, 'interrupted'),
      { type: 'session/end-seed', time: 9_000, data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-b', 'session-a'])
  })
})

describe('projectDirNameForCwd（宿主目录名规则）', () => {
  // ⚠️ 用中性路径做夹具：真实家目录路径会被 privacy-scan 拦下（D145 —— 写进 tests/ 的
  //    注释与字面量**同样过隐私门**）。此处只验"规则"，不验"某个具体机器"。
  it('绝对路径 → --a-b-c-- 形态', () => {
    expect(projectDirNameForCwd('/srv/example/workspace')).toBe('--srv-example-workspace--')
  })

  it('尾部斜杠被忽略（两种写法得到同一个目录名）', () => {
    expect(projectDirNameForCwd('/srv/example/workspace/')).toBe('--srv-example-workspace--')
  })

  it('单层路径也能正确成型', () => {
    expect(projectDirNameForCwd('/workspace')).toBe('--workspace--')
  })
})
