import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// dsh-tools 运行时不可解析（peerDep）——mock defineTool 返回 opts（与 register.test.ts 同款）
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))

import { SKIFF_GUIDE, validateSkiffConfig, listSkiffRoles, applySkiffConfig } from '../src/tools/skiff-admin.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-admin-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

function writeRegistry(entries: Array<{ name: string; path: string }>): void {
  writeFileSync(
    join(dir, 'mech-registry.json'),
    JSON.stringify({ version: 1, description: 'test', entries: entries.map((e) => ({ ...e, skill: 'x', category: 'mech', description: 'd', usage: 'u', flags: [] })) }, null, 2),
  )
}

describe('skiff_admin: guide 定义教程', () => {
  it('含概念/schema/双白名单/认知 MSM 写法/轨迹纪律/示例角色', () => {
    expect(SKIFF_GUIDE).toContain('Skiff Definition Guide')
    expect(SKIFF_GUIDE).toContain('任意子集角色')
    expect(SKIFF_GUIDE).toContain('"msms"')
    expect(SKIFF_GUIDE).toContain('"tools"')
    expect(SKIFF_GUIDE).toContain('"trajectory"')
    expect(SKIFF_GUIDE).toContain('"systemPrompt"')
    expect(SKIFF_GUIDE).toContain('register/deregister 必拒')
    expect(SKIFF_GUIDE).toContain('SERENITY_ROOT')
    expect(SKIFF_GUIDE).toContain('qa-readonly')
    expect(SKIFF_GUIDE).toContain('code-review')
    expect(SKIFF_GUIDE).toContain('debugPort')
    expect(SKIFF_GUIDE).toContain('ACP')
  })
})

describe('skiff_admin: validateSkiffConfig 配置校验', () => {
  it('无角色 → ok（skiff disabled 零影响）', () => {
    writeConfig({})
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect((r as { roleCount: number }).roleCount).toBe(0)
  })

  it('合法配置 → ok', () => {
    writeConfig({
      handyman: { models: ['m/M3'] },
      skiff: {
        roles: {
          'qa-readonly': {
            msms: ['cognitive-qa'],
            tools: [],
            systemPrompt: '你是宁静号的认知问答助手。',
          },
        },
      },
    })
    writeRegistry([{ name: 'cognitive-qa', path: '.opencode/skills/home-serenity/scripts/cognitive-qa.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })

  it('msms 未注册 → 问题清单', () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['ghost-msm'], systemPrompt: 'p' } } } })
    writeRegistry([])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('ghost-msm') && i.includes('not registered'))).toBe(true)
  })

  it('model 不在 handyman.models → 问题清单', () => {
    writeConfig({
      handyman: { models: ['m/M3'] },
      skiff: { roles: { qa: { msms: ['x'], model: 'other/model', systemPrompt: 'p' } } },
    })
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('other/model') && i.includes('not in handyman.models'))).toBe(true)
  })

  it('systemPrompt 空 → 问题清单', () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['x'] } } } })
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('system prompt is empty'))).toBe(true)
  })

  it('systemPromptFile 缺失 → 问题清单（v1.25.10 md 文件引用）', () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['x'], systemPromptFile: '.opencode/skiff/missing.md' } } } })
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('not found'))).toBe(true)
  })

  it('systemPromptFile 合法（存在 + 非空）→ ok（推荐配置方法）', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '文件版完整提示词')
    writeConfig({ skiff: { roles: { qa: { msms: ['x'], systemPromptFile: '.opencode/skiff/qa.md' } } } })
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })
})

describe('skiff_admin: listSkiffRoles 角色摘要', () => {
  it('无角色 → note', () => {
    writeConfig({})
    const r = listSkiffRoles(dir) as { roles: unknown[]; note: string }
    expect(r.roles).toEqual([])
    expect(r.note).toContain('no skiff roles defined')
  })

  it('有角色 → 摘要（名/模型/msms/tools/轨迹纪律）', () => {
    writeConfig({
      handyman: { models: ['m/M3'] },
      skiff: {
        roles: {
          'qa-readonly': { msms: ['cognitive-qa'], tools: [] },
          review: { msms: ['review-scan'], tools: ['read', 'grep'], trajectory: { keeper: true }, systemPrompt: 'p' },
        },
      },
    })
    const r = listSkiffRoles(dir) as { roles: Array<Record<string, unknown>>; count: number }
    expect(r.count).toBe(2)
    const qa = r.roles.find((x) => x.name === 'qa-readonly')!
    expect(qa.model).toBe('(handyman default)')
    expect(qa.msms).toEqual(['cognitive-qa'])
    expect(qa.tools).toEqual([])
    expect((qa.trajectory as Record<string, boolean>).keeper).toBe(false)
    expect(qa.promptSource).toBe('none')
    const review = r.roles.find((x) => x.name === 'review')!
    expect(review.tools).toEqual(['read', 'grep'])
    expect((review.trajectory as Record<string, boolean>).keeper).toBe(true)
    expect(review.promptSource).toBe('inline')
  })

  it('有角色（systemPromptFile）→ promptSource=file + 文件路径展示（v1.25.10）', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '提示词')
    writeConfig({
      skiff: { roles: { qa: { msms: ['x'], systemPromptFile: '.opencode/skiff/qa.md' } } },
    })
    const r = listSkiffRoles(dir) as { roles: Array<Record<string, unknown>>; count: number }
    expect(r.count).toBe(1)
    const qa = r.roles[0]!
    expect(qa.promptSource).toBe('file')
    expect(qa.systemPromptFile).toBe('.opencode/skiff/qa.md')
  })
})

describe('skiff_admin: applySkiffConfig 显式生效机制（v1.25.3）', () => {
  it('合法配置 → applied true + 绑定 CCC + 角色清单', () => {
    writeConfig({
      handyman: { models: ['m/M3'] },
      skiff: { roles: { qa: { msms: ['x'], tools: ['read'], systemPrompt: 'p' } } },
    })
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = applySkiffConfig(dir) as { applied: boolean; cccRoot: string; roleCount: number; roles: string[]; note: string }
    expect(r.applied).toBe(true)
    expect(r.cccRoot).toBe(dir)
    expect(r.roleCount).toBe(1)
    expect(r.roles).toEqual(['qa'])
    expect(r.note).toContain('read live')
  })

  it('非法配置 → applied false + 问题清单 + 修复提示（不应用）', () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['ghost-msm'] } } } })
    writeRegistry([])
    const r = applySkiffConfig(dir) as { applied: boolean; issues: string[]; hint: string; roleCount: number }
    expect(r.applied).toBe(false)
    expect(r.roleCount).toBe(1)
    expect(r.issues.some((i: string) => i.includes('ghost-msm'))).toBe(true)
    expect(r.issues.some((i: string) => i.includes('system prompt is empty'))).toBe(true)
    expect(r.hint).toContain('fix the issues')
  })

  it('无角色 → applied true（skiff disabled 零影响）', () => {
    writeConfig({})
    const r = applySkiffConfig(dir) as { applied: boolean; roleCount: number }
    expect(r.applied).toBe(true)
    expect(r.roleCount).toBe(0)
  })
})
