/**
 * weixin-session-gen.test.ts —— 「没会话就自动新建」的回归钉（S142 2026-10-19，owner 令）
 *
 * ## 需求（owner 原话）：「微信桥发新消息 → 没有 skiff 会话就自动新建一个」
 *
 * ## 为什么要"代次"而不是"换 id 规则"
 *
 * 同用户恒定同一 id 的语义**必须保留**（长期记忆、重启续接都靠它）。真正要解决的是：
 * **工作台（SESSION.md）被归档/删除后，那个旧会话身份就不该再被 resume** ——
 * 它的历史里带着当时的工具清单 ⇒ 新配置永远不生效（实测：每次调用被角色白名单拒，
 * 用户视角是「工具一直不刷新」）。
 *
 * ⇒ 载体没了就**换代**：`baseId` → `baseId-g1` → `baseId-g2` …，且**落盘**，
 * 这样跨进程重启仍然成立（只放内存的话，重启后又 resume 回旧 log）。
 *
 * ## 判据（四条）
 *
 * ① **零回归**：从未换代 ⇒ `currentSessionIdFor` 原样返回 baseId（与改动前逐字相同）；
 * ② 换代后 ⇒ 返回带代次的新 id，且**与旧 id 不同**；
 * ③ **落盘**：新进程（重新读文件）看到的仍是新代次 —— 这是"重启后不复发"的唯一判据；
 * ④ 坏档/缺档 ⇒ 退回 0，永不抛（旁路容忍铁律）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  weixinSessionIdFor,
  currentSessionIdFor,
  discardCurrentSessionGen,
  readSessionGen,
} from '../src/im/route.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-gen-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('微信桥会话代次（载体缺失 ⇒ 新建）', () => {
  it('① 零回归：从未换代 ⇒ currentSessionIdFor 原样返回 baseId', () => {
    const base = weixinSessionIdFor('user-a')
    expect(readSessionGen(dir, base)).toBe(0)
    expect(currentSessionIdFor(dir, base)).toBe(base)
  })

  it('② 换代 ⇒ 返回新 id，且与旧 id 不同（旧会话不再被复用）', () => {
    const base = weixinSessionIdFor('user-a')
    const next = discardCurrentSessionGen(dir, base)
    expect(next).not.toBe(base)
    expect(next.startsWith(base)).toBe(true)
    expect(currentSessionIdFor(dir, base)).toBe(next)
  })

  it('🔴 ③ 落盘：新进程重新读文件仍看到新代次（"重启后不复发"的唯一判据）', () => {
    const base = weixinSessionIdFor('user-b')
    const next = discardCurrentSessionGen(dir, base)
    // 模拟"另一个进程"：只读文件，不信任进程内状态
    const onDisk = JSON.parse(readFileSync(join(dir, 'AGENT_SESSIONS', '.weixin-session-gen.json'), 'utf-8')) as Record<string, number>
    expect(onDisk[base]).toBe(1)
    expect(next).toBe(`${base}-g1`)
    // 再换一次 ⇒ g2（每次载体缺失都得到一个全新身份，不会撞回 g1）
    const next2 = discardCurrentSessionGen(dir, base)
    expect(next2).toBe(`${base}-g2`)
    expect(currentSessionIdFor(dir, base)).toBe(`${base}-g2`)
  })

  it('④ 坏档/缺档 ⇒ 退回 0，永不抛', () => {
    const base = weixinSessionIdFor('user-c')
    mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', '.weixin-session-gen.json'), '{ not json')
    expect(readSessionGen(dir, base)).toBe(0)
    expect(currentSessionIdFor(dir, base)).toBe(base)
    // 坏档下换代仍可用（从空表重来；重置后生成的是**又一个新 id**，不会撞旧 log）
    expect(discardCurrentSessionGen(dir, base)).toBe(`${base}-g1`)
  })

  it('⑤ 多用户互不串味（代次按 baseId 分键）', () => {
    const a = weixinSessionIdFor('user-a')
    const b = weixinSessionIdFor('user-b')
    discardCurrentSessionGen(dir, a)
    expect(readSessionGen(dir, a)).toBe(1)
    expect(readSessionGen(dir, b)).toBe(0)
    expect(currentSessionIdFor(dir, b)).toBe(b)
  })
})
