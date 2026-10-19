import { describe, it, expect } from 'vitest'
import type { Context } from 'cordis'
import { cheapWorkerPresetInheritance } from '../src/trajectory/delegate/preset.js'

/**
 * cheapWorkerPresetInheritance 单元测试：cheap-worker worker 的 preset 继承 + 工具面收窄。
 *
 * 对齐 subagent 先例（applyChildComposition → agentPresets.composeFrom）：
 * cheap-worker worker 应继承发起方会话的 preset standing mount，从而获得 preset 层工具
 * （read/write/edit 等）。agentPresets 是可选服务——无该服务或父未 join preset
 * 时退化为历史行为（空工具层）。
 *
 * v1.24.0 工具面收窄（用户拍板）：worker 内部**不含 cheap-worker 本身**——setup 钩子
 * 在 composeFrom 后对子 scope tools.restrict({ deny: ['cheap-worker'] })，任何路径都执行
 * （防无限嵌套：递归编排归主 agent，worker 内部只走 subagent）。
 */

/** 构造一个带可选 agentPresets 桩 + tools.restrict 记录的 fake ctx（只实现 get 解析）。 */
function fakeCtx(presets: unknown): Context & { denyLog: string[] } {
  const denyLog: string[] = []
  const ctx = {
    denyLog,
    get(name: string): unknown {
      if (name === 'agentPresets') return presets
      return undefined
    },
    tools: {
      restrict(opts: { deny?: string[] }): void {
        if (opts.deny) denyLog.push(...opts.deny)
      },
    },
  }
  return ctx as unknown as Context & { denyLog: string[] }
}

describe('cheapWorkerPresetInheritance', () => {
  it('父 agent 已 join preset → 返回 preset id + setup 钩子（composeFrom + deny cheap-worker）', () => {
    let composedChild: unknown
    let composedParent: unknown
    const presets = {
      composedPreset: () => 'standard',
      composeFrom: (childCtx: unknown, parentCtx: unknown) => {
        composedChild = childCtx
        composedParent = parentCtx
        return 'standard'
      },
    }
    const parentCtx = fakeCtx(presets)
    const result = cheapWorkerPresetInheritance(parentCtx)

    expect(result.agentPreset).toBe('standard')
    expect(result.setup).toBeTypeOf('function')

    // setup 钩子应调用 composeFrom(childCtx, parentCtx) + deny cheap-worker（工具面收窄）
    const childCtx = fakeCtx(presets)
    result.setup!(childCtx)
    expect(composedChild).toBe(childCtx)
    expect(composedParent).toBe(parentCtx)
    expect(childCtx.denyLog).toContain('cheap-worker')
  })

  it('父未 join preset（composedPreset undefined）→ 无 preset，但 setup 仍 deny cheap-worker', () => {
    const presets = {
      composedPreset: () => undefined,
      composeFrom: () => { throw new Error('composeFrom 不应被调用') },
    }
    const parentCtx = fakeCtx(presets)
    const result = cheapWorkerPresetInheritance(parentCtx)
    expect(result.agentPreset).toBeUndefined()
    expect(result.setup).toBeTypeOf('function')
    const childCtx = fakeCtx(undefined)
    result.setup!(childCtx)
    expect(childCtx.denyLog).toContain('cheap-worker')
  })

  it('无 agentPresets 服务 → 无 preset，但 setup 仍 deny cheap-worker（无 roster 部署兼容）', () => {
    const parentCtx = fakeCtx(undefined)
    const result = cheapWorkerPresetInheritance(parentCtx)
    expect(result.agentPreset).toBeUndefined()
    expect(result.setup).toBeTypeOf('function')
    const childCtx = fakeCtx(undefined)
    result.setup!(childCtx)
    expect(childCtx.denyLog).toContain('cheap-worker')
  })

  it('无父 agent（headless / 非 agent 上下文）→ setup 仍 deny cheap-worker', () => {
    const result = cheapWorkerPresetInheritance(undefined)
    expect(result.agentPreset).toBeUndefined()
    expect(result.setup).toBeTypeOf('function')
    const childCtx = fakeCtx(undefined)
    result.setup!(childCtx)
    expect(childCtx.denyLog).toContain('cheap-worker')
  })
})
