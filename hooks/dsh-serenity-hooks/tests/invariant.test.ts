import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyToolConsistency, REGISTERED_TOOLS } from '../src/invariant.js'

describe('invariant: 清单与注册工具一致性', () => {
  it('一致时零问题', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(manifest, JSON.stringify({ id: 'x', contributes: { tools: ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'handyman'] } }))
    expect(verifyToolConsistency(manifest, REGISTERED_TOOLS)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
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
