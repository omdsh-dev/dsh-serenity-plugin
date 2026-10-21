/**
 * duplicate-code-ambiguity.test.ts — **编码重码时解析侧必须响亮报歧义**（A95 ①，owner 2026-10-21 批「①②」）
 *
 * ## 这条判据挡的是什么（不是"新重码"，而是"存量重码被静默消费"）
 *
 * 分配侧早已有闸（`findCodeCollision` 扫**活跃 ＋ 归档**），而自动分配走 `maxId+1`
 * 且扫描域含归档区 ⇒ **按构造不会产生新重码**。
 * 但磁盘上**确实存在**闸装上之前留下的重码（实测：另有 CCC 里 `S017`×3、`S065`×2、`S177`×2）。
 *
 * 改之前：解析侧 `findSession` / `findDirNameByCode` 都用"取第一个命中"。
 * ⇒ 一条 `send-now S017` 会**静默投到三条里的某一条**（按目录扫描顺序），**盘上零信号**。
 * 而编码是**终身身份**（AXIOM 3）—— 静默选其一等于把命令交给另一个对象。
 *
 * ## 判据为什么钉 `throw` 而不是钉返回 `null`
 *
 * 返回 `null` 会被调用方读成"**没有这条**"，于是它自己造一个新的 ⇒ 那正是"重码继续繁殖"的写法。
 * ⇒ 有歧义必须是**响亮的拒绝**（D186：可以拒绝，但不许不出声）。
 *
 * ## 两个解析面都要钉（D167 的教训）
 *
 * `findSession`（core）与 `findDirNameByCode`（policy/profile）是**两条独立的解析路**。
 * 只修一处 ⇒ 另一处继续静默，而症状与真因在读数上完全不像。⇒ 各一条用例。
 *
 * ## 隐私门（D145）
 *
 * 本文件不写真实家目录 / 私有 CCC 名，全部用 tmpdir。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findSession, sessionsRoot } from '../src/trajectory/core.js'
import { findDirNameByCode } from '../src/trajectory/policy/profile.js'

let root: string

/** 造一条轨迹目录（`YYYY-MM-DD--<code>--<desc>`） */
function makeTrajectory(dirName: string): void {
  const p = join(sessionsRoot(root), dirName)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'SESSION.md'), '# SESSION: x\n- ID: x\n', 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dup-code-'))
  mkdirSync(sessionsRoot(root), { recursive: true })
  // `.serenity` 让 activeTrajectoryDirNames 认这个目录为 CCC（profile 侧需要）
  writeFileSync(join(root, '.serenity'), 'dup-code-test\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('A95 ①：重码 ⇒ 解析侧响亮报歧义（⛔ 不许任选其一）', () => {
  it('🔴 findSession：同一编码有两条 ⇒ 抛错，且**把两条目录名都列出来**', () => {
    makeTrajectory('2026-08-03--S017--SSO单点登录500排查')
    makeTrajectory('2026-08-04--S017--价格监控自动下架排查')

    // 判据不能只写 "toThrow"：那连"抛了个别的错"都会放过。
    // ⇒ 同时钉住 ① 说的是"无法确定" ② **两条都在消息里**（否则用户不知道要选哪个）。
    let message = ''
    try {
      findSession(sessionsRoot(root), 'S017')
      throw new Error('本应抛错：重码必须被拒，绝不许静默取首命中')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('S017')
    expect(message).toContain('2 条')
    expect(message).toContain('2026-08-03--S017--SSO单点登录500排查')
    expect(message).toContain('2026-08-04--S017--价格监控自动下架排查')
    // 必须给出可执行的下一步（否则用户只知道"错了"）
    expect(message).toContain('完整目录名')
  })

  it('🔴 findSession：**唯一命中照常返回**（反向钉：不能把正常路径也拦死）', () => {
    makeTrajectory('2026-09-01--S042--独此一条')
    const hit = findSession(sessionsRoot(root), 'S042')
    expect(hit?.dirName).toBe('2026-09-01--S042--独此一条')
  })

  it('🔴 findDirNameByCode：同一编码有两条 ⇒ 抛错（第二个解析面，不能只修一处）', () => {
    makeTrajectory('2026-08-03--S017--alpha')
    makeTrajectory('2026-08-04--S017--beta')

    expect(() => findDirNameByCode(root, 'S017')).toThrow(/S017/)
    expect(() => findDirNameByCode(root, 'S017')).toThrow(/2 条/)
  })

  it('🔴 findDirNameByCode：唯一命中照常返回（反向钉）', () => {
    makeTrajectory('2026-09-01--S042--独此一条')
    expect(findDirNameByCode(root, 'S042')).toBe('2026-09-01--S042--独此一条')
  })

  it('🔴 补零兼容路也过歧义闸（`S17` → `S017`，别只在精确匹配上做）', () => {
    makeTrajectory('2026-08-03--S017--alpha')
    makeTrajectory('2026-08-04--S017--beta')
    expect(() => findSession(sessionsRoot(root), 'S17')).toThrow(/S017/)
  })

  it('🔴 完整目录名**永远**可以指名（歧义态下的逃生门必须真的存在）', () => {
    makeTrajectory('2026-08-03--S017--alpha')
    makeTrajectory('2026-08-04--S017--beta')
    // 重码时代码指不清，但完整目录名是**结构上唯一**的 ⇒ 必须命中
    const hit = findSession(sessionsRoot(root), '2026-08-04--S017--beta')
    expect(hit?.dirName).toBe('2026-08-04--S017--beta')
  })
})
