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
