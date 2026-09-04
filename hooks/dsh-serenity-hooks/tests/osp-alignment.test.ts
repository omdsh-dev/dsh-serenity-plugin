/**
 * osp-alignment.test.ts — 系统提示词结构对齐 spec（v1.19.9 修订，S142）
 *
 * 历史：v1.19.5 前逐字节对齐 opencode-serenity-plugin v0.8.5（CCE/Constraints/Session）。
 * v1.19.6~v1.19.9 用户设计演进（去冗余/隐喻域/结构精简/MSM 约束），dsp 领先于 osp；
 * 用户验证满意后本 spec 正式化——osp 侧按本 spec 同步（opencode-serenity-plugin
 * compacting.ts system.transform，S142/S138 协作，osp 待同步）。
 *
 * 对齐契约（v1.19.9 新结构 + 需求③ Tools 块）：
 *   1. 装配顺序 — ACC(身份) → Metaphor → Principles → CCE → EAP → [SafeMode/Localstore]
 *                → SKILL → Tools → Session（需求③：工具清单独立成块放 SKILL 后 Session 前）
 *   2. CCE 块    — 与 osp 逐字节一致（无例外）；v1.19.6 删 "CCE AND EAP" 段（EAP 定义唯一
 *                  真相源 = EAP 块）→ osp 需同步删段
 *   3. Principles 块 — v1.19.8 合并原 osp Constraints 块（认知容器本体论 + MSM 原则 +
 *                  Operational boundaries；工具名平台真实名）→ osp 需同步合并
 *   4. Metaphor 块 — dsp 扩展（osp 无对应）：三层隐喻域（SHIP/VOYAGE/CREW）10 条，
 *                  提前至 ACC 后（世界模型前置）；M-1~M-4 结构约束见 docs/metaphor-domain.md
 *   5. EAP 块    — dsp 扩展（osp 无对应）
 *   6. Session 块 — 与 osp 逐字节一致（相同会话值时；DSH todowrite 无 priority 字段）
 *   7. SKILL 全文 — 原文直推（无包裹头），对齐 osp `output.system.push(state.skillContent)`
 *   8. 身份块 + Tools 块 — 结构对齐（身份行/CCC；工具清单 + MSM 调用示例独立成块——
 *                  v1.19.6 去 Root（唯一真相源 = Principles 块边界）；工具清单为平台真实工具，
 *                  允许不同；需求③ 工具参考殿后）
 *   9. 块间拼接  — 空行分隔，无 `---` 分隔线
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  identityBlock,
  toolsBlock,
  cceBlock,
  principlesBlock,
  sessionBlock,
  entrySkillSectionText,
  metaphorBlock,
  serenitySystemPrompt,
} from '../src/seams/system-prompt.js'
import { useSession, resetActiveSessionStore } from '../src/session-ops.js'
import { ACC_VERSION } from '../src/constants.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osp-al-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── osp v0.8.5 参照文本（从 compacting.ts 逐字提取，勿改）──

/** osp CCE 块（compacting.ts systemTransformImpl，逐字） */
const OSP_CCE = [
  '',
  '=== Serenity CCE ===',
  '',
  'You are operating inside a Cognitive Container governed by Cognitive Continuity',
  'Engineering (CCE) — the engineering discipline of maintaining identity, accessibility,',
  'and evolution of a cognitive entity through time under bounded resources.',
  '',
  'CCE does not optimize cognition. It preserves the conditions under which cognition',
  'can continue.',
  '',
  'FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions):',
  '',
  '1. Continuity — every interaction modifies the container\'s future state. Before',
  '   acting, consult what came before — prior decisions, abstractions, constraints.',
  '   You are part of a trajectory, not a fresh start.',
  '',
  '2. Bounded Space — the container has boundaries. Respect them. Do not assume',
  '   knowledge that has not been accumulated within this container.',
  '',
  '3. Entropy is Intrinsic — every cognitive system accumulates entropy (duplication,',
  '   obsolescence, conflict, fragmentation, drift). When you produce output, consider',
  '   whether you are adding entropy or reducing it. Favor entropy-reducing actions —',
  '   organizing, deduplicating, cross-referencing, abstracting.',
  '',
  '4. Reconstruction > Preservation — stored artifacts have value only insofar as',
  '   they enable future cognition to recover the reasoning that produced them. When',
  '   recording decisions, ensure reconstruction is possible — not just conclusions,',
  '   but rationale, alternatives considered, and constraints that shaped the choice.',
  '',
  '5. Multi-Agent Cognition — the container is shared. Continuity belongs to the',
  '   container, not to any individual agent. Write for future agents who will enter',
  '   after you leave. They should be able to pick up where you left off.',
  '',
  'OPERATIONAL ENTROPY: The container\'s health metric is operational cognitive entropy',
  '(H_op) — the excess cognitive cost for agents to complete tasks due to disorder.',
  'The container is healthy when H_op ≤ H_critical (agents can still function). The',
  'continuity condition: organization must at minimum match accumulation (ΔH_org ≥ ΔH_in).',
  'Your actions affect H_op — unorganized output increases it, organization decreases it.',
  '',
  'THIS IS PERSISTENCE ENGINEERING: The goal is not to become greater. The goal is to',
  'remain coherent. CCE has no terminal KPI — continuity is maintained while the entity',
  'exists, not optimized toward an endpoint.',
  '',
].join('\n')

