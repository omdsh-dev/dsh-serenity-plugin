import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyToolConsistency, REGISTERED_TOOLS } from '../src/invariant.js'

describe('invariant: 清单与注册工具一致性', () => {
  it('一致时零问题（10 工具，与 dsh.plugin.json contributes.tools 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        id: 'x',
        contributes: {
          tools: ['container_fs', 'logbook', 'dashboard', 'container_git', 'msm', 'praxis', 'handyman', 'localstore', 'container_admin', 'autopilot-trajectory'],
        },
      }),
    )
    expect(verifyToolConsistency(manifest, REGISTERED_TOOLS)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('REGISTERED_TOOLS 含 10 工具（v1.30 命名重构：container 族 + msm/praxis/logbook/dashboard 合一）', () => {
    expect(REGISTERED_TOOLS).toHaveLength(10)
    expect(REGISTERED_TOOLS).toContain('container_fs')
    expect(REGISTERED_TOOLS).toContain('container_admin')
    expect(REGISTERED_TOOLS).toContain('logbook')
    expect(REGISTERED_TOOLS).toContain('msm')
    expect(REGISTERED_TOOLS).toContain('praxis')
    expect(REGISTERED_TOOLS).toContain('dashboard')
    expect(REGISTERED_TOOLS).toContain('localstore')
    expect(REGISTERED_TOOLS).toContain('autopilot-trajectory')
  })

  it('声明了未注册的工具 → 报告', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(manifest, JSON.stringify({ id: 'x', contributes: { tools: ['container_fs', 'ghost'] } }))
    const issues = verifyToolConsistency(manifest, REGISTERED_TOOLS)
    expect(issues.some((i) => i.includes('ghost'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('清单缺失 → 报告', () => {
    expect(verifyToolConsistency('/nonexistent/dsh.plugin.json', REGISTERED_TOOLS).length).toBeGreaterThan(0)
  })
})
