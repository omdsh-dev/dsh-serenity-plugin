import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runCcFs, type CcFsArgs, CC_FS_ACTIONS } from '../src/fs-ops.js'

// reveal 打开 OS 文件管理器（有 GUI 副作用）——模块级 mock child_process，
// 使测试断言调用参数而不真实弹出窗口（node: 内置模块命名空间不可 spyOn）。
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}))

const mockedExec = vi.mocked(execFileSync)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-fs-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'docs', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'nested', 'a.md'), 'hello')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(action: CcFsArgs['action'], extra: Partial<CcFsArgs> = {}): unknown {
  return runCcFs(dir, { action, ...extra })
}

describe('fs-ops: 读操作', () => {
  it('root / resolve / exists / relative', () => {
    expect(run('root')).toBe(dir)
    expect(run('resolve', { path: 'docs' })).toBe(join(dir, 'docs'))
    expect(run('exists', { path: 'docs/nested/a.md' })).toBe(true)
    expect(run('exists', { path: 'nope' })).toBe(false)
    expect(run('relative', { path: join(dir, 'docs', 'a.md') })).toBe('docs/a.md')
  })

  it('list / tree / find', () => {
    const list = run('list') as { name: string }[]
    expect(list.map((e) => e.name)).toContain('docs')

    const tree = run('tree') as { path: string }[]
    expect(tree.some((e) => e.path === 'docs/nested/a.md')).toBe(true)

    expect(run('find', { pattern: 'a.md' })).toEqual(['docs/nested/a.md'])
    expect(run('find', { pattern: 'regex:^a\\.md$' })).toEqual(['docs/nested/a.md'])
  })

  it('info', () => {
    const info = run('info', { path: 'docs/nested/a.md' }) as { exists: boolean; type: string; size: number }
    expect(info.exists).toBe(true)
    expect(info.type).toBe('file')
    expect(info.size).toBe(5)
  })
})

describe('fs-ops: 写操作与守卫', () => {
  it('mkdir/touch/append/mv/cp', () => {
    run('mkdir', { paths: ['tmp/x'] })
    run('touch', { path: 'tmp/x/t.txt' })
    run('append', { path: 'tmp/x/t.txt', content: 'line1' })
    expect(existsSync(join(dir, 'tmp/x/t.txt'))).toBe(true)

    run('mv', { src: 'tmp/x/t.txt', dst: 'tmp/x/u.txt' })
    expect(existsSync(join(dir, 'tmp/x/u.txt'))).toBe(true)

    run('cp', { src: 'tmp/x/u.txt', dst: 'tmp/copy.txt' })
    expect(existsSync(join(dir, 'tmp/copy.txt'))).toBe(true)
  })

  it('rm dry-run 不删除', () => {
    run('rm', { path: 'docs/nested/a.md', dryRun: true })
    expect(existsSync(join(dir, 'docs/nested/a.md'))).toBe(true)
  })

  it('rm 根保护', () => {
    expect(() => run('rm', { path: '.' })).toThrow(/拒绝删除 CCC 根本身/)
  })

  it('路径逃逸阻断', () => {
    expect(() => run('resolve', { path: '../escape' })).toThrow(/Path escape blocked/)
    expect(() => run('touch', { path: '../x' })).toThrow(/Path escape blocked/)
  })
})

describe('fs-ops: reveal（OS 文件管理器打开）', () => {
  it('CC_FS_ACTIONS 含 reveal', () => {
    expect(CC_FS_ACTIONS).toContain('reveal')
  })

  it('reveal 文件 → 打开所在目录（linux xdg-open）', () => {
    mockedExec.mockClear()
    const r = run('reveal', { path: 'docs/nested/a.md' }) as { ok: boolean; revealed: string }
    expect(r.ok).toBe(true)
    expect(r.revealed).toBe('docs/nested/a.md')
    expect(mockedExec).toHaveBeenCalledWith('xdg-open', [dirname(join(dir, 'docs/nested/a.md'))], expect.anything())
  })

  it('reveal 目录 → 打开目录本身', () => {
    mockedExec.mockClear()
    const r = run('reveal', { path: 'docs' }) as { ok: boolean; revealed: string }
    expect(r.ok).toBe(true)
    expect(r.revealed).toBe('docs')
    expect(mockedExec).toHaveBeenCalledWith('xdg-open', [join(dir, 'docs')], expect.anything())
  })

  it('reveal 缺 path 报错', () => {
    expect(() => run('reveal')).toThrow(/reveal 需要 path/)
  })

  it('reveal 不存在路径报错', () => {
    expect(() => run('reveal', { path: 'nope' })).toThrow(/no such path/)
  })

  it('reveal 路径逃逸阻断', () => {
    expect(() => run('reveal', { path: '../outside' })).toThrow(/Path escape blocked/)
  })
})
