import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  UNATTENDED_BLOCKED_FLOOR,
  UNATTENDED_IDENTITY_LINE,
  UNATTENDED_LOG_FILENAME,
  UNATTENDED_MAX_ROUNDS,
  UNATTENDED_MAX_WALL_MS,
  UNATTENDED_OUTBOUND_KEEP,
  UNATTENDED_PROXY_MARK,
  __resetUnattendedForTest,
  activeProxyRoundTotal,
  appendUnattendedLog,
  buildFalseNotifyRebuke,
  buildProxyMessage,
  claimsUserNotification,
  clearProxyRun,
  clearUserTurn,
  decideUnattendedAction,
  doneToken,
  getProxyRun,
  hasDoneToken,
  hasOutboundSendSince,
  isProxyExcludedSessionId,
  isUserTurn,
  loadUnattendedLog,
  newNonce,
  noteOutboundSend,
  noteUserTurn,
  parseDoneNonces,
  pruneUnattendedLogEntries,
  proxyRunSessionIds,
  setProxyRun,
  unattendedLogPath,
  type UnattendedFacts,
} from '../src/unattended-ops.js'

/**
 * unattended-ops 镜像测试（S142 **D77**，2026-09-23）。
 *
 * 覆盖：验证码（生成/解析/只认本轮）｜四选一消息装配｜**判定矩阵**（闸/空间/会话资格/单一续驱者/
 * 合法收束/假完成/两道上限）｜运行态表（含清理）｜出站发送账本（设计 §7 可核验性）｜每轨迹流水。
 */

let dir = ''

beforeEach(() => {
  __resetUnattendedForTest()
  dir = mkdtempSync(join(tmpdir(), 'unattended-ops-'))
})

afterEach(() => {
  __resetUnattendedForTest()
  rmSync(dir, { recursive: true, force: true })
})

/** 判定输入底座（一条"该注入第一轮"的事实） */
function facts(over: Partial<UnattendedFacts> = {}): UnattendedFacts {
  return {
    enabled: true,
    root: '/ccc',
    isMainSession: true,
    sessionIdExcluded: false,
    userInitiated: false,
    hasCroProgram: false,
    run: null,
    nowMs: 1_000_000,
    doneNonce: null,
    claimsNotify: false,
    outboundSeen: false,
    ...over,
  }
}

describe('unattended: 验证码（nonce）', () => {
  it('每枚 16 位 hex；两次生成不相同（禁用短码 ⇒ 不可能被"复述指令"命中）', () => {
    const a = newNonce()
    const b = newNonce()
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })

  it('包装形态固定：[[UNATTENDED-DONE:<hex>]]', () => {
    expect(doneToken('abcdef0123456789')).toBe('[[UNATTENDED-DONE:abcdef0123456789]]')
  })

  it('解析：独占一行的码可被取出；大小写归一；重复只留一次', () => {
    const text = `做完了。\n[[UNATTENDED-DONE:ABCDEF0123456789]]\n又写了一遍 [[UNATTENDED-DONE:abcdef0123456789]]`
    expect(parseDoneNonces(text)).toEqual(['abcdef0123456789'])
  })

  it('解析：不是合法 hex（长度 <8 / 非法字符）⇒ 取不到（只认本轮那枚，手抄歪了就是不认）', () => {
    expect(parseDoneNonces('[[UNATTENDED-DONE:abc]]')).toEqual([])
    expect(parseDoneNonces('[[UNATTENDED-DONE:zzzzzzzzzzzzzzzz]]')).toEqual([])
    expect(parseDoneNonces('')).toEqual([])
  })

  it('hasDoneToken：只认当前轮那枚（旧码在文本里也不算数）', () => {
    const cur = '1111111111111111'
    const old = '2222222222222222'
    expect(hasDoneToken(`[[UNATTENDED-DONE:${cur}]]`, cur)).toBe(true)
    expect(hasDoneToken(`[[UNATTENDED-DONE:${old}]]`, cur)).toBe(false)
    expect(hasDoneToken('没有码', cur)).toBe(false)
    expect(hasDoneToken('x', '')).toBe(false)
  })

  it('全局正则的 lastIndex 是共享状态 ⇒ 连续调用不得漏判（同一段文本连解两次同结果）', () => {
    const text = '[[UNATTENDED-DONE:0123456789abcdef]]'
    expect(parseDoneNonces(text)).toEqual(parseDoneNonces(text))
  })
})

