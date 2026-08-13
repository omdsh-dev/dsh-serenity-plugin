import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findSerenityRoot,
  findGitRoot,
  classifyPath,
  resolveInside,
  loadSerenityConfig,
  isSafeModeOn,
  readBlacklist,
  matchBlacklist,
  isWriteTool,
} from '../src/ccc.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ccc-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ccc: P1/P2/P3', () => {
  it('findSerenityRoot 上溯', () => {
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(findSerenityRoot(nested)).toBe(dir)
    expect(findSerenityRoot('/tmp')).toBeNull()
  })

  it('findGitRoot', () => {
    expect(findGitRoot(dir)).toBeNull()
    mkdirSync(join(dir, '.git'))
    expect(findGitRoot(dir)).toBe(dir)
  })

  it('classifyPath 三分', () => {
    expect(classifyPath(join(dir, 'a.md'), dir)).toBe('inside')
    expect(classifyPath('/tmp/x', dir)).toBe('outside')
    expect(classifyPath(dir, dir)).toBe('same')
  })

  it('resolveInside 阻断逃逸', () => {
    expect(() => resolveInside(dir, '../x')).toThrow(/Path escape blocked/)
  })
})

describe('ccc: 配置', () => {
  it('loadSerenityConfig 读取 .dsh/serenity.json', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ sessionKeeper: { threshold: 100 } }))
    expect(loadSerenityConfig(dir).sessionKeeper?.threshold).toBe(100)
  })

  it('无配置返回空对象', () => {
    expect(loadSerenityConfig(dir)).toEqual({})
  })
})

describe('ccc: 安全模式', () => {
  it('标记文件控制 isSafeModeOn', () => {
    expect(isSafeModeOn(dir)).toBe(false)
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    expect(isSafeModeOn(dir)).toBe(true)
  })

  it('readBlacklist + matchBlacklist（前缀/regex）', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ safeMode: { blacklist: ['.secrets/', 'regex:\\.env$'] } }))
    const rules = readBlacklist(dir)
    expect(matchBlacklist('.secrets/x', rules)).toBe('.secrets/')
    expect(matchBlacklist('a/.env', rules)).toBe('regex:\\.env$')
    expect(matchBlacklist('docs/a.md', rules)).toBeNull()
  })

  it('isWriteTool', () => {
    expect(isWriteTool('bash')).toBe(true)
    expect(isWriteTool('write')).toBe(true)
    expect(isWriteTool('read')).toBe(false)
  })
})
