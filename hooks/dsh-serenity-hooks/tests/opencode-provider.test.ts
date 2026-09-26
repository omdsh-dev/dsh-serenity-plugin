/**
 * opencode-provider.test.ts — opencode 路由自动配置（v1.31.7，S142 用户"省得用户配"）
 *
 * 覆盖三类判据：
 *   ① 计划（纯函数）：路由识别 / 只补缺失键 / 大小写不敏感 / L2 建路由条件 / 各种 idle
 *   ② 执行（settings 面）：深合并补丁形状 / 命名空间未注册 → 交给重试 / 写被拒 → 响亮不抛
 *      🔴 v0.1.7 读面 = `describe()`（列举条目表单后按 `ns` 挑）；夹具形状见 `describeStub`
 *   ③ 装配：settings/updated 自愈 + 定时器随卸载拆卸（F-08 纪律）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  LLM_PI_AI_NAMESPACE,
  OPENCODE_API_KEY_ENV,
  OPENCODE_EXTRA_MODELS,
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

/** 造 0.1.7 `SettingsForms.describe()` 的返回形状（`SettingsDescriptor[]`）。
 *  🔴 `describe` 取代了 0.1.7 前被删除的 `settings.get()`：读面从"按 ns 取值"
 *  改成"列举所有条目表单、再按 `ns` 自己挑" ⇒ **未注册命名空间 = 数组里没有该条目**
 *  （不是"有 ns 但值为 undefined"）。夹具必须复现这个差别，否则测不出重试判据。 */
function describeStub(found: { ns?: string; value?: unknown }[] | undefined) {
  return vi.fn().mockReturnValue(found)
}

