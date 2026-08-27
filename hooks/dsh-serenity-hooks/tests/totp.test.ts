import { describe, it, expect } from 'vitest'
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotpCode,
  otpauthUri,
  TOTP_STEP_SECONDS,
} from '../src/totp.js'

describe('TOTP: base32（RFC 4648）', () => {
  it('编码/解码往返一致', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(secret).length).toBe(20)
    expect(base32Encode(base32Decode(secret))).toBe(secret)
  })

  it('RFC 4648 向量：空串/经典向量', () => {
    // RFC 4648 测试向量（无填充）
    expect(base32Encode(new Uint8Array([0]))).toBe('AA')
    expect(base32Encode(new Uint8Array([0x66]))).toBe('MY')
    expect(base32Encode(new Uint8Array([0x66, 0x6f]))).toBe('MZXQ')
    expect(base32Encode(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('MZXW6')
    expect(base32Encode(new Uint8Array([0x66, 0x6f, 0x6f, 0x62]))).toBe('MZXW6YQ')
    expect(base32Encode(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61]))).toBe('MZXW6YTB')
  })

  it('非法字符抛错；大小写不敏感', () => {
    expect(() => base32Decode('ABC!')).toThrow()
    expect(base32Decode('mzxw6')).toEqual(base32Decode('MZXW6'))
  })
})

describe('TOTP: RFC 4226 官方向量（HOTP，TOTP counter 等价）', () => {
  // RFC 4226 附录 D 测试向量（key = ASCII "12345678901234567890"，counter 直接驱动）。
  // TOTP(counter) 与 HOTP(counter) 同构——counter 即事件计数。
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const b32 = base32Encode(secret)

  it('counter=0 → 755224', () => {
    expect(totpCode(b32, 0)).toBe('755224')
  })

  it('counter=1 → 287082', () => {
    expect(totpCode(b32, 1)).toBe('287082')
  })

  it('counter=2 → 359152', () => {
    expect(totpCode(b32, 2)).toBe('359152')
  })

  it('counter=3 → 969429', () => {
    expect(totpCode(b32, 3)).toBe('969429')
  })

  it('counter=4 → 338314', () => {
    expect(totpCode(b32, 4)).toBe('338314')
  })
})

describe('TOTP: 校验与窗口', () => {
  it('verifyTotpCode：正确 code 命中；错误返回 null', () => {
    const b32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
    const counter = 42
    const code = totpCode(b32, counter)
    expect(verifyTotpCode(b32, code, counter * TOTP_STEP_SECONDS)).toBe(counter)
    expect(verifyTotpCode(b32, '000000', counter * TOTP_STEP_SECONDS)).toBeNull()
  })

  it('允许 ±1 窗口漂移', () => {
    const b32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
    const counter = 42
    const prevCode = totpCode(b32, counter - 1)
    const nextCode = totpCode(b32, counter + 1)
    expect(verifyTotpCode(b32, prevCode, counter * TOTP_STEP_SECONDS)).toBe(counter - 1)
    expect(verifyTotpCode(b32, nextCode, counter * TOTP_STEP_SECONDS)).toBe(counter + 1)
  })

  it('非 6 位数字 → null', () => {
    const b32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
    expect(verifyTotpCode(b32, '12345', 0)).toBeNull()
    expect(verifyTotpCode(b32, 'abcdef', 0)).toBeNull()
    expect(verifyTotpCode(b32, '1234567', 0)).toBeNull()
  })
})

describe('TOTP: otpauth URI', () => {
  it('标准格式（issuer/label/secret/period）', () => {
    const uri = otpauthUri('MZXW6YTB', 'yh@serenity-home', 'Serenity Home')
    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('secret=MZXW6YTB')
    expect(uri).toContain('issuer=Serenity')
    expect(uri).toContain('period=30')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('algorithm=SHA1')
  })
})
