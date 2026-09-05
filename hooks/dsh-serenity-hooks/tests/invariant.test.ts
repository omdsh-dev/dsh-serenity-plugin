import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyToolConsistency, REGISTERED_TOOLS } from '../src/invariant.js'

describe('invariant: 清单与注册工具一致性', () => {
  it('一致时零问题（13 工具，与 dsh.plugin.json contributes.tools 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        id: 'x',
        contributes: {
          tools: ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'handyman', 'session_rebuild', 'localstore', 'skiff_admin', 'autopilot-trajectory'],
        },
      }),
    )
    expect(verifyToolConsistency(manifest, REGISTERED_TOOLS)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('REGISTERED_TOOLS 含 13 工具（v1.25.0 skiff_admin + v1.26.12 autopilot-trajectory）', () => {
    expect(REGISTERED_TOOLS).toHaveLength(13)
    expect(REGISTERED_TOOLS).toContain('skiff_admin')
    expect(REGISTERED_TOOLS).toContain('session_rebuild')
    expect(REGISTERED_TOOLS).toContain('localstore')
    expect(REGISTERED_TOOLS).toContain('autopilot-trajectory')
  })

  it('声明了未注册的工具 → 报告', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(manifest, JSON.stringify({ id: 'x', contributes: { tools: ['cc_fs', 'ghost'] } }))
    const issues = verifyToolConsistency(manifest, REGISTERED_TOOLS)
    expect(issues.some((i) => i.includes('ghost'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('清单缺失 → 报告', () => {
    expect(verifyToolConsistency('/nonexistent/dsh.plugin.json', REGISTERED_TOOLS).length).toBeGreaterThan(0)
  })
})
