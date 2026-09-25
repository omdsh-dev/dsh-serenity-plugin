/**
 * diag-ops-branches.test.ts — `diag-ops.ts` 的**分支面**（⑤ 第 43 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 复扫 coverage 报告取 `src/**` 里**分支覆盖率最低**的文件 ⇒ `diag-ops.ts`：
 *   · 语句 **100%**（163/163）却只有 **分支 52.63%（10/19）** ⇒ **全仓最大的分支缺口**。
 *   · 这正是 ⑤ 换挡后的口径（"语义深度 ／ 边界与错误路径"）：每条语句都跑过，
 *     但**超过一半的分支从没走过另一侧** ⇒ 纯函数测试的典型盲区。
 *   · **无专属测试文件**（`acc-diag.test.ts` 是同域但覆盖的是工具面与装配主路径）。
 *   · 全部 7 处未覆盖分支**均可由公开入口到达**（无需改生产语义）⇒ 是可赎的真靶。
 *
 * ── 本文件覆盖什么（逐条对准未覆盖分支，报告行号见 commit message）───────────
 *   B1 `renderClock` 的 `ts()`：`ms === null` ⇒ `'（从未）'`
 *   B2 `renderClock`：`armedAt !== null` ⇒ 追加 `武装于=`
 *   B3 `renderClock`：`lastSkipReason` 真值 ⇒ 追加 `上次跳过:`
 *   B4 `runAccDiag`：`attempts ?? 0`（条目**缺** `attempts` 字段）
 *   B5 `renderAccDiag`：`processCcc ?? '（无——进程 cwd 不在任何 CCC 内）'`
 *   B6 `renderAccDiag`：会话行三元 `title?` / `cccRoot ??` / `cwd ??`（**三个回退侧**）
 *   B7 `renderAccDiag`：`r.wakes.error` 真值 ⇒ 追加 `⚠ 注册表读取问题:`
 *
 * ── 纪律（本仓）──────────────────────────────────────────────────────────
 *  · **真故障形态**：注册表坏用**真写坏 JSON** 造（不 mock `listWakes`）⇒ 走的是
 *    `loadWakeRegistry` 的真实 catch，而不是替身。
 *  · **不 mock 被测模块**：本文件只 mock `@deepseek-ai/dsh-tools`（acc-diag 工具面所需，
 *    与 `acc-diag.test.ts` 同款），`diag-ops` 自身的两个函数**真跑**。
 *  · `it()` 标题内不用直引号（用「」）。
 *  · 红色即停：若某断言红了而我想改测试让它绿 —— 那是顺着假设改测试 ⇒ 应登记发现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))

import { runAccDiag, renderAccDiag } from '../src/diag-ops.js'
import { registerWakeScheduler, __resetWakeSchedulerStateForTest } from '../src/wake-scheduler.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diag-ops-branches-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  // 时钟进程态是**模块级单例** ⇒ 用例间必须复位，否则"武装过"会串到下一用例（假绿/假红）。
  __resetWakeSchedulerStateForTest()
})

afterEach(() => {
  __resetWakeSchedulerStateForTest()
  __setSimpleSourceForTest(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 最小 fake ctx。与 `acc-diag.test.ts` 同形，但**允许逐条会话带 title/cccRoot 的缺失形态**
 * （B6 需要"没有 title、cwd 非 CCC"的会话）。
 */
function fakeCtx(liveSessions: Array<{ id: string; cwd: string | null }> = []): unknown {
  return {
    get: () => undefined,
    sessions: {
      list: () => liveSessions.map((s) => ({ id: s.id, header: { cwd: s.cwd }, events: [] })),
    },
  }
}

// ── B1：`ts()` 的 `ms === null` 侧（'（从未）'）──────────────────────────────

