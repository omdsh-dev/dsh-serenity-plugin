import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { hashPassword } from '../src/config-ops.js'
import {
  loginPageHtml,
  verifyGatewayLogin,
  issueToken,
  validateToken,
  cookieValue,
} from '../src/gateway.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-gateway-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('F1: verifyGatewayLogin（账号验证）', () => {
  const accounts = [
    { user: 'yh', passHash: hashPassword('secret-1') },
    { user: 'danica', passHash: hashPassword('pw2') },
  ]

  it('正确账号密码 → true', () => {
    expect(verifyGatewayLogin(accounts, 'yh', 'secret-1')).toBe(true)
    expect(verifyGatewayLogin(accounts, 'danica', 'pw2')).toBe(true)
  })

  it('错误密码 → false', () => {
    expect(verifyGatewayLogin(accounts, 'yh', 'wrong')).toBe(false)
  })

  it('未知账号 → false', () => {
    expect(verifyGatewayLogin(accounts, 'nobody', 'x')).toBe(false)
  })

  it('空账号列表 → 全 false', () => {
    expect(verifyGatewayLogin([], 'yh', 'secret-1')).toBe(false)
  })
})

describe('F1: token（颁发/校验）', () => {
  it('颁发后有效', () => {
    const t = issueToken()
    expect(validateToken(t)).toBe(true)
  })

  it('未颁发/空/乱值 → 无效', () => {
    expect(validateToken(undefined)).toBe(false)
    expect(validateToken('')).toBe(false)
    expect(validateToken('not-issued')).toBe(false)
  })
})

describe('F1: cookieValue（Cookie 头解析）', () => {
  it('提取指定 cookie', () => {
    const header = 'serenity_session=abc123; other=x'
    expect(cookieValue(header, 'serenity_session')).toBe('abc123')
    expect(cookieValue(header, 'other')).toBe('x')
  })

  it('无 header/无匹配 → undefined', () => {
    expect(cookieValue(undefined, 'serenity_session')).toBeUndefined()
    expect(cookieValue('a=b', 'missing')).toBeUndefined()
  })
})

describe('F1: loginPageHtml（登录页）', () => {
  it('含表单 + 错误提示注入', () => {
    const html = loginPageHtml('用户名或密码错误')
    expect(html).toContain('<form')
    expect(html).toContain('action="/serenity/login"')
    expect(html).toContain('用户名或密码错误')
    expect(html).toContain('autocomplete="username"')
  })

  it('无错误时提示区为空', () => {
    const html = loginPageHtml('')
    expect(html).toContain('class="error"></div>')
  })
})
