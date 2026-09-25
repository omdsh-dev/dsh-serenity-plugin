/**
 * compact-branches.test.ts — `seams/compact.ts` 的**守卫/防御分支面**（⑤ 第 44 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `seams/compact.ts` = **分支 66.66%（10/15）**，是 `src/**` 中**最低的一个未被做过**的文件
 * （更低的只有 `diag-ops.ts` 已由第 43 件做完）。语句 97.22%（70/72）。
 *
 * ── 为何这 5 处从未被走过（可达性取证）──────────────────────────────────────
 * 既有 `compact.test.ts` 的 `captureListener()` 夹具**恒注册一个"cwd 在 CCC 内"的 agent**
 * ⇒ 它只能走**happy path**，5 处守卫分支结构上永远进不去：
 *
 *   C1 `String(session.id ?? '')` 的 `?? ''` 侧 —— session 总是带 id
 *   C2 `if (!agent) return` —— agent 总被注册
 *   C3 `?.header?.cwd ?? process.cwd()` —— agent.session 总带 cwd
 *   C4 `if (!root) return` —— cwd 总在 CCC 内
 *   C5 `catch { }` —— `agent.inject` 从不抛
 *
 * ⇒ 本文件即补这 5 处。**全部是"守卫/防御路径"** ⇒ 正是 ⑤ 新口径（语义深度／错误路径）的对象。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **真故障形态注入**：C5 让 `inject` **真抛**（而非 mock 掉 try）；C4 用**真不是 CCC 的目录**。
 *  · **不 mock 被测模块**：`compact.ts` 真跑；只 mock 宿主 `dsh-llm`（与既有文件同款，它要 peer）。
 *  · `it()` 标题内不用直引号（用「」）。
 *  · 红色即停：断言红了先分诊"被测对象失败 vs 脚手架失败"，**不要顺着假设改测试**。
 *
 * ── 🆕 本件取证发现（登记，未改生产代码）────────────────────────────────────
 * `compact.ts` 的两处 `session.id` 用法**不对称**：
 *   · :56 的 skiff 判定 —— `String(session.id ?? '')`，**归一化**（undefined → `''`）
 *   · :58 的取 agent —— `ctx.agents.get(session.id)`，用**原始值**（可能是 undefined）
 * ⇒ 后果：`session.id` 缺失时，**skiff 那道按空串判**（不早退），而**查表用 undefined**
 *   ⇒ 实际行为是"查不到 → :59 早退"。功能上无害（两边都通不到注入），但**判据不一致**。
 * ⇒ 🔵 本件仅**登记**（写在本注释与 commit message），**不改**：改它属生产代码改动，
 *   且当前行为无缺陷迹象（两种路径都安全早退）。若将来要改，须回答"哪种才是意图"。
 * ⇒ 该发现正是本用例**首跑红过**的原因（我按 `''` 注册，而代码查的是 `undefined`）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { registerCompactRetention } from '../src/seams/compact.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-compact-branch-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 可**逐用例定制** agent 形态的夹具（既有 `captureListener` 只能造 happy path）。
 * `agent === null` ⇒ 该 session 在注册表里查不到（C2）。
 */
function harness(): {
  emit: (session: unknown, event: unknown) => void
  injected: unknown[]
  setAgent: (id: unknown, agent: unknown) => void
} {
  let handler: ((s: unknown, e: unknown) => void) | null = null
  const injected: unknown[] = []
  // 🔴 键类型必须是 `unknown`：:58 用**原始** `session.id` 查表（可能是 undefined / number）
  const agents = new Map<unknown, unknown>()
  const fakeCtx = {
    on: (name: string, fn: unknown) => {
      if (name === 'session/event') handler = fn as typeof handler
    },
    agents: { get: (id: unknown) => agents.get(id) },
  }

  registerCompactRetention(fakeCtx as never)

  return {
    emit: (session, event) => handler?.(session, event),
    injected,
    setAgent: (id, agent) => agents.set(id, agent),
  }
}

/** 一个"正常"的 agent（cwd 在 CCC 内、inject 只记录） */
function goodAgent(cwd: string | undefined = dir, injectImpl?: (m: unknown) => void): unknown {
  return {
    session: { header: cwd === undefined ? {} : { cwd } },
    inject: injectImpl ?? ((m: unknown) => undefined),
  }
}

const OK_EVENT = { type: 'compaction/end', data: { compactionId: 'c', turn: 1 } }

