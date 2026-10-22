/**
 * tests/im/log-scan.test.ts — `contacts` 的数据源（日志扫描）单测
 *
 * 本文件钉三件事，缺一件这个能力就会"看起来能用"：
 *   ① **真能读出来**：日文件 → 联系人（含 id、账号、时间、条数）；
 *   ② **渠道不猜**：有 `channel` 字段就用它；没有则按 accountId 回填；再没有才落 weixin
 *      （⛔ 绝不按 userId 的形状猜 —— `ou_` 前缀是命名习惯，不是判据）；
 *   ③ **扫描域可见**：`sources` 必须逐文件列出（否定性结论的可信度上限 = 扫描域）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { imLogRoots, scanImContacts } from '../../src/im/log-scan.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'im-log-scan-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 写一份日文件（内容按行给 JSON 对象） */
function putLog(rel: string[], name: string, events: object[]): void {
  const dir = join(root, 'AGENT_SESSIONS', ...rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('imLogRoots：新旧两代目录都认', () => {
  it('都不存在 ⇒ 空（不凭空造路径）', () => {
    expect(imLogRoots(root)).toEqual([])
  })

  it('只有存量 `_weixin-logs` ⇒ 只列它（Phase 1：迁移前）', () => {
    mkdirSync(join(root, 'AGENT_SESSIONS', '_weixin-logs'), { recursive: true })
    expect(imLogRoots(root)).toEqual([join('AGENT_SESSIONS', '_weixin-logs')])
  })

  it('新旧都在 ⇒ 两个都列，新代在前（迁移期间：历史在两处）', () => {
    mkdirSync(join(root, 'AGENT_SESSIONS', '_weixin-logs'), { recursive: true })
    mkdirSync(join(root, 'AGENT_SESSIONS', '_im-logs', 'weixin'), { recursive: true })
    expect(imLogRoots(root)).toEqual([
      join('AGENT_SESSIONS', '_im-logs'),
      join('AGENT_SESSIONS', '_weixin-logs'),
    ])
  })
})

describe('scanImContacts：汇总', () => {
  it('存量目录的日文件 ⇒ 读成联系人（id / accountId / 首末时间 / 条数）', () => {
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1000, accountId: 'wechat-1', userId: 'u-a', role: 'S001' },
      { event: 'outgoing', ts: 3000, accountId: 'wechat-1', userId: 'u-a', role: 'S001' },
      { event: 'incoming', ts: 2000, accountId: 'wechat-2', userId: 'u-b' },
    ])
    const r = scanImContacts(root)
    expect(r.sources).toEqual([join('AGENT_SESSIONS', '_weixin-logs', '2026-10-01.jsonl')])
    expect(r.errors).toEqual([])
    expect(r.contacts).toHaveLength(2)

    const a = r.contacts.find((c) => c.userId === 'u-a')!
    expect(a.channel).toBe('weixin') // 无 channel 字段 + 无回填 ⇒ 存量缺省
    expect(a.accountIds).toEqual(['wechat-1'])
    expect(a.messages).toBe(2)
    expect(a.firstSeen).toBe(1000)
    expect(a.lastSeen).toBe(3000)
    expect(a.roleAtEvent).toBe('S001')
  })

  it('🔴 渠道以**事件字段**为准，绝不按 userId 形状猜', () => {
    // 故意给一个"看起来像飞书"的 id，但事件声明 channel=weixin
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, channel: 'weixin', accountId: 'a1', userId: 'ou_looks_like_feishu' },
    ])
    const r = scanImContacts(root)
    expect(r.contacts[0]!.channel).toBe('weixin')
  })

  it('存量事件缺 channel ⇒ 按 accountId 回填表（不是猜形状）', () => {
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'fs-1', userId: 'ou_x' },
    ])
    const r = scanImContacts(root, { 'fs-1': 'feishu' })
    expect(r.contacts[0]!.channel).toBe('feishu')
  })

  it('新目录按渠道子目录下探一层（`_im-logs/<channel>/<day>.jsonl`）', () => {
    putLog(['_im-logs', 'feishu'], '2026-10-22.jsonl', [
      { event: 'incoming', ts: 5, accountId: 'fs-1', userId: 'ou_y' },
    ])
    const r = scanImContacts(root)
    expect(r.sources).toEqual([join('AGENT_SESSIONS', '_im-logs', 'feishu', '2026-10-22.jsonl')])
    expect(r.contacts[0]).toMatchObject({ channel: 'feishu', userId: 'ou_y', messages: 1 })
  })

  it('同一 (channel,userId) 跨文件跨账号聚合；不同渠道**不合并**', () => {
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 10, channel: 'weixin', accountId: 'w1', userId: 'same' },
    ])
    putLog(['_weixin-logs'], '2026-10-02.jsonl', [
      { event: 'incoming', ts: 20, channel: 'weixin', accountId: 'w2', userId: 'same' },
      { event: 'incoming', ts: 30, channel: 'feishu', accountId: 'f1', userId: 'same' },
    ])
    const r = scanImContacts(root)
    expect(r.contacts).toHaveLength(2)
    const wx = r.contacts.find((c) => c.channel === 'weixin')!
    expect(wx.messages).toBe(2)
    expect(wx.accountIds).toEqual(['w1', 'w2'])
    expect(wx.firstSeen).toBe(10)
    expect(wx.lastSeen).toBe(20)
    const fs = r.contacts.find((c) => c.channel === 'feishu')!
    expect(fs.messages).toBe(1)
  })

  it('按 lastSeen 倒序（最近联系的在前）', () => {
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 100, userId: 'old' },
      { event: 'incoming', ts: 900, userId: 'new' },
    ])
    expect(scanImContacts(root).contacts.map((c) => c.userId)).toEqual(['new', 'old'])
  })

  it('缺 userId 的行走开（那是别的系统事件，不是联系人）', () => {
    putLog(['_weixin-logs'], '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'w1' },
      { event: 'incoming', ts: 2, accountId: 'w1', userId: '' },
      { event: 'incoming', ts: 3, accountId: 'w1', userId: 'ok' },
    ])
    expect(scanImContacts(root).contacts.map((c) => c.userId)).toEqual(['ok'])
  })

  it('🔴 单行损坏不毁掉整档：好行照样读出来，坏行进 errors（不静默）', () => {
    const dir = join(root, 'AGENT_SESSIONS', '_weixin-logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '2026-10-01.jsonl'),
      JSON.stringify({ event: 'incoming', ts: 1, userId: 'good' }) + '\n{ 这不是 JSON\n',
    )
    const r = scanImContacts(root)
    expect(r.contacts.map((c) => c.userId)).toEqual(['good'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('2026-10-01.jsonl')
  })

  it('空目录 ⇒ 空联系人但 **sources 不空**（扫过 vs 没有，必须可分）', () => {
    mkdirSync(join(root, 'AGENT_SESSIONS', '_weixin-logs'), { recursive: true })
    const r = scanImContacts(root)
    expect(r.contacts).toEqual([])
    expect(r.sources).toEqual([]) // 一个文件都没有 ⇒ 扫描域为空（这才是"没扫到东西"的诚实说法）
  })

  it('无任何日志目录 ⇒ 全空（不抛）', () => {
    const r = scanImContacts(root)
    expect(r).toEqual({ contacts: [], sources: [], errors: [] })
  })
})
