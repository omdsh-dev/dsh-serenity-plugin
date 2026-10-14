/**
 * cheap-worker-branches.test.ts — `tools/cheap-worker.ts` 的**拒绝面与预检的"不判定"哲学**
 *
 * 🔴 2026-10-14 重写（owner 两条令：删 background ＋ 不许指定模型）：
 * 本文件原作覆盖的是 **background 路径**的校验与两条保险阀（`max_rounds`／`restart_exceeded`）——
 * **那整条路径已随 background 模式删除**，所以那些用例是**跟着实现一起退场**的（不是回归）。
 * 现在本文件只钉**现存**的两类：
 *
 *  **(甲) 拒绝面**（"配置错了要**响亮报错**而不是静默跑错"）：
 *        无 CCC 根 ／ 无白名单配置 ／ task 缺失或空白 ／ jobs 形状非法 ／ 超并行上限。
 *        每一条都必须**在创建任何子 agent 之前**拒绝（`calls` 长度为 0 是判据之一）。
 *
 *  **(乙) provider 预检的"无法取证 ⇒ 不阻断"**：
 *        `listProviders` **形状不符** 或 **抛错** 时必须**放行**（保持旧行为），
 *        因为"增强不得变成新的失败源"。
 *        ⇒ 若有人把 `return null` 误改成"返回错误文案"，**运维面会凭空多出一种失败**。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**：先证"正常委派 ⇒ done=true"，再证各拒绝面 ——
 *    否则无法区分"拒绝面生效"与"夹具压根没跑起来"。
 *  · **失败路径用真故障形态注入**：真缺服务、真写坏配置，不用空转 spy。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { createCheapWorkerTool } from '../src/tools/cheap-worker.js'

let dir = ''

/** 写入 CCC 配置（模型白名单）＋ `.serenity` 记号（`findSerenityRoot` 需要） */
function writeCcc(models: string[], defaultModel?: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'home-serenity\n', 'utf-8')
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ 'cheap-worker': { models, ...(defaultModel === undefined ? {} : { defaultModel }), ...extra } }),
    'utf-8',
  )
}

/** 替身 subagents：记录请求；`registered` 可配（用于预检正/反控） */
function fakeSubagents(result: Record<string, unknown> = { output: [{ type: 'text', text: 'OK' }], stopReason: 'completed' }) {
  const calls: Array<{ name: string; request: Record<string, unknown> }> = []
  const runtime = {
    start: async (name: string, request: unknown) => {
      calls.push({ name, request: request as Record<string, unknown> })
      return { id: 'child-1', result: Promise.resolve(result), dispose: async () => {} }
    },
  }
  return { runtime, calls }
}

function execIn(dirName = dir) {
  return { agent: { session: { header: { cwd: dirName } } }, signal: new AbortController().signal }
}

/** 用指定 ctx 造工具 */
function toolWith(ctx: unknown) {
  return createCheapWorkerTool(ctx as never) as unknown as {
    execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>
  }
}

