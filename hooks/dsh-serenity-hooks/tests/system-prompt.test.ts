import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  entrySkillSectionText,
  registerEntrySkillSectionGlobal,
  serenitySystemPrompt,
  accBlock,
  cceBlock,
  principlesBlock,
  eapBlock,
  safeModeBlock,
  localstoreBlock,
  codeModeAdaptationLine,
} from '../src/seams/system-prompt.js'
import { ACC_VERSION } from '../src/constants.js'

let dir: string

/** 建立 CCC：.serenity 记号 = tg-serenity（仿 tiangong-serenity），含顶层 skill */
function setupCccWithSkill(skillName = 'tg-serenity', skillBody = '顶层入口原文内容'): void {
  writeFileSync(join(dir, '.serenity'), skillName)
  mkdirSync(join(dir, '.opencode', 'skills', skillName), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: 系统入口\n---\n${skillBody}`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('system-prompt: 入口 skill 发现（.serenity 记号 = 顶层入口名）', () => {
  it('无入口返回空', () => {
    expect(entrySkillSectionText(dir)).toBe('')
  })

  it('按 .serenity 记号内容发现顶层 skill（tg-serenity）', () => {
    setupCccWithSkill('tg-serenity')
    const text = entrySkillSectionText(dir)
    // 对齐 osp：注入 SKILL.md 原文（含 frontmatter），无包裹头
    expect(text).toContain('顶层入口原文内容')
    expect(text).toContain('---\nname: tg-serenity')
    expect(text).not.toContain('# CCC 入口技能')
  })

  it('自动扫描 .opencode/skills/*-serenity 兜底（记号无匹配 skill 时）', () => {
    // .serenity 内容不是合法 skill 名（找不到对应 SKILL.md）→ 走扫描兜底
    writeFileSync(join(dir, '.serenity'), 'no-such-skill')
    mkdirSync(join(dir, '.opencode', 'skills', 'home-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-serenity', 'SKILL.md'), '---\nname: home-serenity\ndescription: 系统入口\n---\n系统入口原文内容')
    const text = entrySkillSectionText(dir)
    expect(text).toContain('系统入口原文内容')
    expect(text).not.toContain('# CCC 入口技能')
  })
})

describe('system-prompt: 结构注入（v1.19.8：ACC→Metaphor→Principles→CCE→EAP→SKILL）', () => {
  it('serenitySystemPrompt 含 ACC/Metaphor/Principles/CCE/EAP/SKILL 全文', () => {
    setupCccWithSkill('tg-serenity')
    const text = serenitySystemPrompt(dir)
    expect(text).toContain('=== Serenity ACC ===')
    expect(text).toContain('=== Serenity Metaphor ===')
    expect(text).toContain('=== Serenity Principles ===')
    expect(text).toContain('=== Serenity CCE ===')
    expect(text).toContain('=== Serenity EAP ===')
    expect(text).toContain('顶层入口原文内容')
    // v1.19.8：独立 Constraints 块已并入 Principles（不再单独存在）
    expect(text).not.toContain('=== Serenity Constraints ===')
  })

  it('ACC 块：CCC 名/版本/工具清单 + 平台工具说明（Root 边界归 Constraints 块，v1.19.6 去重）', () => {
    const block = accBlock(dir)
    expect(block).toContain(`ACC: dsh-serenity-hooks v${ACC_VERSION}`)
    expect(block).toContain(`CCC: sp-`)
    expect(block).not.toContain(`Root: ${dir}`) // v1.19.6：Root 唯一真相源 = Constraints 块
    for (const tool of ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'loop']) {
      expect(block).toContain(tool)
    }
    // EAP 优化 #2：说明平台工具仍可用（关系方向明确）
    expect(block).toContain('DSH platform tools remain available')
    expect(block).toContain('read/write/edit/glob/grep')
  })

  it('CCE 块：5 行为约束 + H_op（逐字对齐 osp）', () => {
    const block = cceBlock()
    expect(block).toContain('FIVE BEHAVIORAL CONSTRAINTS')
    expect(block).toContain('1. Continuity')
    expect(block).toContain('2. Bounded Space')
    expect(block).toContain('3. Entropy is Intrinsic')
    expect(block).toContain('4. Reconstruction > Preservation')
    expect(block).toContain('5. Multi-Agent Cognition')
    expect(block).toContain('OPERATIONAL ENTROPY')
    expect(block).toContain('H_op')
    expect(block).toContain('ΔH_org ≥ ΔH_in')
  })

  it('Principles 块（v1.19.8 合并 Constraints）：本体论 + MSM 原则 + Root/文件/shell/subagent/session-first', () => {
    const block = principlesBlock(dir)
    // 认知容器本体论
    expect(block).toContain('Why a cognitive container')
    expect(block).toContain('contains no errors')
    // MSM 原则（v1.19.9）
    expect(block).toContain('MSM principles')
    expect(block).toContain('Determinism first')
    expect(block).toContain('Single source of truth')
    expect(block).toContain('Registered to act')
    // 操作边界（原 Constraints 内容）
    expect(block).toContain(`Root: ${dir}`)
    expect(block).toContain('File access')
    expect(block).toContain('Shell')
    expect(block).toContain('Subagent')
    expect(block).toContain('Session-first')
  })
})

describe('system-prompt: 全局 section 注册（任何会话自动注入）', () => {
  it('全局注册：text 回调按 context.agent 的 cwd 解析 CCC → 返回完整注入文本', () => {
    let captured: { name: string; order: number; text: unknown } | null = null
    const fakeCtx = {
      systemPrompt: {
        section: (section: { name: string; order: number; text: unknown }) => {
          captured = section
        },
      },
    }
    registerEntrySkillSectionGlobal(fakeCtx as never)

    expect(captured).not.toBeNull()
    expect(captured!.name).toBe('serenity-entry')
    expect(captured!.order).toBe(-50)

    // 非 CCC cwd → 空
    const ctxNoCcc = { agent: { session: { header: { cwd: '/tmp' } } } }
    expect((captured!.text as (c: unknown) => string)(ctxNoCcc)).toBe('')

    // CCC cwd → 完整注入（ACC + CCE + Constraints + skill 全文）
    setupCccWithSkill('tg-serenity')
    const ctxCcc = { agent: { session: { header: { cwd: join(dir, 'sub') } } } }
    const text = (captured!.text as (c: unknown) => string)(ctxCcc)
    expect(text).toContain('=== Serenity ACC ===')
    expect(text).toContain('顶层入口原文内容')

    // 无 agent → 空
    expect((captured!.text as (c: unknown) => string)({})).toBe('')
  })

  it('全局注册失败（重复 section 名）不抛错（try/catch 吞掉）', () => {
    const fakeCtx = {
      systemPrompt: {
        section: () => {
          throw new Error('duplicate section')
        },
      },
    }
    expect(() => registerEntrySkillSectionGlobal(fakeCtx as never)).not.toThrow()
  })
})

describe('system-prompt: EAP 块（S131 P1-6 扩展）', () => {
  it('eapBlock 含 E↑/R↓/S↑ 自检三行', () => {
    const block = eapBlock()
    expect(block).toContain('=== Serenity EAP ===')
    expect(block).toContain('E↑ 显式')
    expect(block).toContain('R↓ 可重建')
    expect(block).toContain('S↑ 稳定')
  })

  it('serenitySystemPrompt 块序 ACC→Metaphor→Principles→CCE→EAP→SKILL（v1.19.8）', () => {
    setupCccWithSkill('tg-serenity')
    const text = serenitySystemPrompt(dir)
    const acc = text.indexOf('=== Serenity ACC ===')
    const meta = text.indexOf('=== Serenity Metaphor ===')
    const pri = text.indexOf('=== Serenity Principles ===')
    const cce = text.indexOf('=== Serenity CCE ===')
    const eap = text.indexOf('=== Serenity EAP ===')
    const skill = text.indexOf('顶层入口原文内容')
    expect(acc).toBeGreaterThanOrEqual(0)
    expect(acc).toBeLessThan(meta)
    expect(meta).toBeLessThan(pri)
    expect(pri).toBeLessThan(cce)
    expect(cce).toBeLessThan(eap)
    expect(eap).toBeLessThan(skill)
  })
})

describe('system-prompt: Code Mode 适配行（S131 P0-2）', () => {
  it('run_code 可见（code|both）→ 返回引导块', () => {
    const fakeCtx = {
      tools: {
        get: (name: string) => name === 'run_code' ? { name: 'run_code' } : undefined,
      },
    }
    const line = codeModeAdaptationLine(fakeCtx as never)
    expect(line).toContain('=== Serenity Code Mode ===')
    expect(line).toContain('await tools.cc_fs')
  })

  it('native（run_code 不可见）→ 空串', () => {
    const fakeCtx = {
      tools: {
        get: () => undefined,
      },
    }
    expect(codeModeAdaptationLine(fakeCtx as never)).toBe('')
  })

  it('无 tools 服务 → 空串（try/catch 吞掉）', () => {
    expect(codeModeAdaptationLine({} as never)).toBe('')
  })
})

describe('system-prompt: 运行时状态动态块（S134 v1.16.12）', () => {
  it('safeModeBlock：ON 注入（英文，与实现对应：bash disabled / blacklist / governance files）/ OFF 空', () => {
    expect(safeModeBlock(dir)).toBe('')
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    const b = safeModeBlock(dir)
    expect(b).toContain('=== Serenity Safe Mode ===')
    expect(b).toContain('bash is disabled')
    expect(b).toContain('blacklist rules apply')
    expect(b).toContain('governance files')
    expect(b).toContain('do not attempt to bypass')
    // write/edit 保留的表述（与 guards.ts SAFE_MODE_DENY_TOOLS 只含 bash 一致；v1.19.8 重排为 Operational details）
    expect(b).toContain('other read/write tools remain available')
    expect(b).toContain('remain available')
  })

  it('safeModeBlock：黑名单规则动态列出', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ safeMode: { blacklist: ['.secrets/'] } }))
    expect(safeModeBlock(dir)).toContain('.secrets/')
  })

  it('localstoreBlock：无文件空 / deny 私有提示（缺省）', () => {
    expect(localstoreBlock(dir)).toBe('')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const b = localstoreBlock(dir)
    expect(b).toContain('=== Serenity Localstore ===')
    expect(b).toContain('local private file')
    expect(b).toContain('gitTrack=deny')
    expect(b).toContain('not committed to git')
    expect(b).toContain('do not write')
  })

  it('localstoreBlock：allow → 进 git 但敏感数据只限该文件（英文）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const b = localstoreBlock(dir)
    expect(b).toContain('committed to git')
    expect(b).toContain('gitTrack=allow')
    expect(b).toContain('ONLY in this file')
    expect(b).toContain('never leak them into other files')
  })

  it('serenitySystemPrompt 装配顺序：EAP → 状态块（ON + localstore 时）→ SKILL（v1.19.8）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const text = serenitySystemPrompt(dir)
    expect(text.indexOf('=== Serenity EAP ===')).toBeLessThan(text.indexOf('=== Serenity Safe Mode ==='))
    expect(text.indexOf('=== Serenity Safe Mode ===')).toBeLessThan(text.indexOf('=== Serenity Localstore ==='))
  })
})
