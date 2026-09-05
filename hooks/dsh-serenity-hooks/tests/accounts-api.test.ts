import { describe, it, expect, afterEach } from 'vitest'
import {
  accountDraftFromWire,
  accountToWire,
  fetchWorkspaces,
  fetchConfig,
  newAccountId,
  newTotpSecret,
  otpauthUriClient,
  totpQrSvg,
  validateDraft,
  type WireAccount,
  type AccountDraft,
  type ConfigResponse,
} from '../src/client/accounts-api.js'

describe('accounts-api: totpQrSvg（v1.24.6 二维码绑定）', () => {
  it('生成合法 SVG：含 otpauth URI 数据的二维码（xmlns + path 模块）', () => {
    const svg = totpQrSvg('MZXW6YTB', 'yh@serenity')
    expect(svg).toContain('<svg')
    expect(svg).toContain('xmlns=')
    expect(svg).toContain('path')
    expect(svg.length).toBeGreaterThan(200)
  })

  it('同一 secret 输出稳定（二维码可复现）', () => {
    const a = totpQrSvg('MZXW6YTB', 'yh@serenity')
    const b = totpQrSvg('MZXW6YTB', 'yh@serenity')
    expect(a).toBe(b)
  })

  it('不同 secret 输出不同（二维码随 secret 变化）', () => {
    expect(totpQrSvg('MZXW6YTB', 'yh@serenity')).not.toBe(totpQrSvg('GEZDGNBV', 'yh@serenity'))
  })
})

describe('accounts-api: draft 转换（纯逻辑）', () => {
  const wire: WireAccount = { id: 'a1', user: 'yh', hasPassword: true, hasTotp: true }

  it('wire → draft（pass 空 + isNew=false + hasPassword/hasTotp 透传 + totpState=none）', () => {
    const d = accountDraftFromWire(wire)
    expect(d).toEqual({
      id: 'a1', user: 'yh', pass: '', isNew: false,
      hasPassword: true, hasTotp: true, totpState: 'none',
    })
  })

  it('draft → wire（带 pass 字段；无 TOTP 操作时不带 totp 字段）', () => {
    const d: AccountDraft = {
      id: 'a1', user: 'yh', pass: 'newpw', isNew: false,
      hasPassword: true, hasTotp: false, totpState: 'none',
    }
    expect(accountToWire(d)).toEqual({ id: 'a1', user: 'yh', pass: 'newpw' })
  })

  it('draft → wire（pending 绑定 → 带 totpSecret；无确认码）', () => {
    const d: AccountDraft = {
      id: 'a1', user: 'yh', pass: '', isNew: false,
      hasPassword: true, hasTotp: false, totpState: 'pending',
      totpSecret: 'MZXW6YTB',
    }
    expect(accountToWire(d)).toEqual({ id: 'a1', user: 'yh', pass: '', totpSecret: 'MZXW6YTB' })
  })

  it('draft → wire（clear 解绑 → 带 totpReset）', () => {
    const d: AccountDraft = {
      id: 'a1', user: 'yh', pass: '', isNew: false,
      hasPassword: true, hasTotp: true, totpState: 'clear',
    }
    expect(accountToWire(d)).toEqual({ id: 'a1', user: 'yh', pass: '', totpReset: true })
  })

  it('newAccountId 唯一且非空', () => {
    expect(newAccountId()).not.toBe(newAccountId())
    expect(newAccountId().length).toBeGreaterThan(0)
  })
})

describe('accounts-api: validateDraft（校验）', () => {
  const base = (over: Partial<AccountDraft>): AccountDraft => ({
    id: 'a', user: 'yh', pass: '', isNew: false,
    hasPassword: true, hasTotp: false, totpState: 'none', ...over,
  })

  it('合法行 → null', () => {
    expect(validateDraft(base({}))).toBeNull()
  })

  it('用户名为空 → 报错', () => {
    expect(validateDraft(base({ user: '  ' }))).toContain('用户名')
  })

  it('新账号无密码 → 报错', () => {
    expect(validateDraft(base({ isNew: true, hasPassword: false }))).toContain('密码')
  })

  it('既有账号 pass 空 → 合法（保留原 hash）', () => {
    expect(validateDraft(base({}))).toBeNull()
  })

  it('v1.24.7：pending 绑定无需确认码（生成即绑定，保存落盘）', () => {
    expect(validateDraft(base({ totpState: 'pending', totpSecret: 'MZXW6YTB' }))).toBeNull()
  })
})

describe('accounts-api: TOTP secret / otpauth URI（v1.22.4）', () => {
  it('newTotpSecret：base32 字符集 + 32 字符（20 字节）', () => {
    const s = newTotpSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
    expect(s).not.toBe(newTotpSecret())
  })

  it('otpauthUriClient：标准格式', () => {
    const uri = otpauthUriClient('MZXW6YTB', 'yh@serenity', 'Serenity Home')
    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('secret=MZXW6YTB')
    expect(uri).toContain('issuer=Serenity')
    expect(uri).toContain('period=30')
  })
})

describe('accounts-api: fetchWorkspaces / fetchConfig（v1.28.0 适配 0.1.2-rc.1 A2 A′：读 /serenity/config knownWorkspaces）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const cfgResponse = (knownWorkspaces: Array<{ path: string; title: string }> | undefined): ConfigResponse => ({
    config: {
      gateway: {
        enabled: true, host: '0.0.0.0', port: 3081, accounts: [], workspaces: [],
        cookieSecure: false, allowWorkspaceCreate: true, totpEnabled: false,
      },
      persona: { mode: '', overrideText: '' },
      publicAsk: { allowed: [] },
    },
    knownWorkspaces,
  })

  it('fetchWorkspaces 读 GET /serenity/config 的 knownWorkspaces（rc.1 替代 workspace.list）', async () => {
    let calledPath: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledPath = typeof input === 'string' ? input : input instanceof URL ? input.pathname : (input as Request).url
      return new Response(JSON.stringify(cfgResponse([
        { path: '/home/yh/home/home-serenity', title: 'home-serenity' },
      ])), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const workspaces = await fetchWorkspaces()
    expect(workspaces).toEqual([{ path: '/home/yh/home/home-serenity', title: 'home-serenity' }])
    // 走 gateway 自有配置接口（非 DSH RPC workspace.list）
    expect(calledPath).toContain('/serenity/config')
  })

  it('fetchConfig 返回 {config, knownWorkspaces}；knownWorkspaces 缺省 → 空数组', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(cfgResponse(undefined)), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const resp = await fetchConfig()
    expect(resp?.config?.gateway.port).toBe(3081)
    expect(resp?.knownWorkspaces).toEqual([])
  })

  it('fetchWorkspaces：非 200 → 空数组（面板显示暂无可选）', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    expect(await fetchWorkspaces()).toEqual([])
  })

  it('fetchWorkspaces：knownWorkspaces 带过滤语义由服务端完成（client 透传）', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(cfgResponse([
      { path: '/a', title: '/a' },
      { path: '/b', title: 'B' },
    ])), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    expect(await fetchWorkspaces()).toEqual([
      { path: '/a', title: '/a' },
      { path: '/b', title: 'B' },
    ])
  })
})