/** ctx：`subagents` 与 `llm` 分别可注入 */
function ctxFor(subagentsRuntime: unknown, llm?: unknown) {
  return {
    get: (name: string) => (name === 'subagents' ? subagentsRuntime : name === 'llm' ? llm : undefined),
  } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cheap-worker-br-'))
  writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// 正控 — 先证明夹具能跑通全链，否则下面所有"拒绝"都无法定性
// ─────────────────────────────────────────────────────────────────────────────
describe('cheap-worker 分支面: 正控（夹具自证）', () => {
  it('正常委派 ⇒ done=true 且真起了 1 个子 agent', async () => {
    const { runtime, calls } = fakeSubagents()
    const res = await toolWith(ctxFor(runtime)).execute({ task: 't', label: 'ok' }, execIn())
    expect(res.done).toBe(true)
    expect(res.stopReason).toBe('completed')
    expect(calls).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 甲 类 — 拒绝面（一律"响亮且可执行"，且必须在创建子 agent 之前拒绝）
// ─────────────────────────────────────────────────────────────────────────────
describe('cheap-worker 分支面: 甲 参数与环境拒绝面', () => {
  it('🔴 A1：无 CCC 根 ⇒ 报 No CCC found（不静默回落 cwd）', async () => {
    // 真故障形态：cwd 指向一个**祖先链上没有 `.serenity`** 的目录
    const bare = mkdtempSync(join(tmpdir(), 'cheap-worker-noccc-'))
    try {
      const { runtime, calls } = fakeSubagents()
      await expect(
        toolWith(ctxFor(runtime)).execute({ task: 't', label: 'l' }, execIn(bare)),
      ).rejects.toThrow(/No CCC found/)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('🔴 A2：无白名单配置 ⇒ 报错含**可照抄的配置样例**（不是干巴巴一句「缺配置」）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({}), 'utf-8')
    const { runtime, calls } = fakeSubagents()
    // 🔴 断言"可执行性"：文案里要有真实的键名与样例，否则调用方（LLM）无法自我修正
    await expect(toolWith(ctxFor(runtime)).execute({ task: 't' }, execIn())).rejects.toThrow(/whitelist/)
    await expect(toolWith(ctxFor(runtime)).execute({ task: 't' }, execIn())).rejects.toThrow(/"cheap-worker"/)
    expect(calls).toHaveLength(0)
  })

  it('🔴 A3：task 缺失 ／ 空串 ／ 全空白 ⇒ 拒绝（三形态）', async () => {
    const { runtime, calls } = fakeSubagents()
    const t = toolWith(ctxFor(runtime))
    await expect(t.execute({}, execIn())).rejects.toThrow(/task is required/)
    await expect(t.execute({ task: '' }, execIn())).rejects.toThrow(/task is required/)
    await expect(t.execute({ task: '   ' }, execIn())).rejects.toThrow(/task is required/)
    expect(calls).toHaveLength(0)
  })

  it('🔴 A4：jobs 形状非法 ⇒ 拒绝（非数组 ／ 空数组 ／ 元素非对象 ／ 缺 task，四形态）', async () => {
    const { runtime, calls } = fakeSubagents()
    const t = toolWith(ctxFor(runtime))
    await expect(t.execute({ jobs: 'not-an-array' }, execIn())).rejects.toThrow(/jobs must be/)
    await expect(t.execute({ jobs: [] }, execIn())).rejects.toThrow(/jobs must be/)
    await expect(t.execute({ jobs: ['string-item'] }, execIn())).rejects.toThrow(/jobs must be/)
    await expect(t.execute({ jobs: [{ label: 'only-label' }] }, execIn())).rejects.toThrow(/jobs must be/)
    expect(calls).toHaveLength(0)
  })

  it('🔴 A5：超并行上限 ⇒ 拒绝，且**文案含当前上限值**（可自我修正）', async () => {
    const { runtime, calls } = fakeSubagents()
    const jobs = Array.from({ length: 11 }, (_, n) => ({ task: `t${n}`, label: `l${n}` }))
    await expect(toolWith(ctxFor(runtime)).execute({ jobs }, execIn())).rejects.toThrow(/exceed the parallel cap 10/)
    // 🔴 关键：拒绝发生在**创建之前** —— 不能"先起 10 个再报错"
    expect(calls).toHaveLength(0)
  })

  it('🔴 A6：宿主 subagents 服务缺席 ⇒ 响亮报错（不静默空跑）', async () => {
    const t = toolWith(ctxFor(undefined))
    await expect(t.execute({ task: 't' }, execIn())).rejects.toThrow(/subagents service unavailable/)
  })

  it('🔴 A7：无 exec.agent ⇒ 拒绝（委派必须有发起方）', async () => {
    const { runtime, calls } = fakeSubagents()
    await expect(
      toolWith(ctxFor(runtime)).execute({ task: 't' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/calling agent/)
    expect(calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 乙 类 — provider 预检的"无法取证 ⇒ 不阻断"（本组是"不判定"哲学的机械判据）
// ─────────────────────────────────────────────────────────────────────────────
describe('cheap-worker 分支面: 乙 预检的不判定面', () => {
  it('🔴 B1：`listProviders` **形状不符**（非数组）⇒ 预检**放行**（不阻断）', async () => {
    const { runtime, calls } = fakeSubagents()
    // 形状不符 = 旧宿主形态 ⇒ 必须保持旧行为（"增强不得变成新失败源"）
    const llm = { listProviders: () => ({ not: 'an-array' }), listConfigurableProviders: () => [] }
    const res = await toolWith(ctxFor(runtime, llm)).execute({ task: 't' }, execIn())
    // 🔴 断言的是**放行**：若有人把 `return null` 改成报错，运维面会凭空多出一种失败
    expect(res.done).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('🔴 B2：`listProviders` **真抛** ⇒ 预检**放行**（读取失败 ≠ 服务缺失）', async () => {
    const { runtime, calls } = fakeSubagents()
    const llm = {
      listProviders: () => { throw new Error('listProviders boom (injected)') },
      listConfigurableProviders: () => [],
    }
    const res = await toolWith(ctxFor(runtime, llm)).execute({ task: 't' }, execIn())
    expect(res.done).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('🔴 B3：`listConfigurableProviders` **抛错** ⇒ 只少一段建议，**不影响判定**', async () => {
    // registered 里**没有**该 provider ⇒ 会走"缺失"判定；declared 面抛错时仍须给出判定
    const { runtime } = fakeSubagents()
    const llm = {
      listProviders: () => [{ id: 'some-other-provider' }],
      listConfigurableProviders: () => { throw new Error('declared boom (injected)') },
    }
    writeCcc(['probe-no-adapter/ProbeModel'], 'probe-no-adapter/ProbeModel')
    // 🔴 语义：**声明面读不到 ≠ 判定不了** —— 判定基于 registered，声明面只贡献"建议段"。
    //    本机确实没有该 provider ⇒ 仍须**报出可执行原因**（不是静默放行、也不是抛异常）。
    const res = await toolWith(ctxFor(runtime, llm)).execute({ task: 't' }, execIn())
    expect(res.done).toBe(false)
    expect(String(res.diagnostic)).toContain('no adapter registered on this machine')
  })

  it('✅ 对照：`llm` 服务整体缺席 ⇒ 预检放行（"无该服务"与"读失败"同档）', async () => {
    const { runtime, calls } = fakeSubagents()
    const res = await toolWith(ctxFor(runtime, undefined)).execute({ task: 't' }, execIn())
    expect(res.done).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('✅ 未取到 provider（model 串无 "/"）⇒ 不判定（沿用 agent 默认路由）', async () => {
    writeCcc(['MiniMax-M3'], 'MiniMax-M3')
    const { runtime, calls } = fakeSubagents()
    // 即便取证面"什么 adapter 都没有"，无 provider 前缀的 model 也不该被判缺失
    const llm = { listProviders: () => [], listConfigurableProviders: () => [] }
    const res = await toolWith(ctxFor(runtime, llm)).execute({ task: 't' }, execIn())
    expect(res.done).toBe(true)
    expect(calls).toHaveLength(1)
  })
})
