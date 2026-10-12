/**
 * skill-layering.test.ts — **A3 分层抽象树档**的判据
 *
 * 🔴 两条纪律（都来自本仓的付学费记录）：
 *  ① **正控 ＋ 负控成对**：只证"抓到了"不够，还要证"该放过的放过了"（否则一个恒真的判据也能全绿）。
 *  ② **真实输入件（D119 教训）**：「合成 fixture 通过」≠「在真实输入上通过」⇒ 末组用例直接跑
 *     真实 CCC 的 38 个 skill（含 CCC 根守卫：定位不到就**响亮失败**，不静默跳过）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  analyzeSkillLayering,
  formatLayeringReport,
  listReferenceDocs,
  TOP_LAYER_MIN_BYTES,
} from '../src/skills/skill-layering.js'

/** 自本文件上溯，找最近的「含 `.opencode/skills`」的祖先（= CCC 根）；ACC 仓独立克隆时返回 undefined */
function findCccRoot(start: string): string | undefined {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.opencode', 'skills'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const CCC_ROOT = findCccRoot(__dirname)
const SKILLS = CCC_ROOT ? join(CCC_ROOT, '.opencode', 'skills') : ''

/** 顶层正文够厚的一段（≥ 下限；内容本身不重要，长度是判据） */
function fatTop(extra = ''): string {
  return `---\nname: demo\ndescription: demo\n---\n\n# Skill: demo\n\n## 1. 身份与边界\n\n本 skill 管 demo。\n\n${'顶层陈述。'.repeat(400)}\n${extra}`
}

function makeSkill(md: string, refs: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'sk-layering-'))
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')
  if (Object.keys(refs).length > 0) {
    mkdirSync(join(dir, 'references'), { recursive: true })
    for (const [name, body] of Object.entries(refs)) {
      writeFileSync(join(dir, 'references', name), body, 'utf-8')
    }
  }
  return dir
}

