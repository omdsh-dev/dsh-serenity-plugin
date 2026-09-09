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
