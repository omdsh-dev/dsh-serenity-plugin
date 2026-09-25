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

import { createHandymanTool } from '../src/tools/handyman.js'

/**
 * handyman foreground 模式（v1.31.3，S142 用户裁决：handyman 双模式）。
 *
 * 覆盖：缺省模式 / 委派请求形状（agentOptions·parent·signal·toolFilter）/ 结果映射
 * （completed vs 非 completed）/ dispose 必调 / 三类拒绝（白名单·服务缺失·foreground 传 jobs）。
 * background 路径不在本文件（需 ctx.agents 全链路，属既有实现，未改动）。
 */

let dir = ''
const TOOL = createHandymanTool({} as never) as unknown as {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

/** 写入 CCC 配置（模型白名单）+ .serenity 记号（findSerenityRoot 需要） */
function writeCcc(models: string[], defaultModel?: string): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'home-serenity\n', 'utf-8')
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ handyman: { models, ...(defaultModel === undefined ? {} : { defaultModel }) } }),
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

/**
 * 替身 agents 服务（**background 路径**）：记录 `create` 参数；worker 从**本轮 prompt** 里取出
 * stop token 回显 ⇒ **1 轮即完成**（确定性，不依赖真实模型）。
 */
function fakeAgents() {
  const created: Record<string, unknown>[] = []
  const runtime = {
    create: async (options: Record<string, unknown>) => {
      created.push(options)
      let events: unknown[] = []
      const agent = {
        status: 'idle',
        session: { id: options.sessionId, snapshotEvents: () => events },
        followup: (message: { content?: Array<{ text?: string }> }) => {
          const text = (message?.content ?? []).map((b) => b.text ?? '').join('')
          const token = /SERENITY_HANDYMAN_DONE_[0-9a-f]+/.exec(text)?.[0] ?? ''
          events = [{
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: `done ${token}` }] } },
          }]
        },
      }
      return { agent, dispose: async () => {} }
    },
  }
  return { runtime, created }
}

/** ctx（background）：`ctx.agents` 为**属性**（runHandymanJob 直接读属性），llm 走 `ctx.get` */
function ctxForBackground(agentsRuntime: unknown, llm?: unknown) {
  return {
    agents: agentsRuntime,
    get: (name: string) => (name === 'agents' ? agentsRuntime : name === 'llm' ? llm : undefined),
  } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handyman-fg-'))
  writeCcc(['minimax-cn-coding-plan/MiniMax-M3'], 'minimax-cn-coding-plan/MiniMax-M3')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('handyman foreground（缺省模式：一次前台串行委派）', () => {
  it('缺省（不传 mode）走 foreground：委派请求形状正确 + 结果映射 + dispose', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute(
      { task: '跑 T-01 用例并回报证据', label: 'T-01' },
      execIn(),
    )
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0].request
    expect(fake.calls[0].name).toBe('spawn')
    expect(req.label).toBe('T-01')
    expect(req.prompt).toEqual([{ type: 'text', text: '跑 T-01 用例并回报证据' }])
    // 模型经 agentOptions 注入（不依赖宿主未放开的模型选择设置）
    expect(req.agentOptions).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    // 委派归属 + 取消通道
    expect(req.parent).toEqual({ session: { header: { cwd: dir } } })
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // 递归防护：子 agent 不再持有 handyman
    expect(req.toolFilter).toEqual({ deny: ['handyman'] })
    // 结果映射
    expect(out.mode).toBe('foreground')
    expect(out.done).toBe(true)
    expect(out.model).toBe('minimax-cn-coding-plan/MiniMax-M3')
    expect(out.stopReason).toBe('completed')
    expect(out.output).toBe('T-01 OK')
    expect(out.childId).toBe('child-session-1')
    expect(fake.disposed()).toBe(1)
  })

  it('显式 mode="foreground" 与缺省等价；model 参数覆盖缺省模型', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'deepseek-official/deepseek-v4-flash'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute({ mode: 'foreground', task: 'x', model: 'deepseek-official/deepseek-v4-flash' }, execIn())
    expect(fake.calls[0].request.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('model 无 provider 前缀 → agentOptions 只带 model（不产生空 provider 键）', async () => {
    writeCcc(['MiniMax-M3'], 'MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await tool.execute({ task: 'x' }, execIn())
    expect(fake.calls[0].request.agentOptions).toEqual({ model: 'MiniMax-M3' })
  })

  it('stopReason 非 completed → done=false + 带 diagnostic（不静默假装成功）+ 仍 dispose', async () => {
    const fake = fakeSubagents({ output: [{ type: 'text', text: '部分产出' }], stopReason: 'error', diagnostic: 'model unavailable' })
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(false)
    expect(out.stopReason).toBe('error')
    expect(out.diagnostic).toBe('model unavailable')
    expect(out.output).toBe('部分产出')
    expect(fake.disposed()).toBe(1)
  })

  it('模型不在白名单 → 拒绝且不调用委派（错误含可用白名单）', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x', model: 'other/model' }, execIn())).rejects.toThrow(/whitelist|handyman\.models/)
    expect(fake.calls).toHaveLength(0)
  })

  it('宿主 subagents 服务缺失 → 响亮报错并指引 background 模式', async () => {
    const tool = createHandymanTool(ctxWith(undefined) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x' }, execIn())).rejects.toThrow(/subagents service unavailable/)
    await expect(tool.execute({ task: 'x' }, execIn())).rejects.toThrow(/mode="background"/)
  })

  it('foreground 传 jobs → 拒绝（jobs 属 background）', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x', jobs: [{ task: 'a', label: 'a' }] }, execIn())).rejects.toThrow(/background-only/)
  })

  it('task 缺失 / 非法 mode → 拒绝', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({}, execIn())).rejects.toThrow(/task is required/)
    await expect(tool.execute({ task: 'x', mode: 'nope' }, execIn())).rejects.toThrow(/mode must be/)
  })

  it('无 exec.agent → 拒绝（委派必须有发起方）', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    await expect(tool.execute({ task: 'x' }, { signal: new AbortController().signal })).rejects.toThrow(/calling agent/)
  })

  it('guide 不创建 agent（两模式表格在场）', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ guide: true }, execIn())
    expect(String(out.guide)).toContain('Two modes (v1.31.3; default = foreground)')
    expect(fake.calls).toHaveLength(0)
  })
})

