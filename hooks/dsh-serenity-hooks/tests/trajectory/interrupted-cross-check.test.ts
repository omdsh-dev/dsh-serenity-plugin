/**
 * 判据交叉校验 —— **ACC 侧 vs CRO 侧必须同一条判据**
 *
 * ## 为什么这个测试必须存在（本轮 review 的头号战场）
 *
 * 「以 interrupted 结尾」这条判据现在有**两处独立实现**：
 *   ① ACC：`src/trajectory/interrupted.ts` 的 `detectInterruptedEnd`
 *   ② 守护轨迹的 CRO：`AGENT_SESSIONS/<guard>/continuous-re-occurrence.ts` 的同名逻辑
 *
 * 🔴 **为什么不能合成一处**：CRO 是**独立子进程**（由 ACC 以 `bun <file>` 起），
 * **不能 import `src/`** —— 那是构建产物，且不在该子进程的运行时路径上。
 * ⇒ 两处实现是**结构性冗余**，不是疏忽。
 *
 * 🔴 **但冗余必须有机械守卫**：两处一旦漂移，症状是
 * 「**ACC 说有待续会话，CRO 说没有**」（或反之）⇒ 守护轨迹**永远叫不起来**，
 * 而两边各自的单测都会是绿的 —— 这是最典型的「跑绿也照样炸」。
 *
 * ## 它怎么测（不复制判据，而是**对读两处实现的行为**）
 *
 * 用**同一批事件序列**分别喂给两个实现，断言**判定结果一致**。
 * ⚠️ 关键：**不在这里再抄一份期望值** —— 抄一份就是第三真相源。
 *    这里只断言「两者**彼此相等**」，期望值由各自的正向单测负责。
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import * as nodeZlib from 'node:zlib'

import { detectInterruptedEnd } from '../../src/trajectory/interrupted.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 路径层级（🔴 数过一次，别再靠感觉）：
 *   tests/trajectory/ ← 本文件
 *   tests/            ← ..1
 *   hooks/dsh-serenity-hooks/ ← ..2
 *   hooks/            ← ..3
 *   dsh-serenity-plugin/ ← ..4
 *   AI_LAB/           ← ..5
 *   CCC 根            ← ..6
 *
 * ⚠️ **实测踩到**：初版只写了 4 级 ⇒ 推导到 `dsh-serenity-plugin` ⇒ CRO 文件不存在
 * ⇒ 测试静默走"跳过"分支 ⇒ **4 个用例全绿但一个都没真跑**（假绿的教科书形态）。
 */
const CCC_ROOT = join(HERE, '..', '..', '..', '..', '..', '..')
const GUARD_CRO = join(CCC_ROOT, 'AGENT_SESSIONS', '2026-10-22--guard--中断守护', 'continuous-re-occurrence.ts')

