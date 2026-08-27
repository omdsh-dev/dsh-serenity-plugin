import { describe, it, expect, afterEach } from 'vitest'
import {
  accountDraftFromWire,
  accountToWire,
  fetchWorkspaces,
  newAccountId,
  newTotpSecret,
  otpauthUriClient,
  validateDraft,
  type WireAccount,
  type AccountDraft,
} from '../src/client/accounts-api.js'

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

  it('draft → wire（pending 绑定 → 带 totpSecret）', () => {
    const d: AccountDraft = {
      id: 'a1', user: 'yh', pass: '', isNew: false,
      hasPassword: true, hasTotp: false, totpState: 'pending',
      totpSecret: 'MZXW6YTB', totpConfirm: '123456',
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

  it('pending 绑定缺确认码 → 报错', () => {
    expect(validateDraft(base({ totpState: 'pending', totpSecret: 'MZXW6YTB', totpConfirm: '' }))).toContain('6 位确认码')
  })

  it('pending 绑定确认码非 6 位数字 → 报错', () => {
    expect(validateDraft(base({ totpState: 'pending', totpSecret: 'MZXW6YTB', totpConfirm: '12ab' }))).toContain('6 位确认码')
  })

  it('pending 绑定确认码合法 → null', () => {
    expect(validateDraft(base({ totpState: 'pending', totpSecret: 'MZXW6YTB', totpConfirm: '123456' }))).toBeNull()
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

describe('accounts-api: fetchWorkspaces（v1.22 workspace.list 信封）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('请求信封完整 ClientRequest（type/rpcId/method/payload——缺 type/method 会 bad-request）', async () => {
    let sent: unknown = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init?.body ? JSON.parse(String(init.body)) : null
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'ws-1',
        result: { ok: true, value: { items: [{ path: '/home/yh/home/home-serenity', title: 'home-serenity' }], archivedSessionIds: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const workspaces = await fetchWorkspaces()
    expect(workspaces).toEqual([{ path: '/home/yh/home/home-serenity', title: 'home-serenity' }])
    // 信封完整：type + rpcId + method + payload（DSH clientRequestSchema 校验）
    expect(sent).toMatchObject({
      type: 'client-request',
      method: 'workspace.list',
      payload: {},
    })
    expect((sent as { rpcId: string }).rpcId).toMatch(/^ws-/)
  })

  it('响应 ok=false / 非 200 → 空数组（面板手输兜底）', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    expect(await fetchWorkspaces()).toEqual([])
  })

  it('响应缺 items → 空数组', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'ws-2', result: { ok: true, value: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    expect(await fetchWorkspaces()).toEqual([])
  })

  it('item 无 path → 过滤（title 缺省回退 path）', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'ws-3',
      result: { ok: true, value: { items: [
        { path: '/a', title: '' },
        { path: '/b', title: 'B' },
        { title: 'no-path' },
      ], archivedSessionIds: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    expect(await fetchWorkspaces()).toEqual([
      { path: '/a', title: '/a' },
      { path: '/b', title: 'B' },
    ])
  })
})