describe('unattended: 结构化消息（四选一）', () => {
  it('注入消息：首行标记 + round + nonce；**首句自报身份与权限边界**；四条齐全；通用下限在文内', () => {
    const msg = buildProxyMessage({ round: 2, maxRounds: 15, nonce: 'deadbeefdeadbeef' })
    expect(msg).toContain(UNATTENDED_PROXY_MARK)
    expect(msg).toContain('round=2/15')
    expect(msg).toContain('nonce=deadbeefdeadbeef')
    expect(msg).toContain(UNATTENDED_IDENTITY_LINE)
    for (const k of ['A)', 'B)', 'C)', 'D)']) expect(msg).toContain(k)
    for (const item of UNATTENDED_BLOCKED_FLOOR) expect(msg).toContain(item)
    expect(msg).toContain(doneToken('deadbeefdeadbeef'))
    expect(msg).toMatch(/旧码一律作废/)
    expect(msg).toMatch(/禁止/)
  })

  it('假完成打回：说明"码对但查不到发送记录 ⇒ 不算合法收束"，且**带新码**（是再来一轮，不是放过）', () => {
    const msg = buildFalseNotifyRebuke({ round: 3, maxRounds: 15, nonce: '0011223344556677' })
    expect(msg).toContain('round=3/15')
    expect(msg).toMatch(/查不到任何发送记录/)
    expect(msg).toContain(doneToken('0011223344556677'))
    expect(msg).toContain('C)')
  })

  it('不可代批清单可被覆盖（结构归 ACC、内容归 CCC）', () => {
    const msg = buildProxyMessage({ round: 1, maxRounds: 15, nonce: 'a'.repeat(16), blocked: ['本 CCC 专属红线'] })
    expect(msg).toContain('本 CCC 专属红线')
    expect(msg).not.toContain('发布 / 发版')
  })

  it('claimsUserNotification：中文/英文声称命中；纯工作汇报不命中（启发式，宁严勿放过）', () => {
    expect(claimsUserNotification('我已经发送邮件告知用户了')).toBe(true)
    expect(claimsUserNotification('已通知用户，等待回复')).toBe(true)
    expect(claimsUserNotification('I have notified the user about the failure')).toBe(true)
    expect(claimsUserNotification('我把三处引用面都改完了，门禁全绿')).toBe(false)
    expect(claimsUserNotification('')).toBe(false)
  })
})

describe('unattended: 会话资格（外部面/桥写死不许开）', () => {
  it('skiff-（含微信桥会话）/ acp- / handyman- ⇒ 排除；rebuild- 与普通会话**不排除**', () => {
    expect(isProxyExcludedSessionId('skiff-weixin-abc')).toBe(true)
    expect(isProxyExcludedSessionId('skiff-qa')).toBe(true)
    expect(isProxyExcludedSessionId('acp-1234')).toBe(true)
    expect(isProxyExcludedSessionId('handyman-worker-1')).toBe(true)
    expect(isProxyExcludedSessionId('rebuild-abc')).toBe(false)
    expect(isProxyExcludedSessionId('dsh-main-1')).toBe(false)
    expect(isProxyExcludedSessionId('')).toBe(true)
  })
})