const zstd = (nodeZlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync

/** 把事件序列写成 CRO 能读的真 zstd 多帧会话日志，返回 {dshHome, cccRoot} */
function stageLog(events: Array<Record<string, unknown>>): { dshHome: string; cccRoot: string; cleanup: () => void } {
  if (zstd === undefined) throw new Error('本机 Node 无 zstdCompressSync')
  const root = mkdtempSync(join(tmpdir(), 'cro-cross-'))
  const ccc = join(root, 'ccc')
  const slug = `--${ccc.split('/').filter(Boolean).join('-')}--`
  const dir = join(root, '.dsh', 'sessions', slug, 'session-target')
  mkdirSync(dir, { recursive: true })
  const frames = events.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return { dshHome: join(root, '.dsh'), cccRoot: ccc, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 跑 CRO，返回它是否 wake:true（= 它认为"有以 interrupted 结尾的会话"） */
function croSaysInterrupted(events: Array<Record<string, unknown>>): boolean | null {
  if (!existsSync(GUARD_CRO)) return null // 轨迹可能被归档/未建 ⇒ 本测试跳过（不是失败）
  const staged = stageLog(events)
  try {
    const res = spawnSync('bun', [GUARD_CRO], {
      input: JSON.stringify({
        identity: { dirName: 'guard', code: 'guard', cccRoot: staged.cccRoot },
        time: { nowMs: Date.now() },
        binding: { liveSessionIds: [], runningSessionIds: [] },
      }),
      encoding: 'utf-8',
      env: { ...process.env, DSH_HOME: staged.dshHome },
      timeout: 30_000,
    })
    const out = (res.stdout ?? '').trim()
    if (out === '') return null
    const parsed = JSON.parse(out) as { wake?: boolean }
    return parsed.wake === true
  } finally {
    staged.cleanup()
  }
}

const interruptedTail = [
  { type: 'turn/start', time: 1000, data: { turn: 5 } },
  { type: 'step/start', time: 1001, data: { turn: 5, step: 1 } },
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'interrupted' } } },
  { type: 'step/end', time: 1003, data: { turn: 5, step: 1 } },
  { type: 'session/end-seed', time: 1004, data: {} },
]

const completedTail = [
  { type: 'turn/start', time: 1000, data: { turn: 5 } },
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'completed' } } },
  { type: 'session/end-seed', time: 1004, data: {} },
]

/** 曾经中断，但之后又继续跑过（最危险的误报形态） */
const resumedAfterInterrupt = [
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'interrupted' } } },
  { type: 'session/end-seed', time: 1003, data: {} },
  { type: 'turn/start', time: 2000, data: { turn: 6 } },
  { type: 'user/message', time: 2001, data: { content: 'later' } },
]

describe('判据交叉校验：ACC 的 detectInterruptedEnd ≡ 守护 CRO 的判定', () => {
  const cases: Array<{ name: string; events: Array<Record<string, unknown>> }> = [
    { name: '末条 end-seed ＋ interrupted ⇒ 命中', events: interruptedTail },
    { name: '正常结束 ⇒ 不命中', events: completedTail },
    { name: '曾经中断但已继续 ⇒ 不命中', events: resumedAfterInterrupt },
    { name: '末条不是 end-seed ⇒ 不命中', events: [{ type: 'turn/start', data: { turn: 1 } }] },
  ]

  /**
   * 🔴 **前置条件必须单独断言成一条用例**，不能散在各用例里静默跳过。
   *
   * 初版把「CRO 文件找不到」处理成 `expect(true).toBe(true)` ⇒ 路径还写错了一级，
   * 结果**4 个用例全绿、一个都没真跑**。⇒ 判据：**"跳过"与"通过"必须是两种不同的颜色**，
   * 前置条件不成立要**显式红**，而不是悄悄放过。
   */
  it('前置条件：守护 CRO 程序必须能被找到（找不到 ⇒ 本条显式失败，不许静默跳过）', () => {
    expect(
      existsSync(GUARD_CRO),
      `找不到 CRO 程序：${GUARD_CRO}\n` +
        '（若该轨迹已被归档/删除，请同步更新本测试的路径或删除本文件）',
    ).toBe(true)
  })

  for (const c of cases) {
    it(`两边判定一致：${c.name}`, () => {
      const accHit = detectInterruptedEnd(c.events as never) !== null
      const croHit = croSaysInterrupted(c.events)

      // 走到这里前置条件已由上面的用例保证；真的拿不到输出 ⇒ 这是环境问题，必须红而不是绿
      expect(croHit, 'CRO 没有产出可解析的决策（bun 不可用？程序报错？）').not.toBeNull()
      expect(
        croHit,
        `ACC 判「${accHit ? '命中' : '不命中'}」而 CRO 判「${croHit ? '命中' : '不命中'}」` +
          ' —— 两侧判据已漂移，守护轨迹会永远叫不起来（或狂叫）',
      ).toBe(accHit)
    })
  }
})
