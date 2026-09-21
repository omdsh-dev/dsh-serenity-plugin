import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findEntrySkill, findEntrySkills, findSkillMd, truncateContent } from '../src/skills-discovery.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-disc-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('skills-discovery: 入口 skill 发现', () => {
  it('无任何入口 → null', () => {
    expect(findEntrySkill(dir)).toBeNull()
  })

  it('🔴 **来源 3 已退场**：`.dsh/skills/*-serenity` 的副本**不再**被当入口技能收（B 案回归钉）', () => {
    mkdirSync(join(dir, '.dsh', 'skills', 'acc-serenity'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'skills', 'acc-serenity', 'SKILL.md'), 'entry-content')
    // 修复前：此处会被自动扫描收成入口技能（并且自 2026-09-17 起每请求静默多注入 10 KB）
    expect(findEntrySkill(dir)).toBeNull()
    // 但 `.dsh/skills` 本身**仍是 `findSkillMd` 的合法搜索根**（该语义另有钉，未动）
    expect(findSkillMd(dir, 'acc-serenity')).not.toBeNull()
  })

  it('约定回退：.opencode/skills/home-serenity', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'home-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-serenity', 'SKILL.md'), 'legacy-entry')
    const s = findEntrySkill(dir)
    expect(s!.name).toBe('home-serenity')
  })

  it('指针文件优先：.dsh/entry-skill', () => {
    mkdirSync(join(dir, '.dsh', 'skills', 'acc-eap'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'skills', 'acc-eap', 'SKILL.md'), 'eap-content')
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'entry-skill'), 'acc-eap')
    const s = findEntrySkill(dir)
    expect(s!.name).toBe('acc-eap')
    expect(s!.content).toContain('eap-content')
  })

  it('truncateContent 超限截断', () => {
    expect(truncateContent('abc', 5)).toBe('abc')
    expect(truncateContent('abcdefgh', 5)).toContain('truncated')
  })

  it('恶意 marker 名（路径穿越 ../）被拒 → 回退空', () => {
    writeFileSync(join(dir, '.serenity'), '../evil')
    const s = findEntrySkill(dir)
    expect(s).toBeNull()
  })

  it('恶意指针名（含 \\ 分隔符）被拒', () => {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'entry-skill'), '..\\..\\evil')
    const s = findEntrySkill(dir)
    expect(s).toBeNull()
  })
})

describe('skills-discovery: 全量入口发现（加强版）', () => {
  it('🔴 只发现 home-serenity（opencode 入口）；`.dsh/skills` 副本**不再**入列（B 案后语义）', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'home-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-serenity', 'SKILL.md'), '---\nname: home-serenity\ndescription: 系统入口\n---\n系统入口正文')
    mkdirSync(join(dir, '.dsh', 'skills', 'acc-serenity'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'skills', 'acc-serenity', 'SKILL.md'), '---\nname: acc-serenity\ndescription: harness 入口\n---\nharness 正文')
    const skills = findEntrySkills(dir)
    const names = skills.map((s) => s.name)
    expect(names).toContain('home-serenity')
    // 修复前此处含 'acc-serenity'（来源 3 自动扫描）——那正是每请求静默 +10 KB 的来路
    expect(names).not.toContain('acc-serenity')
    expect(skills).toHaveLength(1)
    const hs = skills.find((s) => s.name === 'home-serenity')!
    expect(hs.source).toBe('opencode')
    expect(hs.content).toContain('系统入口正文') // 原文全量，不截断（该语义未变）
  })
})
