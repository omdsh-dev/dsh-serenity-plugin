/**
 * fs-ops-guards.test.ts — `container_fs` 的**守卫面与路径校验**（⑤ 第 21 件）
 *
 * 挑靶依据 = **分支覆盖率**（`fs-ops.ts` 64.36%，除已退役 `diag-ops` 与已满的 `output-guard-seam` 外最低）。
 * 🔴 **缺口形态**：既有 `tests/fs-ops.test.ts` 走的是**顺利路径**（正常读/写/删 + 注册表保护 + 词法逃逸），
 * 而报告里成片的 `cbranch-no`/`cstat-no` 全是**守卫与边界**：缺参 ／ 不存在 ／ 根外绝对路径 ／
 * 绝对路径的正常侧 ／ mkdir 已存在两态 ／ rm 的 not-found·dry-run 目录·**空目录 rmdir** ／
 * mv·cp 自动建父目录 ／ touch 已存在 ／ **写路径的 symlink 逃逸** ／ 注册表保护的**另一种文案档** ／
 * 「无 cccName ⇒ 不保护」／ `detectFileType`·`humanSize`·`getFileInfo` 的兜底档 ／ 未知动作。
 *
 * 🔵 **判据纪律（本件复用）**：① 破坏性动作的断言看**盘上结果**，不看返回文本（㊿ 同族）；
 * ② 失败形态用**真形态**注入（悬空 symlink ／ unix socket ／ 真根外路径 ／ 真 symlink 指向根外）；
 * ③ 「期望行为 vs 现状」不一致的**登记性缺口**用 `it.fails`（修好即翻红提示清理，见 §7.7 先例）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCcFs, type CcFsArgs } from '../src/fs-ops.js'

let dir: string
let outside: string | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-fsguards-'))
  outside = null
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'docs', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'nested', 'a.md'), 'hello')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (outside) {
    rmSync(outside, { recursive: true, force: true })
    outside = null
  }
})

function run(action: CcFsArgs['action'], extra: Partial<CcFsArgs> = {}): unknown {
  return runCcFs(dir, { action, ...extra })
}

function outsideDir(): string {
  outside = mkdtempSync(join(tmpdir(), 'hooks-fsguards-out-'))
  return outside
}

// ── 守卫：缺参 / 不存在 / 未知动作（成片的 `cstat-no` 守卫体） ──────────────────────

describe('fs-ops：守卫（缺参·不存在·未知动作）—— 响亮报错，不是崩', () => {
  const GUARDS: Array<[CcFsArgs['action'], Partial<CcFsArgs>, RegExp]> = [
    ['resolve', {}, /resolve requires path/],
    ['exists', {}, /exists requires path/],
    ['list', { path: 'nope' }, /list: path .* does not exist/],
    ['tree', { path: 'nope' }, /tree: path .* does not exist/],
    ['relative', {}, /relative requires path/],
    ['mkdir', {}, /mkdir requires path/],
    ['rm', {}, /rm requires at least one path argument/],
    ['mv', { src: 'a.md' }, /mv requires src \+ dst/],
    ['mv', { src: 'nope.md', dst: 'x.md' }, /mv: source not found/],
    ['cp', { dst: 'x.md' }, /cp requires src \+ dst/],
    ['cp', { src: 'nope.md', dst: 'x.md' }, /cp: source not found/],
    ['touch', {}, /touch requires path/],
    ['append', { path: 'x.txt' }, /append requires path \+ content/],
    ['info', {}, /info requires path/],
    ['find', {}, /find requires pattern/],
    ['find', { path: 'nope', pattern: 'x' }, /find: path .* does not exist/],
    ['bogus' as CcFsArgs['action'], {}, /Unknown action: bogus/],
  ]

  it('逐条守卫：抛错文案精确（不是静默 no-op、不是 TypeError）', () => {
    for (const [action, extra, re] of GUARDS) {
      expect(() => run(action, extra), `${action} 应抛 ${String(re)}`).toThrow(re)
    }
  })
})

// ── 路径校验：根外绝对路径 ／ 绝对路径的正常侧 ／ symlink 逃逸 ──────────────────────

describe('fs-ops：路径校验（绝对路径与 symlink）', () => {
  it('根外**绝对路径**：写动作拒绝；rm 记 [SKIP] 且**不中断整批**', () => {
    const out = outsideDir()
    const outsideFile = join(out, 'x.txt')
    writeFileSync(outsideFile, 'o')

    // 写动作：validateWritePath 的 `!pathInside` 抛（绝对路径侧 + 根外抛点）
    expect(() => run('touch', { path: outsideFile })).toThrow(/outside serenity root/)
    expect(() => run('mkdir', { path: join(out, 'newdir') })).toThrow(/outside serenity root/)

    // rm：同一抛错被 rm 自己的 try/catch 转成 [SKIP]，**同批合法目标照删**（continue 而非 abort）
    writeFileSync(join(dir, 'kill-me.txt'), 'x')
    const batch = run('rm', { paths: [outsideFile, 'kill-me.txt'] }) as string
    expect(batch).toContain('[SKIP] cc-fs: path')
    expect(batch).toContain('[OK] deleted: kill-me.txt')
    expect(existsSync(join(dir, 'kill-me.txt'))).toBe(false) // 盘上判据
    expect(existsSync(outsideFile)).toBe(true) // 根外那一个**没被动过**
  })

  it('读动作接受**根内绝对路径**（`startsWith("/")` 的正常侧）：list / tree / info / find', () => {
    const absDocs = join(dir, 'docs')
    expect((run('list', { path: absDocs }) as { path: string }).path).toBe(absDocs)
    expect((run('tree', { path: absDocs }) as { path: string }).path).toBe(absDocs)
    expect(run('info', { path: join(absDocs, 'nested', 'a.md') })).toContain('type: file')
    expect((run('find', { path: absDocs, pattern: 'a.md' }) as { count: number }).count).toBe(1)
  })

  it('写路径 **symlink 逃逸**：根内 link 指向根外 ⇒ realpath 复核拦住（真 symlink，非构造）', () => {
    const out = outsideDir()
    writeFileSync(join(out, 'x.txt'), 'o')
    symlinkSync(out, join(dir, 'link'), 'dir')
    // 词法在根内（root/link/x.txt），但 realpath 落在根外
    expect(() => run('touch', { path: 'link/x.txt' })).toThrow(/resolves via symlink to .*outside serenity root/)
    expect(() => run('append', { path: 'link/x.txt', content: 'more' })).toThrow(/resolves via symlink to/)
    // 正控：根外那份内容**未被追加**（拒绝是有效的，不只是文案）
    expect(readFileSync(join(out, 'x.txt'), 'utf-8')).toBe('o')
  })

  it('relative：根外绝对路径 ⇒ 抛错（`!startsWith(root)` 抛点）', () => {
    expect(() => run('relative', { path: '/tmp' })).toThrow(/outside serenity root/)
  })

  it('relative 对根自身 ⇒ 「.」（safeRel 的空串兜底档）', () => {
    expect(run('relative', { path: '.' })).toBe('.')
  })

  // 🔴 登记性缺口（`it.fails`）：修好即翻红 ⇒ 提示清理本用例
  it.fails('🔴 缺口：relative 只用 `startsWith(root)`，**根前缀兄弟目录**被误当根内（期望：拒绝）', () => {
    const sib = `${dir}-sib`
    mkdirSync(sib, { recursive: true })
    try {
      // 现状：返回 `../<basename>-sib`（一个**逃出根**的相对路径）而不报错
      expect(() => run('relative', { path: sib })).toThrow(/outside serenity root/)
    } finally {
      rmSync(sib, { recursive: true, force: true })
    }
  })
})

// ── mkdir / touch / rm / mv / cp 的分支档 ────────────────────────────────────────

describe('fs-ops：写动作的分支档', () => {
  it('mkdir 两态：已存在**目录** ⇒ 友好返回；已存在**文件** ⇒ 抛错', () => {
    expect(run('mkdir', { path: 'docs' })).toBe('directory already exists: docs')
    expect(() => run('mkdir', { path: 'docs/nested/a.md' })).toThrow(/exists but is not a directory/)
  })

  it('touch 已存在 ⇒ 只更新时间戳（内容不截断）', () => {
    expect(run('touch', { path: 'docs/nested/a.md' })).toBe('updated timestamp: docs/nested/a.md')
    expect(readFileSync(join(dir, 'docs', 'nested', 'a.md'), 'utf-8')).toBe('hello')
  })

  it('rm：不存在的目标 ⇒ `[SKIP] not found`（继续处理同批其余目标）', () => {
    writeFileSync(join(dir, 'gone.txt'), 'x')
    const out = run('rm', { paths: ['ghost.txt', 'gone.txt'] }) as string
    expect(out).toContain('[SKIP] not found: ghost.txt')
    expect(out).toContain('[OK] deleted: gone.txt')
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false)
  })

  it('rm dry-run：文件与目录两态（目录 extra 只在 recursive 时出现）', () => {
    const fileDry = run('rm', { path: 'docs/nested/a.md', dryRun: true }) as string
    expect(fileDry).toContain('[DRY-RUN] file: docs/nested/a.md')
    const dirDry = run('rm', { path: 'docs', dryRun: true }) as string
    expect(dirDry).toContain('[DRY-RUN] directory: docs')
    expect(dirDry).not.toContain('(recursive)')
    const dirRec = run('rm', { path: 'docs', dryRun: true, recursive: true }) as string
    expect(dirRec).toContain('[DRY-RUN] directory: docs (recursive)')
    expect(existsSync(join(dir, 'docs'))).toBe(true) // dry-run 一律不动盘
  })

  it('rm：**空目录**不带 recursive ⇒ rmdirSync 真删（与"非空 ⇒ SKIP"成对）', () => {
    mkdirSync(join(dir, 'empty-dir'), { recursive: true })
    const out = run('rm', { path: 'empty-dir' }) as string
    expect(out).toContain('[OK] deleted: empty-dir')
    expect(existsSync(join(dir, 'empty-dir'))).toBe(false)
  })

  it('mv / cp：目标父目录不存在 ⇒ 自动建父目录（两处同款分支）', () => {
    run('mv', { src: 'docs/nested/a.md', dst: 'brand/new/moved.md' })
    expect(existsSync(join(dir, 'brand', 'new', 'moved.md'))).toBe(true)
    run('cp', { src: 'brand/new/moved.md', dst: 'brand2/deep/copied.md' })
    expect(existsSync(join(dir, 'brand2', 'deep', 'copied.md'))).toBe(true)
  })
})

// ── 注册表保护：文案另一档 ＋ 「无 cccName ⇒ 不保护」 ──────────────────────────────

describe('fs-ops：mech-registry 保护的两种命中与"无 cccName 不保护"', () => {
  function seedRegistry(cccName: string): string {
    writeFileSync(join(dir, '.serenity'), cccName)
    const aggDir = join(dir, '.opencode', 'skills', cccName, 'references')
    mkdirSync(aggDir, { recursive: true })
    writeFileSync(join(aggDir, 'mech-registry.json'), JSON.stringify({ version: 1, entries: [] }))
    return aggDir
  }

  it('命中**文件** ⇒ 文案指向 container_admin msm register/deregister', () => {
    const aggDir = seedRegistry('test')
    const out = run('rm', { path: '.opencode/skills/test/references/mech-registry.json' }) as string
    expect(out).toContain('refusing to directly modify mech-registry.json')
    expect(out).toContain('container_admin msm register/deregister')
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(true)
  })

  it('命中**祖先目录**且目标文案含 `remove` ⇒ 报 refusing to **remove**（另一文案档）', () => {
    // cccName 含 "remove" ⇒ 保护路径 `.opencode/skills/remove-ccc/references` 也含之
    const aggDir = seedRegistry('remove-ccc')
    const out = run('rm', { path: '.opencode/skills/remove-ccc/references', recursive: true }) as string
    expect(out).toContain('refusing to remove')
    expect(out).toContain('ancestor of the ACC-managed mech-registry.json')
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(true)
  })

  it('🔴 **无 `.serenity` ⇒ 注册表不受保护**（保护以 cccName 为键 ⇒ `!cccName ⇒ null` 两处）', () => {
    const aggDir = seedRegistry('test')
    rmSync(join(dir, '.serenity'))
    const out = run('rm', { path: '.opencode/skills/test/references/mech-registry.json' }) as string
    expect(out).toContain('[OK] deleted:')
    expect(existsSync(join(aggDir, 'mech-registry.json'))).toBe(false)
  })
})

// ── 元数据兜底档：humanSize 三档 ／ detectFileType other ／ getFileInfo catch ──────

describe('fs-ops：元数据的兜底档', () => {
  it('humanSize 三档：B ／ KB ／ MB（用真大小文件，不是 mock）', () => {
    writeFileSync(join(dir, 'kb.bin'), Buffer.alloc(2048))
    writeFileSync(join(dir, 'mb.bin'), Buffer.alloc(2 * 1024 * 1024))
    expect(run('info', { path: 'docs/nested/a.md' })).toContain('size: 5 (5 B)')
    expect(run('info', { path: 'kb.bin' })).toContain('size: 2048 (2.0 KB)')
    expect(run('info', { path: 'mb.bin' })).toContain('size: 2097152 (2.0 MB)')
  })

  it('detectFileType 的 `other` 档：**unix socket** 入 list ⇒ type=other（真形态）', async () => {
    const sockPath = join(dir, 'probe.sock')
    const srv = createServer()
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve))
    try {
      const list = run('list') as { entries: { name: string; type: string }[] }
      expect(list.entries.find((e) => e.name === 'probe.sock')?.type).toBe('other')
      // info 同档（同一 helper 的另一调用点）
      expect(run('info', { path: 'probe.sock' })).toContain('type: other')
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })

  it('getFileInfo 的 `catch` 档：**悬空 symlink** ⇒ {other,0,?,?}（不是崩）', () => {
    symlinkSync(join(dir, 'gone-target'), join(dir, 'dangling'))
    const list = run('list') as { entries: { name: string; type: string; size: number; sizeHuman: string; mtime: string }[] }
    expect(list.entries.find((e) => e.name === 'dangling')).toEqual({ name: 'dangling', type: 'other', size: 0, sizeHuman: '?', mtime: '?' })
  })

  it('🔴 symlink 指向目录 ⇒ 按**目标**判定为 dir（`statSync` 跟随）⇒ `symlink` 档在本模块不可达', () => {
    symlinkSync(join(dir, 'docs'), join(dir, 'docs-link'), 'dir')
    const list = run('list') as { entries: { name: string; type: string }[] }
    expect(list.entries.find((e) => e.name === 'docs-link')?.type).toBe('dir')
    // 机械旁证：本模块只用 statSync（跟随 symlink），没有任何调用点传 lstat ⇒ `isSymbolicLink()` 恒假
    expect(run('info', { path: 'docs-link' })).toContain('type: dir')
  })
})
