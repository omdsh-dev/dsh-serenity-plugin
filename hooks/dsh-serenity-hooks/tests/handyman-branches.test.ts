/**
 * handyman-branches.test.ts — `tools/handyman.ts` 的**守卫面与保险阀**（⑤ 第 49 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `tools/handyman.ts` = 分支 **76.42%（107/140）**，是 `src/**` 中**最低的未被做过**的文件
 * （43 `diag-ops` ／ 44 `compact` ／ 45 `lifecycle` ／ 46 `seams/context` ／ 47 `weixin-hook` ／
 *  48 `wake-scheduler` 已做完）。语句 92.96%（502/540）、函数 11/11。
 *
 * ⚠️ **复扫纠错（本件顺手做的一次验证）**：本轮初查时我把 `src/seams/index.html` 里
 * **80.41% 那一行**读成了 `agent-idle.ts` 的读数，据此一度准备去补 `agent-idle.ts`。
 * **实测推翻**：该行属 **`seams/bootstrap.ts`**（分支 78/97）；而 `agent-idle.ts` 早已
 * **三项全 100%**（83/83 语句 ／ 22/22 分支 ／ 3/3 函数）。
 * ⇒ 🔵 **教训（与纪律 2 同族，但形态更细）**：**读覆盖率表必须"文件名单元格 + 数值单元格"成对读** ——
 *   只读 `data-value` 那一列会**张冠李戴**（表格是 `<tr>` 组织，数值列本身不带文件身份）。
 *
 * ── 🔴 为何这些分支从未被走过（本件的核心发现）──────────────────────────────
 * 未覆盖的分支集中在**两类**，而既有 `handyman-foreground.test.ts`（314 行）虽已覆盖
 * 前台正路与三类拒绝，**这两类都不是它的对象**：
 *
 *  **(甲) 参数校验的"拒绝面"**（`:443`/`:446`/`:455`/`:503`/`:507`…）：既有用例只测了
 *        前台的三类拒绝（白名单／服务缺失／传 jobs）。**后台路径**的校验分支
 *        （`jobs` 形状非法、单 job 缺 task/label、超 maxParallel、`ctx.agents` 缺席、
 *        无 CCC 根、无 handyman 配置）**一次都没跑过** ⇒ 把某条 `throw` 误删／条件写反，
 *        **没有任何测试会红**，而它们正是"配置错了要**响亮报错**而不是静默跑错"的判据。
 *
 *  **(乙) 两条保险阀 ＋ 一条"不判定"哲学**（`:317`/`:330` ＋ `:155~:174`）：
 *        · 🔴 **轮次上限保险阀**（`max_rounds`）：防 worker 永不回显完成码时**死循环**；
 *        · 🔴 **重启上限保险阀**（`restart_exceeded`）：防 worker 反复异常时**无限重启**；
 *        · 🔴 **provider 预检的"无法取证 ⇒ 不阻断"**：`listProviders` **形状不符**或**抛错**时
 *          必须**放行**（保持旧行为），因为"增强不得变成新的失败源"（`:146-151` 逐字）。
 *        ⇒ 这三处的共同点是：**它们是"永远不会发生的坏事"发生时的唯一防线**，
 *          而**永远不会发生**正是它们从不被执行的原因。
 *
 * 逐处清单（源码行 = 本件写作时的锚；**行号只作"某版本的实测读数"**）：
 *   A 类（参数校验拒绝面）
 *     A1 :443 无 CCC 根 ⇒ `NO_CCC_FROM_AGENT_CWD`
 *     A2 :446 无 handyman 配置 ⇒ 报错含**可照抄的配置样例**
 *     A3 :455 非法 mode ⇒ 拒绝（且**不得**被前面的分支吞掉）
 *     A4 :489 `jobs` 形状非法（非数组／空数组／元素非对象／缺 task 或 label）⇒ 拒绝
 *     A5 :494 单 job 缺 task 或 label ⇒ 拒绝
 *     A6 :503 `jobs.length === 0` ⇒ 拒绝
 *     A7 :505 超 `maxParallel` ⇒ 拒绝（**含当前上限值**，便于调用方自我修正）
 *     A8 :507 `jobs` 中某项缺字段 ⇒ 拒绝
 *   B 类（保险阀 ＋ 不判定）
 *     B1 :317 **轮次上限** ⇒ `finishReason='max_rounds'` ＋ 失败状态落盘 ＋ `done=false`
 *     B2 :330 **重启上限** ⇒ `finishReason='restart_exceeded'` ＋ 失败状态落盘
 *     B3 :159 `listProviders` **形状不符** ⇒ 预检**放行**（不阻断）
 *     B4 :163 `listProviders` **抛错** ⇒ 预检**放行**（不阻断）
 *     B5 :172 `listConfigurableProviders` **抛错** ⇒ 只是少一段建议，**不影响判定**
 *     B6 :343 **未回显完成码** ⇒ 不算完成，继续下一轮（检查 `round++` 真发生）
 *
 * ── 本件测的是什么（不是"覆盖率数字"）──────────────────────────────────────
 *   ① **保险阀的语义**：终止时**必须**留下 `finishReason` 与**失败状态文件** ——
 *      这是"可续跑"的前提（主人据它知道"为什么停了、怎么接着跑"）。
 *      只断言"停了"是弱测试：无法区分"保险阀生效"与"崩了"。
 *   ② **"不判定"哲学的机械判据**：取证面坏了 ⇒ **放行**，而**不是**拒绝。
 *      ⇒ 若有人把 `return null` 误改成 `return 错误文案`，**运维面会凭空多出一种失败**。
 *   ③ **拒绝面要"响亮且可执行"**：错误文案须含**当前配置值**或**可照抄的样例**。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：B 类先证"正常完成 ⇒ `finishReason='done'`"，
 *    再证两条保险阀 —— 否则无法区分"保险阀生效"与"夹具压根没跑起来"。
 *  · **失败路径用真故障形态注入**：真抛、真缺服务、真写坏配置，不用空转 spy。
 *  · **每处注入前先确认会落到源码哪一行**（累积纪律 14／15，第 47/48 件的教训）。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { createHandymanTool } from '../src/tools/handyman.js'
import { handymanProgressPaths } from '../src/handyman-ops.js'

let dir = ''

/** 写入 CCC 配置（模型白名单）＋ `.serenity` 记号（`findSerenityRoot` 需要） */
function writeCcc(models: string[], defaultModel?: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'home-serenity\n', 'utf-8')
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ handyman: { models, ...(defaultModel === undefined ? {} : { defaultModel }), ...extra } }),
    'utf-8',
  )
}