describe('A3 分层抽象树档', () => {
  it('A3-1 负控：顶层够厚 ⇒ 不报；且顶层正文按 B 计', () => {
    const dir = makeSkill(fatTop())
    try {
      const r = analyzeSkillLayering(dir)
      expect(r.findings.map((f) => f.code)).not.toContain('A3-1')
      expect(r.topBodyBytes).toBeGreaterThanOrEqual(TOP_LAYER_MIN_BYTES)
      expect(r.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3-1 正控：顶层是桩（只列文件名）⇒ 必须报', () => {
    const dir = makeSkill('---\nname: demo\n---\n\n# Skill: demo\n\n- references/00-a.md\n- references/10-b.md\n')
    try {
      const r = analyzeSkillLayering(dir)
      expect(r.findings.map((f) => f.code)).toContain('A3-1')
      expect(r.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3-2 正控：顶层自称"只是导航层"（= 本次事故形态）⇒ 必须报并回显原文', () => {
    const dir = makeSkill(fatTop('\n> 🔴 **本文件只是导航层**：细节在下列文件里。\n'))
    try {
      const r = analyzeSkillLayering(dir)
      expect(r.findings.map((f) => f.code)).toContain('A3-2')
      expect(r.navSelfDescriptions.length).toBe(1)
      expect(r.navSelfDescriptions[0]).toContain('导航层')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3-2 负控：说"细节在 references/"但**不自述为导航层** ⇒ 不报', () => {
    const dir = makeSkill(fatTop('\n> 细节按 §5 的树按需 read `references/` 各子树。\n'))
    try {
      expect(analyzeSkillLayering(dir).findings.map((f) => f.code)).not.toContain('A3-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3-3 正控/负控：references 下的 .md 未被点名 ⇒ 报；点名后 ⇒ 不报', () => {
    const refs = { '00-a.md': '# A\n', '10-b.md': '# B\n' }
    const bad = makeSkill(fatTop('\n（只提了 references/00-a.md）\n'), refs)
    const good = makeSkill(fatTop('\n见 references/00-a.md 与 references/10-b.md\n'), refs)
    try {
      const rb = analyzeSkillLayering(bad)
      expect(rb.referenceDocs).toEqual(['00-a.md', '10-b.md'])
      expect(rb.notNamedInTop).toEqual(['10-b.md'])
      expect(rb.findings.map((f) => f.code)).toContain('A3-3')
      expect(analyzeSkillLayering(good).notNamedInTop).toEqual([])
    } finally {
      rmSync(bad, { recursive: true, force: true })
      rmSync(good, { recursive: true, force: true })
    }
  })

  it('生成的导航块与 frontmatter **不计入**顶层正文（判据扣的是生成物，不是作者的话）', () => {
    const bare = makeSkill(fatTop())
    const withNav = makeSkill(
      `${fatTop()}\n<!-- skill-lint:split-nav -->\n### 第二层\n${'| `references/x.md` | x |\n'.repeat(60)}<!-- /skill-lint:split-nav -->\n`,
    )
    try {
      const a = analyzeSkillLayering(bare)
      const b = analyzeSkillLayering(withNav)
      expect(b.topBodyBytes).toBe(a.topBodyBytes)
      expect(b.navBlockBytes).toBeGreaterThan(0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
      rmSync(withNav, { recursive: true, force: true })
    }
  })

  it('没有 SKILL.md ⇒ A3-1，且报告不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-layering-'))
    try {
      const r = analyzeSkillLayering(dir)
      expect(r.hasSkillMd).toBe(false)
      expect(r.findings.map((f) => f.code)).toEqual(['A3-1'])
      expect(listReferenceDocs(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('渲染：通过/不通过两种文案都带可行动指引', () => {
    const dir = makeSkill('---\nname: demo\n---\n\n# Skill: demo\n\n- references/a.md\n')
    try {
      const out = formatLayeringReport('demo', analyzeSkillLayering(dir))
      expect(out).toContain('❌ A3 分层档')
      expect(out).toContain('guide')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('A3 · 真实输入件（CCC 的 38 个 skill）', () => {
  it('CCC 根必须可定位（定位不到 = 响亮失败，不许静默跳过）', () => {
    expect(CCC_ROOT, `CCC_ROOT=${CCC_ROOT}（本用例在 CCC 内运行时应可定位）`).toBeTruthy()
  })

  it('真实语料上：探测器不瞎（确实扫到了参考件）＋ dsp skill 自身通过（回归钉）', () => {
    const names = readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(SKILLS, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort()
    expect(names.length).toBeGreaterThan(0)

    const reports = names.map((n) => ({ name: n, r: analyzeSkillLayering(join(SKILLS, n)) }))

    // 正控（探针不瞎）：真实语料里必须真的扫到参考件
    const withRefs = reports.filter((x) => x.r.referenceDocs.length > 0)
    expect(withRefs.length).toBeGreaterThan(0)

    // 回归钉：刚做完"顶层归位"的 dsp skill 必须过 A3（它若再退化成导航桩，本行红）
    const dsp = reports.find((x) => x.name === 'dsh-serenity-plugin-development')
    expect(dsp, '真实语料里应含 dsh-serenity-plugin-development').toBeTruthy()
    expect(dsp!.r.ok, `dsp A3 findings=${JSON.stringify(dsp!.r.findings)}`).toBe(true)

    // 存量一览（**只印不断言**：先量存量、再谈当不当门 —— 数字会随各 skill 演进）
    const fail = reports.filter((x) => !x.r.ok)
    console.log(
      `[A3 存量] 共 ${reports.length} 个 skill：通过 ${reports.length - fail.length}，未过 ${fail.length}`
        + (fail.length > 0 ? ` → ${fail.map((x) => `${x.name}(${x.r.findings.map((f) => f.code).join('/')})`).join(', ')}` : ''),
    )
  })
})
