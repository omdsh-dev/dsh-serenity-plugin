import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CHEAP_WORKER_GUIDE, providerAvailabilityError, requireWhitelistedModel, splitModel } from '../src/cheap-worker-ops.js'

/**
 * cheap-worker-ops（纯逻辑层）。
 *
 * 🔴 2026-10-14（owner 令「删除后台运行能力」）：本模块的**多数导出已随 background 退场** ——
 * 进度文件（`writeProgress`／`readProgress`／`writeFailedStatus`／`cheapWorkerProgressPaths`／
 * `sanitizeLabel`／`listActiveCheapWorkers`）／stop token（`newStopToken`）／轮次 prompt
 * （`buildRoundPrompt`）**全部删除**。它们的用例是**跟着实现一起退场**的（不是"回归"），
 * 因此本文件从 268 行缩到只覆盖**现存契约**：模型串解析 ／ 白名单校验 ／ provider 可用性判读 ／ 指引文本。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cheap-worker-ops-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cheap-worker-ops: 模型串解析 / 白名单', () => {
  it('splitModel：provider/model 与 model-only', () => {
    expect(splitModel('minimax-cn-coding-plan/MiniMax-M3')).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    expect(splitModel('deepseek-v4-flash')).toEqual({ provider: undefined, model: 'deepseek-v4-flash' })
  })

  it('requireWhitelistedModel：白名单内通过；白名单外抛错（提示配置 cheap-worker.models）', () => {
    expect(() => requireWhitelistedModel('minimax-cn-coding-plan/MiniMax-M3', ['minimax-cn-coding-plan/MiniMax-M3'])).not.toThrow()
    expect(() => requireWhitelistedModel('other/model', ['minimax-cn-coding-plan/MiniMax-M3'])).toThrow(
      /not in the CCC whitelist/,
    )
    expect(() => requireWhitelistedModel('other/model', ['minimax-cn-coding-plan/MiniMax-M3'])).toThrow(/cheap-worker\.models/)
  })

  /**
   * 🔴 2026-10-14 负控：模型**不再可由调用方指定** ⇒ 模块层面**不得**再导出任何"按名字取模型"的能力。
   * 这条钉的是"删除"本身（若将来有人把 per-call model 加回来，此处会红）。
   */
  it('🔴 反向钉：本模块不再导出 background 时代的任何符号', async () => {
    const mod = await import('../src/cheap-worker-ops.js')
    for (const gone of [
      'newStopToken', 'buildRoundPrompt', 'readProgress', 'writeProgress', 'writeFailedStatus',
      'cheapWorkerProgressPaths', 'sanitizeLabel', 'listActiveCheapWorkers',
    ]) {
      expect(Object.keys(mod), `已删除的导出不得复活：${gone}`).not.toContain(gone)
    }
  })
})

describe('cheap-worker-ops: guide 指引（现只有前台形态）', () => {
  it('含 eap 要求 / 单任务与并行两栏 / cap 10 / 提示词规范', () => {
    expect(CHEAP_WORKER_GUIDE).toContain('load eap and design the plan')
    expect(CHEAP_WORKER_GUIDE).toContain('Task decomposition (E↑ Explicit)')
    expect(CHEAP_WORKER_GUIDE).toContain('cheap-worker.models')
    expect(CHEAP_WORKER_GUIDE).toContain('Parallel strategy')
    expect(CHEAP_WORKER_GUIDE).toContain('10 (fixed, hardcoded)')
    expect(CHEAP_WORKER_GUIDE).toContain('cheap-worker-internal agent is also required to load eap')
    expect(CHEAP_WORKER_GUIDE).toContain('LOW-COST models')
  })

  /**
   * 🔴 2026-10-14（owner 令删 background）：指引里**不得**再把双模式／循环校验／进度文件**当作选项**介绍
   * —— 否则模型会去用一个已不存在的模式（这正是"文档声称的实现形态"必须回代码取证的那条）。
   *
   * ⚠️ 措辞判据（自纠一次）：**不能**直接 `not.toContain('background')` —— 现行文案里有一句
   * **否定式**表述（"no unattended/background run"），那是**如实说明它不存在**，恰恰该保留。
   * 所以要钉的是"**把它当选项推销**"的形态，而不是这个词本身。
   */
  it('🔴 反向钉：不得再把 background 当选项推销（否定式说明可以）', () => {
    expect(CHEAP_WORKER_GUIDE).not.toContain('Two modes')
    expect(CHEAP_WORKER_GUIDE).not.toContain('mode="background"')
    expect(CHEAP_WORKER_GUIDE).not.toMatch(/\|\s*background\s*\|/)          // 对照表里不得有 background 列
    expect(CHEAP_WORKER_GUIDE).not.toContain('resume with the same label')  // 续跑承诺已不存在
    expect(CHEAP_WORKER_GUIDE).not.toContain('stop token')
    expect(CHEAP_WORKER_GUIDE).not.toContain('AGENT_SESSIONS/cheap-worker-') // 进度文件路径
    // 正面表述必须在场（否则"删干净"可以靠整段清空来骗过上面的否定断言）
    expect(CHEAP_WORKER_GUIDE).toContain('no loop, no completion code, no progress')
    expect(CHEAP_WORKER_GUIDE).toContain('the caller cannot pass one')
  })
})