describe('diag-ops 分支面: 时钟渲染的三个可选段（B1/B2/B3）', () => {
  it('时钟从未武装 / 从未 tick ⇒ 渲染「（从未）」而不是崩溃或留空（B1）', async () => {
    // 本进程内调度器**未武装**（测试进程不 apply 插件）⇒ armedAt/lastTickAt 均为 null。
    const r = await runAccDiag(fakeCtx() as never, dir)
    // 前置：确实处于"从未"态（否则本用例没测到 B1；这是断言的正控）
    expect(r.clocks.wake.armedAt).toBeNull()
    expect(r.clocks.wake.lastTickAt).toBeNull()

    const text = renderAccDiag(r)
    // B1：两个 null 时刻都渲染成「（从未）」
    expect(text).toContain('上次 tick=（从未）')
    expect(text).toContain('tick 次数=')
    // B2 的**反侧**：未武装 ⇒ 不得出现「武装于=」（否则等于凭空报了一个武装时刻）
    expect(text).not.toContain('武装于=')
  })

  it('未武装时不得出现「武装于=」，且「上次跳过」只在真有原因时出现（B2/B3 的反侧）', async () => {
    const r = await runAccDiag(fakeCtx() as never, dir)
    const text = renderAccDiag(r)
    expect(text).not.toContain('武装于=')
    expect(text).not.toContain('上次跳过')
  })

  it('🔴 时钟**真武装**后 ⇒ 渲染出「武装于=」与「上次跳过:」（B2/B3 的正侧）', async () => {
    // 🔴 可达性取证：`wakeSchedulerState()` 读的是**模块级单例时钟**，只有 `registerWakeScheduler`
    //    真的跑过才会填 armedAt / lastSkipReason。⇒ 先真装配一座钟（与 wake-registry.test.ts 同法），
    //    再经**公开入口** runAccDiag/renderAccDiag 观察 —— 不是直接构造快照（那会绕过被测代码）。
    const listeners: Record<string, Array<() => void>> = {}
    vi.spyOn(global, 'setInterval').mockImplementation((() => ({ unref: () => undefined })) as never)
    vi.spyOn(global, 'clearInterval').mockImplementation((() => undefined) as never)
    __setSimpleSourceForTest(() => defaultSimpleSettings())

    // 装配点：启动即 tick 一次；本用例 live 会话为空 ⇒ 必然写一条 lastSkipReason。
    registerWakeScheduler({
      sessions: { list: () => [] },
      agents: { get: () => undefined },
      get: () => undefined,
      on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) },
      effect: (cb: () => () => void) => { cb() },
    } as never)

    // 🔴 **必须等一拍**：`runWakeTick` 是 **async**（CCC 并集枚举含 await）⇒
    //    `lastSkipReason` 由 tick 体**异步**写入。不 await 就读 ⇒ 读到 null。
    //    （本条先红过一次，取证见 commit message：错的是测试不是生产代码。）
    await new Promise((r) => setTimeout(r, 20))

    const r = await runAccDiag(fakeCtx() as never, dir)
    // 前置（正控）：先证明两个字段真被填了 —— 否则后面的渲染断言测不到 B2/B3
    expect(r.clocks.wake.armedAt).not.toBeNull()
    expect(r.clocks.wake.lastSkipReason).not.toBeNull()

    const text = renderAccDiag(r)
    expect(text).toContain('武装于=')
    expect(text).toContain('上次跳过:')
    // B1 的反侧：武装后 armedAt 非 null ⇒ 该时刻走 isoLocal，不再是「（从未）」
    expect(text).toContain('armed=true')
  })
})

// ── B4：`attempts ?? 0`（条目缺 `attempts` 字段）─────────────────────────────

describe('diag-ops 分支面: 注册表条目字段的缺省（B4）', () => {
  it('条目**缺** attempts 字段 ⇒ 报 0 而不是 undefined（B4）', async () => {
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'wake-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          // 🔴 刻意**不写** attempts：这是真实可发生的形态（旧版注册表 / 手写条目）
          { id: 'w-no-att', target: 'S142', at: '2026-09-14T10:00:00Z', message: 'm', state: 'pending', createdBy: 'S142', createdAt: '2026-09-14T09:00:00Z' },
        ],
      }),
    )
    const r = await runAccDiag(fakeCtx() as never, dir)
    expect(r.wakes.entries).toHaveLength(1)
    // B4：是数字 0，不是 undefined
    expect(r.wakes.entries[0]!.attempts).toBe(0)
    expect(typeof r.wakes.entries[0]!.attempts).toBe('number')
    // 渲染面也不得出现字面量 undefined（"报了但报的是 undefined"等于没报）
    const text = renderAccDiag(r)
    expect(text).toContain('attempts=0')
    expect(text).not.toContain('undefined')
    // 🔴 **诚实登记（本件实测发现，不要读成本用例"赎了 B4"）**：
    //    `diag-ops.ts` 的 `e.attempts ?? 0` **在真实路径上不可达** —— 上游 `wake-registry.ts`
    //    的 `asEntry()`（约 :90）**已经把 attempts 规范成有限数**（非有限数一律写 0）⇒
    //    `containerWakes()` 给出的条目里 attempts **永远不是 undefined**。
    //    ⇒ 本用例的绿灯来自 `asEntry` 的规范化，**不是** diag-ops 那个 `??`。
    //    ⇒ 该 `??` 属**防御性冗余**（与地图 §3-8「构造上不可达」同族），本件**不动它**
    //      （删它 = 改生产代码；且它零风险、可读性上有守门价值）⇒ **登记，不赎**。
    //    判据（可重跑）：`grep -n "attempts:" src/wake-registry.ts` ⇒ 命中 `asEntry` 的规范化行。
    expect(r.wakes.entries[0]!.attempts).toBe(0) // 行为本身仍要钉住（回归价值）
  })

  it('条目缺 lastResult ⇒ 渲染**不追加** lastResult 行（`?? null` 的另一侧）', async () => {
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'wake-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'w-no-result', target: 'S142', at: '2026-09-14T10:00:00Z', message: 'm', state: 'pending', createdBy: 'S142', createdAt: '2026-09-14T09:00:00Z', attempts: 2 },
        ],
      }),
    )
    const r = await runAccDiag(fakeCtx() as never, dir)
    expect(r.wakes.entries[0]!.lastResult).toBeNull()
    const text = renderAccDiag(r)
    expect(text).toContain('w-no-result [pending]')
    // `if (w.lastResult)` 的假侧 ⇒ 不得出现该行
    expect(text).not.toContain('lastResult:')
  })
})

