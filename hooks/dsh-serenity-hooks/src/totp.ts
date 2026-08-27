/**
 * totp.ts — TOTP 第二因素（RFC 6238，零依赖，v1.22.4）
 *
 * 背景（S142 安全审计 S1）：公网暴露密码登录不足 → 可选 Authenticator 第二因素。
 * 实现：HMAC-SHA1 TOTP（与 Google Authenticator / 1Password / Aegis 等兼容），
 * base32 secret（RFC 4648 无填充），30s 时步，6 位码，允许 ±1 时步漂移。
 * 零依赖（node:crypto HMAC），可单测。
 *
 * 边界：本模块只做纯算法（生成/校验/URI），secret 的存储/绑定由 config-ops +
 * gateway 登录流负责（wire 层永不返回 secret，只返回 hasTotp 布尔）。
 */

import { createHmac, randomBytes } from 'node:crypto'

/** 时步（秒）——RFC 6238 默认 30 */
export const TOTP_STEP_SECONDS = 30
/** 验证窗口：当前时步 ± 1（容忍时钟漂移/生成延迟） */
export const TOTP_WINDOW = 1
/** 输出位数（标准 6 位） */
export const TOTP_DIGITS = 6

// ── base32（RFC 4648，无填充）──

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 字节 → base32（无填充）。secret 显示/otpauth URI 用。 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** base32（无填充，大小写不敏感）→ 字节；非法字符抛错。 */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=]/g, '')
  if (clean.length === 0) throw new Error('empty base32')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

// ── secret ──

/** 生成新 TOTP secret（20 字节 = 160-bit，RFC 4226 推荐 ≥128-bit；返回 base32） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

// ── code 计算与校验 ──

/** 一个时步的 TOTP code（6 位，前导零保留）。counter = floor(epochSeconds / step) */
export function totpCode(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', Buffer.from(key)).update(msg).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** 当前 epoch 秒 */
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * 校验用户输入的 code（允许 ±TOTP_WINDOW 时步漂移，防重放窗口内同 code 复用由
 * 调用方按账号记录最近成功 counter 实现——本函数只做纯算法校验）。
 * @returns 命中的 counter（用于防重放）；不匹配返回 null。
 */
export function verifyTotpCode(secretBase32: string, code: string, nowSeconds = nowEpochSeconds()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(nowSeconds / TOTP_STEP_SECONDS)
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    if (totpCode(secretBase32, current + offset) === code) return current + offset
  }
  return null
}

// ── otpauth URI（Authenticator 扫码/手动录入）──

/**
 * 生成 otpauth://totp URI（标准格式，主流 Authenticator 兼容）。
 * @param secretBase32 - base32 secret
 * @param label - 账号标识（如 "yh@serenity-home"）
 * @param issuer - 发行方（如 "Serenity Home"）
 */
export function otpauthUri(secretBase32: string, label: string, issuer: string): string {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}