/**
 * 替身 agents 服务（background）。
 * `roundsBeforeDone` = 回显完成码之前**空转几轮**（用于逼出保险阀）。
 * `throwEveryRound` = 每轮 `followup` 都真抛（用于逼出重启上限）。
 */
function fakeAgents(opts: { roundsBeforeDone?: number; throwEveryRound?: boolean } = {}) {
  const created: Record<string, unknown>[] = []
  let disposed = 0
  const runtime = {
    create: async (options: Record<string, unknown>) => {
      created.push(options)
      let events: unknown[] = []
      let round = 0
      const agent = {
        status: 'idle',
        session: { id: options.sessionId, snapshotEvents: () => events },
        followup: (message: { content?: Array<{ text?: string }> }) => {
          round += 1
          if (opts.throwEveryRound) throw new Error('followup boom (injected)')
          const text = (message?.content ?? []).map((b) => b.text ?? '').join('')
          const token = /SERENITY_HANDYMAN_DONE_[0-9a-f]+/.exec(text)?.[0] ?? ''
          const reached = round >= (opts.roundsBeforeDone ?? 1)
          // 未达阈值 ⇒ 回一段**不含完成码**的文本（逼出"继续下一轮"）；达成 ⇒ 回显完成码
          events = [{
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: reached ? `done ${token}` : '还在做' }] } },
          }]
        },
      }
      return { agent, dispose: async () => { disposed += 1 } }
    },
  }
  return { runtime, created, disposed: () => disposed }
}

