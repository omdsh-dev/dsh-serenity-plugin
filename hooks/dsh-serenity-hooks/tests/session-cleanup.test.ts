/**
 * session-cleanup.test.ts — DSH 平台旧会话清理纯逻辑（v1.29 需求③）
 */

import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectEligibleSessions,
  cutoffDaysAgo,
  findSessionLog,
  performCleanup,
  sessionLogArtifacts,
} from '../src/session-cleanup.js'

/** 造一个真实会话目录（project/session-id/session.jsonl），mtime 可调 */
function makeSession(root: string, project: string, id: string, mtimeAgoMs: number, suffix = '.jsonl'): string {
  const dir = join(root, project, id)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, `session${suffix}`)
  writeFileSync(log, `{"type":"session/header","sessionId":"${id}"}\n`, 'utf-8')
  const now = Date.now()
  // mtime 直接设置（文件系统允许）
  const past = new Date(now - mtimeAgoMs)
  utimesSync(log, past, past)
  utimesSync(dir, past, past)
  return dir
}

let root: string
let roots: string[] = []

beforeEach(() => {
  root = join(tmpdir(), `session-cleanup-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
})

afterEach(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true })
  }
  roots = []
})

describe('findSessionLog', () => {
  it('识别 session.jsonl 与 .zstd，忽略其他文件', () => {
    const d = makeSession(root, '--proj--', 's1', 0)
    expect(findSessionLog(d)).toBe(join(d, 'session.jsonl'))
    expect(findSessionLog(root)).toBeNull()
  })

  /**
   * v1.31.13 回归（S142 §25.5 发现的 dsp 缺陷）：
   * 宿主自 DSH 0.1.5 起按**世代**写文件（`session.v3.jsonl.zstd`），且迁移**保留 v0 源文件**
   * ⇒ 旧实现（只认 `session.jsonl[.zstd]`）对新格式会话**完全不可见** = 清理静默 no-op。
   */
  it('识别世代文件 session.vN.jsonl[.zstd]（v1.31.13 修复）', () => {
    const d = join(root, '--proj--', 's-gen')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'session.v3.jsonl.zstd'), 'x', 'utf-8')
    expect(findSessionLog(d)).toBe(join(d, 'session.v3.jsonl.zstd'))
  })

  it('多世代并存 → 返回**最高世代**（宿主 findLog 语义）；同代内 .zstd 优先', () => {
    const d = join(root, '--proj--', 's-multi')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'session.jsonl.zstd'), 'v0', 'utf-8')
    writeFileSync(join(d, 'session.v3.jsonl.zstd'), 'v3', 'utf-8')
    expect(findSessionLog(d)).toBe(join(d, 'session.v3.jsonl.zstd'))

    const d2 = join(root, '--proj--', 's-same')
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, 'session.v2.jsonl'), 'plain', 'utf-8')
    writeFileSync(join(d2, 'session.v2.jsonl.zstd'), 'zstd', 'utf-8')
    expect(findSessionLog(d2)).toBe(join(d2, 'session.v2.jsonl.zstd'))
  })

  it('sessionLogArtifacts：按代递增枚举且忽略无关文件', () => {
    const d = join(root, '--proj--', 's-art')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'session.v3.jsonl.zstd'), '3', 'utf-8')
    writeFileSync(join(d, 'session.jsonl.zstd'), '0', 'utf-8')
    writeFileSync(join(d, 'session.lock'), '', 'utf-8')
    writeFileSync(join(d, 'notes.txt'), '', 'utf-8')
    expect(sessionLogArtifacts(d).map((a) => [a.name, a.generation])).toEqual([
      ['session.jsonl.zstd', 0],
      ['session.v3.jsonl.zstd', 3],
    ])
    expect(sessionLogArtifacts(join(root, 'nope'))).toEqual([])
  })
})

describe('collectEligibleSessions', () => {
  it('只收最后活动早于 cutoff 的非 live 会话', () => {
    // 旧会话（10 天前）→ 应入选；新会话（1 天前）→ 不入选
    makeSession(root, '--proj--', 'old-1', 10 * 24 * 3600 * 1000)
    makeSession(root, '--proj--', 'new-1', 1 * 24 * 3600 * 1000)
    const cutoff = cutoffDaysAgo(7)
    const found = collectEligibleSessions(root, cutoff)
    expect(found.map((c) => c.id)).toEqual(['old-1'])
    expect(found[0]!.project).toBe('--proj--')
  })

  it('live 会话跳过（安全底线）', () => {
    makeSession(root, '--proj--', 'live-1', 30 * 24 * 3600 * 1000)
    makeSession(root, '--proj--', 'dead-1', 30 * 24 * 3600 * 1000)
    const found = collectEligibleSessions(root, cutoffDaysAgo(7), new Set(['live-1']))
    expect(found.map((c) => c.id)).toEqual(['dead-1'])
  })

  it('多项目目录都扫描；非会话目录（无日志文件）忽略', () => {
    makeSession(root, '--proj-a--', 's1', 30 * 24 * 3600 * 1000)
    makeSession(root, '--proj-b--', 's2', 30 * 24 * 3600 * 1000)
    mkdirSync(join(root, '--proj-c--', 'not-a-session'), { recursive: true }) // 无日志
    writeFileSync(join(root, '--proj-c--', 'not-a-session', 'random.txt'), 'x')
    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    expect(found.map((c) => c.id).sort()).toEqual(['s1', 's2'])
  })

  it('root 不存在 → 空（非错误）', () => {
    expect(collectEligibleSessions(join(root, 'nope'), Date.now())).toEqual([])
  })

  it('世代会话（session.vN）也被收——旧实现对其静默不可见（v1.31.13 修复）', () => {
    const dir = join(root, '--proj--', 'gen-old')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.v3.jsonl.zstd')
    writeFileSync(log, 'x', 'utf-8')
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    utimesSync(log, past, past)
    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    expect(found.map((c) => c.id)).toEqual(['gen-old'])
    expect(found[0]!.logPath).toBe(log)
  })

  it('多世代并存 → lastActive 取**最大 mtime**（保守：任一世代被写过就不算旧）', () => {
    const dir = join(root, '--proj--', 'gen-mixed')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'session.jsonl.zstd') // v0：很旧
    const fresh = join(dir, 'session.v3.jsonl.zstd') // v3：刚写过
    writeFileSync(old, 'v0', 'utf-8')
    writeFileSync(fresh, 'v3', 'utf-8')
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    utimesSync(old, past, past)
    // fresh 保持"现在"的 mtime → 该会话不应被回收
    expect(collectEligibleSessions(root, cutoffDaysAgo(7))).toEqual([])

    // 两个世代都很旧 → 应被回收，且 lastActive 取两者最大（= 较新的那个）
    utimesSync(fresh, past, past)
    const found = collectEligibleSessions(root, cutoffDaysAgo(7))
    expect(found.map((c) => c.id)).toEqual(['gen-mixed'])
    expect(Date.now() - found[0]!.lastActiveMs).toBeGreaterThan(7 * 24 * 3600 * 1000)
  })
})

describe('performCleanup', () => {
  it('dryRun 不删只预览', () => {
    const dir = makeSession(root, '--proj--', 'old-1', 30 * 24 * 3600 * 1000)
    const { candidates, result } = performCleanup(root, cutoffDaysAgo(7), new Set(), { dryRun: true })
    expect(candidates).toHaveLength(1)
    expect(result).toBeNull()
    expect(existsSync(dir)).toBe(true)
  })

  it('物理删除会话目录（整个目录含日志）', () => {
    const dir = makeSession(root, '--proj--', 'old-1', 30 * 24 * 3600 * 1000)
    const { result } = performCleanup(root, cutoffDaysAgo(7))
    expect(result!.deleted).toEqual(['old-1'])
    expect(existsSync(dir)).toBe(false)
    // 再跑一次 → 无可删
    expect(performCleanup(root, cutoffDaysAgo(7)).candidates).toHaveLength(0)
  })

  it('新会话不受影响（阈值过滤）', () => {
    const newDir = makeSession(root, '--proj--', 'new-1', 1 * 24 * 3600 * 1000)
    performCleanup(root, cutoffDaysAgo(7))
    expect(existsSync(newDir)).toBe(true)
  })
})
