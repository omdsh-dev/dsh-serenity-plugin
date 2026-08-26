import { describe, it, expect } from 'vitest'
import {
  accountDraftFromWire,
  accountToWire,
  newAccountId,
  validateDraft,
  type WireAccount,
} from '../src/client/accounts-api.js'

describe('accounts-api: draft 转换（纯逻辑）', () => {
  const wire: WireAccount = { id: 'a1', user: 'yh', hasPassword: true }

  it('wire → draft（pass 空 + isNew=false + hasPassword 透传）', () => {
    const d = accountDraftFromWire(wire)
    expect(d).toEqual({ id: 'a1', user: 'yh', pass: '', isNew: false, hasPassword: true })
  })

  it('draft → wire（带 pass 字段）', () => {
    const d = { id: 'a1', user: 'yh', pass: 'newpw', isNew: false, hasPassword: true }
    expect(accountToWire(d)).toEqual({ id: 'a1', user: 'yh', pass: 'newpw' })
  })

  it('newAccountId 唯一且非空', () => {
    expect(newAccountId()).not.toBe(newAccountId())
    expect(newAccountId().length).toBeGreaterThan(0)
  })
})

describe('accounts-api: validateDraft（校验）', () => {
  it('合法行 → null', () => {
    expect(validateDraft({ id: 'a', user: 'yh', pass: '', isNew: false, hasPassword: true })).toBeNull()
  })

  it('用户名为空 → 报错', () => {
    expect(validateDraft({ id: 'a', user: '  ', pass: '', isNew: false, hasPassword: true })).toContain('用户名')
  })

  it('新账号无密码 → 报错', () => {
    expect(validateDraft({ id: 'a', user: 'yh', pass: '', isNew: true, hasPassword: false })).toContain('密码')
  })

  it('既有账号 pass 空 → 合法（保留原 hash）', () => {
    expect(validateDraft({ id: 'a', user: 'yh', pass: '', isNew: false, hasPassword: true })).toBeNull()
  })
})