// ── B5/B6：`??` 回退侧（processCcc / 会话行三处）────────────────────────────

describe('diag-ops 分支面: 归属缺失时的回退文案（B5/B6）', () => {
  it('会话的 cwd 不在任何 CCC 内 ⇒ 三处回退文案都要出现（B6）', async () => {
    // 造一个**不是 CCC** 的目录（无 .serenity）⇒ cccRootForCwd 返回 null
    const nonCcc = mkdtempSync(join(tmpdir(), 'not-a-ccc-'))
    try {
      const r = await runAccDiag(fakeCtx([{ id: 's-orphan', cwd: nonCcc }]) as never, dir)
      const s = r.live.liveSessions[0]!
      // 前置（正控）：确认确实处于"归属缺失"态，否则本用例没测到 B6
      expect(s.cccRoot).toBeNull()
      expect(s.title).toBeNull()

      const text = renderAccDiag(r)
      // B6 三处回退（title 空 ⇒ 无「」；cccRoot null ⇒ '(非 CCC)'）
      expect(text).toContain('s-orphan')
      expect(text).toContain('ccc=(非 CCC)')
      expect(text).toContain('cwd=' + nonCcc)
      // title 为 null ⇒ 不得渲染出「」空书名号
      expect(text).not.toContain('「」')
    } finally {
      rmSync(nonCcc, { recursive: true, force: true })
    }
  })

  it('会话 cwd 为 null ⇒ cwd 回退为「(无)」（B6 的第三处）', async () => {
    const r = await runAccDiag(fakeCtx([{ id: 's-nocwd', cwd: null }]) as never, dir)
    const s = r.live.liveSessions[0]!
    expect(s.cwd).toBeNull()
    expect(s.cccRoot).toBeNull()
    const text = renderAccDiag(r)
    expect(text).toContain('cwd=(无)')
    expect(text).toContain('ccc=(非 CCC)')
  })

  it('进程 cwd 不在 CCC 内时，报告仍给出可读回退而非崩溃（B5）', async () => {
    // 进程 cwd 由 vitest 决定，本机跑测试时通常**不在** CCC 内 ⇒ 走回退侧。
    // 为避免依赖运行环境，这里**同时**断言两个分支的渲染语法都成立：
    //   进程 CCC 行必须存在，且要么是路径、要么是那句显式文案。
    const r = await runAccDiag(fakeCtx() as never, dir)
    const text = renderAccDiag(r)
    const line = text.split('\n').find((l) => l.startsWith('进程 CCC:'))
    expect(line).toBeDefined()
    if (r.live.processCcc === null) {
      expect(line).toContain('（无——进程 cwd 不在任何 CCC 内）')
    } else {
      expect(line).toContain(r.live.processCcc)
    }
    // 无论走哪侧，都不得把字面量 null/undefined 漏进人读报告
    expect(line).not.toContain('null')
    expect(line).not.toContain('undefined')
  })
})

// ── B7：注册表读取问题（`r.wakes.error` 真值）──────────────────────────────

describe('diag-ops 分支面: 注册表读取问题必须显形（B7）', () => {
  it('注册表**真写坏** ⇒ 报告显式告警而不是静默当作「无在办条目」（B7）', async () => {
    // 🔴 真故障形态：写一段非法 JSON，让 loadWakeRegistry 的真实 JSON.parse 抛错。
    //    不 mock listWakes ⇒ 走的是生产代码的 catch 分支（失败路径用真故障形态注入）。
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'wake-registry.json'), '{ broken json')

    const r = await runAccDiag(fakeCtx() as never, dir)
    // 前置（正控）：error 确实非空（否则本用例没测到 B7）
    expect(r.wakes.error).not.toBeNull()
    expect(r.wakes.error).toContain('唤醒注册表解析失败')

    const text = renderAccDiag(r)
    // B7：告警行必须出现（"读坏了"与"没有条目"是两件事，不得混为一谈）
    expect(text).toContain('⚠ 注册表读取问题:')
    expect(text).toContain('唤醒注册表解析失败')
    // 同时仍给出条目计数行（结构性事实不因读取失败而消失）
    expect(text).toContain('条目: 0 条')
  })

  it('注册表**正常**时不得出现该告警（B7 的反侧／防"永远告警"假绿）', async () => {
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'wake-registry.json'), JSON.stringify({ version: 1, entries: [] }))
    const r = await runAccDiag(fakeCtx() as never, dir)
    expect(r.wakes.error).toBeNull()
    expect(renderAccDiag(r)).not.toContain('注册表读取问题')
  })
})
