import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { renameDshSessionOnUse } from '../src/tools/session.js'
import { createSession } from '../src/session-ops.js'
import { defaultSimpleSettings } from '../src/settings-section.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-session-title-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('F3: use 后重命名当前 dsh 会话（renameDshSessionOnUse）', () => {
  const active = { sessionId: 'S001', dirName: '2026-08-26--S001--my-work', mdPath: '/x/SESSION.md' }

  it('门控通过 → rename 调用 + 返回目录名', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      { id: 'dsh-sess-1' },
      (session, title) => { renamed.push(String((session as { id: string }).id) + '=' + title) },
      active,
    )
    expect(result).toBe(active.dirName)
    expect(renamed).toEqual(['dsh-sess-1=2026-08-26--S001--my-work'])
  })

  it('naming.enabled=false → 不 rename', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: false, sessionTitleAvailable: true },
      {},
      (_s, t) => { renamed.push(t) },
      active,
    )
    expect(result).toBeNull()
    expect(renamed).toEqual([])
  })

  it('sessionTitle 服务缺失 → 不 rename（旧组合降级）', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: false },
      {},
      (_s, t) => { renamed.push(t) },
      active,
    )
    expect(result).toBeNull()
    expect(renamed).toEqual([])
  })
})

describe('F3: createSession 目录名（use 的目标名称 = 目录名）', () => {
  it('目录名 = YYYY-MM-DD--S###--desc（SESSION 目录名是唯一真相）', () => {
    const r = createSession({ root: dir, desc: 'my-work', dryRun: false })
    expect(r.dirName).toMatch(/^\d{4}-\d{2}-\d{2}--S\d{3}--my-work$/)
    expect(readdirSync(r.sessionPath)).toContain('SESSION.md')
  })

  it('编号递增（S001 → S002）', () => {
    const a = createSession({ root: dir, desc: 'first', dryRun: false })
    const b = createSession({ root: dir, desc: 'second', dryRun: false })
    expect(a.dirName).toContain('--S001--')
    expect(b.dirName).toContain('--S002--')
  })
})

describe('F3: 简单配置门控默认（namingEnabled 默认开）', () => {
  it('defaultSimpleSettings.namingEnabled = true', () => {
    expect(defaultSimpleSettings().namingEnabled).toBe(true)
  })
})
