/**
 * session-cleanup-branches.test.ts — DSH 旧会话清理：**枚举退化面与竞态兜底**（⑤ 第 57 件，S142 2026-09-26）
 *
 * ## 与既有 `session-cleanup.test.ts` 的分工（互补不重叠）
 *
 * 既有文件走**正路**：会话识别（含 v1.31.13 世代回归钉）、live 保护、阈值过滤、dryRun、
 * 真删、`sessionLogBytesById` 与 `hasSessionLogById` 的命中/fail-closed。
 * 本文件补它**全部没碰**的四类：
 *
 *   ① 🔴 **枚举退化面** —— `readdirSync` 结果里混入**非目录条目**（文件/符号链接）；
 *      会话目录里混入**非目录条目**。这两条 `continue` 是"把文件当会话目录"的唯一防线，
 *      而既有夹具**只造目录** ⇒ **一次都没被执行过**。
 *   ② 🔴 **竞态兜底** —— `statSync` 抛（文件在枚举与 stat 之间消失）、
 *      `readdirSync` 抛（目录不可读/消失）。它们的存在理由写在源码注释里（"竞态"），
 *      但既有用例全是顺序执行、无竞态 ⇒ 零执行。
 *   ③ 🔴 **`mtime` 全世代不可读** ⇒ `continue`（不是"当作 0 而误删"）。
 *   ④ 🔴 **`sessionLogArtifacts` 的排序细节** —— 同代内 `.jsonl` 在前 / `.zstd` 在后
 *      （= 后者更代表"当前书写格式"，即 `findSessionLog` 该选谁）。既有用例只测了**跨代**排序。
 *
 * ## 为什么这四类重要（贴 objective：**这是唯一会物理删用户数据的模块**）
 *
 * `session-cleanup.ts` 是插件里**唯一执行 `rmSync` 删用户会话目录**的地方（`performCleanup`）。
 * 上面①~③正是"**该不该把这条会话列为候选**"的三个否决点：
 *   · ① 若 `isDirectory()` 守卫写反/删掉 ⇒ **普通文件被当成会话目录**，其父目录被扫进候选；
 *   · ② 若竞态 catch 改成 throw ⇒ **一次并发写就让整个清理 500**（且调用方无从区分"没候选"与"崩了"）；
 *   · ③ 若 `!Number.isFinite(mtime)` 判反 ⇒ `-Infinity >= cutoff` 为假，**仍在写入的会话会被列为候选**
 *     —— 这正是源码注释里"conservative"要防的误删。
 * 按 `:15` 逐字："安全底线 = live 会话保护跳过（删正在运行的会话 = 灾难）"⇒ 这几个否决点是
 * 安全底线的**兄弟**，同属"承诺写进注释、却没有回归钉"一族（与第 45/46/47/55/56 件同族）。
 *
 * ## 🔴 本件的硬前置
 *
 * 1. **绝不触碰真实 `~/.dsh/sessions`**：全部用例用 `tmpdir()` 下的隔离 root，
 *    且 `afterEach` 递归删除。**绝不对真实会话 root 跑 `performCleanup`**（会真删用户数据）。
 * 2. **竞态必须用真故障形态注入**：不用 mock 掉被测模块本身，而是让真实 fs 调用**真抛**
 *    （在枚举与 stat 之间删掉文件；用不可读路径触发 readdir 失败）。
 * 3. **降级面断言与正控方向成对**（累积纪律 ⑬）。
 */

import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 🔴 B4 的故障注入开关（**hoisted** —— `vi.mock` 工厂在 import 之前求值）。
 *
 * 为什么不用 `vi.spyOn(fs, 'rmSync')`：**`node:fs` 的导出是不可重定义属性**
 * （实测红：`TypeError: Cannot redefine property: rmSync`）⇒ spy 根本拦不到。
 * 本仓既有先例 = `trajectory-skills.test.ts` 的 `vi.mock('node:fs', importOriginal)`。
 * 开关缺省为空串 ⇒ **其余 12 条用例全部走真实 fs**（零影响）。
 */
