import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('schemastery', () => {
  const chain = (val: unknown) => Object.assign(() => val, { default: () => val })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain([]),
      string: () => chain(''),
      boolean: () => chain(true),
      number: () => chain(0),
    },
  }
})

// 公开版：schemastery 由 @deepseek-ai/schemastery 提供（index.ts 直接导入；v1.21 Config 含 .min/.max 链）
vi.mock('@deepseek-ai/schemastery', () => {
  // 链式 mock：任何属性访问/函数调用返回链自身（.min().max().default() 无限链）
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})

// v1.21 settings-section：index.ts 经 registerSettingsSection 引入 dsh-settings
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { name, inject, apply, type Config } from '../src/index.ts'

function mockCtx() {
  const register = vi.fn(() => () => {})
  const guard = vi.fn()
  const on = vi.fn()
  const ctx = { tools: { register, guard }, on } as any
  return { ctx, register, guard, on }
}

const FULL_CONFIG: Config = {
  tools: true,
  guards: true,
  serenityConfigPaths: [],
}

describe('dsh-serenity-hooks: 插件契约（native cordis 规范）', () => {
  it('导出 name/inject/apply，无 default export', () => {
    expect(typeof name).toBe('string')
    expect(name).toBe('dsh-serenity-hooks')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('apply 注册 10 个真实工具', () => {
    const { ctx, register } = mockCtx()
    apply(ctx, FULL_CONFIG)
    expect(register).toHaveBeenCalledTimes(10)
    const names = register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toContain('cc_fs')
    expect(names).toContain('session')
    expect(names).toContain('acc_kit')
    expect(names).toContain('cc_git')
    expect(names).toContain('acc_msm')
    expect(names).toContain('eap')
    expect(names).toContain('neat')
    expect(names).toContain('cce')
    expect(names).toContain('loop')
    expect(names).toContain('localstore')
  })

  it('apply 订阅拦截缝：tools/pre-execute + guard', () => {
    const { ctx, on, guard } = mockCtx()
    apply(ctx, FULL_CONFIG)
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).toContain('tools/pre-execute')
    expect(guard).toHaveBeenCalledTimes(1)
  })

  it('config 开关控制注册项', () => {
    const { ctx, register, on, guard } = mockCtx()
    apply(ctx, { ...FULL_CONFIG, tools: false, guards: false })
    expect(register).not.toHaveBeenCalled()
    expect(guard).not.toHaveBeenCalled()
    // bootstrap seam 无条件注册（直接默认开启，用户明确"不能关"）——全关时 on 仅含 bootstrap 事件
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).not.toContain('tools/pre-execute')
    expect(events).toContain('session/event')
  })
})
