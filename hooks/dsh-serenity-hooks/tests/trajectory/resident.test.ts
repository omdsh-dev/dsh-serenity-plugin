/**
 * tests/trajectory/resident.test.ts — 常驻名单（D173 兑现口）
 *
 * 钉三件事：
 * ① 写了 `resident.serves` ⇒ 出现在名单里，且 `serves` 可读
 * ② 只写 `resident`（无 serves）⇒ **不进名单**，但单独数出来（写半个比不写更坏）
 * ③ 空名单 ⇒ 是**有效结果**，文案必须说清"这不是错误"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectResident, listResident } from '../../src/trajectory/resident.js'
import { TRAJECTORY_CONSTRAINT_FILENAME } from '../../src/trajectory/policy/profile.js'

let dir: string

function makeTrajectory(code: string, json: Record<string, unknown>, desc = 'traj'): string {
  const dirName = `2026-10-20--${code}--${desc}`
  const abs = join(dir, 'AGENT_SESSIONS', dirName)
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, 'SESSION.md'), `# SESSION: ${code}\n`, 'utf-8')
  writeFileSync(join(abs, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify(json), 'utf-8')
  return dirName
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resident: 名单收集（D173）', () => {
  it('空 CCC ⇒ 空名单（不是错误）', () => {
    const r = collectResident(dir)
    expect(r.entries).toEqual([])
    expect(r.incomplete).toEqual([])
    const text = listResident(dir)
    expect(text).toContain('暂无轨迹声明常驻')
    expect(text).toContain('不是错误')
  })

  it('写了 resident.serves ⇒ 出现在名单，serves 可读', () => {
    makeTrajectory('S900', { resident: { serves: '本地模型部署研究' } })
    const r = collectResident(dir)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.code).toBe('S900')
    expect(r.entries[0]!.serves).toBe('本地模型部署研究')
    expect(listResident(dir)).toContain('本地模型部署研究')
  })

  it('🔴 没有 resident 的轨迹**不出现**（不写就是不参与被找）', () => {
    makeTrajectory('S901', { tools: ['read'] })
    expect(collectResident(dir).entries).toEqual([])
  })

  it('🔴 只写 resident 没写 serves ⇒ 不进名单，但进 incomplete（写半个要说出来）', () => {
    makeTrajectory('S902', { resident: {} })
    const r = collectResident(dir)
    expect(r.entries).toEqual([])
    expect(r.incomplete).toEqual(['S902'])
    const text = listResident(dir)
    expect(text).toContain('S902')
    expect(text).toContain('没写 serves')
  })

  it('serves 是空白串 ⇒ 同样算"写半个"', () => {
    makeTrajectory('S903', { resident: { serves: '   ' } })
    expect(collectResident(dir).incomplete).toEqual(['S903'])
  })

  it('多条 ⇒ 按编码排序（确定性；便于对读）', () => {
    makeTrajectory('S920', { resident: { serves: 'b' } })
    makeTrajectory('S910', { resident: { serves: 'a' } })
    expect(collectResident(dir).entries.map((e) => e.code)).toEqual(['S910', 'S920'])
  })

  it('同时声明 model ⇒ 名单里一并带出（找人时知道它跑在什么模型上）', () => {
    makeTrajectory('S904', { resident: { serves: 'x' }, model: 'p/m' })
    expect(collectResident(dir).entries[0]!.model).toBe('p/m')
  })

  it('`_` 前缀目录不算轨迹（归档区不是候选）', () => {
    const abs = join(dir, 'AGENT_SESSIONS', '_archived', '2026-10-19--S905--old')
    mkdirSync(abs, { recursive: true })
    writeFileSync(join(abs, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify({ resident: { serves: 'old' } }), 'utf-8')
    expect(collectResident(dir).entries).toEqual([])
  })

  it('坏 JSON 的轨迹被跳过（一份坏声明不该让整张名单拿不到）', () => {
    makeTrajectory('S906', { resident: { serves: 'good' } })
    const badDir = join(dir, 'AGENT_SESSIONS', '2026-10-20--S907--bad')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, TRAJECTORY_CONSTRAINT_FILENAME), '{ not json', 'utf-8')
    expect(collectResident(dir).entries.map((e) => e.code)).toEqual(['S906'])
  })

  it('名单文案含"怎么写"——照做即可，且点明只写这一个字段不影响默认行为', () => {
    const text = listResident(dir)
    expect(text).toContain('"resident"')
    expect(text).toContain('不影响任何默认行为')
  })
})
