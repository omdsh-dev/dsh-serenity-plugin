import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveFileToTmp, sanitizeFileName, FILE_UPLOAD_DIR } from '../src/api.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-upload-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 'hello' 的 base64 */
const HELLO_B64 = 'aGVsbG8='

describe('api: sanitizeFileName（路径逃逸 + 非法字符脱敏）', () => {
  it('去路径分隔符：只留 basename', () => {
    expect(sanitizeFileName('../etc/passwd.pdf')).toBe('passwd.pdf')
    expect(sanitizeFileName('C:\\Users\\x\\a.txt')).toBe('a.txt')
  })

  it('去前导点 / 空 → file', () => {
    expect(sanitizeFileName('..')).toBe('file')
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName('   ')).toBe('file')
  })

  it('非法字符替换 + 限长 100', () => {
    expect(sanitizeFileName('a:b*c.txt')).toBe('a-b-c.txt')
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(100)
  })
})

describe('api: saveFileToTmp（任意文件自动落盘，v1.24.1）', () => {
  it('合法 pdf → 写 _tmp/files_from_user/<ts>-<rand>-<name>，返回相对路径', () => {
    const path = saveFileToTmp(dir, 'report.pdf', HELLO_B64)
    expect(path.startsWith(`${FILE_UPLOAD_DIR}/`)).toBe(true)
    expect(path.endsWith('-report.pdf')).toBe(true)
    const abs = join(dir, path)
    expect(readFileSync(abs, 'utf-8')).toBe('hello')
  })

  it('文件名 sanitize：路径成分剥离，保留扩展名', () => {
    const path = saveFileToTmp(dir, '../x/notes.txt', HELLO_B64)
    expect(path.endsWith('-notes.txt')).toBe(true)
  })

  it('可执行扩展名拒绝（安全边界）', () => {
    expect(() => saveFileToTmp(dir, 'evil.exe', HELLO_B64)).toThrow(/blocked executable file type/)
    expect(() => saveFileToTmp(dir, 'a.sh', HELLO_B64)).toThrow(/blocked executable file type/)
    expect(() => saveFileToTmp(dir, 'b.dll', HELLO_B64)).toThrow(/blocked executable file type/)
  })

  it('缺失文件名 / 缺失数据拒绝', () => {
    expect(() => saveFileToTmp(dir, '', HELLO_B64)).toThrow(/missing file name/)
    expect(() => saveFileToTmp(dir, 'a.pdf', '')).toThrow(/missing file data/)
  })

  it('超 10MB 拒绝（用户拍板：与图片一致）', () => {
    const big = 'A'.repeat(14 * 1024 * 1024) // 14MB base64 → 解码 ~10.5MB > 10MB 上限
    expect(() => saveFileToTmp(dir, 'big.pdf', big)).toThrow(/file size out of range/)
  })

  it('目录自动创建 + 文件名唯一（时间戳+随机）', () => {
    const p1 = saveFileToTmp(dir, 'a.pdf', HELLO_B64)
    const p2 = saveFileToTmp(dir, 'a.pdf', HELLO_B64)
    expect(p1).not.toBe(p2)
    expect(readdirSync(join(dir, FILE_UPLOAD_DIR))).toHaveLength(2)
  })
})
