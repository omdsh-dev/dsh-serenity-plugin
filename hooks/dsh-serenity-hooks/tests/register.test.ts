import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

/**
 * 测试卫生（C4 块 A 顺带修复）：`apply` 会装配微信主动发送面，其 sync 读 **plugin 全局配置**
 * （`SERENITY_HOOKS_CONFIG` → 缺省 `~/.dsh/serenity-hooks.json`）。此前本文件没有隔离 ⇒
 * 每个用例都去**真绑生产端口 3082**：本机真插件在跑时是被占用（触发一次"启动失败"日志），
 * 不在跑时**测试会抢走生产端口**。现注入临时配置（面关闭）→ 不绑端口、无日志噪音。
 */
const prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
let cfgDir: string

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'hooks-register-'))
  const cfgPath = join(cfgDir, 'serenity-hooks.json')
  // 面关（enabled:false）+ 端口 0：两份判据任一都足以关闭本面
  writeFileSync(cfgPath, JSON.stringify({ weixinApi: { enabled: false, port: 0 } }))
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
})

afterEach(() => {
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  rmSync(cfgDir, { recursive: true, force: true })
})

describe('dsh-serenity-hooks: 插件契约（native cordis 规范）', () => {
  it('导出 name/inject/apply，无 default export', () => {
    expect(typeof name).toBe('string')
    expect(name).toBe('dsh-serenity-hooks')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('apply 注册 11 个真实工具（v1.30 命名重构 + v1.31.0 im-bridge + v1.33 合并/专属工具，后两者条件可见）', () => {
    const { ctx, register } = mockCtx()
    apply(ctx, FULL_CONFIG)
    expect(register).toHaveBeenCalledTimes(11)
    const names = register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toContain('container_fs')
    expect(names).toContain('container_trajectory')
    expect(names).toContain('dashboard')
    expect(names).toContain('container_git')
    expect(names).toContain('msm')
    expect(names).toContain('praxis')
    expect(names).toContain('handyman')
    expect(names).toContain('localstore')
    expect(names).toContain('container_admin')
    expect(names).toContain('container_trajectory')
    expect(names).toContain('im-bridge')
    expect(names).toContain('acc-diag')
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
    // 自起资源各自登记拆卸：autopilot 时钟 / lifecycle 聚合资源（**含四个自起 HTTP 面**）/
    // opencode 路由自动配置的重试定时器（v1.31.7——命名空间竞态退避）/
    // trajectory 唤醒调度器（D58，v1.32.0——中心 tick + 冷唤醒投递）。
    // ⚠️ v1.35（C2 块 C3）：**skiff root 退避重试定时器已退场**（原 v1.30.13/D1 的第 7 项），故 7 → 6。
    // ⚠️ C4 块 A（2026-09-15）：**gateway 第二监听器**与**weixin send api** 两处自带 disposer 已删
    //    ——listener 生命周期归 `face-host`，拆卸路径归一到 lifecycle 的聚合入口（`stopAllFaces`）。
    //    故 6 → 4，且这两个标签从此**不应再现**（回归钉：删了就别让它悄悄回来）。
    const labels = effect.mock.calls.map((c) => String(c[1]))
    expect(labels).toHaveLength(4)
    expect(labels.join('|')).toContain('autopilot')
    expect(labels.join('|')).toContain('trajectory 唤醒调度器')
    expect(labels.join('|')).toContain('self-started resources')
    expect(labels.join('|')).toContain('opencode provider auto-config retry timer')
    // 退避重试定时器不得再出现（回归钉：删了就不要再悄悄回来）
    expect(labels.join('|')).not.toContain('skiff root retry timer')
    // C4 块 A 回归钉：两处自带 listener disposer 已被单点取代
    expect(labels.join('|')).not.toContain('gateway 第二监听器')
    expect(labels.join('|')).not.toContain('weixin send api')
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
