import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { runCcFs, type CcFsArgs, CC_FS_ACTIONS } from '../src/fs-ops.js'

// reveal 打开 OS 文件管理器（有 GUI 副作用）——模块级 mock child_process + os.platform，
// 使测试断言调用参数而不真实弹出窗口（node: 内置模块命名空间不可 spyOn）。
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})

const mockedExec = vi.mocked(execFileSync)
const mockedSpawn = vi.mocked(spawn)
const mockedPlatform = vi.mocked(platform)

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

describe('fs-ops: 读操作（对齐 osp spec）', () => {
  it('root / resolve / exists / relative', () => {
    expect(run('root')).toBe(dir)
    expect(run('resolve', { path: 'docs' })).toBe(join(dir, 'docs'))
    // exists 返回 'true'/'false' 字符串（对齐 osp）
    expect(run('exists', { path: 'docs/nested/a.md' })).toBe('true')
    expect(run('exists', { path: 'nope' })).toBe('false')
    expect(run('relative', { path: join(dir, 'docs', 'a.md') })).toBe('docs/a.md')
  })

  it('list 返回 {path, entries(元数据), count}', () => {
    const list = run('list') as { path: string; entries: { name: string; type: string; size: number; sizeHuman: string; mtime: string }[]; count: number }
    expect(list.path).toBe(dir)
    expect(list.entries.map((e) => e.name)).toContain('docs')
    const docs = list.entries.find((e) => e.name === 'docs')
    expect(docs?.type).toBe('dir')
    expect(list.count).toBeGreaterThan(0)
  })

  it('tree 返回嵌套 children 结构（filesOnly/dirsOnly）', () => {
    const tree = run('tree') as { path: string; entries: { name: string; type: string; children?: unknown[] }[]; maxDepth: number }
    expect(tree.path).toBe(dir)
    const docs = tree.entries.find((e) => e.name === 'docs')
    expect(docs?.type).toBe('dir')
    expect(docs?.children).toBeDefined()
    // filesOnly
    const files = run('tree', { filesOnly: true }) as { entries: { type: string }[] }
    expect(files.entries.every((e) => e.type !== 'dir' || e.type === 'file')).toBe(true)
    // 互斥报错
    expect(() => run('tree', { filesOnly: true, dirsOnly: true })).toThrow(/mutually exclusive/)
  })

  it('find 支持 glob 与大小写不敏感子串', () => {
    expect(run('find', { pattern: 'a.md' })).toEqual({ path: dir, pattern: 'a.md', matches: ['docs/nested/a.md'], count: 1 })
    // glob *
    expect(run('find', { pattern: '*.md' })).toEqual({ path: dir, pattern: '*.md', matches: ['docs/nested/a.md'], count: 1 })
    // absolute
    const abs = run('find', { pattern: 'a.md', absolute: true }) as { matches: string[] }
    expect(abs.matches[0]).toBe(join(dir, 'docs/nested/a.md'))
    // 指定起点
    const sub = run('find', { pattern: 'a.md', path: 'docs/nested' }) as { matches: string[] }
    expect(sub.matches).toContain('docs/nested/a.md')
  })

  it('info 返回多行元数据（type/size/mtime/mode/uid/gid）', () => {
    const info = run('info', { path: 'docs/nested/a.md' }) as string
    expect(info).toContain('type: file')
    expect(info).toContain('size: 5 (5 B)')
    expect(info).toContain('mtime:')
    expect(info).toContain('mode:')
    expect(() => run('info', { path: 'nope' })).toThrow(/does not exist/)
  })
})