describe('unattended: 判定矩阵（decideUnattendedAction）', () => {
  it('闸/空间/会话资格四道前置门：各给出**稳定理由码**', () => {
    expect(decideUnattendedAction(facts({ enabled: false }))).toEqual({ action: 'skip', reason: 'mode-off', round: 0 })
    expect(decideUnattendedAction(facts({ root: null }))).toEqual({ action: 'skip', reason: 'not-in-ccc', round: 0 })
    expect(decideUnattendedAction(facts({ isMainSession: false }))).toEqual({ action: 'skip', reason: 'not-main-session', round: 0 })
    expect(decideUnattendedAction(facts({ sessionIdExcluded: true }))).toEqual({ action: 'skip', reason: 'excluded-session', round: 0 })
  })

  it('单一续驱者：**用户刚发起** ⇒ 不代理（人在场）；**该轨迹有 CRO 程序** ⇒ 不代理（窄口径唯一排除项）', () => {
    expect(decideUnattendedAction(facts({ userInitiated: true }))).toEqual({ action: 'skip', reason: 'user-initiated', round: 0 })
    expect(decideUnattendedAction(facts({ hasCroProgram: true }))).toEqual({ action: 'skip', reason: 'cro-programmed', round: 0 })
  })

  it('首次停下（无代理段）⇒ 注入第 1 轮', () => {
    expect(decideUnattendedAction(facts())).toEqual({ action: 'inject', reason: 'first-stop', round: 1 })
  })

  it('在代理中、未回码 ⇒ 注入下一轮（新码覆盖旧的）', () => {
    const run = { round: 3, nonce: 'aa'.repeat(8), startedAt: 1_000_000 }
    expect(decideUnattendedAction(facts({ run }))).toEqual({ action: 'inject', reason: 'no-legal-closure', round: 4 })
  })

  it('回**当前轮**那枚码 ⇒ 放过；回**旧码** ⇒ 不算（reason=stale-code）', () => {
    const nonce = 'aa'.repeat(8)
    const run = { round: 2, nonce, startedAt: 1_000_000 }
    expect(decideUnattendedAction(facts({ run, doneNonce: nonce }))).toEqual({ action: 'accept', reason: 'done-code', round: 2 })
    expect(decideUnattendedAction(facts({ run, doneNonce: 'bb'.repeat(8) }))).toEqual({
      action: 'inject',
      reason: 'stale-code',
      round: 3,
    })
  })

  it('🔴 合法收束**优先于轮上限**：最后一轮交的码必须算数（否则永远收不了尾）', () => {
    const nonce = 'cc'.repeat(8)
    const run = { round: UNATTENDED_MAX_ROUNDS, nonce, startedAt: 1_000_000 }
    expect(decideUnattendedAction(facts({ run, doneNonce: nonce })).action).toBe('accept')
    // 同一轮但**没交码** ⇒ 撞上限停下
    expect(decideUnattendedAction(facts({ run }))).toEqual({ action: 'cap', reason: 'round-cap', round: UNATTENDED_MAX_ROUNDS })
  })

  it('🔴 假完成：交了码但**声称已通知用户**、而本轮**无发送记录** ⇒ 不放过，走下一轮（false-notify）', () => {
    const nonce = 'dd'.repeat(8)
    const run = { round: 2, nonce, startedAt: 1_000_000 }
    expect(decideUnattendedAction(facts({ run, doneNonce: nonce, claimsNotify: true }))).toEqual({
      action: 'inject',
      reason: 'false-notify',
      round: 3,
    })
    // 有发送记录 ⇒ 真通知，放过
    expect(decideUnattendedAction(facts({ run, doneNonce: nonce, claimsNotify: true, outboundSeen: true })).action).toBe('accept')
    // 没声称通知（走 A 支）⇒ 不查记录，放过
    expect(decideUnattendedAction(facts({ run, doneNonce: nonce })).action).toBe('accept')
  })

  it('墙钟上限：一个代理段自首次注入起累计超 2h ⇒ cap（**停下不动**，退回改造前行为）', () => {
    const run = { round: 2, nonce: 'ee'.repeat(8), startedAt: 1_000_000 }
    expect(decideUnattendedAction(facts({ run, nowMs: 1_000_000 + UNATTENDED_MAX_WALL_MS })).action).toBe('inject')
    expect(decideUnattendedAction(facts({ run, nowMs: 1_000_000 + UNATTENDED_MAX_WALL_MS + 1 }))).toEqual({
      action: 'cap',
      reason: 'wall-clock',
      round: 2,
    })
  })
})

describe('unattended: 运行态表（含清理 —— 本容器栽过 5 次"只增不清"）', () => {
  it('代理段：set/get/clear；轮数合计可观测', () => {
    setProxyRun('s1', { round: 2, nonce: 'a'.repeat(16), startedAt: 1 })
    setProxyRun('s2', { round: 3, nonce: 'b'.repeat(16), startedAt: 1 })
    expect(getProxyRun('s1')?.round).toBe(2)
    expect(proxyRunSessionIds().sort()).toEqual(['s1', 's2'])
    expect(activeProxyRoundTotal()).toBe(5)
    clearProxyRun('s1')
    expect(getProxyRun('s1')).toBeNull()
    expect(activeProxyRoundTotal()).toBe(3)
  })

  it('用户轮次：**只留最新一条**（表大小 = 会话数，结构性防膨胀）', () => {
    noteUserTurn('s1', 5)
    expect(isUserTurn('s1', 5)).toBe(true)
    expect(isUserTurn('s1', 6)).toBe(false)
    noteUserTurn('s1', 7)
    expect(isUserTurn('s1', 7)).toBe(true)
    expect(isUserTurn('s1', 5)).toBe(false)
    clearUserTurn('s1')
    expect(isUserTurn('s1', 7)).toBe(false)
    expect(isUserTurn('', 1)).toBe(false)
  })
})

describe('unattended: 出站发送账本（设计 §7 可核验性）', () => {
  it('记一次发送后：窗口内可见、窗口外不可见', () => {
    const now = 10_000_000
    noteOutboundSend('/ccc', now)
    expect(hasOutboundSendSince('/ccc', now - 1000, now)).toBe(true)
    expect(hasOutboundSendSince('/ccc', now + 1, now)).toBe(false) // 尚未发生
    expect(hasOutboundSendSince('/other', 0, now)).toBe(false) // 别的 CCC 不算
    // 超出保留窗（TTL）⇒ 不再算数
    const far = now + 7 * 60 * 60 * 1000
    expect(hasOutboundSendSince('/ccc', 0, far)).toBe(false)
  })

  it('环形裁剪：每 CCC 最多留 N 条（表大小有界）', () => {
    for (let i = 0; i < UNATTENDED_OUTBOUND_KEEP + 5; i++) noteOutboundSend('/ccc', 1_000 + i)
    expect(hasOutboundSendSince('/ccc', 1_000, 2_000)).toBe(true)
  })

  it('空根 / 未记过 ⇒ false（不抛）', () => {
    expect(hasOutboundSendSince('', 0, 1)).toBe(false)
    expect(hasOutboundSendSince('/never', 0, 1)).toBe(false)
    noteOutboundSend('')
    expect(hasOutboundSendSince('', 0, 1)).toBe(false)
  })
})

