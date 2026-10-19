/**
 * skiff-admin.test.ts — `container_admin role` 域（guide / validate / list / apply）
 *
 * 🔴 **2026-10-19 skiff 重做后的夹具形态**（owner 重做令：skiff = 目录下有 `skiff.json` 的认知轨迹）：
 * 旧夹具到处写 `serenity.json` 的 `skiff.roles.<name>`，而那一段**已退役** ⇒ 旧形状写出来
 * `listSkiffProfiles` 读到的仍然是空 ⇒ 用例会以"白名单不生效"的形式集体变红，而每处红的表面
 * 原因看起来都不一样。
 *
 * ⇒ 统一走 `tests/helpers/skiff-fixture.ts`（本仓造 skiff 轨迹的单一入口）：测试只描述**意图**
 * （哪条轨迹、什么约束），不重复描述载体。
 * `serenity.json` 在本文件**只剩一个用途**：`cheap-worker.models`（模型白名单校验的数据源）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// dsh-tools 运行时不可解析（peerDep）——mock defineTool 返回 opts（与 register.test.ts 同款）
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))

import { SKIFF_GUIDE, validateSkiffConfig, listSkiffRoles, applySkiffConfig } from '../src/tools/skiff-admin.js'
import { makeTrajectory, skiffJson } from './helpers/skiff-fixture.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-admin-'))
  // 需求⑤a：注册表单级化——cccName（.serenity 首行）= test → 聚合档 .opencode/skills/test/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 写 CCC 配置（**仅** cheap-worker 模型白名单；skiff 约束面已不在这里，见文件头） */
function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

function writeRegistry(entries: Array<{ name: string; path: string }>): void {
  // 需求⑤a：写入 cccName 聚合档（原 root 级 mech-registry.json 已废弃）
  const refs = join(dir, '.opencode', 'skills', 'test', 'references')
  mkdirSync(refs, { recursive: true })
  writeFileSync(
    join(refs, 'mech-registry.json'),
    JSON.stringify({ version: 1, description: 'test', entries: entries.map((e) => ({ ...e, skill: 'x', category: 'mech', description: 'd', usage: 'u', flags: [] })) }, null, 2),
  )
}

describe('skiff 角色逻辑（skiff-admin.ts——v1.30 起归 container_admin role 域）: guide 定义教程', () => {
  it('含一条判据/目录形态/schema/双白名单/纪律缺省/微信路由/调试页', () => {
    // ① 标题（重做后带日期标记）
    expect(SKIFF_GUIDE).toContain('Skiff Guide (2026-10-19 redesigned)')

    // ② 一条判据取代"角色表"——旧断言 `'任意子集角色'` 的**新等价**：
    //    "任意一条带 skiff.json 的轨迹"＋删文件即当场退化（两种语义都在这一句里）
    expect(SKIFF_GUIDE).toContain('A skiff IS a cognitive trajectory')
    expect(SKIFF_GUIDE).toContain('That is the whole rule. No role table, no name registry')
    expect(SKIFF_GUIDE).toContain('delete it and it goes back to being an ordinary trajectory (takes effect at once)')

    // ③ 轨迹目录形态：身份 = 固定位置的编码（不是角色名）
    expect(SKIFF_GUIDE).toContain('AGENT_SESSIONS/<YYYY-MM-DD--<code>--<desc>>/')
    expect(SKIFF_GUIDE).toContain('SESSION.md      ← its persistent body')

    // ④ schema 五个字段（旧断言 '"msms"/"tools"/"cognitiveTrajectory"/"systemPrompt"' 全部保留）
    expect(SKIFF_GUIDE).toContain('"model"')
    expect(SKIFF_GUIDE).toContain('"msms"')
    expect(SKIFF_GUIDE).toContain('"tools"')
    expect(SKIFF_GUIDE).toContain('"cognitiveTrajectory"')
    expect(SKIFF_GUIDE).toContain('"systemPromptFile"')
    expect(SKIFF_GUIDE).toContain('"systemPrompt"')
    expect(SKIFF_GUIDE).toContain('systemPromptFile wins when both are set')

    // ⑤ 双白名单都默认拒（schema 行就写明 register/deregister 必拒）
    expect(SKIFF_GUIDE).toContain('Two whitelists, both default-deny')
    expect(SKIFF_GUIDE).toContain('register/deregister always refused')

    // 🔴 纪律缺省翻成 **true**（工作台就是这条轨迹自己的身体）——本次重做的语义翻转之一，必须在教程里写明
    expect(SKIFF_GUIDE).toContain('all default to true')
    expect(SKIFF_GUIDE).toContain('cut it off from')

    // ⑥ 提示词路径相对 CCC 根（旧断言 `SERENITY_ROOT` 的新等价：相对基准写在教程里）
    expect(SKIFF_GUIDE).toContain('relative to CCC root')

    // ⑦ 旧断言 `'qa-readonly' / 'code-review'` 的新等价 = **路由与反例**（示例角色名不再出现在 ACC 里，
    //    但"无 skiff.json 的轨迹仍是合法路由目标"这条边界必须有）
    expect(SKIFF_GUIDE).toContain('WeChat routing: user → trajectory code')
    expect(SKIFF_GUIDE).toContain('is still a legal target')

    // ⑧ 生效机制（热读、不重启）
    expect(SKIFF_GUIDE).toContain('takes effect on the next turn, no restart')
    expect(SKIFF_GUIDE).toContain('container_admin role apply')

    // ⑨ 调试页端口
    expect(SKIFF_GUIDE).toContain('debugPort')

    // 🔴 负向钉：ACP 那一节在本次重做里**整节删除**（旧断言是"退役后改为指向官方 ACP"）。
    //    现在形态不是改指向，而是不再提 ⇒ 钉住"不得回潮"，否则指南会开始推荐一个已不存在的能力。
    expect(SKIFF_GUIDE).not.toContain('dsh --profile acp')
  })
})

