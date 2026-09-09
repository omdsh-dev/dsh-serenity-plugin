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

// v1.23.5 rebuild.ts 运行时引入 dsh-session（shadow-price 定价）
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { name, inject, apply, type Config } from '../src/index.ts'

function mockCtx() {
  const register = vi.fn(() => () => {})
  const guard = vi.fn()
  const on = vi.fn()
  // v1.30.8（review F-08）：宿主 Context 有 ctx.effect（rc.1 全量使用，如 core/tools/src/index.ts:943）
  // ——替身必须保真，否则 lifecycle 装配在测试里被误判为"缺失"（E-01 同族：替身不镜像宿主）。
  const effect = vi.fn(() => () => {})
  const ctx = { tools: { register, guard }, on, effect } as any
  return { ctx, register, guard, on, effect }
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

  it('apply 注册 11 个真实工具（v1.30 命名重构 + v1.31.0 im-bridge 条件可见）', () => {
    const { ctx, register } = mockCtx()
    apply(ctx, FULL_CONFIG)
    expect(register).toHaveBeenCalledTimes(11)
    const names = register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toContain('container_fs')
    expect(names).toContain('logbook')
    expect(names).toContain('dashboard')
    expect(names).toContain('container_git')
    expect(names).toContain('msm')
    expect(names).toContain('praxis')
    expect(names).toContain('handyman')
    expect(names).toContain('localstore')
    expect(names).toContain('container_admin')
    expect(names).toContain('autopilot-trajectory')
    expect(names).toContain('im-bridge')
  })

  it('apply 订阅拦截缝：tools/pre-execute + guard', () => {
    const { ctx, on, guard } = mockCtx()
    apply(ctx, FULL_CONFIG)
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).toContain('tools/pre-execute')
    expect(guard).toHaveBeenCalledTimes(1)
  })

  it('v1.30.8 F-08：apply 装配生命周期（agent/session disposed 订阅 + 各资源 ctx.effect 拆卸）', () => {
    const { ctx, on, effect } = mockCtx()
    apply(ctx, FULL_CONFIG)
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).toContain('agent/disposed')
    expect(events).toContain('session/disposed')
    // 自起资源各自登记拆卸：gateway 第二监听器 / autopilot 时钟 / lifecycle 聚合资源 /
    // 微信主动发送入口（v1.30.9——只绑 loopback 的独立监听器）/
    // skiff root 退避重试定时器（v1.30.13——D1 定位失败重试；卸载后不得再尝试起服务）
    const labels = effect.mock.calls.map((c) => String(c[1]))
    expect(labels).toHaveLength(5)
    expect(labels.join('|')).toContain('gateway')
    expect(labels.join('|')).toContain('autopilot')
    expect(labels.join('|')).toContain('self-started resources')
    expect(labels.join('|')).toContain('weixin send api')
    expect(labels.join('|')).toContain('skiff root retry timer')
  })

  it('v1.30.8 F-08：ctx.effect 缺失 → 响亮降级不抛错（apply 不可成为启动单点）', () => {
    const { ctx, register } = mockCtx()
    delete (ctx as { effect?: unknown }).effect
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => apply(ctx, FULL_CONFIG)).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ctx.effect 不可用'))).toBe(true)
    warn.mockRestore()
    expect(register).toHaveBeenCalledTimes(11) // 其余装配不受影响
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