/**
 * providerAvailabilityError（v1.48，S142 2026-09-25）：owner 在 **Mac** 上实测到
 * `no adapter registered for provider "<p>"`，而前台 `diagnostic` 是空的 ⇒ 调用方无法自我修正。
 * 本组 pin 的是「**把沉默的失败变成可执行的错误**」这条契约。
 */
describe('cheap-worker-ops: provider 可用性判据（可执行错误，v1.48）', () => {
  const reg = [{ id: 'minimax-cn-coding-plan', name: 'MiniMax CN Coding Plan' }, { id: 'deepseek-official', name: 'DeepSeek' }]

  it('全部 provider 本机都有 adapter ⇒ null（不打扰正常路径）', () => {
    expect(providerAvailabilityError(['minimax-cn-coding-plan/MiniMax-M3'], { registered: reg })).toBeNull()
    expect(providerAvailabilityError(['deepseek-official/x', 'minimax-cn-coding-plan/y'], { registered: reg })).toBeNull()
  })

  it('model 串无 "/"（取不到 provider）⇒ 不判定（沿用 agent 默认路由）', () => {
    expect(providerAvailabilityError(['MiniMax-M3'], { registered: [] })).toBeNull()
    expect(providerAvailabilityError([], { registered: [] })).toBeNull()
  })

  it('provider 缺失 ⇒ 报出：请求的模型 / 配置出处 / **本机可用清单** / 两条修法 / 禁止原样重试', () => {
    const msg = providerAvailabilityError(['probe-no-adapter/ProbeModel'], {
      registered: reg,
      configPath: '.opencode/serenity.json',
    })
    expect(msg).not.toBeNull()
    const m = msg as string
    expect(m).toContain('cheap-worker: provider "probe-no-adapter" has no adapter registered on this machine')
    expect(m).toContain('probe-no-adapter/ProbeModel')                    // 请求的模型串
    expect(m).toContain('.opencode/serenity.json')                         // 配置出处
    expect(m).toContain('"cheap-worker.models"')                               // 落点
    expect(m).toContain('Available on this machine (registered adapters)')
    expect(m).toContain('minimax-cn-coding-plan (MiniMax CN Coding Plan)') // 本机真能用的
    expect(m).toContain('deepseek-official (DeepSeek)')
    expect(m).toContain('Declared but NOT active here')
    expect(m).toContain('Fix (pick one, then retry):')
    expect(m).toContain('Do not retry unchanged')                          // 防死循环
  })

  it('已声明但休眠的 provider ⇒ 给出激活用的 settings 命名空间', () => {
    const msg = providerAvailabilityError(['probe-no-adapter/ProbeModel'], {
      registered: reg,
      declared: [
        { provider: 'probe-no-adapter', displayName: 'Probe', settingsNs: 'llm-pi-ai' },
        { provider: 'unrelated-provider', displayName: '其它', settingsNs: 'x' },
      ],
    }) as string
    expect(msg).toContain('probe-no-adapter (Probe) — settings namespace "llm-pi-ai"')
    expect(msg).not.toContain('unrelated-provider')   // 只列与缺失项相关的声明
  })

  it('本机一个 provider 都没有 ⇒ 明确写 (none)，不假装有', () => {
    const m = providerAvailabilityError(['ghost/m'], { registered: [] }) as string
    expect(m).toContain('(none)')
    expect(m).toContain('ghost')
  })

  it('多个缺失 provider 去重且逐个点名；请求的模型串如实回显（供自查）', () => {
    const m = providerAvailabilityError(['a/m1', 'a/m2', 'b/m3'], { registered: [] }) as string
    expect(m).toContain('"a", "b"')   // 去重（a 出现两次只报一次），保持首次出现顺序
    expect(m).toContain('a/m1')
    expect(m).toContain('a/m2')
    expect(m).toContain('b/m3')
  })
})
