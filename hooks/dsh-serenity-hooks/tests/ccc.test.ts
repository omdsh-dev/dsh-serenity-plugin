import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findSerenityRoot,
  findGitRoot,
  classifyPath,
  resolveInside,
  pathInside,
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

  it('pathInside 前缀判定：兄弟目录不误判', () => {
    // root = /tmp/x/ccc-root，兄弟 /tmp/x/ccc-root2 必须 outside
    const rootAbs = join(tmpdir(), 'ccc-root')
    expect(pathInside(rootAbs, join(rootAbs, 'a', 'b.md'))).toBe(true)
    expect(pathInside(rootAbs, join(rootAbs, 'a.md'))).toBe(true)
    expect(pathInside(rootAbs, join(tmpdir(), 'ccc-root2', 'x.md'))).toBe(false)
    expect(pathInside(rootAbs, join(tmpdir(), 'other', 'x.md'))).toBe(false)
  })

  it('pathInside 跨盘符绝对路径逃逸被阻断（Windows 兼容审计问题 1）', () => {
    // 跨盘：root 在 D:\project\home，target 在 C:\Windows —— 前缀天然不匹配 → outside
    expect(pathInside('D:\\project\\home', 'C:\\Windows', true)).toBe(false)
    expect(pathInside('D:\\project\\home', 'C:\\Windows', false)).toBe(false)
    // 同盘正常 inside
    expect(pathInside('D:\\project\\home', 'D:\\project\\home\\AGENT_SESSIONS', true)).toBe(true)
  })

  it('pathInside Windows 大小写不敏感（caseInsensitive=true 不误拦）', () => {
    expect(pathInside('D:\\project\\home', 'D:\\PROJECT\\HOME\\x.md', true)).toBe(true)
    expect(pathInside('D:\\project\\home', 'D:\\project\\home\\x.md', false)).toBe(true)
    // 区分大小写模式（linux）下不同大小写算 outside（平台行为差异）
    expect(pathInside('D:\\project\\home', 'D:\\PROJECT\\HOME\\x.md', false)).toBe(false)
  })

  it('resolveInside 阻断跨盘绝对路径逃逸（classifyPath 修复联动）', () => {
    // 真实调用：linux 上 resolve('C:\\Windows') = 工作目录下的字面量，不构成跨盘；
    // 该用例验证 resolveInside 对"越出根之外"的统一阻断（相对 .. + 绝对路径）
    expect(() => resolveInside(dir, '../x')).toThrow(/Path escape blocked/)
    expect(() => resolveInside(dir, join(dir, '..', 'outside'))).toThrow(/Path escape blocked/)
  })
})

describe('ccc: 配置', () => {
  it('loadSerenityConfig 读取 .opencode/serenity.json（历史兼容，规范位置）', () => {
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ sessionKeeper: { threshold: 100 } }))
    expect(loadSerenityConfig(dir).sessionKeeper?.threshold).toBe(100)
  })

  it('.dsh/serenity.json 仅作回退（.opencode 优先）', () => {
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ loop: { defaultModel: 'opencode-model' } }))
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ loop: { defaultModel: 'dsh-model' } }))
    // .opencode 优先
    expect(loadSerenityConfig(dir).loop?.defaultModel).toBe('opencode-model')
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
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ safeMode: { blacklist: ['.secrets/', 'regex:\\.env$'] } }))
    const rules = readBlacklist(dir)
    // 对齐 osp：匹配返回条目对象（{pattern} / {pattern, message}）
    expect(matchBlacklist('.secrets/x', rules)).toEqual({ pattern: '.secrets/' })
    expect(matchBlacklist('a/.env', rules)).toEqual({ pattern: 'regex:\\.env$' })
    expect(matchBlacklist('docs/a.md', rules)).toBeNull()
  })

  it('isWriteTool', () => {
    expect(isWriteTool('bash')).toBe(true)
    expect(isWriteTool('write')).toBe(true)
    expect(isWriteTool('read')).toBe(false)
  })
})
