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
import { readCheapWorkerConfig } from '../src/ccc.js'

/**
 * cheap-worker（前台委派）。
 *
 * 🆕 2026-10-14（owner 两条令）：
 *  ① 「不允许指定模型，只读取配置」⇒ **没有 `model` 参数**，模型一律来自 CCC 配置；
 *  ② 「删除后台运行能力」⇒ background 模式（循环／完成码／进度文件／重启／并行 jobs 那半）已退场，
 *     本文件随之删掉全部 background 用例（`fakeAgents` / `ctxForBackground` 夹具一并删除
 *     —— 那是**跟着实现一起退场**的断言，不是回归）。
 *
 * 现存契约：单任务委派 / 并行扇出（jobs，cap 10）/ 结果映射 / dispose / 三类拒绝
 * （白名单 · 服务缺失 · 参数非法）/ provider 预检（正控 + 反控 + 取证面不可读时放行）。
 */

let dir = ''
const TOOL = createCheapWorkerTool({} as never) as unknown as {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

/** 写入 CCC 配置（模型白名单）+ .serenity 记号（findSerenityRoot 需要） */
function writeCcc(models: string[], defaultModel?: string): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'home-serenity\n', 'utf-8')
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ 'cheap-worker': { models, ...(defaultModel === undefined ? {} : { defaultModel }) } }),
    'utf-8',
  )
}

/** 替身 subagents 服务：记录请求 + 返回可配的 run 句柄 */
function fakeSubagents(result: Record<string, unknown> = { output: [{ type: 'text', text: 'T-01 OK' }], stopReason: 'completed' }) {
  const calls: { name: string; request: Record<string, unknown> }[] = []
  let disposed = 0
  const runtime = {
    start: async (name: string, request: unknown) => {
      calls.push({ name, request: request as Record<string, unknown> })
      return {
        id: 'child-session-1',
        result: Promise.resolve(result),
        dispose: async () => { disposed++ },
      }
    },
  }
  return { runtime, calls, disposed: () => disposed }
}

function ctxWith(runtime: unknown) {
  return { get: (name: string) => (name === 'subagents' ? runtime : undefined) } as never
}

function execIn(agent: unknown = { session: { header: { cwd: dir } } }) {
  return { agent, signal: new AbortController().signal }
}

/**
 * 替身 llm 服务（`ctx.llm` → `LlmRuntime` 的**取证面**）。
 * ⚠️ 不传时为 `undefined` ⇒ 预检**不阻断**（"增强不得变成新失败源"）。
 */
function fakeLlm(opts: {
  registered?: Array<{ id: string; name?: string }>
  declared?: Array<{ provider: string; displayName?: string; settingsNs?: string }>
} = {}) {
  return {
    listProviders: () => opts.registered ?? [],
    listConfigurableProviders: () => opts.declared ?? [],
  }
}

