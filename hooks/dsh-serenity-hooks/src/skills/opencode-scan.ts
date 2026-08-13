/**
 * opencode-scan.ts — opencode skill 标准扫描（纯逻辑，零 DSH 依赖）
 *
 * 兼容 opencode 的 skill 标准：`.opencode/skills/<name>/SKILL.md`
 * （frontmatter: name/description/whenToUse；结构含 references/、scripts/）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OpencodeSkillMeta {
  name: string
  description: string
  whenToUse?: string
}

export interface OpencodeSkill {
  name: string
  dir: string
  meta: OpencodeSkillMeta
  content: string
  path: string
}

/** 解析 --- 分隔的 YAML frontmatter（只需 name/description/whenToUse） */
export function parseFrontmatter(raw: string): { meta: OpencodeSkillMeta; content: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw)
  if (!m) return { meta: { name: '', description: '' }, content: raw }
  const fm = m[1]!
  const body = raw.slice(m[0].length)
  const grab = (key: string): string | undefined => {
    const line = fm.split('\n').find((l) => l.startsWith(`${key}:`))
    if (!line) return undefined
    return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  const meta: OpencodeSkillMeta = {
    name: grab('name') ?? '',
    description: grab('description') ?? '',
  }
  const whenToUse = grab('whenToUse')
  if (whenToUse) meta.whenToUse = whenToUse
  return { meta, content: body }
}

/** 扫描 CCC 的 .opencode/skills（一级目录 + SKILL.md 存在性） */
export function listOpencodeSkillDirs(root: string): string[] {
  const dir = join(root, '.opencode', 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .filter((d) => existsSync(join(d, 'SKILL.md')))
}

/** 加载一个 opencode skill（frontmatter 解析 + 正文） */
export function loadOpencodeSkill(skillDir: string): OpencodeSkill {
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
  const { meta, content } = parseFrontmatter(raw)
  return { name: meta.name, dir: skillDir, meta, content, path: join(skillDir, 'SKILL.md') }
}
