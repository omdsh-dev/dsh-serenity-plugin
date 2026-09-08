/**
 * host/effect.test.ts — 资源拆卸登记（S142 review F-08）
 *
 * 契约：装配成功返回 true 并在 fiber 销毁时执行清理；宿主无 `ctx.effect` 或注册抛错时
 * **响亮降级**（告警 + false），绝不让 `apply` 抛错（宿主对 apply 抛错 = 整机启动失败）。
 */
import { describe, it, expect, vi } from 'vitest'
import { registerDisposer, __resetDisposerWarningsForTest } from '../../src/host/effect.js'

describe('host/effect: registerDisposer', () => {
  it('装配成功 → true，且 effect 回调返回的 disposer 执行清理', () => {
    let disposer: (() => void) | undefined
    const ctx = {
      effect: vi.fn((cb: () => () => void, label?: string) => {
        expect(label).toBe('dsh-serenity-hooks: test resource')
        disposer = cb()
      }),
    }
    const cleanup = vi.fn()
    expect(registerDisposer(ctx, 'test resource', cleanup)).toBe(true)
    expect(cleanup).not.toHaveBeenCalled() // 装配时不执行
    disposer?.()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('清理抛错 → 吞掉并告警（不影响其它清理）', () => {
    let disposer: (() => void) | undefined
    const ctx = { effect: (cb: () => () => void) => { disposer = cb() } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerDisposer(ctx, 'boom', () => {
      throw new Error('cleanup boom')
    })
    expect(() => disposer?.()).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('资源清理失败（boom）'))).toBe(true)
    warn.mockRestore()
  })

  it('宿主无 ctx.effect → 响亮降级返回 false（不抛错；同标签只告警一次）', () => {
    __resetDisposerWarningsForTest()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(registerDisposer({}, 'no effect', () => {})).toBe(false)
    expect(registerDisposer(undefined, 'no ctx', () => {})).toBe(false)
    expect(registerDisposer({ effect: 42 }, 'not fn', () => {})).toBe(false)
    registerDisposer({}, 'no effect', () => {}) // 重复标签 → 去重不再告警
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.filter((m) => m.includes('资源拆卸未装配'))).toHaveLength(3)
    expect(messages.every((m) => m.includes('ctx.effect 不可用'))).toBe(true)
    warn.mockRestore()
    __resetDisposerWarningsForTest()
  })

  it('effect 调用抛错 → 告警 + false（注册失败不阻断装配）', () => {
    const ctx = {
      effect: () => {
        throw new Error('fiber disposed')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(registerDisposer(ctx, 'late', () => {})).toBe(false)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('资源拆卸注册失败（late）'))).toBe(true)
    warn.mockRestore()
  })
})
