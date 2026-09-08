import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  resolveRoleSystemPrompt,
  createRolePromptReader,
  resolveSkiffKind,
  systemPromptSource,
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

describe('skiff-role: resolveRoleSystemPrompt（v1.25.10 md 文件引用）', () => {
  it('systemPromptFile 优先（推荐）：读取 md 文件内容', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '你是宁静号的认知问答助手。\n\n专注、准确。')
    const role: SkiffRoleConfig = { systemPromptFile: '.opencode/skiff/qa.md', systemPrompt: '旧内嵌' }
    expect(resolveRoleSystemPrompt(dir, role)).toBe('你是宁静号的认知问答助手。\n\n专注、准确。')
    expect(systemPromptSource(role)).toBe('file')
  })

  it('无 systemPromptFile → 回退内嵌 systemPrompt（兼容旧配置）', () => {
    const role: SkiffRoleConfig = { systemPrompt: '内嵌提示词' }
    expect(resolveRoleSystemPrompt(dir, role)).toBe('内嵌提示词')
    expect(systemPromptSource(role)).toBe('inline')
  })

  it('两者都无 → 空字符串（source=none）', () => {
    expect(resolveRoleSystemPrompt(dir, undefined)).toBe('')
    expect(resolveRoleSystemPrompt(dir, {})).toBe('')
    expect(systemPromptSource({})).toBe('none')
  })

  it('文件缺失 → 抛错（validate 报 issue；装配 catch 降级）', () => {
    const role: SkiffRoleConfig = { systemPromptFile: '.opencode/skiff/missing.md' }
    expect(() => resolveRoleSystemPrompt(dir, role)).toThrow(/not found/)
  })

  it('路径逃逸 → 抛错（resolveInside 拒绝）', () => {
    const role: SkiffRoleConfig = { systemPromptFile: '../outside.md' }
    expect(() => resolveRoleSystemPrompt(dir, role)).toThrow(/escape/i)
  })

  it('BOM 剥除（Windows 编辑器写出的 \uFEFF 前缀）', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '\uFEFF带 BOM 的内容')
    const role: SkiffRoleConfig = { systemPromptFile: '.opencode/skiff/qa.md' }
    expect(resolveRoleSystemPrompt(dir, role)).toBe('带 BOM 的内容')
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

  it('roleToolWhitelist：tools + msms 非空时 msm 自动可用', () => {
    expect([...roleToolWhitelist(full)].sort()).toEqual(['grep', 'msm', 'read', 'write'])
    expect([...roleToolWhitelist({ tools: ['read'] })].sort()).toEqual(['read'])
    expect([...roleToolWhitelist({ msms: ['x'] })].sort()).toEqual(['msm'])
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
    expect(p).toContain('msm("<name>", ["<args>"])')
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

describe('skiff-role: 类型二分 resolveSkiffKind（v1.30.15，S142 用户拍板）', () => {
  it('显式 kind 优先于隐式推断', () => {
    // 显式 temporary + 有稳定 id → 仍 temporary（CCC 主权）
    expect(resolveSkiffKind({ kind: 'temporary' }, true)).toBe('temporary')
    // 显式 persistent + 无稳定 id → 仍 persistent
    expect(resolveSkiffKind({ kind: 'persistent' }, false)).toBe('persistent')
  })

  it('缺省 = 隐式推断：有稳定会话 id → persistent，否则 temporary', () => {
    expect(resolveSkiffKind(undefined, true)).toBe('persistent')
    expect(resolveSkiffKind(undefined, false)).toBe('temporary')
    expect(resolveSkiffKind({ msms: ['x'] }, true)).toBe('persistent')
    expect(resolveSkiffKind({ msms: ['x'] }, false)).toBe('temporary')
  })

  it('非法 kind 值 → 回落隐式推断（不信任脏配置）', () => {
    expect(resolveSkiffKind({ kind: 'forever' as never }, true)).toBe('persistent')
    expect(resolveSkiffKind({ kind: 'forever' as never }, false)).toBe('temporary')
  })

  it('readSkiffRoles 解析 kind 字段（合法值透传；非法值丢弃）', () => {
    writeConfig({
      skiff: {
        roles: {
          a: { kind: 'persistent', msms: ['x'] },
          b: { kind: 'temporary' },
          c: { kind: 'nonsense', msms: ['y'] },
        },
      },
    })
    const roles = readSkiffRoles(dir)
    expect(roles.get('a')!.kind).toBe('persistent')
    expect(roles.get('b')!.kind).toBe('temporary')
    expect(roles.get('c')!.kind).toBeUndefined()
  })
})

describe('skiff-role: createRolePromptReader 热更新（v1.30.15 方案 A）', () => {
  function writePrompt(text: string): void {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'r.md'), text)
  }

  it('改文件即生效（第二次读取返回新内容，无需重启）', () => {
    writePrompt('第一版提示词')
    const read = createRolePromptReader(dir, { systemPromptFile: '.opencode/skiff/r.md' })
    expect(read()).toBe('第一版提示词')
    writePrompt('第二版提示词（热更）')
    expect(read()).toBe('第二版提示词（热更）')
  })

  it('mtime/size 未变 → 命中缓存（同一字符串实例，零重复解析）', () => {
    writePrompt('稳定内容')
    const read = createRolePromptReader(dir, { systemPromptFile: '.opencode/skiff/r.md' })
    const a = read()
    const b = read()
    expect(a).toBe('稳定内容')
    expect(b).toBe(a)
  })

  it('BOM 剥除 + trim（与 resolveRoleSystemPrompt 同口径）', () => {
    writePrompt('\uFEFF 带 BOM  \n')
    const read = createRolePromptReader(dir, { systemPromptFile: '.opencode/skiff/r.md' })
    expect(read()).toBe('带 BOM')
  })

  it('内嵌 systemPrompt → 静态读取器（JSON 改动需重启，符合语义）', () => {
    const read = createRolePromptReader(dir, { systemPrompt: '内嵌' })
    expect(read()).toBe('内嵌')
    expect(read()).toBe('内嵌')
    expect(createRolePromptReader(dir, undefined)()).toBe('')
  })

  it('路径逃逸 → 空读取器（不抛错，装配不阻断）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = createRolePromptReader(dir, { systemPromptFile: '../outside.md' })
    expect(read()).toBe('')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('路径非法'))).toBe(true)
    warn.mockRestore()
  })

  it('文件被删除 → 沿用上次成功内容（绝不返回空）+ 告警一次', () => {
    writePrompt('有效内容')
    const read = createRolePromptReader(dir, { systemPromptFile: '.opencode/skiff/r.md' })
    expect(read()).toBe('有效内容')
    rmSync(join(dir, '.opencode', 'skiff', 'r.md'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(read()).toBe('有效内容')
    expect(read()).toBe('有效内容')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('读取失败'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('热重载打一行 info 日志（首次不报，变更才报）', () => {
    writePrompt('v1')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const read = createRolePromptReader(dir, { systemPromptFile: '.opencode/skiff/r.md' })
    read()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('热重载'))).toHaveLength(0)
    writePrompt('v2 更长一些的内容')
    read()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('热重载'))).toHaveLength(1)
    info.mockRestore()
  })
})