/** osp Session 块模板（DSH 适配版：todowrite 首项无 priority——DSH 平台 schema 不支持，v1.17.2；v1.23.0 载体关系行 + steward 预声明——dsp 领先扩展） */
const OSP_SESSION = (sessionId: string, dirName: string, mdPath: string) => [
  '',
  '=== Serenity Session ===',
  `Active session: ${sessionId} — ${dirName} (this session is the rebuildable carrier of the trajectory)`,
  `SESSION.md path: ${mdPath} (the trajectory's persistent body — stays in place through rebuilds)`,
  '',
  'Rules:',
  '  • Record all progress into this SESSION.md',
  '  • Update the "进度记录" section after advancing work',
  '  • Reference this session in all subsequent messages',
  '',
  'IMPORTANT: Read SESSION.md now. Parse the "剩余工作" / "进度记录" /',
  '"变更日志" sections and call todowrite to synchronize the built-in todo',
  'list. Keep todos in sync with SESSION.md as work progresses.',
  '',
  'CRITICAL: When calling todowrite, the first item in the todos array MUST',
  'always be:',
  `  { content: "SESSION: ${sessionId} — ${dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')}",`,
  '    status: "completed" }',
  'This preserves the session context across todo updates.',
  'Do NOT remove or reorder this item — keep it at position 0.',
  '',
  'TRAJECTORY-STEWARD: a background tracker scores your tool use (write/edit=3,',
  'task=10, read/grep/glob/msm=1, +1 per minute) and reminds you with a',
  '[TRAJECTORY-STEWARD] message when the threshold is reached. On every such',
  'reminder you MUST reply with the exact ACK code:',
  '  [TRAJECTORY-STEWARD-recorded-{code}]  — if you recorded progress to SESSION.md',
  '  [TRAJECTORY-STEWARD-skipped-{code}]  — if nothing to record this round',
  'Do not ignore the reminder; do not stop ongoing work. Codes are single-use;',
  'never reuse a prior code.',
  '',
].join('\n')

