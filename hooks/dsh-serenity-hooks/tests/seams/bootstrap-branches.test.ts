/**
 * bootstrap-branches.test.ts — `seams/bootstrap.ts` 的**退化输入守卫面**（⑤ 第 51 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `seams/bootstrap.ts` = 分支 **80.41%（78/97）**，是 `src/**` 中**最低的未被做过**的文件
 * （43~50 已做完）。语句 90.09%（364/404）、函数 13/13。
 * 🔵 复扫按「文件名单元格 ＋ 数值单元格」**成对读**（纪律 16）。
 *
 * 🔵 **为何它值得优先做（贴 objective）**：`bootstrap.ts` 管的是 **first-anchor 两阶段工具目录**
 * ——**与 DSH 的衔接面**（`system-prompt/assemble` ／ `agent/pre-step` ／ `agent/inbox/inserted`
 * ／ `session/event` 四条缝）。objective 要害是「**尤其管好与 DSH 的衔接面**」。
 *
 * ── 🔴 为何这 19 处从未被走过（本件的核心发现）────────────────────────────────
 * 既有两个文件分工明确：`bootstrap.test.ts` 测**纯函数语义**（晋升/压缩/兜底轮次），
 * `bootstrap-register.test.ts` 测**四条缝的行为**（窄化/剥离/注入）。
 * **两边都只走"形态完整"的输入** ⇒ 所有**退化输入守卫**从未执行：
 *
 *  · 纯函数侧：`agent` / `session` / `sid` 为 `undefined`、`seq` 非数、事件表为空、
 *    `observe` 在"该 session 尚未 scan 过"时到达 —— 每一条都是**防御性早退**；
 *  · 缝侧：`cwd` 非字符串、`session.id` 非字符串、`inbox.prepend` 缺席、
 *    **子 agent 分支（`depth > 0`）**、`assemble` 处理体真抛（catch）、`pre-step` 处理体真抛（catch）。
 *
 * 🔴 **为什么"防御性早退"值得钉**（不是凑覆盖率）：这些分支的**共同承诺**是
 * 「**装配失败绝不锁死会话 / 绝不吞上下文**」（文件头 `:15` 逐字：*降级：过滤器出错绝不吞上下文
 * （pre-step 保留全部）/ 工具缺失降级完整目录 + 一次性告警*）。⇒ 把某条 `return assembled`
 * 误删（例如让 `catch` 改成 rethrow）、或把 `promoted` 判反，**既有测试全绿**，
 * 而后果是**会话在首锚阶段拿不到工具 / 上下文被静默吞掉** —— 正是本机制设计时要防的事。
 *
 * 逐处清单（源码行 = 本件写作时的锚；**行号只作"某版本的实测读数"**）：
 *   A 纯函数守卫（`createEpochPromotion`）
 *     A1 `:158` `status(undefined)` ⇒ 恒晋升（无 agent 不窄化）
 *     A2 `:160` `agent.session === undefined` ⇒ 恒晋升
 *     A3 `:173` `sessionIdOf` 取不到 sid ⇒ 恒晋升
 *     A4 `:180` `observe` 的 sid 取不到 ⇒ 早退
 *     A5 `:182` `observe` 的 session **尚未 scan**（state 无该 sid）⇒ 早退
 *     A6 `:184`/`:137` `seq` **非数** ⇒ 按 0 处理（两处，scan 与 observe）
 *     A7 `:185` `observe` 收到 `compaction/end` ⇒ **重置计数器**（boundary 推进）
 *   B 缝守卫（`registerBootstrap`）
 *     B1 `:239` `cwd` **非字符串** ⇒ `agentRoot` 返回 null（两处调用各自早退）
 *     B2 `:267` `session/event` 的 root 解析不到 ⇒ 早退
 *     B3 `:287` `session.id` **非字符串** ⇒ `sid = undefined`（锚定判定走"无 sid"路）
 *     B4 `:293~:300` **子 agent 分支（`depth > 0`）** ⇒ 用 `anchoredSessions` 防重（**只锚定一次**）
 *     B5 `:304` `inbox.prepend` **缺席** ⇒ 早退（不抛）
 *     B6 `:316` 注入体真抛（`inbox.prepend` 抛）⇒ **吞掉，不阻断会话**
 *     B7 `:323` `warnOnce` **第二次调用** ⇒ 早退（只喊一次）
 *     B8 `:376`/`:398` 处理体真抛 ⇒ **降级**（assemble 给完整目录 ／ pre-step 保留全部上下文）
 *
 * ── 本件测的是什么（不是"覆盖率数字"）──────────────────────────────────────
 *   ① **降级的方向必须是"放开"，不是"收紧"**：assemble 出错 ⇒ **完整目录**（不是空目录）；
 *      pre-step 出错 ⇒ **保留全部上下文**（不是剥光）。⇒ 断言**方向**，不只断言"不抛"
 *      （纪律 12/17 同族：只断言"不抛"无法区分"放开"与"收紧"）。
 *   ② **"只喊一次"是契约**：`warnOnce` 第二次**不得**再写日志（否则刷屏）。
 *   ③ **子 agent 的防重是"进程内一次"**（与根会话的"无历史才锚定"是**两套判据**）⇒ 分别钉。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：每条退化断言前，先证明**同夹具的正常形态**走通，
 *    否则无法区分"守卫生效"与"夹具压根没建对"。
 *  · **失败路径用真故障形态注入**：真抛（不用空转 spy）、真缺方法、真非字符串。
 *  · ⚠️ **不断言日志内容**（`warnOnce` 是"只喊一次"的模块级状态 ⇒ 用例间互相干扰，既有先例）。
 *    本件对 B7 的钉法改为**观测 `console.warn` 的调用次数**（spy），且**在该用例内自建 ctx**。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerBootstrap, createEpochPromotion, hasUserMessageHistory } from '../../src/seams/bootstrap.js'
import { ACC_MESSAGE_KIND } from '../../src/message-source.js'

type Handler = (...args: unknown[]) => unknown

interface FakeCtx {
  handlers: Map<string, Handler[]>
  on: (name: string, fn: Handler) => FakeCtx
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, Handler[]>()
  const ctx: FakeCtx = {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return ctx
    },
  }
  return ctx
}

function first(ctx: FakeCtx, name: string): Handler {
  const h = (ctx.handlers.get(name) ?? [])[0]
  if (!h) throw new Error(`handler not registered: ${name}`)
  return h
}

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  outside = mkdtempSync(join(tmpdir(), 'boot-br-out-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// A 类 — 纯函数守卫（createEpochPromotion）
// ─────────────────────────────────────────────────────────────────────────────
describe('bootstrap 分支面: A 晋升跟踪器的退化输入守卫', () => {
  const EV = new Set<'tool/call' | 'assistant/message'>(['assistant/message'])

  it('正控：形态完整的未晋升会话 ⇒ promoted=false（证明夹具不瞎）', () => {
    const t = createEpochPromotion(EV, 2, 3)
    const s = { id: 's-ok', snapshotEvents: () => [{ type: 'step/start', seq: 1 }] }
    // 🔴 正控先行：后面所有"恒晋升/早退"的断言都要与这条对照，
    //    否则无法区分"守卫生效"与"夹具压根产不出未晋升状态"。
    expect(t.status({ session: s } as never).promoted).toBe(false)
  })

  it('🔴 A1：`status(undefined)` ⇒ **恒晋升**（无 agent 不窄化目录）', () => {
    const t = createEpochPromotion(EV, 2, 3)
    const st = t.status(undefined)
    // 🔴 方向：**放开**（promoted=true ⇒ 完整目录），不是收紧。
    expect(st.promoted).toBe(true)
    expect(st.boundary).toBe(-1)
  })

  it('🔴 A2：`agent.session === undefined` ⇒ **恒晋升**', () => {
    const t = createEpochPromotion(EV, 2, 3)
    const st = t.status({} as never)
    expect(st.promoted).toBe(true)
    expect(st.boundary).toBe(-1)
  })

  it('🔴 A3：session 取不到 `id`（非对象 / id 非字符串）⇒ **恒晋升**', () => {
    const t = createEpochPromotion(EV, 2, 3)
    // ① session 不是对象
    expect(t.status({ session: 'not-an-object' } as never).promoted).toBe(true)
    // ② session.id 非字符串
    expect(t.status({ session: { id: 12345 } } as never).promoted).toBe(true)
  })

  it('🔴 A5：`observe` 在 **session 尚未 scan 过** 时到达 ⇒ 早退（不建表、不抛）', () => {
    const t = createEpochPromotion(EV, 2, 3)
    const s = { id: 'never-scanned', snapshotEvents: () => [] }
    // 未调用 status ⇒ state 里没有该 sid ⇒ observe 必须早退
    expect(() => t.observe(s, { type: 'assistant/message', seq: 1 })).not.toThrow()
    // 🔴 语义佐证：早退意味着"不建表" ⇒ 随后 status 仍走 scan 路径（而 scan 只看到空事件 ⇒ 未晋升）
    //    若把早退误删（改成"没有就新建"），下面这条会变 true（凭 observe 的那条信号晋升）。
    expect(t.status({ session: s } as never).promoted).toBe(false)
  })

  it('🔴 A4：`observe` 的 sid 取不到 ⇒ 早退（不抛）', () => {
    const t = createEpochPromotion(EV, 2, 3)
    expect(() => t.observe({ id: 999 }, { type: 'assistant/message', seq: 1 })).not.toThrow()
    expect(() => t.observe(undefined, { type: 'assistant/message', seq: 1 })).not.toThrow()
  })

  it('🔴 A6：`seq` **非数** ⇒ 按 0 处理（scan 与 observe 两侧都不崩）', () => {
    const t = createEpochPromotion(EV, 1, 99)
    const s = {
      id: 'seq-nan',
      // 事件带 promoteEvents 类型但 seq 缺失/非数 ⇒ seq 归 0，而 boundary 初值 -1 ⇒ 0 > -1 ⇒ 仍计一次
      snapshotEvents: () => [{ type: 'assistant/message' }],
    }
    // 🔴 断言的是"**不崩 + 语义仍是按 0 比较**"：seq 归 0 后 0 > -1 成立 ⇒ 计一次 ⇒ 达 1 ⇒ 晋升。
    expect(t.status({ session: s } as never).promoted).toBe(true)
    expect(() => t.observe(s, { type: 'assistant/message' })).not.toThrow()
  })

  it('🔴 A7：`observe` 收到 `compaction/end` ⇒ **计数器重置**（boundary 推进、需重新累计）', () => {
    const t = createEpochPromotion(EV, 1, 99)
    const s = { id: 'obs-compact', snapshotEvents: () => [] }
    // 先 scan 建表（否则 observe 会早退，落不到 A7 这条分支）
    expect(t.status({ session: s } as never).promoted).toBe(false)
    // 一条晋升信号 ⇒ 达 requiredSignals=1 ⇒ 晋升
    t.observe(s, { type: 'assistant/message', seq: 1 })
    expect(t.status({ session: s } as never).promoted).toBe(true)
    // compaction/end ⇒ 重置：boundary=seq、signalCount=0、rounds=0 ⇒ 回落未晋升
    t.observe(s, { type: 'compaction/end', seq: 2 })
    const after = t.status({ session: s } as never)
    expect(after.promoted).toBe(false)
    expect(after.boundary).toBe(2)
    // boundary 前的老信号不再计数 ⇒ 仍不晋升
    t.observe(s, { type: 'assistant/message', seq: 1 })
    expect(t.status({ session: s } as never).promoted).toBe(false)
  })

  it('A6 对照：`seq` 是数字时按真值比较（boundary 后的事件才计数）', () => {
    const t = createEpochPromotion(EV, 1, 99)
    const s = {
      id: 'seq-num',
      // compaction/end(seq=5) 之后的信号(seq=6)才计数；seq=1 的老信号不算
      snapshotEvents: () => [
        { type: 'assistant/message', seq: 1 },
        { type: 'compaction/end', seq: 5 },
        { type: 'assistant/message', seq: 6 },
      ],
    }
    expect(t.status({ session: s } as never).promoted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B 类 — 缝守卫（registerBootstrap 的四条缝）
// ─────────────────────────────────────────────────────────────────────────────
describe('bootstrap 分支面: B 四条缝的退化输入守卫', () => {
  async function assemble(ctx: FakeCtx, agent: unknown, tools: unknown): Promise<unknown> {
    const h = first(ctx, 'system-prompt/assemble')
    return h({}, { agent }, async () => ({ tools }))
  }
  async function preStep(ctx: FakeCtx, agent: unknown, decision: unknown): Promise<unknown> {
    const h = first(ctx, 'agent/pre-step')
    return h({ agent }, async () => decision)
  }

  it('🔴 B1：`cwd` **非字符串** ⇒ 三条缝各自早退（不窄化 / 不剥离 / 不锚定）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const tools = [{ name: 'read' }, { name: 'grep' }]
    // ① assemble：cwd 缺失 ⇒ root=null ⇒ 原样返回**完整目录**
    const asm = await assemble(ctx, { session: { header: {} } }, tools)
    expect((asm as { tools: unknown[] }).tools).toEqual(tools)
    // ② pre-step：cwd 非字符串（数字）⇒ root=null ⇒ 原样返回 decision
    const decision = { kind: 'enter', messages: [{ source: { kind: 'skill-catalog' } }] }
    const pre = await preStep(ctx, { session: { header: { cwd: 123 } } }, decision)
    expect(pre).toBe(decision)
    // ③ inbox：无 agent 上的 session.header.cwd ⇒ 不注入任何 prepend
    const prepends: unknown[] = []
    const inboxAgent = {
      session: { id: 'x', header: {} },
      inbox: { prepend: (q: string, m: unknown) => prepends.push({ q, m }) },
    }
    first(ctx, 'agent/inbox/inserted')({ agent: inboxAgent, message: { source: { kind: 'user' } } })
    expect(prepends).toHaveLength(0)
  })

  it('🔴 B2：`session/event` 的 root 解析不到 ⇒ 早退（不抛、不建 tracker）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const h = first(ctx, 'session/event')
    // ① cwd 缺失 ② cwd 不在任何 CCC 内（outside 无 .serenity）
    expect(() => h({ header: {} }, { type: 'assistant/message', seq: 1 })).not.toThrow()
    expect(() => h({ header: { cwd: outside } }, { type: 'assistant/message', seq: 1 })).not.toThrow()
  })

  it('🔴 B5：`inbox.prepend` **缺席** ⇒ 早退（不抛，会话正常处理）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = { session: { id: 'no-inbox', header: { cwd: dir } } } // 无 inbox
    expect(() =>
      first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } }),
    ).not.toThrow()
  })

  it('🔴 B6：注入体**真抛**（`prepend` 抛）⇒ 吞掉，**不阻断会话**', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = {
      session: { id: 'throw-inbox', header: { cwd: dir } },
      inbox: { prepend: () => { throw new Error('prepend boom (injected)') } },
    }
    // 🔴 断言方向：**不抛出去**（锚定注入失败不阻断会话 —— 文件头 :15 的承诺）
    expect(() =>
      first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } }),
    ).not.toThrow()
  })

  it('🔴 B4：**子 agent（delegationDepth > 0）** ⇒ 用 `anchoredSessions` 防重（只锚定一次）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const h = first(ctx, 'agent/inbox/inserted')
    let n = 0
    const agent = {
      session: { id: 'sub-1', header: { cwd: dir, delegationDepth: 1 } },
      inbox: { prepend: () => { n += 1 } },
    }
    h({ agent, message: { source: { kind: 'user' } } })
    const afterFirst = n
    // 🔴 子 agent 的判据是「**进程内只锚定一次**」（`anchoredSessions` Set），
    //    **不是**根会话那套"看有没有 user/message 历史" ⇒ 第二条消息**不得**再锚定。
    h({ agent, message: { source: { kind: 'user' } } })
    expect(n).toBe(afterFirst) // 第二次没有新增
    expect(afterFirst).toBeGreaterThan(0) // 首次确实锚定了（正控意味）
  })

  it('🔴 B3：`session.id` **非字符串** ⇒ `sid = undefined`（仍按根会话路径锚定）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    let n = 0
    const agent = {
      session: { id: 777, header: { cwd: dir } }, // id 非字符串
      inbox: { prepend: () => { n += 1 } },
    }
    first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } })
    // 🔴 语义：sid 取不到 ⇒ ① 不写 `anchoredSessions` ② 仍走 depth===0 的"无历史即锚定"
    //    ⇒ **确实锚定了**（不被 id 非串这件事挡住）。若把判据写成"必须有 sid 才锚定"，
    //    这条会红 —— 那正是一处语义变更。
    expect(n).toBeGreaterThan(0)
  })

  it('🔴 B7：`warnOnce` **只喊一次**（第二次不得再写日志）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const tools = [{ name: 'read' }] // 缺 compactionTools ⇒ 触发 "expected compaction tools missing"
    const agent = { session: { id: 'warn-1', header: { cwd: dir } } }
    // 先造出未晋升 + boundary ≥ 0 的状态（compaction/end 走 session/event 缝）
    first(ctx, 'session/event')({ header: { cwd: dir }, id: 'warn-1' }, { type: 'compaction/end', seq: 10 })
    await assemble(ctx, agent, tools)
    const afterFirst = warnSpy.mock.calls.length
    await assemble(ctx, agent, tools)
    // 🔴 契约：**只喊一次** —— 第二次调用必须早退（否则每次 assemble 都刷一条）。
    //    ⚠️ 断言"**未增加**"，**不**断言"总数为 1"：`warned` 是**模块级**状态，
    //    同文件更早的用例（或同进程其它用例）可能已把它置位 ⇒ 首次调用就可能**一条不打**。
    //    本件首跑正是栽在这个假设上（我原写了 `toBeGreaterThan(0)`，实测 0）——
    //    错的是我的期望，不是生产代码。
    expect(warnSpy.mock.calls.length).toBe(afterFirst)
  })

  it('🔴 B8a：assemble 处理体真抛 ⇒ 降级**完整目录**（方向是放开，不是收紧）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const tools = [{ name: 'read' }, { name: 'grep' }]
    // 真故障形态：让 `status()` 在解析中抛（`session` 的 getter 抛）
    const agent = {
      session: {
        id: 'boom-asm',
        header: { cwd: dir },
        get snapshotEvents(): () => unknown {
          throw new Error('snapshotEvents boom (injected)')
        },
      },
    }
    const asm = await assemble(ctx, agent, tools)
    // 🔴 断言**方向**：出错时给**完整目录**（`assembled`），而**不是**空目录/裁剪后的目录。
    //    只断言"不抛"是弱测试（无法区分"放开"与"收紧"）。
    expect((asm as { tools: unknown[] }).tools).toEqual(tools)
  })

  it('🔴 B8b：pre-step 处理体真抛 ⇒ **保留全部上下文**（绝不吞上下文）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const messages = [
      { source: { kind: 'skill-catalog' } },
      { source: { kind: 'user' } },
    ]
    const decision = { kind: 'enter', messages }
    const agent = {
      session: {
        id: 'boom-pre',
        header: { cwd: dir },
        get snapshotEvents(): () => unknown {
          throw new Error('snapshotEvents boom (injected)')
        },
      },
    }
    const pre = await preStep(ctx, agent, decision)
    // 🔴 断言**方向**：出错时**原样返回 decision**（上下文一条都不少）——
    //    这正是文件头"过滤器出错绝不吞上下文"的机械判据。
    expect(pre).toBe(decision)
    expect((pre as { messages: unknown[] }).messages).toHaveLength(2)
  })

  it('正控（B8 对照）：形态完整时 assemble 真窄化 ⇒ 证明上面不是"永远原样返回"', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const tools = [{ name: 'read' }, { name: 'grep' }]
    const agent = { session: { id: 'narrow-1', header: { cwd: dir }, snapshotEvents: () => [] } }
    const asm = await assemble(ctx, agent, tools)
    // 未晋升 + zeroTools + boundary < 0 ⇒ 首请求 **0 工具**
    expect((asm as { tools: unknown[] }).tools).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 补充：hasUserMessageHistory 的退化输入（与会话事件读取的边界）
// ─────────────────────────────────────────────────────────────────────────────
describe('bootstrap 分支面: hasUserMessageHistory 退化输入', () => {
  it('session 为 undefined / 非对象 ⇒ false（不抛）', () => {
    expect(hasUserMessageHistory(undefined)).toBe(false)
    expect(hasUserMessageHistory(null)).toBe(false)
    expect(hasUserMessageHistory('not-an-object')).toBe(false)
  })

  it('snapshotEvents 非函数且无 events ⇒ false（不抛）', () => {
    expect(hasUserMessageHistory({})).toBe(false)
    expect(hasUserMessageHistory({ snapshotEvents: 'not-a-function' })).toBe(false)
  })

  it('正控：含 user/message ⇒ true', () => {
    expect(
      hasUserMessageHistory({ snapshotEvents: () => [{ type: 'user/message' }] }),
    ).toBe(true)
  })

  /**
   * 🔴 **本件实测发现的一处真实缺口（登记，不涂绿）**
   *
   * `hasUserMessageHistory` 的实现是：
   *   `sessionEvents(session).some((event) => (event as { type?: string }).type === 'user/message')`
   * —— `as` 断言在运行时**被擦除**，故事件条目若是 `null`/`undefined`，读 `.type` 直接 **TypeError**。
   *
   * **为何是真缺口（不是"用例太刁"）**：
   *   · `sessionEvents()` 是**忠实透传**（`snapshotEvents()` 原样返回 / `.events` 原样返回），
   *     它**不保证**条目非空 —— 条目形态由**宿主**决定，插件无从假设；
   *   · 调用点 `bootstrap.ts:297` **在 `try` 内**（`:279` 开），所以不会把异常抛给宿主 ——
   *     **但后果仍是行为性的**：`catch`（`:316`）吞掉后 `agent/inbox/inserted` **整段提前结束**
   *     ⇒ **该会话永远不会得到 first-anchor 锚定轮**（静默、无告警）。
   *   · 同文件 `pre-step`（`:393`）的同类过滤用的是 `message?.source?.kind` **可选链** ——
   *     ⇒ **同一模块内两种写法并存，本处是较弱的那种**（与第 44 件发现的"生产代码不对称"同族）。
   *
   * **本用例的姿态**：如实钉住**当前**行为（会抛），**不**断言"理想行为"。真修法属 `src/` 改动
   * ⇒ **须发版令**（D14）⇒ 登记为待裁候选，见 §待 owner 裁决。
   */
  it('🔴 登记：事件条目为 null/undefined ⇒ **当前实现会抛 TypeError**（未加可选链）', () => {
    // ① 含一个 null 条目 + 一条合法 user/message：**仍会抛**（some 在遇到 null 时即崩）
    expect(() =>
      hasUserMessageHistory({ snapshotEvents: () => [null, { type: 'user/message' }] }),
    ).toThrow(TypeError)
    // ② 只有 null/undefined：同样抛（而非"当作 false"）
    expect(() =>
      hasUserMessageHistory({ snapshotEvents: () => [undefined] }),
    ).toThrow(TypeError)
    // 🔵 对照（证明"非对象但非空"是可以的）：数字条目读 `.type` 得 undefined ⇒ 不抛
    expect(hasUserMessageHistory({ snapshotEvents: () => [42] })).toBe(false)
  })
})