/** ctx：subagents ＋ llm 两服务可分别注入（用于预检的正/反控） */
function ctxWithLlm(subagentsRuntime: unknown, llm: unknown) {
  return {
    get: (name: string) => (name === 'subagents' ? subagentsRuntime : name === 'llm' ? llm : undefined),
  } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cheap-worker-fg-'))
  writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cheap-worker（一次前台串行委派）', () => {
  it('委派请求形状正确 + 结果映射 + dispose', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute(
      { task: '跑 T-01 用例并回报证据', label: 'T-01' },
      execIn(),
    )
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0].request
    expect(fake.calls[0].name).toBe('spawn')
    expect(req.label).toBe('T-01')
    expect(req.prompt).toEqual([{ type: 'text', text: '跑 T-01 用例并回报证据' }])
    // 模型经 agentOptions 注入（不依赖宿主未放开的模型选择设置）；值来自 CCC 配置
    expect(req.agentOptions).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    // 委派归属 + 取消通道
    expect(req.parent).toEqual({ session: { header: { cwd: dir } } })
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // 递归防护：子 agent 不再持有 cheap-worker
    expect(req.toolFilter).toEqual({ deny: ['cheap-worker'] })
    // 结果映射
    expect(out.mode).toBe('foreground')
    expect(out.done).toBe(true)
    expect(out.model).toBe('minimax-cn-coding-plan/MiniMax-M3')
    expect(out.stopReason).toBe('completed')
    expect(out.output).toBe('T-01 OK')
    expect(out.childId).toBe('child-session-1')
    expect(fake.disposed()).toBe(1)
  })

  /**
   * 🔴 2026-10-14（owner：「不允许指定模型，只读取配置」）：`model` 参数**已不存在**。
   * 双面钉：① 传了它**不生效**（走配置，不是被静默采用）；② schema 里**没有**它。
   */
  it('🔴 传 model 参数不生效：模型仍取自 CCC 配置（且 schema 无此参数）', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'deepseek-official/deepseek-v4-flash'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute({ task: 'x', model: 'deepseek-official/deepseek-v4-flash' }, execIn())
    // 用了配置里的 defaultModel，**不是**传入的那个
    expect(fake.calls[0].request.agentOptions).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    // schema 面：参数表里不得再有 model
    const schema = (TOOL as unknown as { parameters: Record<string, unknown> }).parameters
    expect(Object.keys(schema)).not.toContain('model')
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['task', 'label', 'jobs', 'guide']))
  })

  it('defaultModel 指向白名单外 ⇒ 回落 models[0]（配置层的既有契约）', async () => {
    writeCcc(['a/one', 'b/two'], 'c/not-listed')
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute({ task: 'x' }, execIn())
    expect(fake.calls[0].request.agentOptions).toEqual({ provider: 'a', model: 'one' })
  })

  it('model 无 provider 前缀 → agentOptions 只带 model（不产生空 provider 键）', async () => {
    writeCcc(['MiniMax-M3'], 'MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute({ task: 'x' }, execIn())
    expect(fake.calls[0].request.agentOptions).toEqual({ model: 'MiniMax-M3' })
  })

  it('stopReason 非 completed → done=false + 带 diagnostic（不静默假装成功）+ 仍 dispose', async () => {
    const fake = fakeSubagents({ output: [{ type: 'text', text: '部分产出' }], stopReason: 'error', diagnostic: 'model unavailable' })
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(false)
    expect(out.stopReason).toBe('error')
    expect(out.diagnostic).toBe('model unavailable')
    expect(out.output).toBe('部分产出')
    expect(fake.disposed()).toBe(1)
  })

  it('宿主 subagents 服务缺失 → 响亮报错（并指引 dashboard health）', async () => {
    const tool = createCheapWorkerTool(ctxWith(undefined) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x' }, execIn())).rejects.toThrow(/subagents service unavailable/)
    await expect(tool.execute({ task: 'x' }, execIn())).rejects.toThrow(/dashboard health/)
  })

  it('🔴 并行扇出：每个 job 各起一个子 agent，结果**保持传入顺序**', async () => {
    const fake = fakeSubagents({ output: [{ type: 'text', text: 'R' }], stopReason: 'completed' })
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute(
      {
        jobs: [
          { task: 'a', label: 'A' },
          { task: 'b', label: 'B' },
          { task: 'c' }, // label 可选（只是显示名）
        ],
      },
      execIn(),
    )
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls.map((c) => (c.request.prompt as Array<{ text: string }>)[0]?.text)).toEqual(['a', 'b', 'c'])
    expect(out.mode).toBe('foreground')
    expect(out.done).toBe(true)
    const jobs = out.jobs as Array<Record<string, unknown>>
    expect(jobs).toHaveLength(3)
    expect(jobs.map((j) => j.done)).toEqual([true, true, true])
    expect(jobs.map((j) => j.output)).toEqual(['R', 'R', 'R'])
  })

  it('🔴 并行扇出：每个 job 都用 CCC 配置的同一个模型（无 per-job 覆盖）', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'deepseek-official/deepseek-v4-flash'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute(
      { jobs: [{ task: 'a', model: 'deepseek-official/deepseek-v4-flash' }, { task: 'b' }] },
      execIn(),
    )
    // 传进 job 的 model 被忽略 —— 两个子 agent 都用配置里的 defaultModel
    expect((fake.calls[0]?.request.agentOptions as Record<string, unknown>).model).toBe('MiniMax-M3')
    expect((fake.calls[1]?.request.agentOptions as Record<string, unknown>).model).toBe('MiniMax-M3')
  })

  it('🔴 超过并行上限 10 ⇒ 拒绝且**一个子 agent 都不起**（含 cap 文案）', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const jobs = Array.from({ length: 11 }, (_, i) => ({ task: `t${i}` }))
    await expect(tool.execute({ jobs }, execIn())).rejects.toThrow(/exceed the parallel cap 10/)
    expect(fake.calls).toHaveLength(0) // ← 关键：拒绝发生在创建之前
  })

  it('非法 jobs（非数组 / 空 / 缺 task）⇒ 拒绝', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({ jobs: 'nope' }, execIn())).rejects.toThrow(/jobs must be/)
    await expect(tool.execute({ jobs: [] }, execIn())).rejects.toThrow(/jobs must be/)
    await expect(tool.execute({ jobs: [{ label: 'no-task' }] }, execIn())).rejects.toThrow(/jobs must be/)
    expect(fake.calls).toHaveLength(0)
  })

  it('正控：不传 jobs ⇒ 单任务路径产出单一结果（不产出 jobs 数组）', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'solo' }, execIn())
    expect(fake.calls).toHaveLength(1)
    expect(out.mode).toBe('foreground')
    expect(out.jobs).toBeUndefined() // ← 单任务路径**不**产出 jobs 数组（形状未被污染）
  })

  it('task 缺失 / 空串 ⇒ 拒绝', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({}, execIn())).rejects.toThrow(/task is required/)
    await expect(tool.execute({ task: '   ' }, execIn())).rejects.toThrow(/task is required/)
  })

  /**
   * 🔴 `mode` 参数已随 background 退场 ⇒ 传任何 mode 都**不再被识别**（既不是错误、也不改变行为）。
   * 这里钉的是"它不再是契约的一部分"：传旧值仍走单任务前台路径。
   */
  it('🔴 mode 参数已退场：传旧值不报错、也不改变前台行为', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x', mode: 'background', label: 'bg-1' }, execIn())
    expect(out.mode).toBe('foreground')
    expect(fake.calls).toHaveLength(1)
    const schema = (TOOL as unknown as { parameters: Record<string, unknown> }).parameters
    expect(Object.keys(schema)).not.toContain('mode')
  })

  it('无 exec.agent → 拒绝（委派必须有发起方）', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x' }, { signal: new AbortController().signal })).rejects.toThrow(/calling agent/)
  })

  it('无 CCC 配置（无白名单）⇒ 报错含可照抄的配置样例', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cheap-worker-nocfg-'))
    try {
      mkdirSync(join(bare, '.opencode'), { recursive: true })
      writeFileSync(join(bare, '.serenity'), 'x\n', 'utf-8')
      writeFileSync(join(bare, '.opencode', 'serenity.json'), JSON.stringify({}), 'utf-8')
      const fake = fakeSubagents()
      const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
      await expect(
        tool.execute({ task: 'x' }, { agent: { session: { header: { cwd: bare } } }, signal: new AbortController().signal }),
      ).rejects.toThrow(/requires a model whitelist/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('guide 不创建 agent（表格在场，且不再宣传双模式）', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ guide: true }, execIn())
    expect(String(out.guide)).toContain('Scale-Up Usage Guide')
    expect(String(out.guide)).not.toContain('Two modes')
    expect(fake.calls).toHaveLength(0)
  })
})

