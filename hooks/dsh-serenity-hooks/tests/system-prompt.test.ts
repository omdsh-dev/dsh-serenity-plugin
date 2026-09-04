import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  entrySkillSectionText,
  registerEntrySkillSectionGlobal,
  serenitySystemPrompt,
  identityBlock,
  toolsBlock,
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

describe('system-prompt: 结构注入（需求③：ACC身份→Metaphor→Principles→CCE→EAP→SKILL→Tools→Session）', () => {
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

  it('身份块：CCC 名/版本 + 平台工具说明，不含工具清单（需求③：工具清单移出 toolsBlock）', () => {
    const block = identityBlock(dir)
    expect(block).toContain(`ACC: dsh-serenity-hooks v${ACC_VERSION}`)
    expect(block).toContain(`CCC: sp-`)
    expect(block).not.toContain(`Root: ${dir}`) // v1.19.6：Root 唯一真相源 = Constraints 块
    // 需求③：身份块不再内嵌工具清单
    for (const tool of ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'handyman']) {
      expect(block).not.toMatch(new RegExp(`^  ${tool} `, 'm'))
    }
    // EAP 优化 #2：说明平台工具仍可用（关系方向明确）
    expect(block).toContain('DSH platform tools remain available')
    expect(block).toContain('read/write/edit/glob/grep')
    // 指引指向文末 Tools 块（heading 短语，非完整头——避免干扰块序 indexOf 定位）
    expect(block).toContain('"Serenity Tools" heading')
  })

  it('toolsBlock：13 工具清单 + MSM 调用示例（需求③：独立块放 SKILL 后 Session 前）', () => {
    const block = toolsBlock()
    expect(block).toContain('=== Serenity Tools ===')
    for (const tool of ['cc_fs', 'session', 'acc_kit', 'cc_git', 'acc_msm', 'eap', 'neat', 'cce', 'handyman', 'session_rebuild', 'localstore', 'skiff_admin', 'autopilot-trajectory']) {
      expect(block).toContain(tool)
    }
    // MSM 调用协议示例（3 步：list 发现 / --schema 1 查用法 / exec 执行）
    expect(block).toContain('MSM call protocol')
    expect(block).toContain('acc_msm list')
    expect(block).toContain('--schema 1')
    expect(block).toContain('acc_msm exec <name> <args...>')
    expect(block).toContain('never edit mech-registry.json directly')
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

  it('全局注册：Skiff 会话（session id `skiff-` 前缀）→ 空（角色 CCC 提示词全替换，F4b 旁路）', () => {
    let captured: { name: string; order: number; text: unknown } | null = null
    const fakeCtx = {
      systemPrompt: {
        section: (section: { name: string; order: number; text: unknown }) => {
          captured = section
        },
      },
    }
    registerEntrySkillSectionGlobal(fakeCtx as never)
    setupCccWithSkill('tg-serenity')
    const ctxSkiff = { agent: { session: { id: 'skiff-qa-readonly-uuid', header: { cwd: dir } } } }
    expect((captured!.text as (c: unknown) => string)(ctxSkiff)).toBe('')
    // 对照：普通会话仍注入
    const ctxNormal = { agent: { session: { id: 'main-1', header: { cwd: dir } } } }
    expect((captured!.text as (c: unknown) => string)(ctxNormal)).toContain('=== Serenity ACC ===')
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
  it('eapBlock 含 E↑/R↓/S↑ 自检三行（v1.23.0 英化）', () => {
    const block = eapBlock()
    expect(block).toContain('=== Serenity EAP ===')
    expect(block).toContain('E↑ Explicit')
    expect(block).toContain('R↓ Reconstructable')
    expect(block).toContain('S↑ Stable')
    expect(block).toContain('external reconstructability')
  })

  it('serenitySystemPrompt 块序 ACC→Metaphor→Principles→CCE→EAP→SKILL→Tools→Session（需求③）', () => {
    setupCccWithSkill('tg-serenity')
    const text = serenitySystemPrompt(dir)
    const acc = text.indexOf('=== Serenity ACC ===')
    const meta = text.indexOf('=== Serenity Metaphor ===')
    const pri = text.indexOf('=== Serenity Principles ===')
    const cce = text.indexOf('=== Serenity CCE ===')
    const eap = text.indexOf('=== Serenity EAP ===')
    const skill = text.indexOf('顶层入口原文内容')
    const tools = text.indexOf('=== Serenity Tools ===')
    expect(acc).toBeGreaterThanOrEqual(0)
    expect(acc).toBeLessThan(meta)
    expect(meta).toBeLessThan(pri)
    expect(pri).toBeLessThan(cce)
    expect(cce).toBeLessThan(eap)
    expect(eap).toBeLessThan(skill)
    // 需求③：Tools 块在 SKILL 后（无 Session 时它接近文末）
    expect(tools).toBeGreaterThan(skill)
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

describe('v1.23.1 persona 彩蛋（装配替换，SERENITY_HOOKS_CONFIG 注入全局文件）', () => {
  let cfgPath: string
  let oldEnv: string | undefined

  beforeEach(() => {
    cfgPath = join(dir, 'serenity-hooks.json')
    oldEnv = process.env.SERENITY_HOOKS_CONFIG
    process.env.SERENITY_HOOKS_CONFIG = cfgPath
  })

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
    else process.env.SERENITY_HOOKS_CONFIG = oldEnv
  })

  it('personaBlock：mode+文本齐 → Persona 块；mode 空 → 空串', async () => {
    const { personaBlock } = await import('../src/seams/system-prompt.js')
    const on = personaBlock('大肥鱼', 'You are a big fat fish.\nLazy but correct.')
    expect(on).toContain('=== Serenity Persona ===')
    expect(on).toContain('big fat fish')
    expect(on).not.toContain('=== Serenity EAP ===')
    expect(personaBlock('', 'text')).toBe('')
    expect(personaBlock('mode', '   ')).toBe('')
  })

  it('未配置 → 与默认逐字节一致（零影响）：含 EAP 块 + MSM 原则段', async () => {
    const { serenitySystemPrompt } = await import('../src/seams/system-prompt.js')
    const text = serenitySystemPrompt(dir)
    expect(text).toContain('=== Serenity EAP ===')
    expect(text).toContain('E↑ Explicit')
    expect(text).toContain('MSM principles')
    expect(text).toContain('Determinism first')
    expect(text).not.toContain('=== Serenity Persona ===')
  })

  it('配置 → EAP 块替换为 Persona 块 + MSM 原则段剥离（安全边界保留）', async () => {
    writeFileSync(cfgPath, JSON.stringify({ persona: { mode: '大肥鱼', overrideText: 'You are a big fat fish.' } }))
    const { serenitySystemPrompt } = await import('../src/seams/system-prompt.js')
    const text = serenitySystemPrompt(dir)
    // Persona 块出现、EAP 块消失
    expect(text).toContain('=== Serenity Persona ===')
    expect(text).toContain('big fat fish')
    expect(text).not.toContain('=== Serenity EAP ===')
    // MSM 原则段剥离（指令遵循约束被 persona 承接）
    expect(text).not.toContain('MSM principles')
    expect(text).not.toContain('Determinism first')
    // 安全硬约束永远保留：本体论 / 关系段 / 操作边界 / CCE
    expect(text).toContain('Why a cognitive container')
    expect(text).toContain('The session-trajectory relation')
    expect(text).toContain('Operational boundaries:')
    expect(text).toContain('File access')
    expect(text).toContain('=== Serenity CCE ===')
    // 装配位置：Persona 在 CCE 之后（EAP 原位）
    expect(text.indexOf('=== Serenity CCE ===')).toBeLessThan(text.indexOf('=== Serenity Persona ==='))
  })

  it('principlesBlock(omitMsmPrinciples) 纯函数：剥离 MSM 段但保留其余', async () => {
    const { principlesBlock } = await import('../src/seams/system-prompt.js')
    const full = principlesBlock(dir, false)
    const omitted = principlesBlock(dir, true)
    expect(full).toContain('MSM principles')
    expect(omitted).not.toContain('MSM principles')
    expect(omitted).toContain('Why a cognitive container')
    expect(omitted).toContain('Operational boundaries:')
    expect(omitted).toContain('Session-first')
  })
})
