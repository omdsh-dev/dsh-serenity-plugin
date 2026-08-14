import { describe, it, expect } from 'vitest'
import type { Context } from 'cordis'
import { loopPresetInheritance } from '../src/loop-preset-inherit.js'

/**
 * loopPresetInheritance 单元测试：loop agent 的 preset 继承决策。
 *
 * 对齐 subagent 先例（applyChildComposition → agentPresets.composeFrom）：
 * loop agent 应继承发起方会话的 preset standing mount，从而获得 preset 层工具
 * （read/write/edit 等）。agentPresets 是可选服务——无该服务或父未 join preset
 * 时退化为历史行为（空工具层）。
 */

/** 构造一个带可选 agentPresets 桩的 fake ctx（只实现 get 解析）。 */
function fakeCtx(presets: unknown): Context {
  return {
    get(name: string): unknown {
      if (name === 'agentPresets') return presets
      return undefined
    },
  } as unknown as Context
}

describe('loopPresetInheritance', () => {
  it('父 agent 已 join preset → 返回 preset id + composeFrom setup 钩子', () => {
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
    const result = loopPresetInheritance(parentCtx)

    expect(result.agentPreset).toBe('standard')
    expect(result.setup).toBeTypeOf('function')

    // setup 钩子应调用 composeFrom(childCtx, parentCtx)
    const childCtx = fakeCtx(presets)
    result.setup!(childCtx)
    expect(composedChild).toBe(childCtx)
    expect(composedParent).toBe(parentCtx)
  })

  it('父未 join preset（composedPreset undefined）→ 返回空（退化历史行为）', () => {
    const presets = {
      composedPreset: () => undefined,
      composeFrom: () => { throw new Error('composeFrom 不应被调用') },
    }
    const parentCtx = fakeCtx(presets)
    expect(loopPresetInheritance(parentCtx)).toEqual({})
  })

  it('无 agentPresets 服务 → 返回空（无 roster 部署兼容）', () => {
    const parentCtx = fakeCtx(undefined)
    expect(loopPresetInheritance(parentCtx)).toEqual({})
  })

  it('无父 agent（headless / 非 agent 上下文）→ 返回空', () => {
    expect(loopPresetInheritance(undefined)).toEqual({})
  })
})