/** 单条目情形（绝大多数用例）：命名空间已注册且值为 `value` */
function describeOne(value: unknown) {
  return describeStub([{ ns: LLM_PI_AI_NAMESPACE, value }])
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
    const settings = { describe: describeStub([]), update: vi.fn() }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('补齐 → 调用 update 且 patch 形状正确；读的是 llm-pi-ai 命名空间', async () => {
    const settings = {
      describe: describeOne({ providers: { 'opencode-go': {} } }),
      update: vi.fn().mockResolvedValue(undefined),
    }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: true, registered: true })
    // 🔴 钉住 `describe` 契约：**必以零参调用**（传 options 无妨，但不能传 ns —— 它不是取值器）
    expect(settings.describe).toHaveBeenCalledWith()
    expect(settings.describe).toHaveBeenCalledTimes(1)
    expect(settings.update).toHaveBeenCalledWith(LLM_PI_AI_NAMESPACE, { providers: { 'opencode-go': { headers: HEADERS } } })
  })

  it('describe 返回里有别的 ns 但没有 llm-pi-ai → registered:false（按条目挑，认 ns 字段）', async () => {
    const settings = { describe: describeStub([{ ns: 'someone-else', value: { providers: {} } }]), update: vi.fn() }
    const { ctx } = fakeCtx(settings)
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('方法调用保 this（解构裸调用会丢 this —— 本仓第四次同病，故断言 this 绑定）', async () => {
    const settings = {
      seen: 'me' as string | undefined,
      describe(this: { seen?: string }) {
        return this.seen === 'me' ? [{ ns: LLM_PI_AI_NAMESPACE, value: { providers: { opencode: {} } } }] : []
      },
      async update(this: { seen?: string }) { if (this.seen !== 'me') throw new Error('lost this') },
    }
    const { ctx } = fakeCtx(settings)
    await expect(applyOpencodeAutoConfigOnce(ctx, {})).resolves.toEqual({ wrote: true, registered: true })
  })

  it('无事可做 → 不调用 update（避免无谓触发 settings/updated）', async () => {
    const settings = {
      describe: describeOne({ providers: { opencode: { headers: { ...HEADERS } } } }),
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
      describe: describeOne({ providers: { 'opencode-go': {} } }),
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
      describe: vi.fn().mockImplementation(() => { throw new Error('settings disposed') }),
      update: vi.fn(),
    }
    const { ctx } = fakeCtx(settings)
    await expect(applyOpencodeAutoConfigOnce(ctx, {})).resolves.toEqual({ wrote: false, registered: false })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('settings 服务缺失（无 describe/update）→ 告警但不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 🔴 用 0.1.7 **真实存在但不是我方读面**的成员做夹具（`configure` 只做页策略）
    //    —— 比"传个旧成员"更能证明"缺 describe 就一定跳过"
    const { ctx } = fakeCtx({ configure: () => undefined })
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings 服务不可用'))
    warn.mockRestore()
  })

  it('有 describe 但缺 update（半拉服务）→ 同样跳过，不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ctx } = fakeCtx({ describe: describeOne({ providers: {} }) })
    const r = await applyOpencodeAutoConfigOnce(ctx, {})
    expect(r).toEqual({ wrote: false, registered: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings 服务不可用'))
    warn.mockRestore()
  })
})

describe('opencode-provider: 装配（registerOpencodeAutoConfig）', () => {
  it('apply 时立即尝试一次；命名空间未注册 → 排入退避重试（非失败日志）', async () => {
    const settings = { describe: describeStub([]), update: vi.fn() }
    const handlers = new Map<string, (arg?: unknown) => void>()
    const ctx = {
      settings,
      get: (name: string) => (name === 'settings' ? settings : undefined),
      on: (name: string, fn: (arg?: unknown) => void) => { handlers.set(name, fn) },
      effect: () => undefined,
    }
    registerOpencodeAutoConfig(ctx as never)
    await new Promise((r) => setImmediate(r))
    expect(settings.describe).toHaveBeenCalledWith()
    // 已订阅 settings/document-updated（自愈路径；v0.1.7 前名 settings/updated）
    expect(handlers.has('settings/document-updated')).toBe(true)
  })

  it('settings/document-updated 只对 llm-pi-ai 命名空间复评（别人的命名空间不触发）', async () => {
    const settings = {
      describe: describeOne({ providers: { opencode: { headers: { ...HEADERS } } } }),
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
    const before = settings.describe.mock.calls.length
    handlers.get('settings/document-updated')?.('serenity-hooks') // 别人的命名空间
    await new Promise((r) => setImmediate(r))
    expect(settings.describe.mock.calls.length).toBe(before)
    // v0.1.7：载荷为**两个位置参** `(ns, revision)`；我方只读 ns
    handlers.get('settings/document-updated')?.(LLM_PI_AI_NAMESPACE, 1) // 我们的目标命名空间
    await new Promise((r) => setImmediate(r))
    expect(settings.describe.mock.calls.length).toBeGreaterThan(before)
  })
})

// ── L3 补模型（v1.48.0）──

describe('opencode-provider: L3 补目录未收录的模型', () => {
  const EXTRA_ID = Object.keys(OPENCODE_EXTRA_MODELS)[0] as string
  const EXTRA = OPENCODE_EXTRA_MODELS[EXTRA_ID] as NonNullable<(typeof OPENCODE_EXTRA_MODELS)[string]>

  /** 一个"用户已显式声明 models 列表"的 opencode-go 路由（本层唯一会动的形态） */
  function routeWithModels(models: unknown[], api?: unknown) {
    return {
      providers: {
        'opencode-go': {
          headers: { ...HEADERS },
          models,
          ...(api === undefined ? {} : { api }),
        },
      },
    }
  }

  it('🔴 有 models 列表却缺该模型 ⇒ 追加条目 + 一并设路由 api（目录服务档才会需要它）', () => {
    const p = plan(routeWithModels([{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]))
    const route = (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
    // 原条目逐字保留 + 新条目在尾部
    const models = route.models as { id: string }[]
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' })
    expect(models[1]!.id).toBe(EXTRA_ID)
    // 新模型必须带 reasoningEfforts（否则宿主判它非推理 ⇒ "能用但没 thinking"）
    expect(models[1]).toMatchObject({
      name: EXTRA.name,
      reasoningEfforts: EXTRA.reasoningEfforts,
      compat: EXTRA.compat,
    })
    // 目录外模型拿不到 base.api ⇒ 必须设路由级 api
    expect(route.api).toBe(EXTRA.api)
  })

  it('🔴 目录服务档（没有 models 列表）⇒ **绝不**补 —— 补 models 会把整个目录顶掉', () => {
    const p = plan({ providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', headers: { ...HEADERS } } } })
    expect(p.patch).toEqual({})
    // 常态不出声（否则每次起服务都刷一行）
    expect(p.actions).toEqual([{ kind: 'skip-route', route: 'opencode-go', reason: 'headers-complete' }])
  })

  it('幂等：该模型已在列表里 ⇒ 不重复追加、也不重复写 api', () => {
    const p = plan(routeWithModels([{ id: EXTRA_ID, name: 'x' }]))
    expect(p.patch).toEqual({})
  })

  it('🔴 安全闸：列表含已知异协议模型（minimax-m3 走 anthropic-messages）⇒ 拒绝补，并说明原因', () => {
    // 设路由 api 会覆盖该条目的 base.api，把它配坏 ⇒ 宁可不动
    const p = plan(routeWithModels([{ id: 'minimax-m3' }, { id: 'deepseek-v4-flash' }]))
    expect(p.patch).toEqual({})
    expect(p.actions).toContainEqual({ kind: 'skip-models', route: 'opencode-go', reason: 'mixed-protocol' })
  })

  it('安全闸：路由已显式设了**别的** api ⇒ 拒绝补（那是用户的显式选择）', () => {
    const p = plan(routeWithModels([{ id: 'deepseek-v4-flash' }], 'anthropic-messages'))
    expect(p.patch).toEqual({})
    expect(p.actions).toContainEqual({ kind: 'skip-models', route: 'opencode-go', reason: 'api-conflict' })
  })

  it('路由已显式设了**同值** api ⇒ 补模型但不重复写 api（避免无谓的 settings/updated）', () => {
    const p = plan(routeWithModels([{ id: 'deepseek-v4-flash' }], EXTRA.api))
    const route = (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
    expect(route.api).toBeUndefined() // 键不在场（纪律⑱：不写 undefined）
    expect((route.models as unknown[]).length).toBe(2)
  })

  it('🔴 头齐备 **不阻断** 补模型：两者在同一笔补丁里（曾被 continue 短路）', () => {
    const p = plan(routeWithModels([{ id: 'deepseek-v4-flash' }]))
    const route = (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
    expect(route.headers).toBeUndefined() // 头已齐 ⇒ 不重复补
    expect(route.models).toBeDefined() // 但模型照补
    expect(p.actions).toEqual([{ kind: 'add-models', route: 'opencode-go', ids: [EXTRA_ID], api: EXTRA.api }])
  })

  it('🔴 缺头 + 缺模型 ⇒ 两个动作都在，补丁含 headers ／ models ／ api ／ baseURL', () => {
    const p = plan({ providers: { 'opencode-go': { models: [{ id: 'deepseek-v4-flash' }] } } })
    const route = (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
    // baseURL 是 v1.48.1 补的（目录外模型的必需品；缺了会被宿主整条拒绝）
    expect(Object.keys(route).sort()).toEqual(['api', 'baseURL', 'headers', 'models'])
    expect(p.actions.map((a) => a.kind).sort()).toEqual(['add-models', 'fill-headers'])
  })

  it('模型条目形状：input 是**拷贝**（不共享表里的数组 ⇒ 调用方改补丁不会污染表）', () => {
    const p = plan(routeWithModels([{ id: 'deepseek-v4-flash' }]))
    const route = (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
    const added = (route.models as { id: string; input: string[] }[])[1]!
    expect(added.input).toEqual(EXTRA.input)
    expect(added.input).not.toBe(EXTRA.input)
  })

  it('★ 规格取自目录同族兄弟：thinkingFormat=deepseek 且 reasoningEfforts 各档非空', () => {
    // 判据来源 = pi-ai data/opencode-go.json 的 deepseek-v4-flash（不自行发明规格）
    expect(EXTRA.compat.thinkingFormat).toBe('deepseek')
    expect(EXTRA.api).toBe('openai-completions')
    for (const [level, wire] of Object.entries(EXTRA.reasoningEfforts)) {
      // 宿主：除 off 外必须给非空 wire 值，否则 invalid
      if (level !== 'off') expect(wire).not.toBe('')
    }
  })

  it('describeOpencodeAction 覆盖三个新动作（日志可读，含拒绝原因）', () => {
    expect(describeOpencodeAction({ kind: 'add-models', route: 'opencode-go', ids: [EXTRA_ID], api: 'openai-completions' }))
      .toContain(EXTRA_ID)
    expect(describeOpencodeAction({ kind: 'add-models', route: 'r', ids: [EXTRA_ID], api: null })).not.toContain('api=')
    expect(describeOpencodeAction({ kind: 'skip-models', route: 'r', reason: 'catalog-served' })).toContain('目录')
    expect(describeOpencodeAction({ kind: 'skip-models', route: 'r', reason: 'mixed-protocol' })).toContain('异协议')
    expect(describeOpencodeAction({ kind: 'skip-models', route: 'r', reason: 'api-conflict' })).toContain('api')
  })
})

/**
 * v1.48.1 —— 两处**真机暴露**的缺口（v1.48.0 在本机被宿主整条拒绝，逐字证据见 SESSION.md）：
 *   A 目录外模型缺 **路由级 `baseURL`** ⇒ 宿主 `resolveRouteModels` 三级兜底全空 ⇒ 严格写入拒绝。
 *   B 模型**已经在列表里**但缺 `reasoningEfforts`（"手抄过"的形态）⇒ 宿主判非推理 ⇒ 能用但没 thinking；
 *     只补"缺失的模型"补不到它。
 */
describe('opencode-provider: v1.48.1 两处缺口（baseURL / 已列出但缺规格）', () => {
  const EXTRA_ID = Object.keys(OPENCODE_EXTRA_MODELS)[0] as string
  const EXTRA = OPENCODE_EXTRA_MODELS[EXTRA_ID] as NonNullable<(typeof OPENCODE_EXTRA_MODELS)[string]>

  /** 真机形态：路由**带着四个头**（本插件的稳态）——夹具不带头会让"补头"分支也开火，看不准本层 */
  function providers(route: Record<string, unknown>) {
    return { providers: { 'opencode-go': { headers: { ...HEADERS }, ...route } } }
  }
  function routeOf(p: { patch: Record<string, unknown> }) {
    return (p.patch.providers as Record<string, Record<string, unknown>>)['opencode-go']!
  }

  it('🔴 缺口 A：追加目录外模型时**必须**一并设路由级 baseURL（宿主 :669 三级兜底里唯一可控项）', () => {
    // 事故原文：model "deepseek-v4.1-flash" needs a baseURL; the installed catalog does not describe this route
    const p = plan(providers({ models: [{ id: 'deepseek-v4-flash' }] }))
    expect(routeOf(p).baseURL).toBe(EXTRA.baseUrl)
  })

  it('缺口 A：路由自己写过 baseURL ⇒ 绝不覆盖（用户的端点就是用户的端点）', () => {
    const p = plan(providers({ baseURL: 'https://my-proxy.example/v1', models: [{ id: 'deepseek-v4-flash' }] }))
    expect(Object.keys(routeOf(p))).not.toContain('baseURL')
  })

  it('🔴 缺口 B：模型**已列出**但缺 reasoningEfforts ⇒ 就地补齐（条目数不变、原字段逐字保留）', () => {
    const listed = { id: EXTRA_ID, name: '我自己起的名字', contextWindow: 1024000, maxTokens: 384000, input: ['text', 'image'] }
    const p = plan(providers({ api: EXTRA.api, baseURL: 'https://opencode.ai/zen/go/v1/', models: [listed] }))
    const models = routeOf(p).models as Record<string, unknown>[]
    expect(models).toHaveLength(1) // 不是追加，是就地补
    expect(models[0]!.reasoningEfforts).toEqual(EXTRA.reasoningEfforts)
    // 用户字段一个都不许丢、更不许改
    expect(models[0]!.name).toBe('我自己起的名字')
    expect(models[0]!.contextWindow).toBe(1024000)
    expect(models[0]!.input).toEqual(['text', 'image'])
    // 不重复写 api / baseURL（路由本就写过），也不重复补头
    expect(Object.keys(routeOf(p))).toEqual(['models'])
    expect(p.actions).toEqual([{ kind: 'enrich-models', route: 'opencode-go', ids: [EXTRA_ID] }])
  })

  it('缺口 B：compat 是**合并**，用户已写的键优先（绝不覆盖用户的选择）', () => {
    const p = plan(providers({
      api: EXTRA.api,
      baseURL: 'https://opencode.ai/zen/go/v1/',
      models: [{ id: EXTRA_ID, compat: { thinkingFormat: '自家协议', chatTemplateKwargs: {} } }],
    }))
    const compat = (routeOf(p).models as { compat: Record<string, unknown> }[])[0]!.compat
    expect(compat.thinkingFormat).toBe('自家协议') // 用户值赢
    expect(compat.chatTemplateKwargs).toEqual({}) // 用户键保留
    expect(compat.maxTokensField).toBe('max_tokens') // 用户没写的由我们补
  })

  it('缺口 B 幂等：已带 reasoningEfforts（含显式 false）⇒ 一个字节都不动', () => {
    for (const efforts of [{ low: 'low' }, false]) {
      const p = plan(providers({ api: EXTRA.api, baseURL: 'https://x/v1', models: [{ id: EXTRA_ID, reasoningEfforts: efforts }] }))
      expect(p.patch).toEqual({})
    }
  })

  it('缺口 B 拒绝面：已列出缺档、路由**没写 api**、又无需追加 ⇒ 判不出协议，不碰', () => {
    const p = plan(providers({ baseURL: 'https://x/v1', models: [{ id: EXTRA_ID }] }))
    expect(p.patch).toEqual({})
    expect(p.actions).toContainEqual({ kind: 'skip-models', route: 'opencode-go', reason: 'api-missing' })
  })

  it('缺口 B 拒绝面：路由 api 与本表规格不一致 ⇒ 不补（compat 会配错协议）', () => {
    const p = plan(providers({ api: 'anthropic-messages', models: [{ id: EXTRA_ID }] }))
    expect(p.patch).toEqual({})
    expect(p.actions).toContainEqual({ kind: 'skip-models', route: 'opencode-go', reason: 'api-conflict' })
  })

  it('★ 真机形态复刻：owner 那条手写路由（api+baseURL+三条 models，其中本表模型缺档）⇒ 只动那一条', () => {
    const others = [
      { id: 'union-alpha', name: 'union-alpha', input: [] },
      { id: 'mimo-v2.6-flash', name: 'mimo-v2.6-flash' },
    ]
    const target = { id: EXTRA_ID, name: EXTRA_ID, contextWindow: 1024000, maxTokens: 384000, input: ['text', 'image'] }
    const p = plan(providers({
      apiKeyEnv: 'OPENCODE_GO_RESPONSES_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://opencode.ai/zen/go/v1/',
      models: [target, ...others],
    }))
    const models = routeOf(p).models as Record<string, unknown>[]
    expect(models).toHaveLength(3)
    // 另外两条**逐字不变**（值与键序都一致）
    expect(models[1]).toEqual(others[0])
    expect(models[2]).toEqual(others[1])
    expect(models[0]!.reasoningEfforts).toEqual(EXTRA.reasoningEfforts)
    // 只改 models 一项 —— 别的键一个都不写
    expect(Object.keys(routeOf(p))).toEqual(['models'])
  })

  it('结构事实：本表只有 1 条 ⇒ "追加"与"就地补规格"**互斥**（不可能同批发生）', () => {
    // 该模型已在列表里 ⇒ 没有东西要追加 ⇒ 此时判不出协议就该**整条不碰**（api-missing）
    // 注意：这时连 providers 都不该出现在补丁里（头已齐备 ⇒ 无事可做 ⇒ 不写，避免无谓触发 settings/updated）
    const p = plan(providers({ models: [{ id: EXTRA_ID }] }))
    expect(p.patch).toEqual({})
    expect(p.actions).toContainEqual({ kind: 'skip-models', route: 'opencode-go', reason: 'api-missing' })
  })
})