/**
 * provider 预检（v1.48，S142 2026-09-25）：owner 在 **Mac** 上实测 `no adapter registered for
 * provider "<p>"` —— provider adapter 由**每台机器的宿主**注册，而白名单写在**随 git 走的 CCC** 里。
 * 本组 pin：① 缺失时**不创建注定失败的子 agent** 且把可执行原因写进 `diagnostic`；
 * ② 有 adapter 时**不误伤**（正控）；③ 取证面不可读时**放行**（增强不得变成新失败源）。
 */
describe('handyman provider 预检（把沉默的失败变成可执行的错误）', () => {
  it('本机没有该 provider 的 adapter ⇒ 不委派 + diagnostic 带完整可执行信息', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'probe-no-adapter/ProbeModel'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeSubagents()
    const tool = createHandymanTool(
      ctxWithLlm(fake.runtime, fakeLlm({ registered: [{ id: 'minimax-cn-coding-plan', name: 'MiniMax CN' }] })) as never,
    ) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x', model: 'probe-no-adapter/ProbeModel' }, execIn())
    expect(out.done).toBe(false)
    expect(out.stopReason).toBe('error')
    const d = String(out.diagnostic)
    expect(d).toContain('no adapter registered on this machine')
    expect(d).toContain('probe-no-adapter')
    expect(d).toContain('Available on this machine')
    expect(d).toContain('minimax-cn-coding-plan')
    expect(d).toContain('handyman.models')
    expect(d).toContain('Do not retry unchanged')
    expect(fake.calls).toHaveLength(0)   // 🔴 关键：不为注定失败的模型创建子 agent
  })

  it('正控：provider 本机有 adapter ⇒ 照常委派（预检不误伤）', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(
      ctxWithLlm(fake.runtime, fakeLlm({ registered: [{ id: 'minimax-cn-coding-plan' }] })) as never,
    ) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })

  it('llm 取证面不可读（旧宿主 / 无该服务）⇒ 预检放行，保持旧行为', async () => {
    const fake = fakeSubagents()
    const tool = createHandymanTool(ctxWith(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ task: 'x' }, execIn())
    expect(out.done).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })
})

/**
 * 🔴 后台**单 job** 的 `model` 透传（v1.48 修复的真因）：此前只构造 `{task,label}` ⇒
 * `runHandymanJob` 回落 `defaultModel`，**调用方指定的模型被静默忽略**。实测形态：传
 * `probe-no-adapter/ProbeModel`，实际跑 `defaultModel` ⇒ 在 provider 不同的机器上必然起不来。
 */
describe('handyman background 单 job 的 model 透传（真因修复）', () => {
  it('🔴 显式 model 必须进 agentOptions（不再静默回退 defaultModel）', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'deepseek-official/deepseek-v4-flash'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeAgents()
    const tool = createHandymanTool(ctxForBackground(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute(
      { mode: 'background', task: 'x', label: 'bg-1', model: 'deepseek-official/deepseek-v4-flash' },
      execIn(),
    )
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0].agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const jobs = out.jobs as Array<Record<string, unknown>>
    expect(jobs[0].model).toBe('deepseek-official/deepseek-v4-flash')
    expect(jobs[0].done).toBe(true)
  })

  it('不传 model ⇒ 仍用 defaultModel（缺省路径行为不变）', async () => {
    const fake = fakeAgents()
    const tool = createHandymanTool(ctxForBackground(fake.runtime) as never) as unknown as typeof TOOL
    const out = await tool.execute({ mode: 'background', task: 'x', label: 'bg-2' }, execIn())
    expect(fake.created[0].agentOptions).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    const jobs = out.jobs as Array<Record<string, unknown>>
    expect(jobs[0].model).toBe('minimax-cn-coding-plan/MiniMax-M3')
  })

  it('后台遇缺失 provider ⇒ 抛可执行错误，且**未创建 worker**', async () => {
    writeCcc(['minimax-cn-coding-plan/MiniMax-M3', 'probe-no-adapter/ProbeModel'], 'minimax-cn-coding-plan/MiniMax-M3')
    const fake = fakeAgents()
    const tool = createHandymanTool(
      ctxForBackground(fake.runtime, fakeLlm({ registered: [{ id: 'minimax-cn-coding-plan' }] })) as never,
    ) as unknown as typeof TOOL
    await expect(
      tool.execute({ mode: 'background', task: 'x', label: 'bg-3', model: 'probe-no-adapter/ProbeModel' }, execIn()),
    ).rejects.toThrow(/no adapter registered on this machine/)
    expect(fake.created).toHaveLength(0)
  })
})