/** ctx（background）：`ctx.agents` 是**属性**；`llm` 走 `ctx.get` */
function ctxForBackground(agentsRuntime: unknown, llm?: unknown, label = 'llm') {
  return {
    agents: agentsRuntime,
    get: (name: string) => (name === label ? llm : undefined),
  } as never
}

/** 替身 llm 取证面：`registered`／`declared` 可分别注入"形状不符"或"真抛" */
function fakeLlm(opts: {
  registered?: unknown
  declared?: unknown
  throwOnList?: boolean
  throwOnDeclared?: boolean
} = {}) {
  return {
    listProviders: () => {
      if (opts.throwOnList) throw new Error('listProviders boom (injected)')
      return opts.registered ?? [{ id: 'minimax-cn-coding-plan' }]
    },
    listConfigurableProviders: () => {
      if (opts.throwOnDeclared) throw new Error('listDeclared boom (injected)')
      return opts.declared ?? []
    },
  }
}

function tool() {
  return createHandymanTool({} as never) as unknown as {
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
  }
}

function execIn(dirName = dir) {
  return { agent: { session: { header: { cwd: dirName } } } }
}

/** 读失败状态文件（保险阀必须留下它 —— "可续跑"的前提） */
function readFailedJson(label: string): Record<string, unknown> | null {
  const { json } = handymanProgressPaths(dir, label)
  if (!existsSync(json)) return null
  return JSON.parse(readFileSync(json, 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handyman-br-'))
  writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// A 类 — 参数校验的拒绝面（"配置错了要响亮报错，不是静默跑错"）
// ─────────────────────────────────────────────────────────────────────────────
describe('handyman 分支面: A 参数校验拒绝面', () => {
  it('🔴 A1：无 CCC 根 ⇒ 报 NO_CCC_FROM_AGENT_CWD（不静默回落 cwd）', async () => {
    // 真故障形态：cwd 指向一个**祖先链上没有 `.serenity`** 的目录
    const bare = mkdtempSync(join(tmpdir(), 'handyman-noccc-'))
    try {
      await expect(
        tool().execute({ mode: 'background', task: 't', label: 'l' }, execIn(bare)),
      ).rejects.toThrow(/No CCC found/)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('🔴 A2：无 handyman 配置 ⇒ 报错含**可照抄的配置样例**（不是干巴巴一句"缺配置"）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({}), 'utf-8')
    const p = tool().execute({ mode: 'background', task: 't', label: 'l' }, execIn())
    await expect(p).rejects.toThrow(/whitelist/)
    // 🔴 断言"可执行性"：文案里要有真实的键名与样例，否则调用方（LLM）无法自我修正
    await expect(
      tool().execute({ mode: 'background', task: 't', label: 'l' }, execIn()),
    ).rejects.toThrow(/handyman/)
  })

  it('🔴 A3：非法 mode ⇒ 拒绝（不得被缺省值吞掉）', async () => {
    await expect(
      tool().execute({ mode: 'bogus', task: 't', label: 'l' }, execIn()),
    ).rejects.toThrow(/mode must be/)
  })

  it('🔴 A4：jobs 形状非法 ⇒ 拒绝（非数组 / 空数组 / 元素非对象 / 缺字段，四形态）', async () => {
    const t = tool()
    // ① 非数组
    await expect(
      t.execute({ mode: 'background', jobs: 'not-an-array' }, execIn()),
    ).rejects.toThrow(/jobs must be/)
    // ② 空数组（`parseJobs` 的 `raw.length === 0` 真侧）
    await expect(
      t.execute({ mode: 'background', jobs: [] }, execIn()),
    ).rejects.toThrow(/jobs must be/)
    // ③ 元素非对象（`typeof item !== 'object'` 真侧）
    await expect(
      t.execute({ mode: 'background', jobs: ['string-item'] }, execIn()),
    ).rejects.toThrow(/jobs must be/)
    // ④ 元素缺 task/label
    await expect(
      t.execute({ mode: 'background', jobs: [{ task: 'only-task' }] }, execIn()),
    ).rejects.toThrow(/jobs must be/)
  })

  it('🔴 A5：单 job 缺 task 或 label ⇒ 拒绝', async () => {
    const t = tool()
    await expect(
      t.execute({ mode: 'background', task: 'has-task' }, execIn()),
    ).rejects.toThrow(/task and label are required/)
    await expect(
      t.execute({ mode: 'background', label: 'has-label' }, execIn()),
    ).rejects.toThrow(/task and label are required/)
  })

  it('🔴 A7：超 maxParallel ⇒ 拒绝，且**文案含当前上限值**（可自我修正）', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3', { maxParallel: 2 })
    const jobs = [1, 2, 3].map((n) => ({ task: `t${n}`, label: `l${n}` }))
    await expect(
      tool().execute({ mode: 'background', jobs }, execIn()),
    ).rejects.toThrow(/exceed maxParallel 2/)
  })

  it('🔴 A6/direct：`ctx.agents` 缺席 ⇒ 响亮报错（不静默空跑）', async () => {
    // 单 job 后台模式：ctx 无 agents 属性 ⇒ runHandymanJob 里 `if (!ctx.agents)` 真侧
    const ctxNoAgents = { get: () => undefined } as never
    const t = createHandymanTool(ctxNoAgents) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
    await expect(
      t.execute({ mode: 'background', task: 't', label: 'l' }, execIn()),
    ).rejects.toThrow(/ctx\.agents unavailable/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B 类 — 两条保险阀 ＋ "不判定"哲学（本件主靶）
// ─────────────────────────────────────────────────────────────────────────────
describe('handyman 分支面: B 保险阀与不判定', () => {
  /** 用指定 ctx 造工具（**不是** `tool()` —— 那个闭包捕获的是空 ctx） */
  function toolWith(ctx: unknown) {
    return createHandymanTool(ctx as never) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
  }

  it('正控：worker 当轮回显完成码 ⇒ finishReason=done（证明夹具能跑通全链）', async () => {
    const { runtime } = fakeAgents()
    const res = await toolWith(ctxForBackground(runtime)).execute(
      { mode: 'background', task: 't', label: 'ok' },
      execIn(),
    ) as { jobs: Array<Record<string, unknown>> }
    // 🔴 正控先行：证明"后台全链能跑通"。若这条红了，下面两条保险阀的断言
    //    就无法区分"保险阀生效"与"夹具压根没跑起来"。
    expect(res.jobs[0]?.finishReason).toBe('done')
    expect(res.jobs[0]?.done).toBe(true)
  })

  it('🔴 B6：worker **不回显完成码** ⇒ 不算完成，继续下一轮（round++ 真发生）', async () => {
    // roundsBeforeDone=3 ⇒ 前两轮无完成码，第三轮回显 ⇒ rounds 应到 3
    const { runtime } = fakeAgents({ roundsBeforeDone: 3 })
    const res = await toolWith(ctxForBackground(runtime)).execute(
      { mode: 'background', task: 't', label: 'multi' },
      execIn(),
    ) as { jobs: Array<Record<string, unknown>> }
    // 🔴 语义：**完成码是唯一正常结束判据** —— agent 自报"还在做"时不得提前收工。
    //    断言 rounds=3 而非仅 done=true：后者无法区分"真跑了三轮"与"一轮就蒙对"。
    expect(res.jobs[0]?.rounds).toBe(3)
    expect(res.jobs[0]?.done).toBe(true)
  })

  it('🔴 B1：**轮次上限保险阀** ⇒ max_rounds ＋ 失败状态落盘 ＋ done=false', async () => {
    // maxRounds=2 ＋ worker 永不回显完成码 ⇒ 必须被保险阀终止，**不能死循环**
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3', { maxRounds: 2 })
    const { runtime } = fakeAgents({ roundsBeforeDone: 999 })
    const res = await toolWith(ctxForBackground(runtime)).execute(
      { mode: 'background', task: 't', label: 'capped' },
      execIn(),
    ) as { done: boolean; jobs: Array<Record<string, unknown>> }
    expect(res.jobs[0]?.finishReason).toBe('max_rounds')
    expect(res.jobs[0]?.done).toBe(false)
    // 🔴 关键：保险阀终止**必须留下失败状态文件** —— 那是"可续跑"的前提
    //    （只断言 finishReason 是弱的：无法区分"落了盘"与"只在内存里改了字段"）
    const failed = readFailedJson('capped')
    expect(failed).not.toBeNull()
    expect(failed?.errorCode).toBe('max_rounds')
    expect(String(failed?.errorMessage ?? '')).toContain('resume')
  })

  it('🔴 B2：**重启上限保险阀** ⇒ restart_exceeded ＋ 失败状态落盘', async () => {
    // followup 每轮真抛 ⇒ 走重启路径；重启上限 100 次后必须终止（**不得无限重启**）
    const { runtime, created } = fakeAgents({ throwEveryRound: true })
    const res = await toolWith(ctxForBackground(runtime)).execute(
      { mode: 'background', task: 't', label: 'restart' },
      execIn(),
    ) as { jobs: Array<Record<string, unknown>> }
    expect(res.jobs[0]?.finishReason).toBe('restart_exceeded')
    expect(res.jobs[0]?.done).toBe(false)
    expect(Number(res.jobs[0]?.restarts)).toBeGreaterThan(0)
    // 佐证"真重启过"：create 被调用多次（首次 + 每次重启）
    expect(created.length).toBeGreaterThan(1)
    const failed = readFailedJson('restart')
    expect(failed?.errorCode).toBe('restart_exceeded')
  }, 60_000)

  it('🔴 B3：`listProviders` **形状不符**（非数组）⇒ 预检**放行**（不阻断）', async () => {
    const { runtime } = fakeAgents()
    // 形状不符 = 旧宿主形态 ⇒ 必须保持旧行为（"增强不得变成新失败源"）
    const ctx = ctxForBackground(runtime, fakeLlm({ registered: { not: 'an-array' } }))
    const t = createHandymanTool(ctx) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
    const res = await t.execute({ mode: 'background', task: 't', label: 'shape' }, execIn()) as { jobs: Array<Record<string, unknown>> }
    // 🔴 断言的是**放行**：若有人把 `return null` 改成报错，运维面会凭空多出一种失败
    expect(res.jobs[0]?.finishReason).toBe('done')
  })

  it('🔴 B4：`listProviders` **真抛** ⇒ 预检**放行**（读取失败 ≠ 服务缺失）', async () => {
    const { runtime } = fakeAgents()
    const ctx = ctxForBackground(runtime, fakeLlm({ throwOnList: true }))
    const t = createHandymanTool(ctx) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
    const res = await t.execute({ mode: 'background', task: 't', label: 'threw' }, execIn()) as { jobs: Array<Record<string, unknown>> }
    expect(res.jobs[0]?.finishReason).toBe('done')
  })

  it('🔴 B5：`listConfigurableProviders` **抛错** ⇒ 只少一段建议，**不影响判定**', async () => {
    const { runtime } = fakeAgents()
    // registered 里**没有**该 provider ⇒ 会走"缺失"判定；declared 面抛错时仍须给出判定
    const llm = {
      listProviders: () => [{ id: 'some-other-provider' }],
      listConfigurableProviders: () => { throw new Error('declared boom (injected)') },
    }
    const ctx = ctxForBackground(runtime, llm)
    const t = createHandymanTool(ctx) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
    // 🔴 语义：**声明面读不到 ≠ 判定不了** —— 判定基于 registered，声明面只贡献"建议段"。
    //    本机确实没有该 provider ⇒ 仍须**抛可执行错误**（不是静默放行）。
    await expect(
      t.execute({ mode: 'background', task: 't', label: 'decl-threw' }, execIn()),
    ).rejects.toThrow(/probe|adapter|provider/i)
  })

  it('✅ 对照：`llm` 服务整体缺席 ⇒ 预检放行（"无该服务"与"读失败"同档）', async () => {
    const { runtime } = fakeAgents()
    const ctx = ctxForBackground(runtime, undefined)
    const t = createHandymanTool(ctx) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
    }
    const res = await t.execute({ mode: 'background', task: 't', label: 'nollm' }, execIn()) as { jobs: Array<Record<string, unknown>> }
    expect(res.jobs[0]?.finishReason).toBe('done')
  })
})
