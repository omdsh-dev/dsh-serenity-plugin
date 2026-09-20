/**
 * trajectory-skills.test.ts — 轨迹 skill 声明与注入（规格 docs/trajectory-skill-injection.md §6 九条）
 *
 * 覆盖：解析 5 例 / 注入 3 例 / 缺 skill 提示 / 长度截断 / 🔒 路径穿越（断言 fs 未被以其名访问）/
 * 绑定来源（readLastBound 为 null、mdPath 不存在）/ 回归钉（SEP 符号在 src/** 命中 0）/
 * keeper 两条文案均含 frontmatter / 查找顺序（.dsh 优先）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/** fs 访问记录（🔒 用例用它断言"以不安全名拼出的 fs 访问未发生"） */
const h = vi.hoisted(() => ({ fs: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const rec = (p: unknown): void => {
    if (typeof p === 'string') h.fs.push(p)
  }
  return {
    ...actual,
    existsSync: (p: string) => {
      rec(p)
      return actual.existsSync(p)
    },
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      rec(p)
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
    statSync: (p: unknown, ...rest: unknown[]) => {
      rec(p)
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
    readdirSync: (p: unknown, ...rest: unknown[]) => {
      rec(p)
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
  }
})

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  parseDeclaredSkills,
  extractFrontmatter,
  buildTrajectorySkillsSection,
  hasTrajectorySkillsDeclaration,
  mergeSkillNames,
  TRAJECTORY_SKILLS_MAX_CHARS,
} from '../src/trajectory-skills.js'
import { readTrajectorySkills } from '../src/ccc.js'
import { findSkillMd } from '../src/skills-discovery.js'
import { registerTrajectorySkillSection } from '../src/seams/system-prompt.js'
import { trajectoryCompactionReminderText } from '../src/seams/keeper.js'

let dir: string
let seq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traj-skills-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  h.fs.length = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── 夹具 ──

function writeSkill(root: string, base: '.dsh' | '.opencode', name: string, content: string): void {
  mkdirSync(join(root, base, 'skills', name), { recursive: true })
  writeFileSync(join(root, base, 'skills', name, 'SKILL.md'), content)
}

function writeSession(root: string, dirName: string, md: string): string {
  const d = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(d, { recursive: true })
  const p = join(d, 'SESSION.md')
  writeFileSync(p, md)
  return p
}

function bind(root: string, sessionId: string, dirName: string, mdPath: string): void {
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  writeFileSync(
    join(root, 'AGENT_SESSIONS', '.bindings.json'),
    JSON.stringify({ version: 1, sessions: { [sessionId]: { dirName, mdPath, action: 'activate', at: Date.now() } } }),
  )
}

interface CapturedSection {
  name: string
  order?: number
  text: string | ((context: unknown) => string)
}

/** 假 agent：捕获 section 注册（与 registerEntrySkillSection 的调用形态一致）。
 *  ⚠️ 会话 id 必须**两处都在**：section 注册门用顶层 `session.id`（与 context.ts 同形），
 *  绑定读取用 `session.header.id`（trajectory-bound.sessionHeader 的权威来源）。 */
function fakeAgent(root: string, sessionId: string): { agent: never; sections: CapturedSection[] } {
  const sections: CapturedSection[] = []
  const agent = {
    session: { id: sessionId, header: { id: sessionId, cwd: root } },
    ctx: { systemPrompt: { section: (s: CapturedSection) => { sections.push(s); return () => {} } } },
  }
  return { agent: agent as never, sections }
}

function renderText(s: CapturedSection): string {
  return typeof s.text === 'function' ? s.text({}) : s.text
}

function freshSessionId(): string {
  seq += 1
  return `sess-${seq}-${Date.now()}`
}

// ── 1. 解析（规格 §2.1 / §6-1）──

describe('trajectory-skills: 声明解析', () => {
  it('① 标准行内数组 ⇒ 按书写顺序', () => {
    expect(parseDeclaredSkills('---\nskills: [home-rhetoric, acc-eap]\n---\n\n# SESSION: x\n')).toEqual(['home-rhetoric', 'acc-eap'])
  })

  it('② 缩进列表 ⇒ 按书写顺序', () => {
    expect(parseDeclaredSkills('---\nskills:\n  - acc-eap\n  - home-rhetoric\n---\n# SESSION\n')).toEqual(['acc-eap', 'home-rhetoric'])
  })

  it('③ 无 frontmatter（首行不是 ---）⇒ 空；未闭合块也按无 frontmatter 处理', () => {
    expect(parseDeclaredSkills('# SESSION\nskills: [a]\n')).toEqual([])
    expect(parseDeclaredSkills('skills: [a]\n---\n')).toEqual([])
    expect(parseDeclaredSkills('---\nskills: [a]\n')).toEqual([]) // 无闭合 ---
    expect(extractFrontmatter('# x\n')).toBeNull()
  })

  it('④ 空 skills（空数组 / 空列表）⇒ 空', () => {
    expect(parseDeclaredSkills('---\nskills: []\n---\n')).toEqual([])
    expect(parseDeclaredSkills('---\nskills:\n---\n')).toEqual([])
  })

  it('⑤ 未知键一律忽略（向前兼容，不报错）；只认 skills', () => {
    const md = '---\nname: x\ntags: [a, b]\nskills: [home-rhetoric]\nother: [z]\n---\n'
    expect(parseDeclaredSkills(md)).toEqual(['home-rhetoric'])
  })

  it('⑥ 名字去空白 / 空项丢弃 / 同名去重（保留首次位置）', () => {
    expect(parseDeclaredSkills('---\nskills: [  a  , b , a , ,  ]\n---\n')).toEqual(['a', 'b'])
    expect(parseDeclaredSkills('---\nskills:\n  - a\n  -  \n  - b\n---\n')).toEqual(['a', 'b'])
  })
})

// ── 2/3/4/5. 装配（注入内容 / 缺失 / 截断 / 安全）──

describe('trajectory-skills: 注入内容装配', () => {
  it('按声明顺序拼接各 skill 全文，每段带 === skill: <name> === 抬头', () => {
    writeSkill(dir, '.opencode', 'home-rhetoric', '# home-rhetoric 正文')
    writeSkill(dir, '.opencode', 'acc-eap', '# acc-eap 正文')
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [home-rhetoric, acc-eap]\n---\n# SESSION\n')
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('=== skill: home-rhetoric ===')
    expect(out).toContain('# home-rhetoric 正文')
    expect(out).toContain('=== skill: acc-eap ===')
    expect(out).toContain('# acc-eap 正文')
    expect(out.indexOf('home-rhetoric')).toBeLessThan(out.indexOf('acc-eap'))
  })

  it('缺 skill ⇒ 响亮提示（含 [缺失] 标记），不静默', () => {
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [does-not-exist]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('[缺失]')
    expect(out).toContain('does-not-exist')
  })

  it('无声明（无 frontmatter）⇒ 空串（不产生噪声）', () => {
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n正文\n')
    expect(buildTrajectorySkillsSection(dir, mdPath)).toBe('')
  })

  it('长度守卫：超限 ⇒ 截断 + 明示（复用 truncateContent），且不超 32 KB + 标记', () => {
    writeSkill(dir, '.opencode', 'big', 'y'.repeat(TRAJECTORY_SKILLS_MAX_CHARS + 5_000))
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [big]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(TRAJECTORY_SKILLS_MAX_CHARS + 100)
  })

  it('🔒 路径穿越名 ⇒ 按缺失处理 + 提示，且不发生任何以该名拼出的 fs 访问', () => {
    const mdPath = writeSession(
      dir,
      '2026-09-15--S999--x',
      '---\nskills: [../../etc/passwd, ..\\\\..\\\\evil]\n---\n',
    )
    h.fs.length = 0
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('[缺失]')
    expect(out).toContain('../../etc/passwd')
    // 断言：没有任何一次 fs 调用以该名拼出（不查表、不拼路径）
    expect(h.fs.filter((p) => p.includes('passwd') || p.includes('etc') || p.includes('evil'))).toEqual([])
    // 直接查发现层：不安全名恒 null（也不发生 fs 访问）
    h.fs.length = 0
    expect(findSkillMd(dir, '../../etc/passwd')).toBeNull()
    expect(h.fs).toEqual([])
  })

  it('mdPath 指向不存在的文件 ⇒ 响亮提示（不静默、不抛）', () => {
    const missing = join(dir, 'AGENT_SESSIONS', 'ghost', 'SESSION.md')
    expect(() => buildTrajectorySkillsSection(dir, missing)).not.toThrow()
    expect(buildTrajectorySkillsSection(dir, missing)).toContain('[缺失]')
  })

  it('查找顺序：同名 skill 同时存在 .dsh/skills 与 .opencode/skills ⇒ 取 .dsh（与 findSkillMd 既有语义一致）', () => {
    writeSkill(dir, '.dsh', 'dup', 'DSH 版正文')
    writeSkill(dir, '.opencode', 'dup', 'OPENCODE 版正文')
    expect(findSkillMd(dir, 'dup')).toBe(join(dir, '.dsh', 'skills', 'dup', 'SKILL.md'))
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [dup]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('DSH 版正文')
    expect(out).not.toContain('OPENCODE 版正文')
  })

  it('hasTrajectorySkillsDeclaration：有声明 true / 无声明 false / 文件缺失 true（需响亮提示）', () => {
    const withDecl = writeSession(dir, '2026-09-15--S999--a', '---\nskills: [x]\n---\n')
    const noDecl = writeSession(dir, '2026-09-15--S999--b', '# SESSION\n')
    const empty = writeSession(dir, '2026-09-15--S999--c', '---\nskills: []\n---\n')
    expect(hasTrajectorySkillsDeclaration(dir, withDecl)).toBe(true)
    expect(hasTrajectorySkillsDeclaration(dir, noDecl)).toBe(false)
    expect(hasTrajectorySkillsDeclaration(dir, empty)).toBe(false)
    expect(hasTrajectorySkillsDeclaration(dir, join(dir, 'AGENT_SESSIONS', 'ghost', 'SESSION.md'))).toBe(true)
  })
})

// ── 6. 绑定来源与注册门（规格 §3）──

describe('trajectory-skills: section 注册门（per-agent）', () => {
  it('有绑定 + 有声明 ⇒ 注册，内容是各 skill 全文与抬头', () => {
    writeSkill(dir, '.opencode', 'home-rhetoric', '# 修辞正文')
    const id = freshSessionId()
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [home-rhetoric]\n---\n')
    bind(dir, id, '2026-09-15--S999--x', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(true)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('serenity-trajectory-skills')
    const text = renderText(sections[0]!)
    expect(text).toContain('=== skill: home-rhetoric ===')
    expect(text).toContain('# 修辞正文')
  })

  it('无绑定（readLastBound 为 null）⇒ 不注册该 section', () => {
    mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
    const { agent, sections } = fakeAgent(dir, freshSessionId())
    expect(registerTrajectorySkillSection(agent, dir)).toBe(false)
    expect(sections).toEqual([])
  })

  it('有绑定但无声明 ⇒ 不注册（不产生空 section、不产生噪声）', () => {
    const id = freshSessionId()
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n无 frontmatter\n')
    bind(dir, id, '2026-09-15--S999--x', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(false)
    expect(sections).toEqual([])
  })

  it('绑定存在但 mdPath 不存在 ⇒ 注册并发响亮提示（不抛、不静默）', () => {
    const id = freshSessionId()
    const mdPath = join(dir, 'AGENT_SESSIONS', 'ghost', 'SESSION.md')
    bind(dir, id, 'ghost', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(true)
    expect(renderText(sections[0]!)).toContain('[缺失]')
  })

  it('绑定切换后求值跟随当前绑定（section 持久，内容不僵化）', () => {
    writeSkill(dir, '.opencode', 'first', 'FIRST 正文')
    writeSkill(dir, '.opencode', 'second', 'SECOND 正文')
    const id = freshSessionId()
    const md1 = writeSession(dir, '2026-09-15--S999--a', '---\nskills: [first]\n---\n')
    bind(dir, id, '2026-09-15--S999--a', md1)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(true)
    expect(renderText(sections[0]!)).toContain('FIRST 正文')
    // 换绑定 → 同一 section 的求值改为新轨迹的声明
    const md2 = writeSession(dir, '2026-09-15--S999--b', '---\nskills: [second]\n---\n')
    bind(dir, id, '2026-09-15--S999--b', md2)
    const after = renderText(sections[0]!)
    expect(after).toContain('SECOND 正文')
    expect(after).not.toContain('FIRST 正文')
  })
})

// ── 7. 回归钉：SEP 符号不得复活 ──

describe('trajectory-skills: 回归钉（SEP 已废除，规格 §5/§6-7）', () => {
  const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
  const SRC_DIR = join(HOOKS_DIR, 'src')

  function collectTs(d: string, out: string[] = []): string[] {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) collectTs(full, out)
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('SEP 符号（discoverCccHooks / buildExtHint / buildSepGuide / create-transform）在 src/** 命中数 = 0', () => {
    const symbols = ['discoverCccHooks', 'buildExtHint', 'buildSepGuide', 'create-transform']
    const hits: string[] = []
    for (const file of collectTs(SRC_DIR)) {
      const text = readFileSync(file, 'utf-8')
      for (const s of symbols) {
        if (text.includes(s)) hits.push(`${relative(HOOKS_DIR, file)}: ${s}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('🔴 散文残留：`session-extension` 在 src/** 命中数 = 0（符号名断言抓不到散文写法）', () => {
    // 2026-09-15 实测漏网后补：C1 原本只钉四个**符号名**，而**面向模型的 toolsBlock 文案**里
    // 仍留着 "the dev manual also carries the session-extension protocol"（指向已废章节）——
    // 符号没了、散文还在。⇒ 判据必须同时覆盖"旧机制的词"，不只覆盖"旧机制的标识符"。
    // 注：`Session Extension Protocol` 的**首字母大写全称**在 `container-admin.ts` / `trajectory.ts`
    // 里作为**"已废除"的中文说明**合法存在（属历史沿革记录），故此处只钉连字小写的英文散文形态。
    const hits: string[] = []
    for (const file of collectTs(SRC_DIR)) {
      if (readFileSync(file, 'utf-8').includes('session-extension')) hits.push(relative(HOOKS_DIR, file))
    }
    expect(hits).toEqual([])
  })
})

// ── 8. keeper 护栏（规格 §4/§6-8）──

describe('trajectory-skills: keeper compaction 护栏', () => {
  it('两条 compaction 提醒文案均含 frontmatter 保留提示', () => {
    const base = { sizeKB: 300, limitKB: 200, mdPath: join(dir, 'AGENT_SESSIONS', 'x', 'SESSION.md') }
    const normal = trajectoryCompactionReminderText(base)
    const escalated = trajectoryCompactionReminderText({ ...base, escalated: true })
    expect(normal).toContain('frontmatter')
    expect(escalated).toContain('frontmatter')
    expect(normal).toContain('skill declarations')
    expect(escalated).toContain('skill declarations')
  })
})

// ── 9. CCC 级声明（v1.44.0；规格 v1.1 §2.3）──
//
// owner 令 2026-09-20：「要求实现我的诉求……注入是动态注入就行；create 先不触发吧；skiff 也支持」
// ⇒ 声明来源由"轨迹自己"扩为**两条并集**（CCC 级在前、轨迹级追加）。

describe('trajectory-skills: CCC 级声明（trajectory.skills）', () => {
  /** 写 CCC 配置（原始文本——损坏场景要能写坏 JSON） */
  function writeCccConfig(root: string, raw: string): void {
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(join(root, '.opencode', 'serenity.json'), raw)
  }

  it('readTrajectorySkills：读数组 / 去空白 / 丢非字符串 / 保序；未配置或无该键 ⇒ []', () => {
    expect(readTrajectorySkills(dir)).toEqual([])
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: [' a ', 'b', 7, '', null, 'c'] } }))
    expect(readTrajectorySkills(dir)).toEqual(['a', 'b', 'c'])
    writeCccConfig(dir, JSON.stringify({ trajectory: { autopilot: { enabled: true } } }))
    expect(readTrajectorySkills(dir)).toEqual([])
    expect(readTrajectorySkills(dir, ['.dsh/serenity.json'])).toEqual([])
  })

  it('配置损坏 ⇒ 空数组、不抛（轨迹级声明不受牵连）', () => {
    writeCccConfig(dir, '{ broken json')
    expect(() => readTrajectorySkills(dir)).not.toThrow()
    expect(readTrajectorySkills(dir)).toEqual([])
  })

  it('mergeSkillNames：CCC 级在前、轨迹级追加、同名去重取首次位置', () => {
    expect(mergeSkillNames(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(mergeSkillNames([], ['x'])).toEqual(['x'])
    expect(mergeSkillNames(['x'], [])).toEqual(['x'])
    expect(mergeSkillNames([' x '], ['x', ' '])).toEqual(['x'])
  })

  it('只有 CCC 级（该轨迹无声明）⇒ 仍注入全文 —— v1.1 的新覆盖', () => {
    writeSkill(dir, '.opencode', 'ccc-only', 'CCC 级正文')
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n无 frontmatter\n')
    const out = buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, ['ccc-only'])
    expect(out).toContain('=== skill: ccc-only ===')
    expect(out).toContain('CCC 级正文')
  })

  it('并集装配：CCC 级在前、轨迹级在后；同名只出现一次', () => {
    writeSkill(dir, '.opencode', 'base', 'BASE 正文')
    writeSkill(dir, '.opencode', 'extra', 'EXTRA 正文')
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [extra, base]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, ['base'])
    expect(out.indexOf('=== skill: base ===')).toBeLessThan(out.indexOf('=== skill: extra ==='))
    expect(out.match(/=== skill: base ===/g)).toHaveLength(1)
  })

  it('mdPath 缺失但 CCC 级有声明 ⇒ 响亮提示在前、正文随后（提示不被吞掉）', () => {
    writeSkill(dir, '.opencode', 'base', 'BASE 正文')
    const missing = join(dir, 'AGENT_SESSIONS', 'ghost', 'SESSION.md')
    const out = buildTrajectorySkillsSection(dir, missing, TRAJECTORY_SKILLS_MAX_CHARS, ['base'])
    expect(out).toContain('[缺失]')
    expect(out).toContain('BASE 正文')
    expect(out.indexOf('[缺失]')).toBeLessThan(out.indexOf('=== skill: base ==='))
  })

  it('长度守卫：**合并后**统一截断（两条来源共享一份上限）', () => {
    writeSkill(dir, '.opencode', 'big', 'y'.repeat(TRAJECTORY_SKILLS_MAX_CHARS + 5_000))
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '---\nskills: [big]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, ['big'])
    expect(out.match(/=== skill: big ===/g)).toHaveLength(1) // 去重后只一份
    expect(out.length).toBeLessThan(TRAJECTORY_SKILLS_MAX_CHARS + 100)
  })

  it('注册门（v1.1）：有绑定 + CCC 有声明 + 该轨迹无声明 ⇒ 注册并注入', () => {
    writeSkill(dir, '.opencode', 'ccc-skill', 'CCC 级正文')
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: ['ccc-skill'] } }))
    const id = freshSessionId()
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n无声明\n')
    bind(dir, id, '2026-09-15--S999--x', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(true)
    const text = renderText(sections[0]!)
    expect(text).toContain('=== skill: ccc-skill ===')
    expect(text).toContain('CCC 级正文')
  })

  it('注册门：无绑定 + CCC 有声明 ⇒ 仍不注册（注入的门是"存在绑定"，不是"CCC 配了"）', () => {
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: ['ccc-skill'] } }))
    mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
    const { agent, sections } = fakeAgent(dir, freshSessionId())
    expect(registerTrajectorySkillSection(agent, dir)).toBe(false)
    expect(sections).toEqual([])
  })

  it('注册门：两条来源皆无 + 有绑定 ⇒ 不注册（v1.0 行为不变、零噪声）', () => {
    const id = freshSessionId()
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n无声明\n')
    bind(dir, id, '2026-09-15--S999--x', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(false)
    expect(sections).toEqual([])
  })

  it('🔴 动态注入：改 CCC 配置后，同一 section 的下一次求值跟随变化（不缓存）', () => {
    writeSkill(dir, '.opencode', 'before', 'BEFORE 正文')
    writeSkill(dir, '.opencode', 'after', 'AFTER 正文')
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: ['before'] } }))
    const id = freshSessionId()
    const mdPath = writeSession(dir, '2026-09-15--S999--x', '# SESSION\n无声明\n')
    bind(dir, id, '2026-09-15--S999--x', mdPath)
    const { agent, sections } = fakeAgent(dir, id)
    expect(registerTrajectorySkillSection(agent, dir)).toBe(true)
    expect(renderText(sections[0]!)).toContain('BEFORE 正文')
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: ['after'] } }))
    const next = renderText(sections[0]!)
    expect(next).toContain('AFTER 正文')
    expect(next).not.toContain('BEFORE 正文')
  })

  it('create 不触发：CCC 有声明也不因 create 而注入（U6 不动——门始终是"存在绑定"）', () => {
    // 该判据是**语义钉**：create 只写审计记录、不改绑定（trajectory.ts:312-326），
    // 故"未绑定的会话"拿不到注入，哪怕 CCC 配了 skills。
    writeCccConfig(dir, JSON.stringify({ trajectory: { skills: ['ccc-skill'] } }))
    const { agent, sections } = fakeAgent(dir, freshSessionId())
    expect(registerTrajectorySkillSection(agent, dir)).toBe(false)
    expect(sections).toEqual([])
  })
})
