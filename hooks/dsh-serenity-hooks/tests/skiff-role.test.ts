import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SKIFF_SESSION_PREFIX,
  isSkiffSessionId,
  readSkiffRoles,
  trajectorySubset,
  roleToolWhitelist,
  roleMsmWhitelist,
  buildSkiffBasePrompt,
} from '../src/skiff-role.js'
import type { SkiffRoleConfig } from '../src/ccc.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-role-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

describe('skiff-role: sessionId 判定', () => {
  it('skiff- 前缀命中；其余（含 undefined/空）不命中', () => {
    expect(isSkiffSessionId(`${SKIFF_SESSION_PREFIX}qa-readonly-uuid`)).toBe(true)
    expect(isSkiffSessionId('skiff-x-1')).toBe(true)
    expect(isSkiffSessionId('normal-session')).toBe(false)
    expect(isSkiffSessionId('handyman-x-1')).toBe(false)
    expect(isSkiffSessionId(undefined)).toBe(false)
    expect(isSkiffSessionId('')).toBe(false)
  })
})

describe('skiff-role: readSkiffRoles 配置解析', () => {
  it('无 skiff 段 / 空 roles → 空 Map（Skiff 未启用）', () => {
    writeConfig({ handyman: { models: ['m/M'] } })
    expect(readSkiffRoles(dir).size).toBe(0)
    writeConfig({ skiff: {} })
    expect(readSkiffRoles(dir).size).toBe(0)
    writeConfig({ skiff: { roles: {} } })
    expect(readSkiffRoles(dir).size).toBe(0)
  })

  it('单角色全字段解析', () => {
    writeConfig({
      skiff: {
        roles: {
          'qa-readonly': {
            model: 'm/M3',
            msms: ['cognitive-qa'],
            tools: [],
            trajectory: { session: false, keeper: false, rebuild: false },
            systemPrompt: '你是宁静号的认知问答助手。',
          },
        },
      },
    })
    const roles = readSkiffRoles(dir)
    expect(roles.size).toBe(1)
    const r = roles.get('qa-readonly')!
    expect(r.model).toBe('m/M3')
    expect(r.msms).toEqual(['cognitive-qa'])
    expect(r.tools).toEqual([])
    expect(r.trajectory).toEqual({ session: false, keeper: false, rebuild: false })
    expect(r.systemPrompt).toContain('认知问答')
  })

  it('多角色 + 字段缺省（model/trajectory/systemPrompt 可省略）', () => {
    writeConfig({
      skiff: {
        roles: {
          a: { msms: ['x'] },
          b: { tools: ['read', 'grep'] },
        },
      },
    })
    const roles = readSkiffRoles(dir)
    expect(roles.size).toBe(2)
    expect(roles.get('a')!.model).toBeUndefined()
    expect(roles.get('a')!.trajectory).toBeUndefined()
    expect(roles.get('b')!.tools).toEqual(['read', 'grep'])
  })

  it('非法条目（非对象 / 空名）跳过', () => {
    writeConfig({ skiff: { roles: { '': { msms: ['x'] }, '  ': { msms: ['y'] }, bad: 'not-an-object' } } })
    expect(readSkiffRoles(dir).size).toBe(0)
  })

  it('配置读取失败 → 空 Map（零影响）', () => {
    // 无 .opencode/serenity.json：loadSerenityConfig 返回 {} → 空
    expect(readSkiffRoles(dir).size).toBe(0)
  })
})

describe('skiff-role: 子集与白名单纯函数', () => {
  const full: SkiffRoleConfig = {
    model: 'm/M3',
    msms: ['a', 'b'],
    tools: ['read', 'grep', 'write'],
    trajectory: { session: false, keeper: true, rebuild: false },
    systemPrompt: 'p',
  }

  it('trajectorySubset 缺省全 false（完全独立）；按配置取', () => {
    expect(trajectorySubset(undefined)).toEqual({ session: false, keeper: false, rebuild: false })
    expect(trajectorySubset(full)).toEqual({ session: false, keeper: true, rebuild: false })
    expect(trajectorySubset({ msms: ['x'] })).toEqual({ session: false, keeper: false, rebuild: false })
  })

  it('roleToolWhitelist：tools + msms 非空时 acc_msm 自动可用', () => {
    expect([...roleToolWhitelist(full)].sort()).toEqual(['acc_msm', 'grep', 'read', 'write'])
    expect([...roleToolWhitelist({ tools: ['read'] })].sort()).toEqual(['read'])
    expect([...roleToolWhitelist({ msms: ['x'] })].sort()).toEqual(['acc_msm'])
    expect([...roleToolWhitelist(undefined)].sort()).toEqual([])
  })

  it('roleMsmWhitelist：独立 MSM 白名单', () => {
    expect([...roleMsmWhitelist(full)].sort()).toEqual(['a', 'b'])
    expect(roleMsmWhitelist(undefined).size).toBe(0)
  })
})

describe('skiff-role: buildSkiffBasePrompt 动态基础提示词', () => {
  it('msms + tools 双清单', () => {
    const p = buildSkiffBasePrompt('qa-readonly', { msms: ['cognitive-qa'], tools: ['read'] })
    expect(p).toContain('=== Serenity Skiff ===')
    expect(p).toContain('Role: qa-readonly (defined by this CCC)')
    expect(p).toContain('MSMs: cognitive-qa')
    expect(p).toContain('Tools: read')
    expect(p).toContain('acc_msm exec <name> [args...]')
    expect(p).toContain('No other tools are available.')
  })

  it('无 msms → (none)；无 tools → (none)', () => {
    const p = buildSkiffBasePrompt('r', { tools: [] })
    expect(p).toContain('MSMs: (none)')
    expect(p).toContain('Tools: (none)')
  })

  it('纯 MSM 角色（tools 空）', () => {
    const p = buildSkiffBasePrompt('r', { msms: ['a'] })
    expect(p).toContain('MSMs: a')
    expect(p).toContain('Tools: (none)')
  })
})