describe('compact 守卫面: 五个防御分支（C1~C5）', () => {
  // ── 🔵 夹具正控 ─────────────────────────────────────────────────────────

  it('【夹具正控】happy path：cwd 在 CCC 内 + agent 已在表 ⇒ 真注入 1 次', () => {
    // 🔴 **必须先证明夹具不瞎**：若本用例也红，则后面所有守卫用例的「不注入」
    //    都无法区分「守卫生效」与「夹具坏了」。这是纪律「读数器本身要先证明不瞎」的应用。
    const h = harness()
    h.setAgent('sess-ok', goodAgent(dir, (m) => h.injected.push(m)))
    h.emit({ id: 'sess-ok' }, OK_EVENT)
    expect(h.injected.length).toBe(1)
  })

  // ── C1：session 无 id ⇒ 退化为空串（不抛）────────────────────────────────

  it('session **无 id 字段** ⇒ 不抛、且按空串判定（非 skiff）（C1）', () => {
    const h = harness()
    // 无 id ⇒ `String(session.id ?? '')` 走 `?? ''` 侧。空串不是 skiff 前缀 ⇒ **不早退**。
    // 🔴 取证发现（本用例首跑红过）：:56 的 skiff 判定**归一化**成 `''`，
    //    但 :58 的 `ctx.agents.get(session.id)` 用的是**原始值** `undefined`
    //    ⇒ 两侧**不对称**。故这里必须按 `undefined` 注册才能走到 inject。
    //    （该不对称本身已登记进文件头部的"发现"段，本件不改生产代码。）
    let injectedCount = 0
    h.setAgent(undefined, goodAgent(dir, () => { injectedCount += 1 }))
    expect(() => h.emit({}, OK_EVENT)).not.toThrow()
    expect(injectedCount).toBe(1)
  })

  it('session **无 id** 且注册表里也没有 ⇒ 在 :58 处早退（C1+C2 联合）', () => {
    const h = harness()
    // 同上，但**不**注册 ⇒ 验证"无 id 时查表用的是 undefined"这一事实（反侧）
    expect(() => h.emit({}, OK_EVENT)).not.toThrow()
    expect(h.injected.length).toBe(0)
  })

  it('session **id 为非字符串**（如数字）⇒ 不抛（`String()` 兜住）', () => {
    const h = harness()
    // :58 用原始 `session.id`（数字 42）查表；Map 的键按 SameValueZero ⇒ 数字 42 可命中
    h.setAgent(42, goodAgent(dir, (m) => h.injected.push(m)))
    expect(() => h.emit({ id: 42 }, OK_EVENT)).not.toThrow()
    expect(h.injected.length).toBe(1)
  })

  // ── C2：agent 查不到 ⇒ 早退，不注入 ──────────────────────────────────────

  it('session 对应的 agent **不存在** ⇒ 直接 return，不注入、不抛（C2）', () => {
    const h = harness()
    // 刻意**不**注册该 id 的 agent ⇒ `ctx.agents.get()` 返回 undefined
    expect(() => h.emit({ id: 'sess-unknown' }, OK_EVENT)).not.toThrow()
    expect(h.injected.length).toBe(0)
  })

  // ── C3：agent.session 无 cwd ⇒ 回落 process.cwd() ──────────────────────

  it('agent.session **无 cwd** ⇒ 回落 `process.cwd()`（不再往下走 CCC 判定）（C3）', () => {
    const h = harness()
    // cwd 缺失 ⇒ 走 `?? process.cwd()` 侧；而测试进程的 cwd 通常不在任何 CCC 内
    // ⇒ 紧接着由 C4 的 `!root` 早退 ⇒ **不注入**。
    // 🔵 本用例断言的是"不抛"，其分支命中由 C3+C4 共同完成（两者本就是链式守卫）。
    h.setAgent('sess-nocwd', goodAgent(undefined, (m) => h.injected.push(m)))
    expect(() => h.emit({ id: 'sess-nocwd' }, OK_EVENT)).not.toThrow()
  })

  // ── C4：cwd 不在任何 CCC 内 ⇒ 早退 ───────────────────────────────────────

  it('cwd **不在任何 CCC 内**（真造一个无 .serenity 的目录）⇒ 直接 return（C4）', () => {
    const h = harness()
    const nonCcc = mkdtempSync(join(tmpdir(), 'not-a-ccc-compact-'))
    try {
      // 🔵 真故障形态：该目录**确实**没有 .serenity ⇒ cccRootForCwd 返回 null
      h.setAgent('sess-outside', goodAgent(nonCcc, (m) => h.injected.push(m)))
      expect(() => h.emit({ id: 'sess-outside' }, OK_EVENT)).not.toThrow()
      expect(h.injected.length).toBe(0) // 早退 ⇒ 未注入
    } finally {
      rmSync(nonCcc, { recursive: true, force: true })
    }
  })

  // ── C5：注入抛错 ⇒ 被 catch 吞掉，不阻断 ────────────────────────────────

  it('`agent.inject` **真抛错** ⇒ 被 catch 吞掉：不冒泡、不影响后续（C5）', () => {
    const h = harness()
    // 🔴 真故障形态：让 inject 真的抛（不是 mock 掉 try）——守卫仍应兜底。
    h.setAgent('sess-throw', goodAgent(dir, () => {
      throw new Error('inject boom（模拟注入失败）')
    }))
    expect(() => h.emit({ id: 'sess-throw' }, OK_EVENT)).not.toThrow()
    expect(h.injected.length).toBe(0)
  })

  it('注入抛错后**下一次**仍能正常工作（catch 不留残留状态）', () => {
    const h = harness()
    h.setAgent('sess-flaky', goodAgent(dir, () => {
      throw new Error('boom')
    }))
    h.emit({ id: 'sess-flaky' }, OK_EVENT) // 第一次抛，被吞
    // 换成正常 inject ⇒ 应恢复（证明 catch 没有把监听器搞坏）
    h.setAgent('sess-flaky', goodAgent(dir, (m) => h.injected.push(m)))
    h.emit({ id: 'sess-flaky' }, OK_EVENT)
    expect(h.injected.length).toBe(1)
  })
})
