/**
 * skills-discovery.ts — CCC 入口 skill 自动发现（纯逻辑，零 DSH 依赖）
 *
 * 发现全部入口技能（原文全量，不截断）：
 *   0. **`.serenity` 记号文件内容 = 顶层入口 skill 名**（CCC 记号文件的权威语义，
 *      tiangong-serenity 的 .serenity 内容为 `tg-serenity`）—— 最高优先
 *   1. `.dsh/entry-skill` 指针文件（内容 = skill 名）—— 兼容旧约定
 *   2. `.opencode/skills/*-serenity/SKILL.md` —— 自动扫描该 CCC 的顶层入口
 *      （home-serenity / tg-serenity / pangu-serenity …，命名模式 `*-serenity`）
 *   3. `.dsh/skills/*-serenity/SKILL.md` —— 自动扫描 ACC/harness 入口（acc-serenity 等）
 * 按名去重；顺序 = 记号文件 → 指针 → opencode 入口 → dsh 入口。
 *
 * 任何 CCC 都能自动注入其顶层入口 skill 全文（不硬编码名字）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'

type EntrySkillSource = 'serenity-marker' | 'pointer' | 'opencode' | 'dsh'

interface EntrySkill {
  name: string
  content: string
  source: EntrySkillSource
}

/** 顶层入口命名模式：目录名以 -serenity 结尾（home-serenity / tg-serenity / acc-serenity …） */
const SERENITY_SUFFIX = '-serenity'

function isSerenityEntry(name: string): boolean {
  return name.endsWith(SERENITY_SUFFIX)
}

/** 扫描某 skills 根下所有 `*-serenity` 目录（含 SKILL.md 的） */
function scanSerenityDirs(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return []
  return readdirSync(skillsRoot)
    .filter((name) => isSerenityEntry(name))
    .map((name) => join(skillsRoot, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md')))
    .sort()
}

/**
 * 防穿越：skill 名必须是简单目录名（拒绝分隔符与 `..`/`.` 路径段）。
 * v1.34.1：导出——轨迹 skill 声明（CCC 数据）的名字也要**先过这一关**才能用于拼路径
 * （规格 `docs/trajectory-skill-injection.md` §3「名字安全（必做）」）。
 */
export function isSafeSkillName(name: string): boolean {
  if (name.length === 0) return false
  if (name.includes('/') || name.includes('\\')) return false
  return !name.split(/[/\\]/).some((seg) => seg === '..' || seg === '.')
}

/**
 * 按名在两个 skills 根下定位 SKILL.md（`.dsh/skills` 优先，其次 `.opencode/skills`）。
 * v1.34.1：导出——轨迹 skill 注入复用本函数（不新造发现逻辑）；不安全名在此**先行拒绝**
 * （返回 null，且不发生任何以该名拼出的 fs 访问）。
 */
export function findSkillMd(root: string, name: string): string | null {
  if (!isSafeSkillName(name)) return null
  for (const base of ['.dsh', '.opencode']) {
    const p = resolve(root, base, 'skills', name, 'SKILL.md')
    if (existsSync(p)) return p
  }
  return null
}

/** 发现全部入口技能（原文全量，不截断） */
export function findEntrySkills(root: string): EntrySkill[] {
  const out: EntrySkill[] = []
  const seen = new Set<string>()
  const add = (path: string, source: EntrySkillSource, forcedName?: string): void => {
    if (!existsSync(path)) return
    const name = forcedName ?? basename(dirname(path))
    if (seen.has(name)) return
    seen.add(name)
    out.push({ name, content: readFileSync(path, 'utf-8'), source })
  }

  // 0) `.serenity` 记号文件（CCC 记号文件的权威语义 = 顶层入口 skill 名）
  const marker = resolve(root, '.serenity')
  if (existsSync(marker)) {
    const name = readFileSync(marker, 'utf-8').trim()
    if (name) {
      const md = findSkillMd(root, name)
      if (md) add(md, 'serenity-marker', name)
    }
  }
  // 1) `.dsh/entry-skill` 指针文件（兼容旧约定；任意名字）
  const pointer = resolve(root, '.dsh', 'entry-skill')
  if (existsSync(pointer)) {
    const name = readFileSync(pointer, 'utf-8').trim()
    if (name) {
      const md = findSkillMd(root, name)
      if (md) add(md, 'pointer', name)
    }
  }
  // 2) opencode 顶层入口：自动扫描 .opencode/skills/*-serenity
  for (const dir of scanSerenityDirs(resolve(root, '.opencode', 'skills'))) {
    add(join(dir, 'SKILL.md'), 'opencode')
  }
  // 🔴 **来源 3 已删**（2026-09-21 所有者令「连模板和安装命令一起删」＝ B 案）
  //
  // 删掉的是：自动扫描 `.dsh/skills/*-serenity`——即把"ACC 安装进 CCC 的技能副本"也当**入口技能**收。
  //
  // **为什么删（实测证据）**：`.dsh/entry-skill` 自 **2026-08-07** 起就写着 `acc-serenity`，
  // 但当时**两个 skills 根里都没有该文件** ⇒ `findSkillMd` 返回 null ⇒ **一直没生效**；
  // **2026-09-17 那次 `install --skills`** 让 `.dsh/skills/acc-serenity/SKILL.md` **第一次存在**
  // ⇒ `findSkillMd` 命中它 ⇒ **自那天起，每请求静默多注入 10,355 B**（10 KB）。
  // ⇒ 现象：owner 2026-09-21 问「系统提示词怎么膨胀了好多倍」；实测入口块 = 43,089（home-serenity）
  //    + 10,355（acc-serenity）≈ **53 KB / 每请求**，且**无任何提示**。
  //
  // 副本机制（模板 + `install --skills` + `.dsh/skills`）整体退场 ⇒ 此处不再有第三个来源。
  return out
}

/** 兼容旧接口：第一个入口（或 null） */
export function findEntrySkill(root: string): EntrySkill | null {
  return findEntrySkills(root)[0] ?? null
}

export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n... (truncated, original length ${content.length} chars)`
}
