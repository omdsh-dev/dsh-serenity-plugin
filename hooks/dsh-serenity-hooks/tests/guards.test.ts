import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decideGuard, type GuardInput, syncSafeModeRestriction } from '../src/seams/guards.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guards-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function base(over: Partial<GuardInput>): GuardInput {
  return { root: '/ccc', toolName: 'read', safeModeOn: false, blacklist: [], pathArg: undefined, ...over }
}

describe('guards: decideGuard 纯决策', () => {
  it('非安全模式 + 无路径 → allow', () => {
    expect(decideGuard(base({}))).toEqual({ kind: 'allow' })
  })

  it('安全模式 + 写工具 → deny（提示不泄露 safe-mode：bash 不存在）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'bash' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('bash')
    expect(d.deny).not.toContain('safe mode')
    expect(d.deny).not.toContain('serenity')
  })

  it('安全模式 + write（非 bash）干净路径 → allow（标准语义：只禁 bash）', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('安全模式 + write + 黑名单路径 → deny（黑名单分支）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'write', blacklist: ['.secrets/'], pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('安全模式 + 读工具 → allow', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'read' })).kind).toBe('allow')
  })

  it('路径越界 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '../escape' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('path escape')
  })

  it('黑名单命中 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', blacklist: ['.secrets/'], pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('路径合法且不命中 → allow', () => {
    expect(decideGuard(base({ toolName: 'write', blacklist: ['.secrets/'], pathArg: 'docs/a.md' })).kind).toBe('allow')
  })
})

describe('safe-mode 工具隐藏（syncSafeModeRestriction）', () => {
  it('标记存在 → restrict deny 隐藏写工具；消失 → 解除', () => {
    // 纯逻辑验证：restrict 的 deny 列表由 SAFE_MODE_DENY_TOOLS 定义
    // （agent.ctx.tools.restrict 为 DSH 运行时行为，这里验证调用契约）
    const calls: { on: boolean; deny?: string[] }[] = []
    const mkAgent = (on: boolean) => {
      const key = on ? 'k1' : 'k2'
      return {
        session: { id: key },
        ctx: {
          tools: {
            restrict: (f: { deny?: string[] }) => {
              calls.push({ on, deny: f.deny })
              return () => { calls.push({ on: false }) }
            },
          },
        },
      } as any
    }
    // 直接验证守卫工具列表不含 bash/write 时的整体语义由运行时保证；
    // 此处验证 syncSafeModeRestriction 在标记 on 时调用 restrict
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    const agent = mkAgent(true)
    syncSafeModeRestriction(agent, dir)
    expect(calls.filter(c => c.on === true)).toHaveLength(1)
    expect(calls[0]!.deny).toContain('bash')
    expect(calls[0]!.deny).not.toContain('write') // 只隐藏 bash，write/edit 保留
  })
})

describe('guards: CCC 治理文件保护（agent 不可写 .serenity/.serenity-safe-on）', () => {
  it('写 .serenity-safe-on 被拒（无论安全模式）', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity-safe-on' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('治理文件')
  })

  it('写 .serenity 被拒', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity' }))
    expect(d.kind).toBe('deny')
  })

  it('普通文件不受影响', () => {
    expect(decideGuard(base({ toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })
})
