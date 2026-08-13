/**
 * opencode-skills.ts — opencode skill 标准兼容 provider
 *
 * 通过 ctx.skills.registerProvider 把 CCC 的 `.opencode/skills/*`（opencode 标准
 * skill：SKILL.md + frontmatter + references/ + scripts/）注册为 DSH 可加载技能。
 * 按 agent 会话 cwd 解析 CCC 根 → 自动发现；resourceBase 指向 skill 目录，
 * 使 references/scripts 相对引用可解析。
 *
 * rank = 250：低于 project-dsh（100）与 custom（300）之间——本地 .dsh/skills 优先。
 */

import type { Context } from 'cordis'
import type { SkillProvider, SkillCandidate, SkillDefinition, SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { findSerenityRoot } from '../ccc.js'
import { listOpencodeSkillDirs, loadOpencodeSkill } from '../skills/opencode-scan.js'

export const OPENCODE_PROVIDER = 'opencode-skills'
export const OPENCODE_RANK = 250

export function registerOpencodeSkills(ctx: Context): void {
  const provider: SkillProvider = {
    name: OPENCODE_PROVIDER,
    async list(options: SkillLookupOptions) {
      const cwd = options.cwd ?? process.cwd()
      const root = findSerenityRoot(cwd)
      if (!root) return { candidates: [], complete: true }

      const candidates: SkillCandidate[] = []
      for (const dir of listOpencodeSkillDirs(root)) {
        const skill = loadOpencodeSkill(dir)
        if (!skill.meta.name) continue
        candidates.push({
          name: skill.meta.name,
          description: skill.meta.description || '(opencode skill)',
          ...(skill.meta.whenToUse ? { whenToUse: skill.meta.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'opencode-skills',
          provider: OPENCODE_PROVIDER,
          resourceBase: { kind: 'directory', path: dir },
          rank: OPENCODE_RANK,
          locator: dir,
          path: skill.path,
        })
      }
      return { candidates, complete: true }
    },
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const dir = candidate.locator as string
      const skill = loadOpencodeSkill(dir)
      return {
        name: skill.meta.name,
        description: skill.meta.description || candidate.description,
        ...(skill.meta.whenToUse ? { whenToUse: skill.meta.whenToUse } : {}),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: OPENCODE_PROVIDER,
        resourceBase: candidate.resourceBase,
        content: skill.content,
        path: skill.path,
      }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
