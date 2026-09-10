/**
 * opencode-provider.test.ts — opencode 路由自动配置（v1.31.7，S142 用户"省得用户配"）
 *
 * 覆盖三类判据：
 *   ① 计划（纯函数）：路由识别 / 只补缺失键 / 大小写不敏感 / L2 建路由条件 / 各种 idle
 *   ② 执行（settings 面）：深合并补丁形状 / 命名空间未注册 → 交给重试 / 写被拒 → 响亮不抛
 *   ③ 装配：settings/updated 自愈 + 定时器随卸载拆卸（F-08 纪律）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  LLM_PI_AI_NAMESPACE,
  OPENCODE_API_KEY_ENV,
  OPENCODE_ROUTE_TO_CREATE,
  OPENCODE_SESSION_ID,
  applyOpencodeAutoConfigOnce,
  describeOpencodeAction,
  isOpencodeRoute,
  opencodeRouteHeaders,
  planOpencodeAutoConfig,
  registerOpencodeAutoConfig,
} from '../src/opencode-provider.js'

const HEADERS = opencodeRouteHeaders()

function plan(resolved: unknown, env: Record<string, string | undefined> = {}) {
  return planOpencodeAutoConfig({ resolved, env })
}

describe('opencode-provider: 路由识别', () => {
  it('按路由名识别（opencode / opencode-go）', () => {
    expect(isOpencodeRoute('opencode', {})).toBe(true)
    expect(isOpencodeRoute('opencode-go', {})).toBe(true)
    expect(isOpencodeRoute('openai', {})).toBe(false)
  })

  it('按 baseURL 识别（用户可能把路由改名）', () => {
    expect(isOpencodeRoute('zen', { baseURL: 'https://opencode.ai/zen/go' })).toBe(true)
    expect(isOpencodeRoute('zen', { baseURL: 'https://opencode.ai/zen/go/v1' })).toBe(true)
    expect(isOpencodeRoute('zen', { baseURL: 'https://gateway.opencode.ai/v1' })).toBe(true)
  })

  it('相似但不同的主机名不算（防误伤：opencode.ai.evil.com / notopencode.ai）', () => {
    expect(isOpencodeRoute('x', { baseURL: 'https://opencode.ai.evil.com/v1' })).toBe(false)
    expect(isOpencodeRoute('x', { baseURL: 'https://notopencode.ai/v1' })).toBe(false)
    expect(isOpencodeRoute('x', { baseURL: 'https://gateway.example.com/v1' })).toBe(false)
    expect(isOpencodeRoute('x', { baseURL: 'not-a-url' })).toBe(false)
    expect(isOpencodeRoute('x', {})).toBe(false)
  })
})

describe('opencode-provider: 计划（纯函数）', () => {
  it('命名空间未注册（undefined）→ idle，交由调用方重试', () => {
    const p = plan(undefined)
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'idle', reason: 'namespace-unregistered' }])
  })

  it('L1：已有 opencode 路由缺头 → 补全部头（深合并形状：providers.<route>.headers）', () => {
    const p = plan({ providers: { 'opencode-go': { apiKeyEnv: OPENCODE_API_KEY_ENV } } })
    expect(p.patch).toEqual({ providers: { 'opencode-go': { headers: HEADERS } } })
    expect(p.actions).toEqual([{ kind: 'fill-headers', route: 'opencode-go', keys: Object.keys(HEADERS) }])
  })

  it('L1：只补缺失键，用户已写的值一律保留（不覆盖）', () => {
    const p = plan({
      providers: { 'opencode-go': { headers: { 'x-opencode-session': 'my-own-session', 'X-Title': 'keep-me' } } },
    })
    const headers = (p.patch.providers as Record<string, { headers: Record<string, string> }>)['opencode-go']!.headers
    expect(headers['x-opencode-session']).toBeUndefined() // 用户的会话值不被改写
    expect(headers['X-Title']).toBeUndefined() // 我们本来就不注入身份族；用户自己的更不该动
    expect(headers['x-opencode-client']).toBe('dsh')
    // 两个头名是同一逻辑值的别名：用户只写了 `x-opencode-session`，`X-Session-ID` 确实该补——
    // 但必须补成**用户的值**（不是本插件常量），否则两条请求头会互相矛盾。
    expect(headers['X-Session-ID']).toBe('my-own-session')
  })

  it('L1：别名反向——用户只写 X-Session-ID 时，补出的 x-opencode-session 用他的值', () => {
    const p = plan({ providers: { 'opencode-go': { headers: { 'X-Session-ID': 'theirs' } } } })
    const headers = (p.patch.providers as Record<string, { headers: Record<string, string> }>)['opencode-go']!.headers
    expect(headers['X-Session-ID']).toBeUndefined()
    expect(headers['x-opencode-session']).toBe('theirs')
  })

  it('L1：头名大小写不敏感（用户写 X-Session-Id 也算已备）', () => {
    const p = plan({
      providers: {
        'opencode-go': {
          headers: {
            'X-SESSION-ID': 'u1',
            'X-Opencode-Session': 'u2',
            'X-Opencode-Client': 'mine',
            'X-OPENCODE-PROJECT': 'p',
          },
        },
      },
    })
    expect(p.patch).toEqual({}) // 全部已存在（大小写不同但同名）→ 不写
    expect(p.actions).toEqual([{ kind: 'skip-route', route: 'opencode-go', reason: 'headers-complete' }])
  })

  it('L1：头齐备 → skip-route 且不产生写入（幂等核心）', () => {
    const p = plan({ providers: { opencode: { headers: { ...HEADERS } } } })
    expect(p.patch).toEqual({})
    expect(p.actions[0]).toEqual({ kind: 'skip-route', route: 'opencode', reason: 'headers-complete' })
  })

  it('L1：多个 opencode 路由各自补（互不影响）', () => {
    const p = plan({
      providers: {
        opencode: { headers: { ...HEADERS } },
        'opencode-go': {},
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
      },
    })
    const providers = p.patch.providers as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(['opencode-go']) // opencode 齐备、openai 非 opencode → 都不在补丁里
  })

  it('L2：无 opencode 路由 + 环境有 OPENCODE_API_KEY → 建路由并带全头', () => {
    const p = plan({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }, { [OPENCODE_API_KEY_ENV]: 'sk-x' })
    expect(p.patch).toEqual({ providers: { [OPENCODE_ROUTE_TO_CREATE]: { headers: HEADERS } } })
    expect(p.actions).toEqual([{ kind: 'create-route', route: OPENCODE_ROUTE_TO_CREATE }])
  })

  it('L2：不写 apiKeyEnv（依赖 pi-ai 目录 provider 自带的环境发现，避免多一层未验证的凭据缝）', () => {
    const p = plan({ providers: {} }, { [OPENCODE_API_KEY_ENV]: 'sk-x' })
    const profile = (p.patch.providers as Record<string, Record<string, unknown>>)[OPENCODE_ROUTE_TO_CREATE]!
    expect(profile.apiKeyEnv).toBeUndefined()
    expect(Object.keys(profile)).toEqual(['headers'])
  })

  it('L2：无 key → 不建路由（不给不用 opencode 的人平白多出一组模型）', () => {
    const p = plan({ providers: {} }, {})
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'idle', reason: 'no-route' }])
  })

  it('L2：key 为空字符串视作没有', () => {
    const p = plan({ providers: {} }, { [OPENCODE_API_KEY_ENV]: '' })
    expect(p.patch).toEqual({})
  })

  it('L2：已有 opencode 路由时不再建新路由（即便有 key）', () => {
    const p = plan({ providers: { opencode: {} } }, { [OPENCODE_API_KEY_ENV]: 'sk-x' })
    const providers = p.patch.providers as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(['opencode'])
    expect(providers[OPENCODE_ROUTE_TO_CREATE]).toBeUndefined()
  })

  it('容错：providers 非对象 / 路由值非对象 都当作空，不抛', () => {
    expect(plan({ providers: 'nope' }, {}).patch).toEqual({})
    expect(plan({ providers: { 'opencode-go': null } }, {}).actions[0]!.kind).toBe('fill-headers')
    expect(plan({}, {}).patch).toEqual({})
    expect(plan([], {}).patch).toEqual({})
  })

  it('会话标识是稳定常量（静态值是有意选择：随机值 = 每次启动换亲和键 = 缓存永不命中）', () => {
    expect(OPENCODE_SESSION_ID).toBe('dsh-serenity')
    expect(opencodeRouteHeaders()['x-opencode-session']).toBe(OPENCODE_SESSION_ID)
    expect(opencodeRouteHeaders()['X-Session-ID']).toBe(OPENCODE_SESSION_ID)
  })

  it('不注入身份族与 UA：不冒充 OpenCode 客户端（免费档滥用判别不归本插件管）', () => {
    for (const forbidden of ['X-Title', 'HTTP-Referer', 'User-Agent', 'user-agent']) {
      expect(Object.keys(HEADERS)).not.toContain(forbidden)
    }
  })

  it('不注入 x-opencode-request（语义是会话内递增，静态假值比不写更糟）', () => {
    expect(Object.keys(HEADERS)).not.toContain('x-opencode-request')
  })

  it('每次调用返回新对象（放进 patch 的对象不得共享可变引用）', () => {
    const a = opencodeRouteHeaders()
    const b = opencodeRouteHeaders()
    expect(a).not.toBe(b)
    a['X-Title'] = 'mutated'
    expect(b['X-Title']).toBeUndefined()
  })
})

describe('opencode-provider: 动作描述（日志可读性）', () => {
  it('四类动作都有单行中文描述且不含秘密', () => {
    expect(describeOpencodeAction({ kind: 'fill-headers', route: 'opencode-go', keys: ['X-Title'] })).toContain('opencode-go')
    expect(describeOpencodeAction({ kind: 'create-route', route: 'opencode-go' })).toContain(OPENCODE_API_KEY_ENV)
    expect(describeOpencodeAction({ kind: 'skip-route', route: 'opencode', reason: 'headers-complete' })).toContain('齐备')
    expect(describeOpencodeAction({ kind: 'idle', reason: 'no-route' })).toContain('无需动作')
  })
})

describe('opencode-provider: 执行（settings 面）', () => {
  function fakeCtx(settings: unknown): { ctx: never; calls: { update: unknown[][] } } {
    const calls: { update: unknown[][] } = { update: [] }
    return { ctx: { settings } as never, calls }
  }

  it('命名空间未注册 → 不写、标记 registered:false（交由装配层重试）', async () => {
    const settings = { get: vi.fn().mockReturnValue(undefined), update: vi.fn() }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('补齐 → 调用 update 且 patch 形状正确；读的是 llm-pi-ai 命名空间', async () => {
    const settings = {
      get: vi.fn().mockReturnValue({ providers: { 'opencode-go': {} } }),
      update: vi.fn().mockResolvedValue(undefined),
    }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: true, registered: true })
    expect(settings.get).toHaveBeenCalledWith(LLM_PI_AI_NAMESPACE)
    expect(settings.update).toHaveBeenCalledWith(LLM_PI_AI_NAMESPACE, { providers: { 'opencode-go': { headers: HEADERS } } })
  })

  it('方法调用保 this（解构裸调用会丢 this —— 本仓第四次同病，故断言 this 绑定）', async () => {
    const settings = {
      seen: 'me' as string | undefined,
      get(this: { seen?: string }) { return this.seen === 'me' ? { providers: { opencode: {} } } : undefined },
      async update(this: { seen?: string }) { if (this.seen !== 'me') throw new Error('lost this') },
    }
    const { ctx } = fakeCtx(settings)
    await expect(applyOpencodeAutoConfigOnce(ctx, {})).resolves.toEqual({ wrote: true, registered: true })
  })

  it('无事可做 → 不调用 update（避免无谓触发 settings/updated）', async () => {
    const settings = {
      get: vi.fn().mockReturnValue({ providers: { opencode: { headers: { ...HEADERS } } } }),
      update: vi.fn(),
    }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: true })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('写入被拒 → 响亮告警但不抛（apply 抛错 = 整个 dsh 启动失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const settings = {
      get: vi.fn().mockReturnValue({ providers: { 'opencode-go': {} } }),
      update: vi.fn().mockRejectedValue(new Error('route not serviceable')),
    }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('opencode 路由自动配置写入被拒'))
    warn.mockRestore()
  })

  it('读取抛错 → 告警但不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const settings = {
      get: vi.fn().mockImplementation(() => { throw new Error('settings disposed') }),
      update: vi.fn(),
    }
    const { ctx } = fakeCtx(settings)
    await expect(applyOpencodeAutoConfigOnce(ctx, {})).resolves.toEqual({ wrote: false, registered: false })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('settings 服务缺失（无 get/update）→ 告警但不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ctx } = fakeCtx({ installSection: () => undefined })
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings 服务不可用'))
    warn.mockRestore()
  })
})

describe('opencode-provider: 装配（registerOpencodeAutoConfig）', () => {
  it('apply 时立即尝试一次；命名空间未注册 → 排入退避重试（非失败日志）', async () => {
    const settings = { get: vi.fn().mockReturnValue(undefined), update: vi.fn() }
    const handlers = new Map<string, (arg?: unknown) => void>()
    const ctx = {
      settings,
      get: (name: string) => (name === 'settings' ? settings : undefined),
      on: (name: string, fn: (arg?: unknown) => void) => { handlers.set(name, fn) },
      effect: () => undefined,
    }
    registerOpencodeAutoConfig(ctx as never)
    await new Promise((r) => setImmediate(r))
    expect(settings.get).toHaveBeenCalledWith(LLM_PI_AI_NAMESPACE)
    // 已订阅 settings/updated（自愈路径）
    expect(handlers.has('settings/updated')).toBe(true)
  })

  it('settings/updated 只对 llm-pi-ai 命名空间复评（别人的命名空间不触发）', async () => {
    const settings = {
      get: vi.fn().mockReturnValue({ providers: { opencode: { headers: { ...HEADERS } } } }),
      update: vi.fn(),
    }
    const handlers = new Map<string, (arg?: unknown) => void>()
    const ctx = {
      settings,
      get: (name: string) => (name === 'settings' ? settings : undefined),
      on: (name: string, fn: (arg?: unknown) => void) => { handlers.set(name, fn) },
      effect: () => undefined,
    }
    registerOpencodeAutoConfig(ctx as never)
    await new Promise((r) => setImmediate(r))
    const before = settings.get.mock.calls.length
    handlers.get('settings/updated')?.('serenity-hooks') // 别人的命名空间
    await new Promise((r) => setImmediate(r))
    expect(settings.get.mock.calls.length).toBe(before)
    handlers.get('settings/updated')?.(LLM_PI_AI_NAMESPACE) // 我们的目标命名空间
    await new Promise((r) => setImmediate(r))
    expect(settings.get.mock.calls.length).toBeGreaterThan(before)
  })
})
