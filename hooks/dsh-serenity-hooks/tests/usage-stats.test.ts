/**
 * usage-stats.test.ts — `src/usage-stats.ts` 的镜像测试
 *
 * 覆盖：落点 / 初态 / 自增语义（firstAt 不漂、lastAt 跟进）/ **重启续算** /
 * 两个 skill 口径不混 / 只记名字不记参数 / 损坏容错（不抛且能自愈）/
 * 原子写不留 `.tmp` / 键长与键数上界。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  USAGE_MAX_KEYS_PER_BUCKET,
  USAGE_NAME_MAX_CHARS,
  USAGE_STATS_FILENAME,
  USAGE_STATS_SUBDIR,
  bumpBucket,
  isRecordableUsageName,
  loadUsageStats,
  nameFromArgs,
  recordSkillInjections,
  recordToolUsage,
  usageStatsPath,
} from '../src/usage-stats.js'

let root = ''
let path = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acc-usage-'))
  path = usageStatsPath(root)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 固定时刻，便于断言 firstAt/lastAt */
const T1 = Date.parse('2026-09-22T10:00:00+08:00')
const T2 = Date.parse('2026-09-22T11:30:00+08:00')

function read(): ReturnType<typeof JSON.parse> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('落点与初态', () => {
  it('路径 = <root>/_tmp/acc-usage.json（所有者令：CCC 的 _tmp 内指定文件）', () => {
    expect(usageStatsPath('/x/ccc')).toBe(join('/x/ccc', USAGE_STATS_SUBDIR, USAGE_STATS_FILENAME))
    expect(USAGE_STATS_SUBDIR).toBe('_tmp')
  })

  it('文件不存在 = 正常初态：空账本、error 为 null、且**不**建文件', () => {
    const { stats, error } = loadUsageStats(root)
    expect(error).toBeNull()
    expect(stats.msm).toEqual({})
    expect(stats.skill.loads).toEqual({})
    expect(stats.skill.injections).toEqual({})
    expect(existsSync(path)).toBe(false)
  })

  it('非目标工具 ⇒ 什么都不记、也不建文件', () => {
    for (const t of ['read', 'write', 'container_fs', 'handyman']) {
      const r = recordToolUsage(root, t, { name: 'x' }, T1)
      expect(r.recorded).toBeNull()
      expect(r.wrote).toBe(false)
    }
    expect(existsSync(path)).toBe(false)
  })

  it('目标工具但取不到名字 ⇒ 不计（不算失败）', () => {
    expect(recordToolUsage(root, 'msm', { args: ['x'] }, T1).recorded).toBeNull()
    expect(recordToolUsage(root, 'msm', null, T1).recorded).toBeNull()
    expect(recordToolUsage(root, 'skill', { other: 1 }, T1).recorded).toBeNull()
    expect(existsSync(path)).toBe(false)
  })
})

describe('自增语义', () => {
  it('首次记录 msm ⇒ count=1 且 firstAt=lastAt', () => {
    const r = recordToolUsage(root, 'msm', { name: 'dsh-develop' }, T1)
    expect(r.ok).toBe(true)
    expect(r.recorded).toBe('msm')
    expect(r.name).toBe('dsh-develop')
    expect(r.wrote).toBe(true)
    const c = read().msm['dsh-develop']
    expect(c.count).toBe(1)
    expect(c.firstAt).toBe(c.lastAt)
  })

  it('再次记录 ⇒ count 累加、**firstAt 不漂**、lastAt 跟进', () => {
    recordToolUsage(root, 'msm', { name: 'homekeeper' }, T1)
    const firstSeenAt = read().msm['homekeeper'].firstAt
    recordToolUsage(root, 'msm', { name: 'homekeeper' }, T2)
    const c = read().msm['homekeeper']
    expect(c.count).toBe(2)
    expect(c.firstAt).toBe(firstSeenAt)
    expect(c.firstAt).not.toBe(c.lastAt)
  })

  it('🔴 重启续算：新进程只 load 也能读到旧计数，再记即 3', () => {
    recordToolUsage(root, 'msm', { name: 'a' }, T1)
    recordToolUsage(root, 'msm', { name: 'a' }, T1)
    // 模拟"进程重启"：只从磁盘读
    expect(loadUsageStats(root).stats.msm['a'].count).toBe(2)
    recordToolUsage(root, 'msm', { name: 'a' }, T2)
    expect(loadUsageStats(root).stats.msm['a'].count).toBe(3)
  })

  it('不同名字分桶', () => {
    recordToolUsage(root, 'msm', { name: 'a' }, T1)
    recordToolUsage(root, 'msm', { name: 'b' }, T1)
    recordToolUsage(root, 'msm', { name: 'a' }, T1)
    const msm = read().msm
    expect(msm['a'].count).toBe(2)
    expect(msm['b'].count).toBe(1)
  })
})

