import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter, listOpencodeSkillDirs, loadOpencodeSkill } from '../src/skills/opencode-scan.js'

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
    expect(skill.name).toBe('home-git')
    expect(skill.content).toContain('body-text')
    expect(skill.path.endsWith('SKILL.md')).toBe(true)
  })
})
