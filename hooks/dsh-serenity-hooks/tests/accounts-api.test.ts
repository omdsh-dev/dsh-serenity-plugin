import { describe, it, expect } from 'vitest'
import {
  accountDraftFromWire,
  accountToWire,
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
