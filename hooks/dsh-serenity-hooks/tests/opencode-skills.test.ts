import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter, listOpencodeSkillDirs, loadOpencodeSkill } from '../src/skills/opencode-scan.js'
import { registerOpencodeSkills, OPENCODE_PROVIDER, OPENCODE_RANK } from '../src/seams/opencode-skills.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-skills-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('opencode-scan: frontmatter 解析（opencode skill 标准）', () => {
  it('标准 frontmatter（name/description）', () => {
    const raw = `---\nname: home-git\ndescription: 家庭 GitLab 操作指南\n---\n# 正文`
    const { meta, content } = parseFrontmatter(raw)
    expect(meta.name).toBe('home-git')
    expect(meta.description).toBe('家庭 GitLab 操作指南')
    expect(content).toContain('# 正文')
  })

  it('带 whenToUse + 引号值', () => {
    const raw = `---\nname: home-session\ndescription: "会话追踪"\nwhenToUse: 多步工作时\n---\nbody`
    const { meta } = parseFrontmatter(raw)
    expect(meta.description).toBe('会话追踪')
    expect(meta.whenToUse).toBe('多步工作时')
  })

  it('无 frontmatter 回退空 meta', () => {
    const { meta, content } = parseFrontmatter('plain markdown')
    expect(meta.name).toBe('')
    expect(content).toBe('plain markdown')
  })
})

describe('opencode-scan: 扫描与加载', () => {
  it('扫描 .opencode/skills 一级目录', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'home-git'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-git', 'SKILL.md'), '---\nname: home-git\ndescription: git\n---\nbody')
    mkdirSync(join(dir, '.opencode', 'skills', 'no-skill'), { recursive: true })
    const dirs = listOpencodeSkillDirs(dir)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]!.endsWith('home-git')).toBe(true)
  })

  it('加载返回 meta + content + path', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'home-git'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-git', 'SKILL.md'), '---\nname: home-git\ndescription: git\n---\nbody-text')
    const skill = loadOpencodeSkill(join(dir, '.opencode', 'skills', 'home-git'))
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('home-git')
    expect(skill!.content).toContain('body-text')
    expect(skill!.path.endsWith('SKILL.md')).toBe(true)
  })

  it('读失败（SKILL.md 不存在/EPERM）返回 null 容错', () => {
    const skill = loadOpencodeSkill(join(dir, '.opencode', 'skills', 'no-such-dir'))
    expect(skill).toBeNull()
  })
})

describe('opencode-skills seam: registerOpencodeSkills provider（P1-1 补测——审计唯一 funcs 0 模块）', () => {
  let captured: (() => { list: (o: { cwd?: string }) => Promise<{ candidates: unknown[]; complete: boolean }>; get: (c: { locator?: string }) => Promise<unknown> }) | null = null
  let registered = 0

  function fakeCtx(): unknown {
    return {
      skills: {
        registerProvider: (fn: () => unknown) => {
          registered += 1
          captured = fn as typeof captured
        },
      },
    }
  }

  beforeEach(() => {
    captured = null
    registered = 0
    // 建两个真实 skill 目录
    mkdirSync(join(dir, '.opencode', 'skills', 'home-git'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-git', 'SKILL.md'), '---\nname: home-git\ndescription: git 指南\nwhenToUse: git 操作时\n---\nbody')
    mkdirSync(join(dir, '.opencode', 'skills', 'home-media'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-media', 'SKILL.md'), '---\nname: home-media\ndescription: 媒体\n---\nmedia-body')
    // 一个无 SKILL.md 的目录（应被 list 跳过）
    mkdirSync(join(dir, '.opencode', 'skills', 'empty-dir'), { recursive: true })
  })

  it('注册 provider（rank 250）', () => {
    registerOpencodeSkills(fakeCtx() as never)
    expect(registered).toBe(1)
    expect(captured).not.toBeNull()
  })

  it('list：CCC 内 cwd → 返回候选（name/description/whenToUse/resourceBase/rank）', async () => {
    registerOpencodeSkills(fakeCtx() as never)
    const provider = captured!()
    const res = await provider.list({ cwd: dir })
    expect(res.complete).toBe(true)
    const names = (res.candidates as { name: string }[]).map((c) => c.name).sort()
    expect(names).toEqual(['home-git', 'home-media'])
    const git = (res.candidates as { name: string; description: string; whenToUse?: string; provider: string; rank: number; resourceBase: { kind: string; path: string } }[]).find((c) => c.name === 'home-git')
    expect(git?.description).toBe('git 指南')
    expect(git?.whenToUse).toBe('git 操作时')
    expect(git?.provider).toBe(OPENCODE_PROVIDER)
    expect(git?.rank).toBe(OPENCODE_RANK)
    expect(git?.resourceBase.kind).toBe('directory')
    // 无 SKILL.md 目录不产生候选
    expect((res.candidates as { name: string }[]).some((c) => c.name === 'empty-dir')).toBe(false)
  })

  it('list：非 CCC cwd（无 .serenity）→ 空候选', async () => {
    registerOpencodeSkills(fakeCtx() as never)
    const provider = captured!()
    const outside = mkdtempSync(join(tmpdir(), 'oc-outside-'))
    try {
      const res = await provider.list({ cwd: outside })
      expect(res.candidates).toEqual([])
      expect(res.complete).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('list：skill 无 name（frontmatter 缺 name）→ 跳过', async () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'no-name'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'no-name', 'SKILL.md'), '---\ndescription: 无名\n---\nbody')
    registerOpencodeSkills(fakeCtx() as never)
    const provider = captured!()
    const res = await provider.list({ cwd: dir })
    expect((res.candidates as { name: string }[]).some((c) => c.name === 'no-name')).toBe(false)
  })

  it('get：locator 命中 → SkillDefinition（content 载入）', async () => {
    registerOpencodeSkills(fakeCtx() as never)
    const provider = captured!()
    const listRes = await provider.list({ cwd: dir })
    const git = (listRes.candidates as { locator: string; name: string; description: string }[]).find((c) => c.name === 'home-git')
    const def = await provider.get(git as never)
    expect(def).not.toBeUndefined()
    const d = def as { name: string; content: string; provider: string }
    expect(d.name).toBe('home-git')
    expect(d.content).toContain('body')
    expect(d.provider).toBe(OPENCODE_PROVIDER)
  })

  it('get：locator 目录已删/无效 → undefined', async () => {
    registerOpencodeSkills(fakeCtx() as never)
    const provider = captured!()
    const def = await provider.get({ locator: join(dir, '.opencode', 'skills', 'gone') })
    expect(def).toBeUndefined()
  })
})
