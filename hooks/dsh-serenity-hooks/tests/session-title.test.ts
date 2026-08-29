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

import { namingTitleFor, renameDshSessionOnUse, activeInfoFromCreate, renameDshSessionForActive } from '../src/tools/session.js'
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

describe('F3: renameDshSessionOnUse（v1.22.9：返回结果对象，不静默；v1.23.2：服务对象方法调用）', () => {
  const active = { sessionId: 'S001', dirName: '2026-08-26--S001--my-work', mdPath: '/x/SESSION.md' }
  const okTitles = (log: string[]): { rename: (s: unknown, t: string) => unknown } => ({
    rename: (session, title) => { log.push(String((session as { id: string }).id) + '=' + title) },
  })

  it('门控通过 → titles.rename 方法调用（S###-日期标题）', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      { id: 'dsh-sess-1' },
      okTitles(renamed),
      active,
    )
    expect(result).toEqual({ ok: true, title: 'S001-2026-08-26' })
    expect(renamed).toEqual(['dsh-sess-1=S001-2026-08-26'])
  })

  // v1.23.2 回归：方法调用 this 绑定——模拟 DSH 服务方法内部读 this（assertServiceActive 模式）。
  // 旧实现传解构裸函数 → this=undefined → 抛错（日志实证 Cannot read properties of undefined）。
  // 现传服务对象 → renameDshSessionOnUse 内部 titles.rename(...) 方法调用 → this = 服务实例。
  it('方法内部读 this（服务实例态）→ 成功（this 绑定回归）', () => {
    const service = {
      active: true,
      rename(this: { active: boolean }, _s: unknown, title: string): string {
        if (!this.active) throw new Error('assertServiceActive failed')
        return title
      },
    }
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      { id: 'dsh-sess-1' },
      service,
      active,
    )
    expect(result).toEqual({ ok: true, title: 'S001-2026-08-26' })
  })

  it('naming.enabled=false → 返回失败原因（不静默）', () => {
    const renamed: string[] = []
    const result = renameDshSessionOnUse(
      { namingEnabled: false, sessionTitleAvailable: true },
      {},
      okTitles(renamed),
      active,
    )
    expect(result).toEqual({ ok: false, reason: 'naming.enabled=false' })
    expect(renamed).toEqual([])
  })

  it('sessionTitle 服务缺失（undefined）→ 返回失败原因', () => {
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      {},
      undefined,
      active,
    )
    expect(result).toEqual({ ok: false, reason: 'sessionTitle service unavailable' })
  })

  it('sessionTitle 服务无 rename 方法 → 返回失败原因', () => {
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      {},
      {} as never,
      active,
    )
    expect(result).toEqual({ ok: false, reason: 'sessionTitle service unavailable' })
  })

  it('rename 抛错 → 返回失败原因（不传播，调用方决定可见性）', () => {
    const result = renameDshSessionOnUse(
      { namingEnabled: true, sessionTitleAvailable: true },
      {},
      { rename: () => { throw new Error('session is not live in this store') } },
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

describe('F3: activeInfoFromCreate（v1.25.11 create 命名——无需 use 激活即可驱动重命名）', () => {
  it('desc 模式 → sessionId=S### + dirName + mdPath=sessionPath/SESSION.md', () => {
    const r = createSession({ root: dir, desc: 'my-work', dryRun: false })
    const info = activeInfoFromCreate(r)
    expect(info.sessionId).toMatch(/^S\d{3}$/)
    expect(info.dirName).toBe(r.dirName)
    expect(info.mdPath).toBe(join(r.sessionPath, 'SESSION.md'))
    // 命名标题 = S###-日期（与 use 后命名一致）
    expect(namingTitleFor(info)).toMatch(/^S\d{3}-\d{4}-\d{2}-\d{2}$/)
  })

  it('issue 模式 → sessionId=issue + 标题回退目录名', () => {
    const r = createSession({ root: dir, issue: 'apaas-26116', dryRun: false })
    const info = activeInfoFromCreate(r)
    expect(info.sessionId).toBe('apaas-26116')
    expect(namingTitleFor(info)).toBe(r.dirName)
  })
})

describe('F3: renameDshSessionForActive（v1.25.11 use/create 共用封装）', () => {
  const info = { sessionId: 'S010', dirName: '2026-08-29--S010--my-work', mdPath: '/x/SESSION.md' }

  it('门控通过 → titles.rename 方法调用（S###-日期标题）', () => {
    const renamed: string[] = []
    const ctx = { get: () => ({ rename: (s: unknown, t: string) => { renamed.push(`${String((s as { id: string }).id)}=${t}`) } }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameDshSessionForActive(ctx as never, { agent: { session: { id: 'dsh-1' } } }, info)
    expect(renamed).toEqual(['dsh-1=S010-2026-08-29'])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('缺 agent session → warn 不抛错（create 主流程不阻断）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameDshSessionForActive({ get: () => undefined } as never, { agent: {} }, info)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('缺少 agent session')
    warn.mockRestore()
  })

  it('sessionTitle 服务缺失 → warn（不静默；create 仍成功返回）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameDshSessionForActive({ get: () => undefined } as never, { agent: { session: { id: 'dsh-1' } } }, info)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('sessionTitle service unavailable')
    warn.mockRestore()
  })
})

describe('F3: 简单配置门控默认（namingEnabled 默认开）', () => {
  it('defaultSimpleSettings.namingEnabled = true', () => {
    expect(defaultSimpleSettings().namingEnabled).toBe(true)
  })
})
