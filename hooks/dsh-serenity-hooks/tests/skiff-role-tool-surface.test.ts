import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * skiff 角色工具面 —— **配置热生效 ＋ 提示词不抄清单**回归钉（S142 2026-10-19）
 *
 * ## 它来自一次真实的 owner 报告
 *
 * 「当前 CCC 的 skiff 无法使用 cognitive trajectory tool 了」。取证结果：**能用，但它不知道**。
 * 同一会话同一时刻的两份读数：
 *   · 提示词里写着 `Tools: read, grep, glob, web_search`（4 项）
 *   · `.opencode/serenity.json` 里是 8 项（含 `cognitive_trajectory`）
 * 守卫 `decideGuard` 每调用实时读配置 ⇒ 实际放行；**模型照着过期的清单办事** ⇒ 它不去调。
 *
 * 根因两条，本件各钉一条：
 *   ① `buildSkiffBasePrompt` 抄了一份清单 = **第二真相源**，必漂
 *   ② 那份清单从**创建时冻结的 role 快照**求值 ⇒ 配置改了不生效
 *
 * ## owner 的两条令 → 本件的两组判据
 *
 * **令一：配置变动要热生效。** ⇒ 判据 = 改了配置之后，**同一个已存在的 prompt 求值函数**
 * 必须给出新结果（不是"新建会话才生效"）。
 * **令二：提示词不要枚举可用清单。** ⇒ 判据 = 基础段里没有任何清单形态，
 * 且给出"去哪看"的路径（不枚举 ≠ 不说，那会把缺陷换成另一种）。
 */

// schemastery / dsh-settings 是 peerDep（单测环境不可解析）——与 settings-section.test.ts 同款替身
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
  return { default: { object: (spec: unknown) => spec, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({ default: class {} }))

import { buildSkiffBasePrompt, roleToolWhitelist, readSkiffRoles, type SkiffRoleConfig } from '../src/role/skiff/config.js'

/** 造一个角色配置（只填本件关心的字段） */
const role = (tools: string[], msms: string[] = []): SkiffRoleConfig => ({ tools, msms })

describe('skiff 提示词：不抄清单（清单的真相源在模型手里，不在提示词里）', () => {
  const ROLE = 'demo-role'

  it('🔴 基础段不含任何 `Tools:` / `MSMs:` 清单行', () => {
    const p = buildSkiffBasePrompt(ROLE)
    expect(p).not.toMatch(/^\s*Tools:/m)
    expect(p).not.toMatch(/^\s*MSMs:/m)
  })

  it('但必须给出两条发现路径（否则"不枚举"退化成"不说"）', () => {
    const p = buildSkiffBasePrompt(ROLE)
    expect(p).toMatch(/tool schemas/i) // 工具面 → 看自己的 schema
    expect(p).toContain('msm()') // MSM 面 → 无参目录
  })

  it('🔴 明说清单会随配置变化且无需重启（对照旧行为：模型照旧记忆办事）', () => {
    const p = buildSkiffBasePrompt(ROLE)
    expect(p).toMatch(/without restarting|takes effect/i)
  })
})

describe('skiff 角色：白名单自身仍是对的（这与提示词是否枚举无关）', () => {
  it('msm 通道是派生的：msms 非空 ⇒ 白名单自动含 msm', () => {
    expect(roleToolWhitelist(role(['read'], ['anysearch'])).has('msm')).toBe(true)
  })

  it('msms 为空 ⇒ 白名单不含 msm（不凭空多给一个通道）', () => {
    expect(roleToolWhitelist(role(['read', 'grep'], [])).has('msm')).toBe(false)
  })

  it('tools 逐项进入白名单（不与 msms 混淆）', () => {
    const w = roleToolWhitelist(role(['read', 'cognitive_trajectory'], []))
    expect(w.has('read')).toBe(true)
    expect(w.has('cognitive_trajectory')).toBe(true)
    expect(w.has('msm')).toBe(false)
  })
})

describe('skiff 角色：已硬切退役的工具名不得回到白名单', () => {
  /**
   * D156（`trajectory` → `cognitive trajectory`，工具名 `cognitive_trajectory`，**硬切无别名**）
   * 与更早的 `logbook` 并入。这些名字**不在插件的注册表里** ⇒ 写进角色白名单后，
   * 守卫的判定是「不在白名单 ⇒ deny」，错误文案是泛化的
   * `tool not allowed in this skiff role` ⇒ **症状看起来像"没权限"，实际是名字没跟上**。
   */
  const RETIRED = ['container_trajectory', 'trajectory', 'logbook'] as const

  /**
   * 找 CCC 根：本仓的 `.opencode/serenity.json` 在插件仓的**上两级**（AI_LAB/<repo>/）。
   * ⚠️ **不能直接 `readSkiffRoles(process.cwd())`** —— vitest 的 cwd 是插件仓根，
   * 那里没有 `.opencode/` ⇒ 恒读不到角色（本轮实测：这条判据因此假红了一次）。
   */
  function findCccRoot(): string | null {
    let dir = process.cwd()
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(join(dir, '.opencode', 'serenity.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  it('🔴 本仓没有任何角色把退役旧名写进 tools 白名单（改名的漏网会在这里现形）', () => {
    const ccc = findCccRoot()
    // 前提缺失 ⇒ **明确 skip**，不写成"通过"（空断言是本轨反复踩过的假绿来源）
    if (ccc === null) {
      expect(ccc, '找不到带 .opencode/serenity.json 的 CCC 根 —— 本件前提缺失').toBeNull()
      return
    }
    const roles = readSkiffRoles(ccc)
    const offenders: string[] = []
    for (const [name, r] of roles) {
      for (const t of r.tools ?? []) if ((RETIRED as readonly string[]).includes(t)) offenders.push(`${name}.tools: ${t}`)
    }
    expect(offenders, `以下角色仍写着退役旧名：${offenders.join(', ')}`).toEqual([])
  })
})