describe('skiff 角色逻辑（v1.30 起归 container_admin role 域）: validateSkiffConfig 配置校验', () => {
  it('无 skiff 轨迹 → ok（skiff disabled 零影响）', () => {
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect((r as { roleCount: number }).roleCount).toBe(0)
    expect((r as { note: string }).note).toContain('no skiff trajectories in this CCC')
  })

  it('合法配置 → ok', () => {
    writeConfig({ 'cheap-worker': { models: ['m/M3'] } })
    makeTrajectory(dir, 'qa-readonly', skiffJson({
      msms: ['cognitive-qa'],
      tools: [],
      systemPrompt: '你是宁静号的认知问答助手。',
    }))
    writeRegistry([{ name: 'cognitive-qa', path: '.opencode/skills/home-serenity/scripts/cognitive-qa.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
    expect((r as { roleCount: number }).roleCount).toBe(1)
  })

  it('msms 未注册 → 问题清单', () => {
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['ghost-msm'], systemPrompt: 'p' }))
    writeRegistry([])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    // 🔴 问题串现在带**轨迹编码**前缀（旧版没有身份前缀）——一起断言，防止"知道有问题但不知道是哪条"
    expect(r.issues.some((i: string) => i.includes('trajectory "qa"') && i.includes('ghost-msm') && i.includes('not registered'))).toBe(true)
  })

  it('model 不在 cheap-worker.models → 问题清单', () => {
    writeConfig({ 'cheap-worker': { models: ['m/M3'] } })
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'], model: 'other/model', systemPrompt: 'p' }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('trajectory "qa"') && i.includes('other/model') && i.includes('not in cheap-worker.models'))).toBe(true)
  })

  it('无任何章程（既无 PROMPT.md 也无旧字段）→ 问题清单', () => {
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'] }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    // 🔴 v1.72.0：文案从「system prompt is empty」改为点名两条来源之一
    //    （PROMPT.md 是新形态、旧字段是兼容期）——断言跟语义走，别钉死措辞。
    expect(r.issues.some((i: string) => i.includes('no trajectory prompt'))).toBe(true)
    expect(r.issues.some((i: string) => i.includes('PROMPT.md'))).toBe(true)
  })

  it('🔴 只写 PROMPT.md（无旧字段）⇒ **不报**缺章程（新形态正控）', () => {
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'] }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const trajDir = readdirSync(join(dir, 'AGENT_SESSIONS')).find((n) => n.includes('--qa'))
    writeFileSync(join(dir, 'AGENT_SESSIONS', trajDir!, 'PROMPT.md'), '我是这条轨迹。')
    const r = validateSkiffConfig(dir)
    expect(r.issues.some((i: string) => i.includes('trajectory prompt'))).toBe(false)
  })

  it('systemPromptFile 缺失 → 问题清单（v1.25.10 md 文件引用）', () => {
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'], systemPromptFile: '.opencode/skiff/missing.md' }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i: string) => i.includes('trajectory "qa"') && i.includes('not found'))).toBe(true)
  })

  it('systemPromptFile 合法（存在 + 非空）→ ok（推荐配置方法）', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '文件版完整提示词')
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'], systemPromptFile: '.opencode/skiff/qa.md' }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = validateSkiffConfig(dir)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })
})