describe('unattended: 每轨迹流水（两日窗 · 原子写 · 永不抛）', () => {
  const DIR = '2026-09-23--S142--x'

  it('落点 = <轨迹目录>/unattended-log.json；追加后可读回（含机制事实，不含散文）', () => {
    const res = appendUnattendedLog(dir, DIR, { event: 'inject', round: 1, nonce: 'a'.repeat(16), reason: 'first-stop', sessionId: 'dsh-1' }, 1_000_000)
    expect(res.ok).toBe(true)
    expect(unattendedLogPath(dir, DIR)).toBe(join(dir, 'AGENT_SESSIONS', DIR, UNATTENDED_LOG_FILENAME))
    const { log, error } = loadUnattendedLog(dir, DIR)
    expect(error).toBeNull()
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.event).toBe('inject')
    expect(log.entries[0]?.reason).toBe('first-stop')
    expect(log.entries[0]?.sessionId).toBe('dsh-1')
  })

  it('写入时按窗裁剪：超两日的旧条在**同一次写入**里被清掉（结构上不存在"忘了清"）', () => {
    const now = Date.parse('2026-09-23T12:00:00+08:00')
    appendUnattendedLog(dir, DIR, { event: 'inject', round: 1, nonce: 'a'.repeat(16), reason: 'first-stop', sessionId: 's' }, now - 3 * 24 * 60 * 60 * 1000)
    expect(loadUnattendedLog(dir, DIR).log.entries).toHaveLength(1)
    appendUnattendedLog(dir, DIR, { event: 'accept', round: 1, nonce: 'a'.repeat(16), reason: 'done-code', sessionId: 's' }, now)
    const { log } = loadUnattendedLog(dir, DIR)
    expect(log.entries.map((e) => e.event)).toEqual(['accept'])
  })

  it('条目形状校验：字段缺失/事件名不认识 ⇒ 丢该条（不阻断整档）', () => {
    const path = unattendedLogPath(dir, DIR)
    mkdirSync(join(dir, 'AGENT_SESSIONS', DIR), { recursive: true })
    writeFileSync(path, JSON.stringify({
      version: 1,
      entries: [
        { at: '2026-09-23T12:00:00+08:00', event: 'inject', reason: 'ok', sessionId: 's' },
        { at: '2026-09-23T12:01:00+08:00', event: '不认识的事件', reason: 'ok' },
        { at: '', event: 'inject', reason: 'ok' },
        { event: 'inject', reason: 'ok' },
      ],
    }))
    expect(loadUnattendedLog(dir, DIR).log.entries).toHaveLength(1)
  })

  it('读坏档 ⇒ 当作空档 + 返回错误文本（**不静默**）', () => {
    const path = unattendedLogPath(dir, DIR)
    mkdirSync(join(dir, 'AGENT_SESSIONS', DIR), { recursive: true })
    writeFileSync(path, '{ 这不是 JSON')
    const { log, error } = loadUnattendedLog(dir, DIR)
    expect(log.entries).toEqual([])
    expect(error).toMatch(/解析失败/)
  })

  it('裁剪纯函数：`at` 不可解析 ⇒ **丢弃并报数**（不静默吞）', () => {
    const now = Date.parse('2026-09-23T12:00:00+08:00')
    const r = pruneUnattendedLogEntries(
      [
        { at: new Date(now).toISOString(), event: 'inject', round: 1, nonce: null, reason: 'a', sessionId: 's' },
        { at: '不是时间', event: 'inject', round: 1, nonce: null, reason: 'a', sessionId: 's' },
        { at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), event: 'inject', round: 1, nonce: null, reason: 'a', sessionId: 's' },
      ],
      now,
    )
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toBe(1)
    expect(r.pruned).toBe(1)
  })

  it('缺根/缺目录名 ⇒ 结构化失败（**不抛**）', () => {
    expect(appendUnattendedLog('', DIR, { event: 'inject', round: 1, nonce: null, reason: 'x', sessionId: 's' }).ok).toBe(false)
    expect(appendUnattendedLog(dir, '', { event: 'inject', round: 1, nonce: null, reason: 'x', sessionId: 's' }).ok).toBe(false)
  })
})
