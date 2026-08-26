import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveImageToTmp, IMAGE_UPLOAD_DIR } from '../src/api.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'img-upload-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 1x1 透明 PNG 的 base64 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('api: saveImageToTmp（图片自动落盘基础设施，S142）', () => {
  it('合法 png → 写 _tmp/images_from_user/<ts>-<rand>.png，返回相对路径', () => {
    const path = saveImageToTmp(dir, 'image/png', PNG_BASE64)
    expect(path.startsWith(`${IMAGE_UPLOAD_DIR}/`)).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    const abs = join(dir, path)
    const bytes = readFileSync(abs)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('类型白名单：jpeg/webp/gif 接受；其他类型拒绝', () => {
    expect(saveImageToTmp(dir, 'image/jpeg', PNG_BASE64)).toMatch(/\.jpg$/)
    expect(saveImageToTmp(dir, 'image/webp', PNG_BASE64)).toMatch(/\.webp$/)
    expect(saveImageToTmp(dir, 'image/gif', PNG_BASE64)).toMatch(/\.gif$/)
    expect(() => saveImageToTmp(dir, 'application/pdf', PNG_BASE64)).toThrow(/unsupported media type/)
    expect(() => saveImageToTmp(dir, '', PNG_BASE64)).toThrow(/unsupported media type/)
  })

  it('缺失 data 拒绝', () => {
    expect(() => saveImageToTmp(dir, 'image/png', '')).toThrow(/missing image data/)
  })

  it('超 10MB 拒绝', () => {
    const big = 'A'.repeat(14 * 1024 * 1024) // 14MB base64 → 解码 ~10.5MB > 10MB 上限
    expect(() => saveImageToTmp(dir, 'image/png', big)).toThrow(/image size out of range/)
  })

  it('目录自动创建（幂等多次写入）', () => {
    saveImageToTmp(dir, 'image/png', PNG_BASE64)
    const p2 = saveImageToTmp(dir, 'image/png', PNG_BASE64)
    expect(p2).not.toBe(saveImageToTmp(dir, 'image/png', PNG_BASE64))
  })
})