describe('两个 skill 口径不混', () => {
  it('skill.loads 与 skill.injections 各自计数、互不污染 msm', () => {
    recordToolUsage(root, 'skill', { name: 'home-rhetoric' }, T1)
    recordSkillInjections(root, ['home-rhetoric', 'home-session'], T2)
    const s = read()
    expect(s.skill.loads['home-rhetoric'].count).toBe(1)
    expect(s.skill.loads['home-session']).toBeUndefined()
    expect(s.skill.injections['home-rhetoric'].count).toBe(1)
    expect(s.skill.injections['home-session'].count).toBe(1)
    expect(s.msm).toEqual({})
  })

  it('recordSkillInjections 空数组 / 全非法名 ⇒ 不写盘', () => {
    expect(recordSkillInjections(root, [], T1).recorded).toBeNull()
    expect(recordSkillInjections(root, ['', 'x'.repeat(USAGE_NAME_MAX_CHARS + 1)], T1).recorded).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  it('一次注入多个名字只写一次盘（读改写合并在同一笔）', () => {
    const r = recordSkillInjections(root, ['s1', 's2', 's3'], T1)
    expect(r.ok).toBe(true)
    expect(Object.keys(read().skill.injections).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('skill 工具的名字键做防御性容错（name / skill / skillName）', () => {
    recordToolUsage(root, 'skill', { skill: 'via-skill-key' }, T1)
    expect(read().skill.loads['via-skill-key'].count).toBe(1)
  })
})

describe('只记名字、不记参数（所有者令）', () => {
  it('🔴 入参里的敏感值**不得**出现在文件里', () => {
    recordToolUsage(root, 'msm', { name: 'ssh-connect', args: ['SENTINEL_PASSWORD_abc123'] }, T1)
    recordToolUsage(root, 'skill', { name: 'home-session', prompt: 'SENTINEL_PROMPT_xyz' }, T1)
    const text = readFileSync(path, 'utf-8')
    expect(text).not.toContain('SENTINEL_PASSWORD_abc123')
    expect(text).not.toContain('SENTINEL_PROMPT_xyz')
    expect(text).toContain('ssh-connect')
  })
})

describe('容错与原子写（永不抛）', () => {
  it('文件损坏 ⇒ 空账本 + error 文本，且**不抛**', () => {
    mkdirSync(join(root, USAGE_STATS_SUBDIR), { recursive: true })
    writeFileSync(path, '{ this is not json', 'utf-8')
    const { stats, error } = loadUsageStats(root)
    expect(error).toContain('用量统计解析失败')
    expect(stats.msm).toEqual({})
  })

  it('损坏后仍能自愈写回（下一次记录重建干净文件）', () => {
    mkdirSync(join(root, USAGE_STATS_SUBDIR), { recursive: true })
    writeFileSync(path, 'garbage', 'utf-8')
    const r = recordToolUsage(root, 'msm', { name: 'recover' }, T1)
    expect(r.ok).toBe(true)
    expect(read().msm['recover'].count).toBe(1)
  })

  it('非法条目被丢弃、合法条目保留（容忍手改）', () => {
    mkdirSync(join(root, USAGE_STATS_SUBDIR), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: 'x',
        skill: { loads: { bad: { count: 'NaN' }, good: { count: 2, firstAt: 'f', lastAt: 'l' } }, injections: {} },
        msm: { alsoBad: null },
      }),
      'utf-8',
    )
    const { stats, error } = loadUsageStats(root)
    expect(error).toBeNull()
    expect(Object.keys(stats.skill.loads)).toEqual(['good'])
    expect(stats.skill.loads['good'].count).toBe(2)
    expect(stats.msm).toEqual({})
  })

  it('原子写：落盘后不留 .tmp 残骸', () => {
    recordToolUsage(root, 'msm', { name: 'a' }, T1)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('写盘失败（父路径是文件 ⇒ 建不出目录）⇒ 返回 ok:false 且**不抛**', () => {
    const fileRoot = join(root, 'not-a-dir')
    writeFileSync(fileRoot, 'x', 'utf-8')
    const r = recordToolUsage(fileRoot, 'msm', { name: 'a' }, T1)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('用量统计写入失败')
  })
})

describe('纯函数：键的合法性、长度与数量上界', () => {
  it('isRecordableUsageName：拒空、拒超长、收正常名', () => {
    expect(isRecordableUsageName('home-session')).toBe(true)
    expect(isRecordableUsageName('')).toBe(false)
    expect(isRecordableUsageName('x'.repeat(USAGE_NAME_MAX_CHARS))).toBe(true)
    expect(isRecordableUsageName('x'.repeat(USAGE_NAME_MAX_CHARS + 1))).toBe(false)
    expect(isRecordableUsageName(undefined)).toBe(false)
    expect(isRecordableUsageName(7)).toBe(false)
  })

  it('nameFromArgs：首个命中的键胜出；非对象 ⇒ null', () => {
    expect(nameFromArgs({ skill: 'b', name: 'a' }, ['name', 'skill'])).toBe('a')
    expect(nameFromArgs({ skill: 'b' }, ['name', 'skill'])).toBe('b')
    expect(nameFromArgs(null, ['name'])).toBeNull()
    expect(nameFromArgs('str', ['name'])).toBeNull()
  })

  it('bumpBucket：纯函数（不改入参）', () => {
    const before = { a: { count: 1, firstAt: 'f', lastAt: 'f' } }
    const after = bumpBucket(before, 'a', 'g')
    expect(before.a!.count).toBe(1) // 入参未被改
    expect(after.a!.count).toBe(2)
    expect(after.a!.firstAt).toBe('f')
    expect(after.a!.lastAt).toBe('g')
  })

  it('🔴 键数上界：满桶后**不新增键**，但仍能自增已有键（结构上有界）', () => {
    const full: Record<string, { count: number; firstAt: string; lastAt: string }> = {}
    for (let i = 0; i < USAGE_MAX_KEYS_PER_BUCKET; i += 1) full[`k${i}`] = { count: 1, firstAt: 'f', lastAt: 'f' }
    const after = bumpBucket(full, 'brand-new', 'now')
    expect(Object.keys(after)).toHaveLength(USAGE_MAX_KEYS_PER_BUCKET)
    expect(after['brand-new']).toBeUndefined()
    const bumpExisting = bumpBucket(full, 'k0', 'now')
    expect(bumpExisting['k0']!.count).toBe(2)
  })
})