describe('skiff 角色逻辑（v1.30 起归 container_admin role 域）: listSkiffRoles 角色摘要', () => {
  it('无 skiff 轨迹 → note', () => {
    const r = listSkiffRoles(dir) as { roles: unknown[]; note: string }
    expect(r.roles).toEqual([])
    expect(r.note).toContain('no skiff trajectories in this CCC')
    expect(r.note).toContain('no trajectory has skiff.json')
  })

  it('有轨迹 → 摘要（编码/目录/模型/msms/tools/纪律/提示词来源）', () => {
    writeConfig({ 'cheap-worker': { models: ['m/M3'] } })
    makeTrajectory(dir, 'qa-readonly', skiffJson({ msms: ['cognitive-qa'], tools: [] }))
    makeTrajectory(dir, 'review', skiffJson({
      msms: ['review-scan'],
      tools: ['read', 'grep'],
      cognitiveTrajectory: { keeper: true, session: false },
      systemPrompt: 'p',
    }))
    const r = listSkiffRoles(dir) as { roles: Array<Record<string, unknown>>; count: number }
    expect(r.count).toBe(2)
    // 🔴 `name` 键名保留（消费方形状不变），但值 = **轨迹编码**（新模型里的身份）
    const qa = r.roles.find((x) => x.name === 'qa-readonly')!
    expect(qa.model).toBe('(cheap-worker default)')
    expect(qa.msms).toEqual(['cognitive-qa'])
    expect(qa.tools).toEqual([])
    // 🔴 纪律缺省翻成全 true（旧版缺省全 false）——摘要必须展示**生效值**，不是声明值
    expect(qa.cognitiveTrajectory).toEqual({ session: true, keeper: true, rebuild: true })
    expect(qa.promptSource).toBe('none')
    const review = r.roles.find((x) => x.name === 'review')!
    expect(review.tools).toEqual(['read', 'grep'])
    // 显式子集逐项生效：关掉的那项 false，没写的 keeper 仍为 true
    expect(review.cognitiveTrajectory).toEqual({ session: false, keeper: true, rebuild: true })
    expect(review.promptSource).toBe('inline')
    // 轨迹目录名也带出来（调试"这个编码对应哪条轨迹"）
    expect(String(review.dirName)).toContain('--review--')
  })

  it('有轨迹（systemPromptFile）→ promptSource=file + 文件路径展示（v1.25.10）', () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '提示词')
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'], systemPromptFile: '.opencode/skiff/qa.md' }))
    const r = listSkiffRoles(dir) as { roles: Array<Record<string, unknown>>; count: number }
    expect(r.count).toBe(1)
    const qa = r.roles[0]!
    expect(qa.name).toBe('qa')
    expect(qa.promptSource).toBe('file')
    expect(qa.systemPromptFile).toBe('.opencode/skiff/qa.md')
  })
})

describe('skiff 角色逻辑（v1.30 起归 container_admin role 域）: applySkiffConfig 显式生效机制（v1.25.3）', () => {
  it('合法配置 → applied true + 绑定 CCC + 轨迹编码清单', () => {
    writeConfig({ 'cheap-worker': { models: ['m/M3'] } })
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['x'], tools: ['read'], systemPrompt: 'p' }))
    writeRegistry([{ name: 'x', path: 'scripts/x.ts' }])
    const r = applySkiffConfig(dir) as { applied: boolean; cccRoot: string; roleCount: number; roles: string[]; note: string }
    expect(r.applied).toBe(true)
    expect(r.cccRoot).toBe(dir)
    expect(r.roleCount).toBe(1)
    // 清单值 = 轨迹编码（不再是"角色名"——那个概念已不存在）
    expect(r.roles).toEqual(['qa'])
    expect(r.note).toContain('read live')
  })

  it('非法配置 → applied false + 问题清单 + 修复提示（不应用）', () => {
    makeTrajectory(dir, 'qa', skiffJson({ msms: ['ghost-msm'] }))
    writeRegistry([])
    const r = applySkiffConfig(dir) as { applied: boolean; issues: string[]; hint: string; roleCount: number }
    expect(r.applied).toBe(false)
    expect(r.roleCount).toBe(1)
    expect(r.issues.some((i: string) => i.includes('ghost-msm'))).toBe(true)
    expect(r.issues.some((i: string) => i.includes('no trajectory prompt'))).toBe(true)
    expect(r.hint).toContain('fix the issues')
  })

  it('无 skiff 轨迹 → applied true（skiff disabled 零影响）', () => {
    const r = applySkiffConfig(dir) as { applied: boolean; roleCount: number }
    expect(r.applied).toBe(true)
    expect(r.roleCount).toBe(0)
  })
})
