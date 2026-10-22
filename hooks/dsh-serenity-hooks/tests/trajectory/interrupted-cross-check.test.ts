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
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

/**
 * 把事件序列写成 CRO 能读的真 zstd 多帧会话日志，返回 {dshHome, cccRoot}。
 *
 * 🔴 **必须把 mtime 回拨**（2026-10-23 实测；否则 5 条用例会**假红**）。
 *
 * CRO 侧有一条 live 保护：日志 mtime 落在 `RECENT_MTIME_MS`（90s）以内 ⇒ 视为
 * "这条会话可能正在跑" ⇒ **本轮直接跳过**。它加这条的理由是正当的（ACC 快照给的
 * `liveSessionIds` 只含**绑到本轨迹**的载体，护不住别人家的活会话）。
 * 而本夹具是**刚刚**写出的文件 ⇒ mtime 必然是"现在" ⇒ **每条用例都被跳过**
 * ⇒ CRO 恒答 `wake:false` ⇒ 与 ACC 侧天然不一致 ⇒ 红，且**红得与被测判据无关**。
 *
 * ⇒ 夹具把 mtime 拨到 `RECENT_MTIME_MS` 之外、`LOOKBACK_MS`（8h）之内：
 * 「一条几分钟前停在那里、且没人在跑的会话」—— 这才是被测对象的**真形态**。
 * ⚠️ 这不是"为了让测试变绿而放宽"：把 mtime 留在"现在"，测的就**不是判据**，
 *    而是那条 live 保护（D204 同族：先让被测格子成立）。
 */
function stageLog(events: Array<Record<string, unknown>>): { dshHome: string; cccRoot: string; cleanup: () => void } {
  if (zstd === undefined) throw new Error('本机 Node 无 zstdCompressSync')
  const root = mkdtempSync(join(tmpdir(), 'cro-cross-'))
  const ccc = join(root, 'ccc')
  const slug = `--${ccc.split('/').filter(Boolean).join('-')}--`
  const dir = join(root, '.dsh', 'sessions', slug, 'session-target')
  mkdirSync(dir, { recursive: true })
  const frames = events.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(logPath, Buffer.concat(frames))
  // 回拨 mtime：**10 分钟前** ⇒ 远超 90s、远小于 8h。两端的量级差一个数量级以上，
  // 不会因为将来微调阈值而变得黏在边界上。数值各自持有，不跨文件 import（CRO 不能 import ACC）。
  const stagedAgeSec = 10 * 60
  const t = new Date(Date.now() - stagedAgeSec * 1000)
  utimesSync(logPath, t, t)
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

/**
 * 🔴🔴 **2026-10-23 新增（D210，owner 实测报障的病历本身）**：
 * 末轮 interrupted **之后**又追加了 `agent/inbox/spliced`（宿主重启后把待办消息重塞收件箱）。
 * 真机形态逐字为 `turn/end[interrupted] -> session/end-seed -> agent/inbox/spliced -> agent/inbox/spliced`。
 *
 * 旧判据要求「**末条** = end-seed」⇒ 这一格**恒不命中**，而实测本机有 **2 条**会话长这样
 * ⇒ 它们永远叫不醒。**这恰恰是"被恢复过、又再次被打断"的会话**，即最该被守护的那一类。
 */
const interruptedThenInboxSpliced = [
  { type: 'turn/start', time: 1000, data: { turn: 5 } },
  { type: 'step/start', time: 1001, data: { turn: 5, step: 1 } },
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'interrupted' } } },
  { type: 'session/end-seed', time: 1003, data: {} },
  { type: 'agent/inbox/spliced', time: 1004, data: { target: 'main', start: 0, inserted: [] } },
  { type: 'agent/inbox/spliced', time: 1005, data: { target: 'main', start: 0, inserted: [] } },
]

describe('判据交叉校验：ACC 的 detectInterruptedEnd ≡ 守护 CRO 的判定', () => {
  const cases: Array<{ name: string; events: Array<Record<string, unknown>> }> = [
    { name: '末条 end-seed ＋ interrupted ⇒ 命中', events: interruptedTail },
    { name: '正常结束 ⇒ 不命中', events: completedTail },
    { name: '曾经中断但已继续 ⇒ 不命中', events: resumedAfterInterrupt },
    { name: '末条不是 end-seed ⇒ 不命中', events: [{ type: 'turn/start', data: { turn: 1 } }] },
    // 🔴 D210：末轮 interrupted 之后只有非轮次事件（end-seed / inbox/spliced）⇒ **仍要命中**
    { name: 'D210 末轮 interrupted ＋ 之后仅 inbox/spliced ⇒ 命中（不是"末条非 end-seed 就不命中"）', events: interruptedThenInboxSpliced },
    // 🔴 与上一条配对的**反向钉**：中断之后真的又开了一轮 ⇒ 不命中（放宽没把误报放进来）
    {
      name: 'D210 反向钉：interrupted 之后又有 turn/start ⇒ 不命中',
      events: [...interruptedThenInboxSpliced, { type: 'turn/start', time: 2000, data: { turn: 6 } }],
    },
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