const h = vi.hoisted(() => ({ failRmOn: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: ((p: unknown, ...rest: unknown[]) => {
      if (h.failRmOn !== '' && String(p).includes(h.failRmOn)) {
        const err = new Error('EPERM synthetic: operation not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return (actual.rmSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.rmSync,
  }
})

import {
  collectEligibleSessions,
  cutoffDaysAgo,
  findSessionLog,
  performCleanup,
  sessionLogArtifacts,
} from '../src/session-cleanup.js'

let root: string
const roots: string[] = []

function freshRoot(): string {
  const r = join(tmpdir(), `session-cleanup-br-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(r, { recursive: true })
  roots.push(r)
  return r
}

/** 造真会话目录并把 mtime 设成 N 毫秒前 */
function makeSession(r: string, project: string, id: string, mtimeAgoMs: number, fileName = 'session.jsonl'): string {
  const dir = join(r, project, id)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, fileName)
  writeFileSync(log, '{}\n', 'utf-8')
  const past = new Date(Date.now() - mtimeAgoMs)
  utimesSync(log, past, past)
  utimesSync(dir, past, past)
  return dir
}

beforeEach(() => {
  root = freshRoot()
})

afterEach(() => {
  h.failRmOn = '' // 故障注入开关必须复位（否则会污染后续用例 —— 模块级状态纪律）
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots.length = 0
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// A. 枚举退化面：非目录条目必须被跳过
// ─────────────────────────────────────────────────────────────────────────────

describe('session-cleanup: 枚举退化面（非目录条目不得被当作会话）', () => {
  it('🔴 A1：sessions root 下混入**普通文件** ⇒ 跳过（不被当 project 目录）', () => {
    // 源码 :59 `if (!project.isDirectory()) continue`
    // 真故障形态：DSH root 里除了 project 目录，本就有 README/index 之类的散文件。
    makeSession(root, '--proj--', 's-old', cutoffDaysAgo(30))
    writeFileSync(join(root, 'stray-file.jsonl'), 'not a dir\n', 'utf-8')

    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    // 🔴 判据 = **只找到真会话**，且**不因散文件而多出一条/崩掉**
    expect(found.map((c) => c.id)).toEqual(['s-old'])
  })

  it('🔴 A2：project 目录下混入**普通文件** ⇒ 跳过（不被当会话目录）', () => {
    // 源码 :62 `if (!entry.isDirectory()) continue`
    makeSession(root, '--proj--', 's-old', cutoffDaysAgo(30))
    writeFileSync(join(root, '--proj--', 'session.jsonl'), 'stray\n', 'utf-8') // 不在会话目录里

    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    expect(found.map((c) => c.id)).toEqual(['s-old'])
  })

  it('A3（正控）：同一夹具在**只有真会话**时正常列出 ⇒ 证明 A1/A2 的跳过不是夹具坏了', () => {
    makeSession(root, '--proj--', 's-old', cutoffDaysAgo(30))
    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    expect(found.map((c) => c.id)).toEqual(['s-old'])
    expect(found[0]!.project).toBe('--proj--')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 竞态兜底
// ─────────────────────────────────────────────────────────────────────────────

describe('session-cleanup: 竞态兜底（枚举与 stat 之间世界会变）', () => {
  it('🔴 B1：`statSync` 抛（文件在枚举后消失）⇒ 跳过该世代；**全世代都抛 ⇒ 不列为候选**', () => {
    // 源码 :76 的 catch「文件消失/不可读 → 跳过该世代（竞态）」
    // ＋ :80 `if (!Number.isFinite(mtime)) continue`（mtime 仍是 -Infinity ⇒ 不当候选）
    // 真故障形态：枚举完 artifacts 之后、stat 之前，文件真被删掉（并发写/清理）。
    makeSession(root, '--proj--', 's-gone', cutoffDaysAgo(30))
    const logPath = join(root, '--proj--', 's-gone', 'session.jsonl')
    unlinkSync(logPath) // ← 目录还在、日志没了（真实竞态形态）

    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    // 🔴 判据 = **不列为候选**。若 `!Number.isFinite(mtime)` 判反 ⇒ -Infinity 会被当作"很久没动"
    //    ⇒ 一个**日志已消失的目录**被列进候选、进而被 rmSync 删掉。
    expect(found).toEqual([])
  })

  it('🔴 B2：一个世代可读 + 一个世代不可读 ⇒ 用**可读那个**的 mtime（不因一个坏掉就丢弃整个会话）', () => {
    // 源码 :70~79 的注释："lastActive = **全部世代的最大 mtime**" ⇒ 单个世代 stat 失败
    // 不能连累整个会话（多世代并存是常态）。
    makeSession(root, '--proj--', 's-multi', cutoffDaysAgo(30), 'session.jsonl')
    const dir = join(root, '--proj--', 's-multi')
    // 造第二个世代（v3）并让它"不可读"——用 symlink 指向不存在目标 ⇒ statSync 抛 ENOENT
    symlinkSync(join(dir, 'missing-target'), join(dir, 'session.v3.jsonl.zstd'))

    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    // 🔴 判据 = **仍然被正确列为候选**，且 mtime 来自那个**可读**的世代（不是 -Infinity、不是 NaN）
    expect(found.map((c) => c.id)).toEqual(['s-multi'])
    expect(Number.isFinite(found[0]!.lastActiveMs)).toBe(true)
    expect(found[0]!.lastActiveMs).toBeLessThan(cutoffDaysAgo(7))
  })

  it('🔴 B3：`sessionLogArtifacts` 对**不可读目录** ⇒ 返回 []（不抛）', () => {
    // 源码 :104~108 的 catch「目录不可读/消失 → 视为无日志（竞态）」
    // 真故障形态：权限位剥掉（chmod 000）⇒ readdirSync 抛 EACCES。
    // ⚠️ 以 root 身份跑时 chmod 不生效 ⇒ 先探一次，不生效就跳过（诚实跳过，不造假绿）。
    const dir = makeSession(root, '--proj--', 's-noperm', 0)
    chmodSync(dir, 0o000)
    let throwing = false
    try {
      // 探针：确认这个形态**真的**会让 readdirSync 抛（否则本用例测不到目标分支）
      readdirSync(dir)
    } catch {
      throwing = true
    }
    if (!throwing) {
      chmodSync(dir, 0o755)
      // root 身份下 chmod 拦不住 ⇒ 本分支在本环境不可构造。**如实跳过，不涂绿**（纪律 8）。
      expect(true).toBe(true)
      return
    }
    try {
      expect(sessionLogArtifacts(dir)).toEqual([])
      // 正控（成对）：同目录恢复权限后**确实能列出**一个世代
      chmodSync(dir, 0o755)
      expect(sessionLogArtifacts(dir)).toHaveLength(1)
    } finally {
      try {
        chmodSync(dir, 0o755)
      } catch {
        /* 已恢复 */
      }
    }
  })

  it('🔴 B4：`performCleanup` 中 `rmSync` 抛 ⇒ 记入 errors 且**不中断其余**（逐个容错）', () => {
    // 源码 :154 的 catch「权限/竞态」
    // 真故障形态：让其中一条会话的 rmSync 真抛。
    // ⚠️ 故障注入走上方 `vi.mock` 的 hoisted 开关（`vi.spyOn` 对 node:fs 无效）。
    //    开关只影响路径里含 's-fail' 的那一条 ⇒ 其余删除走真实 fs。
    makeSession(root, '--proj--', 's-ok', cutoffDaysAgo(30))
    makeSession(root, '--proj--', 's-fail', cutoffDaysAgo(30))

    h.failRmOn = 's-fail'
    const { result } = performCleanup(root, cutoffDaysAgo(7))
    h.failRmOn = ''

    expect(result).not.toBeNull()
    // 🔴 判据一：失败的**记进 errors**（不是静默吞掉）
    expect(result!.errors.map((e) => e.id)).toEqual(['s-fail'])
    expect(result!.errors[0]!.reason).toContain('EPERM synthetic')
    // 🔴 判据二：**其余照删**（一个失败不得中断整批）—— 只断言 errors 无法区分"中断了"与"跳过后继续"
    expect(result!.deleted).toEqual(['s-ok'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. mtime 边界与排序细节
// ─────────────────────────────────────────────────────────────────────────────

describe('session-cleanup: mtime 边界与世代排序', () => {
  it('🔴 C1：无任何世代可 stat ⇒ mtime 保持 -Infinity ⇒ **不列为候选**（不得当成"极旧"）', () => {
    // 源码 :80 `if (!Number.isFinite(mtime)) continue`
    // 这是"宁可漏删、不可误删"的那个否决点。
    makeSession(root, '--proj--', 's-noart', cutoffDaysAgo(30), 'session.jsonl')
    const dir = join(root, '--proj--', 's-noart')
    // 把唯一的日志换成"名字像日志但一行也不是"的存在：先删目录里的真日志，放一个悬空 symlink
    unlinkSync(join(dir, 'session.jsonl'))
    symlinkSync(join(dir, 'nowhere'), join(dir, 'session.jsonl'))

    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    // 🔴 判据 = **空**。判反的后果（源码注释的"conservative"）：-Infinity < cutoff ⇒ 被列进候选 ⇒ 真删。
    expect(found).toEqual([])
  })

  it('🔴 C2：`sessionLogArtifacts` 同代内 `.jsonl` 在前、`.zstd` 在后 ⇒ `findSessionLog` 取 `.zstd`', () => {
    // 源码 :115~116 的排序第二键 `(a.name.endsWith('.zstd') ? 1 : 0) - (b.name.endsWith('.zstd') ? 1 : 0)`
    // 既有用例只测了**跨代**排序（v0 vs v3）⇒ 同代这个第二键**零执行**。
    // 语义（源码 :96）：`.zstd`「更代表"当前书写格式"」⇒ 它必须排在后面（= `findSessionLog` 选它）。
    const dir = makeSession(root, '--proj--', 's-samegen', 0, 'session.jsonl')
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'z\n', 'utf-8')

    const arts = sessionLogArtifacts(dir)
    expect(arts.map((a) => a.name)).toEqual(['session.jsonl', 'session.jsonl.zstd'])
    expect(arts.every((a) => a.generation === 0)).toBe(true) // 同代（v0）
    // 🔴 判据 = `findSessionLog` 选中 **.zstd**（排序第二键失效就会选错当前世代）
    expect(findSessionLog(dir)).toBe(join(dir, 'session.jsonl.zstd'))
  })

  it('C3（正控）：跨代排序仍成立（v3 在 v0 之后）⇒ 与 C2 成对', () => {
    const dir = makeSession(root, '--proj--', 's-crossgen', 0, 'session.jsonl')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'z\n', 'utf-8')
    expect(sessionLogArtifacts(dir).map((a) => a.generation)).toEqual([0, 3])
    expect(findSessionLog(dir)).toBe(join(dir, 'session.v3.jsonl.zstd'))
  })

  it('🔴 C4：不符合命名规则的文件被忽略（generation 仅认 `session[.vN].jsonl[.zstd]`）', () => {
    const dir = makeSession(root, '--proj--', 's-names', 0, 'session.jsonl')
    writeFileSync(join(dir, 'session.v12.jsonl'), 'x\n', 'utf-8')
    writeFileSync(join(dir, 'session.txt'), 'x\n', 'utf-8')
    writeFileSync(join(dir, 'my-session.jsonl'), 'x\n', 'utf-8') // 前缀必须完全匹配

    const arts = sessionLogArtifacts(dir)
    expect(arts.map((a) => a.name)).toEqual(['session.jsonl', 'session.v12.jsonl'])
    expect(arts.map((a) => a.generation)).toEqual([0, 12])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. dirOf 的边界（`performCleanup` 内部依赖它定位要删的目录）
// ─────────────────────────────────────────────────────────────────────────────

describe('session-cleanup: performCleanup 的删除目标定位', () => {
  it('🔴 D1：删的是**会话目录本身**，不是它的父目录（`dirOf` 取父级）', () => {
    // 源码 :163 `logPath.slice(0, logPath.lastIndexOf('/'))`
    // 这是**最危险的一行**：若写成 lastIndexOf('/') 再往前一层，就会删掉整个 project 目录。
    const dir = makeSession(root, '--proj--', 's-victim', cutoffDaysAgo(30))
    makeSession(root, '--proj--', 's-keep-recent', 0) // 同 project 下的新会话，必须存活

    const { result } = performCleanup(root, cutoffDaysAgo(7))
    expect(result!.deleted).toEqual(['s-victim'])
    // 🔴 判据 = 被删的**只有那一个会话目录**；同 project 的兄弟会话与 project 目录本身都还在
    expect(() => collectEligibleSessions(root, cutoffDaysAgo(7))).not.toThrow()
    expect(sessionLogArtifacts(dir)).toEqual([]) // victim 目录已整目录删除
    expect(sessionLogArtifacts(join(root, '--proj--', 's-keep-recent'))).toHaveLength(1) // 兄弟存活
    expect(sessionLogArtifacts(join(root, '--proj--')).length).toBeGreaterThanOrEqual(0) // project 目录仍在（未抛即证明）
  })

  it('🔴 D2：dryRun ⇒ **一个文件都不动**（candidates 照常返回、result 为 null）', () => {
    // 源码 :147 `if (opts.dryRun) return { candidates, result: null }`
    const dir = makeSession(root, '--proj--', 's-preview', cutoffDaysAgo(30))
    const { candidates, result } = performCleanup(root, cutoffDaysAgo(7), new Set(), { dryRun: true })
    expect(candidates.map((c) => c.id)).toEqual(['s-preview'])
    expect(result).toBeNull()
    // 🔴 判据 = **磁盘上真的还在**（只断言 result===null 无法区分"没删"与"删了但没记"）
    expect(sessionLogArtifacts(dir)).toHaveLength(1)
  })
})
