import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * skiff 约束面工具面 —— **配置热生效 ＋ 提示词不抄清单**回归钉（S142 2026-10-19）
 *
 * ## 它来自一次真实的 owner 报告
 *
 * 「当前 CCC 的 skiff 无法使用 cognitive trajectory tool 了」。取证结果：**能用，但它不知道**。
 * 同一会话同一时刻的两份读数：
 *   · 提示词里写着 `Tools: read, grep, glob, web_search`（4 项）
 *   · 约束面里是 8 项（含 `cognitive_trajectory`）—— 当时约束面写在 `serenity.json` 的
 *     `skiff.roles.<name>`（该段已退役；现在是轨迹目录下的 `skiff.json`）
 * 守卫 `decideGuard` 每调用实时读配置 ⇒ 实际放行；**模型照着过期的清单办事** ⇒ 它不去调。
 *
 * 根因两条，本件各钉一条：
 *   ① `buildSkiffBasePrompt` 抄了一份清单 = **第二真相源**，必漂
 *   ② 那份清单从**创建时冻结的约束面快照**求值 ⇒ 配置改了不生效
 *
 * ## 2026-10-19 重做：本件只改名字，判据一条没变（R↓）
 *
 * skiff = **目录下有 `skiff.json` 的认知轨迹**（旧"角色"模型整块退役）⇒
 *   · `roleToolWhitelist(role)` → `profileToolWhitelist(profile)`
 *   · `readSkiffRoles(ccc)`     → `listSkiffProfiles(ccc)`
 *   · 身份从"角色名"变成"轨迹编码"（`buildSkiffBasePrompt(code)` 的入参）
 * 本件**保留**而不是删除的理由：它的判据（清单归模型、真相源单一）不依赖角色模型，
 * 而白名单推导 + 提示词文本正是这次重做**改动最贴近**的两个面。
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

import { buildSkiffBasePrompt, profileToolWhitelist } from '../src/role/skiff/config.js'
import { listSkiffProfiles, type SkiffProfile } from '../src/role/skiff/profile.js'

/**
 * 造一个约束面（纯函数入参，只填本件关心的字段）。
 *
 * 字段齐备是因为 `SkiffProfile` 的这几个字段都是**必填**——读盘层（`readSkiffProfileAt`）
 * 归一后才有这个形状；本件要验的是**纯函数的推导**，不必为它去造盘。
 */
function profile(tools: string[], msms: string[] = []): SkiffProfile {
  return {
    dirName: '2026-10-19--demo--traj',
    code: 'demo',
    path: '/nowhere/skiff.json',
    tools,
    msms,
    cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
  }
}

describe('skiff 提示词：不抄清单（清单的真相源在模型手里，不在提示词里）', () => {
  /** 入参现在是**轨迹编码**（身份 = 轨迹，不是"你扮演的角色"） */
  const CODE = 'demo-traj'

  it('🔴 基础段不含任何 `Tools:` / `MSMs:` 清单行', () => {
    const p = buildSkiffBasePrompt(CODE)
    expect(p).not.toMatch(/^\s*Tools:/m)
    expect(p).not.toMatch(/^\s*MSMs:/m)
  })

  it('🔴 结构上就抄不了：签名只收编码，收不到约束面', () => {
    // 比"断言不含某串"更硬的判据：函数拿不到 tools/msms ⇒ 抄清单在结构上不可能发生
    expect(buildSkiffBasePrompt.length).toBe(1)
  })

  it('但必须给出两条发现路径（否则"不枚举"退化成"不说"）', () => {
    const p = buildSkiffBasePrompt(CODE)
    expect(p).toMatch(/tool schemas/i) // 工具面 → 看自己的 schema
    expect(p).toContain('msm()') // MSM 面 → 无参目录
  })

  it('🔴 明说清单会随配置变化且无需重启（对照旧行为：模型照旧记忆办事）', () => {
    const p = buildSkiffBasePrompt(CODE)
    expect(p).toMatch(/without restarting|takes effect/i)
  })
})

describe('skiff 约束面：白名单自身仍是对的（这与提示词是否枚举无关）', () => {
  it('msm 通道是派生的：msms 非空 ⇒ 白名单自动含 msm', () => {
    expect(profileToolWhitelist(profile(['read'], ['anysearch'])).has('msm')).toBe(true)
  })

  it('msms 为空 ⇒ 白名单不含 msm（不凭空多给一个通道）', () => {
    expect(profileToolWhitelist(profile(['read', 'grep'], [])).has('msm')).toBe(false)
  })

  it('tools 逐项进入白名单（不与 msms 混淆）', () => {
    const w = profileToolWhitelist(profile(['read', 'cognitive_trajectory'], []))
    expect(w.has('read')).toBe(true)
    expect(w.has('cognitive_trajectory')).toBe(true)
    expect(w.has('msm')).toBe(false)
  })
})

describe('skiff 约束面：已硬切退役的工具名不得回到白名单', () => {
  /**
   * D156（`trajectory` → `cognitive trajectory`，工具名 `cognitive_trajectory`，**硬切无别名**）
   * 与更早的 `logbook` 并入。这些名字**不在插件的注册表里** ⇒ 写进约束面白名单后，
   * 守卫的判定是「不在白名单 ⇒ deny」，错误文案是泛化的
   * `tool not allowed in this skiff` ⇒ **症状看起来像"没权限"，实际是名字没跟上**。
   */
  const RETIRED = ['container_trajectory', 'trajectory', 'logbook'] as const

  /**
   * 找 CCC 根：本仓的 `.opencode/serenity.json` 在插件仓的**上两级**（AI_LAB/<repo>/）。
   * ⚠️ **不能直接 `listSkiffProfiles(process.cwd())`** —— vitest 的 cwd 是插件仓根，
   * 那里没有 `AGENT_SESSIONS/` ⇒ 恒读不到约束面（本轮实测：这条判据因此假红过一次）。
   *
   * ⚠️ 2026-10-19 起**扫的对象换了**：旧模型扫 `serenity.json` 的 `skiff.roles`（该段已退役），
   * 新模型扫**真实轨迹目录下的 `skiff.json`**（判据 = 有该文件的认知轨迹就是 skiff）。
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

  it('🔴 本 CCC 没有任何 skiff 约束面把退役旧名写进 tools 白名单（改名的漏网会在这里现形）', () => {
    const ccc = findCccRoot()
    // 前提缺失 ⇒ **明确 skip**，不写成"通过"（空断言是本轨反复踩过的假绿来源）
    if (ccc === null) {
      expect(ccc, '找不到带 .opencode/serenity.json 的 CCC 根 —— 本件前提缺失').toBeNull()
      return
    }
    const profiles = listSkiffProfiles(ccc)
    // ⚠️ 换了判据载体之后**多一种前提缺失**：CCC 找到了，但一条 `skiff.json` 都还没有
    //    （容器尚未迁到新判据）⇒ 扫的是空集 = 假绿。明确 skip，别让它长成"通过"。
    if (profiles.length === 0) {
      expect(profiles, `CCC ${ccc} 下没有任何轨迹的 skiff.json —— 本件前提缺失（容器尚未迁移到 skiff.json 判据）`).toEqual([])
      return
    }
    const offenders: string[] = []
    for (const p of profiles) {
      for (const t of p.tools) if ((RETIRED as readonly string[]).includes(t)) offenders.push(`${p.code}(${p.dirName}).tools: ${t}`)
    }
    expect(offenders, `以下约束面仍写着退役旧名：${offenders.join(', ')}`).toEqual([])
  })
})
