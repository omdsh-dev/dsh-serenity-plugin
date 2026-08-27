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

import { namingTitleFor, renameDshSessionOnUse } from '../src/tools/session.js'
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

describe('F3: namingTitleFor（v1.22.9 格式修正：S###-日期，非完整目录名）', () => {
  it('有 S### 编号 → S###-日期（用户拍板格式）', () => {
    const t = namingTitleFor({ sessionId: 'S143', dirName: '2026-08-26--S143--my-work', mdPath: '/x/SESSION.md' })
    expect(t).toBe('S143-2026-08-26')
  })

  it('issue 会话（无 S### 编号）→ 回退目录名', () => {
    const t = namingTitleFor({ sessionId: 'apaas-26116', dirName: '2026-08-26--apaas-26116', mdPath: '/x/SESSION.md' })
    expect(t).toBe('2026-08-26--apaas-26116')
  })

  it('目录名无日期前缀 → 回退 sessionId', () => {
    const t = namingTitleFor({ sessionId: 'S005', dirName: 'S005', mdPath: '/x/SESSION.md' })
    expect(t).toBe('S005')
  })
})

describe('F3: renameDshSessionOnUse（v1.22.9：返回结果对象，不静默）', () => {
  const active = { sessionId: 'S001', dirName: '2026-08-26--S001--my-work', mdPath: '/x/SESSION.md' }

  it('门控通过 → rename 调用（S###-日期标题）', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      { id: 'dsh-sess-1' },
      (session, title) => { renamed.push(String((session as { id: string }).id) + '=' + title) },
      active,
    )
    expect(result).toEqual({ ok: true, title: 'S001-2026-08-26' })
    expect(renamed).toEqual(['dsh-sess-1=S001-2026-08-26'])
  })

  it('naming.enabled=false → 返回失败原因（不静默）', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: false, sessionTitleAvailable: true },
      {},
      (_s, t) => { renamed.push(t) },
      active,
    )
    expect(result).toEqual({ ok: false, reason: 'naming.enabled=false' })
    expect(renamed).toEqual([])
  })

  it('sessionTitle 服务缺失 → 返回失败原因', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: false },
      {},
      (_s, t) => { renamed.push(t) },
      active,
    )
    expect(result).toEqual({ ok: false, reason: 'sessionTitle service unavailable' })
    expect(renamed).toEqual([])
  })

  it('rename 抛错 → 返回失败原因（不传播，调用方决定可见性）', () => {
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      {},
      () => { throw new Error('session is not live in this store') },
      active,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not live in this store')
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