/** 建立含顶层 skill 的 CCC */
function setupCccWithSkill(skillName = 'tg-serenity', skillBody = '顶层入口原文内容'): void {
  writeFileSync(join(dir, '.serenity'), skillName)
  mkdirSync(join(dir, '.opencode', 'skills', skillName), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: 系统入口\n---\n${skillBody}`)
}

describe('osp 对齐：CCE 块逐字节一致', () => {
  it('cceBlock() 与 osp CCE 参照完全相等', () => {
    expect(cceBlock()).toBe(OSP_CCE)
  })
})

describe('dsp 扩展：Principles 块（v1.19.8 合并原 Constraints——spec 修订：Constraints 不再独立对齐）', () => {
  it('principlesBlock() 含认知容器本体论 + Operational boundaries（Root/文件/shell/subagent/session-first）', () => {
    const block = principlesBlock(dir)
    // 本体论（认知容器：无错误只有认知不足）
    expect(block).toContain('=== Serenity Principles ===')
    expect(block).toContain('Why a cognitive container')
    expect(block).toContain('all work is cognition')
    expect(block).toContain('contains no errors')
    expect(block).toContain('not-knowing is a state to be repaired')
    // v1.23.0：session-trajectory 关系段（session = trajectory 的可重建载体）
    expect(block).toContain('The session-trajectory relation')
    expect(block).toContain('a session is the rebuildable carrier of a')
    expect(block).toContain("SESSION.md is the trajectory's persistent body")
    expect(block).toContain('Identity belongs to the trajectory')
    // 操作边界（原 Constraints 内容，工具名为平台真实名 acc_msm）
    expect(block).toContain('Operational boundaries:')
    expect(block).toContain(`Root: ${dir}`)
    expect(block).toContain('File access')
    expect(block).toContain('use acc_msm')
    expect(block).toContain('Subagent')
    expect(block).toContain('Session-first')
  })
})

describe('dsp 领先：Session 块（v1.23.0 载体关系 + steward 预声明；唯一 osp 例外 = DSH todowrite 无 priority 字段）', () => {
  it('sessionBlock() 与 DSH 适配版参照完全相等', () => {
    // 建立内存活跃会话（S134 v1.16.14 内存化：useSession 写内存 Map，不落盘）
    const dirName = '2026-08-13--S126--dsh-serenity-public-beta-adapt'
    const mdRel = join('AGENT_SESSIONS', dirName, 'SESSION.md')
    mkdirSync(join(dir, 'AGENT_SESSIONS', dirName), { recursive: true })
    writeFileSync(join(dir, mdRel), '# test')
    useSession(dir, 'S126', 'test-scope')

    const block = sessionBlock(dir, 'test-scope')
    expect(block).not.toBe('')
    expect(block).toBe(OSP_SESSION('S126', dirName, join(dir, mdRel)))
    // 同时证明：除 todowrite priority 字段外与 osp 一致（osp 版含 priority: "low"）
    const ospOriginal = OSP_SESSION('S126', dirName, join(dir, mdRel)).replace(
      '    status: "completed" }',
      '    status: "completed", priority: "low" }',
    )
    expect(block.replace('    status: "completed" }', '    status: "completed", priority: "low" }')).toBe(ospOriginal)
  })
})

describe('osp 对齐：SKILL 全文原文直推 + 装配结构', () => {
  it('entrySkillSectionText() 原文直推（含 frontmatter，无包裹头）', () => {
    setupCccWithSkill('tg-serenity', '顶层入口原文内容')
    const text = entrySkillSectionText(dir)
    expect(text).toBe('---\nname: tg-serenity\ndescription: 系统入口\n---\n顶层入口原文内容')
  })

  it('serenitySystemPrompt() 块序 ACC→Metaphor→Principles→CCE→EAP→SKILL→Tools→Session，无 --- 分隔线（需求③ Tools 放 SKILL 后 Session 前）', () => {
    setupCccWithSkill('tg-serenity')
    const dirName = '2026-08-13--S126--dsh-serenity-public-beta-adapt'
    mkdirSync(join(dir, 'AGENT_SESSIONS', dirName), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'), '# test')
    useSession(dir, 'S126', 'test-scope')

    const text = serenitySystemPrompt(dir, 'test-scope')
    const accIdx = text.indexOf('=== Serenity ACC ===')
    const metaIdx = text.indexOf('=== Serenity Metaphor ===')
    const priIdx = text.indexOf('=== Serenity Principles ===')
    const cceIdx = text.indexOf('=== Serenity CCE ===')
    const eapIdx = text.indexOf('=== Serenity EAP ===')
    const skillIdx = text.indexOf('顶层入口原文内容')
    const toolsIdx = text.indexOf('=== Serenity Tools ===')
    const sesIdx = text.indexOf('=== Serenity Session ===')
    expect(accIdx).toBeGreaterThanOrEqual(0)
    expect(metaIdx).toBeGreaterThan(accIdx)
    expect(priIdx).toBeGreaterThan(metaIdx)
    expect(cceIdx).toBeGreaterThan(priIdx)
    expect(eapIdx).toBeGreaterThan(cceIdx)
    expect(skillIdx).toBeGreaterThan(eapIdx)
    // 需求③：Tools 块在 SKILL 后、Session 前
    expect(toolsIdx).toBeGreaterThan(skillIdx)
    expect(sesIdx).toBeGreaterThan(toolsIdx)
    expect(text).not.toContain('---\n\n')
    expect(text).not.toContain('# CCC 入口技能')
  })
})

describe('osp 对齐：身份块 + Tools 块结构（工具清单独立成块，需求③）', () => {
  it('identityBlock() 含身份行/CCC/MSM 发现行，不含工具清单（Root 边界归 Constraints 块，v1.19.6 去重）', () => {
    const block = identityBlock(dir)
    expect(block).toContain(`ACC: dsh-serenity-hooks v${ACC_VERSION}`)
    expect(block).toContain(`CCC: ${dir.split('/').pop()}`)
    expect(block).not.toContain(`Root: ${dir}`) // v1.19.6：Root 唯一真相源 = Constraints 块
    expect(block).toContain('You are running inside a Concrete Cognitive Container (CCC)')
    // 身份块不再内嵌工具清单（需求③移出 toolsBlock）
    expect(block).not.toContain('cc_fs     —')
    expect(block).not.toContain('handyman  —')
    expect(block).toContain('call acc_msm list to discover them')
    // 指引指向文末 Tools 块（heading 短语，非完整头——避免干扰块序 indexOf 定位）
    expect(block).toContain('"Serenity Tools" heading')
  })

  it('toolsBlock() 含 13 工具清单 + MSM 调用示例（需求③）', () => {
    const block = toolsBlock()
    expect(block).toContain('=== Serenity Tools ===')
    for (const tool of ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'handyman', 'session_rebuild', 'localstore', 'skiff_admin', 'autopilot-trajectory']) {
      expect(block).toContain(tool)
    }
    // MSM 调用示例（3 步协议：发现/查用法/执行）
    expect(block).toContain('MSM call protocol')
    expect(block).toContain('acc_msm list')
    expect(block).toContain('--schema 1')
    expect(block).toContain('acc_msm exec <name> <args...>')
    expect(block).toContain('mech-registry.json')
  })
})

describe('dsp 扩展：Metaphor 块（v1.19.6 起，宁静号宇宙隐喻域——无 osp 对应）', () => {
  it('metaphorBlock() 三层结构 + 全英文 10 条隐喻 + 映射标注 + Verdict 判据（v1.19.9：+MSM 两条）', () => {
    const block = metaphorBlock()
    expect(block).toContain('=== Serenity Metaphor ===')
    // 三层分组（v1.19.7 结构化）
    expect(block).toContain('THE SHIP — the container itself')
    expect(block).toContain('THE VOYAGE — the cognitive lifecycle')
    expect(block).toContain('THE CREW — multi-agent collaboration')
    // World 层呼应句（v1.19.8：认知容器本体论隐喻化）
    expect(block).toContain('The Sea has no mistakes — only waters you have not yet charted.')
    // 10 条隐喻本体
    for (const name of [
      'The Hull',
      'Deck Order',
      'Engineering Drawings',
      'The Machinery',
      'The Manifest',
      'Harbor Inspection',
      'The Logbook',
      'The Ship of Theseus',
      'Crew Rotation',
      'Blueprint over Statue',
    ]) {
      expect(block).toContain(name)
    }
    // 每条含 → 约束映射（M-1）+ Verdict 判据（M-2）
    expect(block.match(/→/g)?.length).toBe(10)
    for (const constraint of ['Bounded Space', 'Entropy (H_op)', 'EAP', 'MSM (Mech & Semi-Mech)', 'Single Source of Truth', 'First Anchor', 'Session Tracking', 'Continuity', 'Multi-Agent Cognition', 'Reconstruction > Preservation']) {
      expect(block).toContain(constraint)
    }
    expect(block.match(/Verdict:/g)?.length).toBe(10)
    // 无中文（全英文）
    expect(block).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