/**
 * provider 预检（v1.48，S142 2026-09-25）：owner 在 **Mac** 上实测 `no adapter registered for
 * provider "<p>"` —— provider adapter 由**每台机器的宿主**注册，而白名单写在**随 git 走的 CCC** 里。
 * 本组 pin：① 缺失时**不创建注定失败的子 agent** 且把可执行原因写进 `diagnostic`；
 * ② 有 adapter 时**不误伤**（正控）；③ 取证面不可读时**放行**（增强不得变成新失败源）。
 */
describe('cheap-worker provider 预检（把沉默的失败变成可执行的错误）', () => {
  it('本机没有该 provider 的 adapter ⇒ 不委派 + diagnostic 带完整可执行信息', async () => {
    // 🔴 关键：缺 provider 的那个模型必须是**配置里的 defaultModel**（模型不再由调用方指定，
    //    所以"请求一个本机没有的 provider"只能经配置达成）。它同时必须在白名单内，
    //    否则会先回落 models[0]（那正是本条曾红的原因）。
    writeCcc(['probe-no-adapter/ProbeModel'], 'probe-no-adapter/ProbeModel')
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(
      ctxWithLlm(fake.runtime, fakeLlm({ registered: [{ id: 'minimax-cn-coding-plan', name: 'MiniMax CN' }] })) as never,
    ) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(false)
    expect(out.stopReason).toBe('error')
    const d = String(out.diagnostic)
    expect(d).toContain('no adapter registered on this machine')
    expect(d).toContain('probe-no-adapter')
    expect(d).toContain('Available on this machine')
    expect(d).toContain('minimax-cn-coding-plan')
    expect(d).toContain('cheap-worker.models')
    expect(d).toContain('Do not retry unchanged')
    expect(fake.calls).toHaveLength(0)   // 🔴 关键：不为注定失败的模型创建子 agent
  })

  it('正控：provider 本机有 adapter ⇒ 照常委派（预检不误伤）', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(
      ctxWithLlm(fake.runtime, fakeLlm({ registered: [{ id: 'minimax-cn-coding-plan' }] })) as never,
    ) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })

  it('llm 取证面不可读（旧宿主 / 无该服务）⇒ 预检放行，保持旧行为', async () => {
    const fake = fakeSubagents()
    const tool = createCheapWorkerTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })
})