describe('fs-ops: 写操作与守卫（对齐 osp spec）', () => {
  it('mkdir/touch/append/mv/cp', () => {
    run('mkdir', { path: 'tmp/x' })
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

  it('rm 非空目录需 recursive（对齐 osp）', () => {
    const r = run('rm', { path: 'docs' }) as string
    expect(r).toContain('[SKIP] directory not empty')
    expect(existsSync(join(dir, 'docs'))).toBe(true)
    run('rm', { path: 'docs', recursive: true })
    expect(existsSync(join(dir, 'docs'))).toBe(false)
  })

  it('rm 根与 .serenity 保护', () => {
    // 对齐 osp：assertNotProtected 抛错被 catch 为 [SKIP]（不整体抛错）
    const rRoot = run('rm', { path: '.' }) as string
    expect(rRoot).toContain('refusing to delete the CCC root directory')
    const r = run('rm', { path: '.serenity' }) as string
    expect(r).toContain('[SKIP]')
    expect(existsSync(join(dir, '.serenity'))).toBe(true)
  })

  it('rm -r 受保护注册表祖先目录 → [SKIP]（review P2-2：文件级保护不可被删父目录绕过）', () => {
    // 建聚合档目录树（.serenity=test → cccName=test）
    const aggDir = join(dir, '.opencode/skills/test/references')
    mkdirSync(aggDir, { recursive: true })
    writeFileSync(join(aggDir, 'mech-registry.json'), JSON.stringify({ version: 1, entries: [] }), 'utf-8')
    // 直接删注册表文件 → [SKIP]
    const rFile = run('rm', { path: '.opencode/skills/test/references/mech-registry.json' }) as string
    expect(rFile).toContain('[SKIP]')
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(true)
    // rm -r references/ 目录（递归）→ [SKIP]（祖先目录保护）
    const rDir = run('rm', { path: '.opencode/skills/test/references', recursive: true }) as string
    expect(rDir).toContain('[SKIP]')
    expect(rDir).toContain('ancestor of the ACC-managed mech-registry.json')
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(true)
    // mv references/ 到别处 → 拒绝（祖先目录 mv 保护）
    expect(() => run('mv', { src: '.opencode/skills/test/references', dst: '.opencode/skills/test/references-moved' })).toThrow(/ancestor of the ACC-managed/)
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(true)
    // 非聚合档的普通目录仍可正常删（不误伤）
    mkdirSync(join(dir, '.opencode/skills/test/docs'), { recursive: true })
    writeFileSync(join(dir, '.opencode/skills/test/docs/x.txt'), 'x')
    const rOk = run('rm', { path: '.opencode/skills/test/docs', recursive: true }) as string
    expect(rOk).toContain('[OK] deleted:')
    expect(existsSync(join(dir, '.opencode/skills/test/docs'))).toBe(false)
  })

  it('cp 目录需 recursive（对齐 osp）', () => {
    expect(() => run('cp', { src: 'docs', dst: 'docs-copy' })).toThrow(/use recursive/)
    run('cp', { src: 'docs', dst: 'docs-copy', recursive: true })
    expect(existsSync(join(dir, 'docs-copy'))).toBe(true)
    // dst 已存在报错
    expect(() => run('cp', { src: 'docs/nested/a.md', dst: 'docs-copy' })).toThrow(/already exists/)
  })

  it('mv dst 已存在报错', () => {
    expect(() => run('mv', { src: 'docs/nested/a.md', dst: 'docs' })).toThrow(/already exists/)
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
    const r = run('reveal', { path: 'docs/nested/a.md' }) as string
    expect(r).toContain('revealed in file manager:')
    expect(mockedExec).toHaveBeenCalledWith('xdg-open', [dirname(join(dir, 'docs/nested/a.md'))], expect.anything())
  })

  it('reveal 目录 → 打开目录本身', () => {
    mockedExec.mockClear()
    run('reveal', { path: 'docs' })
    expect(mockedExec).toHaveBeenCalledWith('xdg-open', [join(dir, 'docs')], expect.anything())
  })

  it('reveal 缺 path 报错', () => {
    expect(() => run('reveal')).toThrow(/reveal requires path/)
  })

  it('reveal 不存在路径报错', () => {
    expect(() => run('reveal', { path: 'nope' })).toThrow(/no such path/)
  })

  it('reveal 路径逃逸阻断', () => {
    expect(() => run('reveal', { path: '../outside' })).toThrow(/Path escape blocked/)
  })

  it('reveal Windows 目录 → explorer <dir>（fire-and-forget，不判定退出码）', () => {
    mockedPlatform.mockReturnValueOnce('win32')
    mockedSpawn.mockClear()
    mockedExec.mockClear()
    run('reveal', { path: 'docs' })
    expect(mockedSpawn).toHaveBeenCalledWith('explorer', [join(dir, 'docs')], expect.objectContaining({ detached: true }))
    // GUI 子系统进程：成功也常非零 → 不能经 execFileSync 判定
    expect(mockedExec).not.toHaveBeenCalled()
  })

  it('reveal Windows 文件 → explorer /select,<abs>（选中该文件；合并参数，Windows 审计问题 7）', () => {
    mockedPlatform.mockReturnValueOnce('win32')
    mockedSpawn.mockClear()
    mockedExec.mockClear()
    run('reveal', { path: 'docs/nested/a.md' })
    expect(mockedSpawn).toHaveBeenCalledWith('explorer', [`/select,${join(dir, 'docs/nested/a.md')}`], expect.objectContaining({ detached: true }))
    expect(mockedExec).not.toHaveBeenCalled()
  })
})