/**
 * 🆕 2026-10-14（owner 令「配置兼容旧配置 key」）：读新键 `cheap-worker`，**读不到时回落旧键 `handyman`**。
 * 这条在**真实 CCC**上是现役路径 —— 本容器的 `.opencode/serenity.json` **此刻仍写着 `handyman`**。
 */
describe('cheap-worker 配置：新键优先 ＋ 旧键回落（owner 令）', () => {
  function writeRaw(cfg: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify(cfg), 'utf-8')
  }

  it('只有旧键 handyman ⇒ 照常读到（回落生效）', () => {
    writeRaw({ handyman: { models: ['a/one', 'b/two'], defaultModel: 'b/two' } })
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])).toEqual({ models: ['a/one', 'b/two'], defaultModel: 'b/two' })
  })

  it('只有新键 cheap-worker ⇒ 正常读到', () => {
    writeRaw({ 'cheap-worker': { models: ['c/three'] } })
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])).toEqual({ models: ['c/three'], defaultModel: 'c/three' })
  })

  it('🔴 两键都在 ⇒ **新键胜出**（回落只在读不到时发生）', () => {
    writeRaw({
      'cheap-worker': { models: ['new/model'] },
      handyman: { models: ['old/model'], defaultModel: 'old/model' },
    })
    const got = readCheapWorkerConfig(dir, ['.dsh/serenity.json'])!
    expect(got.models).toEqual(['new/model'])
    expect(got.defaultModel).toBe('new/model')
  })

  it('🔴 新键存在但 models 无效（空数组 / 非数组）⇒ 视同"读不到"，回落旧键', () => {
    writeRaw({ 'cheap-worker': { models: [] }, handyman: { models: ['old/model'] } })
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])!.models).toEqual(['old/model'])
    writeRaw({ 'cheap-worker': { models: 'nope' }, handyman: { models: ['old/model'] } })
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])!.models).toEqual(['old/model'])
  })

  it('两键都无效 ⇒ null（工具报错要求配置）', () => {
    writeRaw({ 'cheap-worker': {}, handyman: { models: [] } })
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])).toBeNull()
    writeRaw({})
    expect(readCheapWorkerConfig(dir, ['.dsh/serenity.json'])).toBeNull()
  })

  it('旧键里的 maxRounds / maxParallel 留着无害（已随 background 退场，不再被读）', () => {
    writeRaw({ handyman: { models: ['a/one'], maxRounds: 100, maxParallel: 10 } })
    const got = readCheapWorkerConfig(dir, ['.dsh/serenity.json'])
    expect(got).toEqual({ models: ['a/one'], defaultModel: 'a/one' })
    // 返回形状里**不含**这两个键 —— 它们不是现行契约
    expect(Object.keys(got!)).toEqual(['models', 'defaultModel'])
  })
})
