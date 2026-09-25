/**
 * trajectory-skills.ts — 轨迹 skill 声明解析 + 注入内容装配（纯逻辑，零 DSH 依赖）
 *
 * 接口真相源：`docs/trajectory-skill-injection.md` v1.0（§2 数据契约 / §3 注入契约）。
 * 一句话：**轨迹自己声明它要挂哪些 skill**（`SESSION.md` 顶部 YAML frontmatter 的 `skills:`），
 * ACC 在**绑定期间**把这些 skill 的 `SKILL.md` 全文注入系统提示词。
 *
 * 分工（R↓：为什么解析与注册分开）：
 *   · 本模块 = **纯文本层**（解析 / 装配 / 安全判定）——可脱离 DSH 单测；
 *   · `seams/system-prompt.ts` 的 `registerTrajectorySkillSection` = **宿主接入层**
 *     （per-agent `ctx.systemPrompt.section`），只做门与注册，不再解析文本。
 *
 * 边界（规格 §2.2）：**不解析** `skills` 以外任何键的语义（CCC 可自由使用，ACC 视而不见）；
 * **不改写** frontmatter（ACC 只读）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findSkillMd, isSafeSkillName, truncateContent } from './skills-discovery.js'

/** 全文注入总长上限（字符数；规格 §3「缺省 32 KB」——防上下文爆炸） */
export const TRAJECTORY_SKILLS_MAX_CHARS = 32 * 1024

/** 缺失标记（规格 §3/§6-3 的验收锚点：任何"拿不到全文"的情况都必须带它，绝不静默）
 *  🔴 2026-09-25（S142 分批清死代码·第 1 批）：**降为模块内常量**——全仓唯一消费者在本文件，
 *  导出只服务测试（测试用的是字面量 `'[缺失]'`）⇒ 导出面无意义。 */
const SKILL_MISSING_MARK = '[缺失]'

/** 统一缺失提示（规格 §3 逐字约定：`[缺失] <name>（未找到该 skill）`） */
function missingNotice(name: string): string {
  return `${SKILL_MISSING_MARK} ${name}（未找到该 skill）`
}

/**
 * 抽取文件顶部 YAML frontmatter 区（规格 §2.1）。
 *
 * 规则：**第一行必须是 `---`**；到下一个 `---` 行为止是 frontmatter 区。
 * 首行不是 `---`，或没有闭合 `---` ⇒ 视为**无 frontmatter**（返回 null）。
 * 边界判断（R↓）：未闭合块按"无 frontmatter"处理而非吞掉整个文件——半个声明块是格式错误，
 * 猜它的意图等于把坏数据当好消息（宁可零注入，也不注入来路不明的半截列表）。
 *
 * @param content SESSION.md 全文
 * @returns frontmatter 区各行（不含两条 `---` 定界行）；无 → null
 */
export function extractFrontmatter(content: string): string[] | null {
  // 归一 CRLF：`\r` 会让 `---` 比较失败（Windows 侧编辑过的 SESSION.md 不该静默失配）
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return lines.slice(1, i)
  }
  return null
}

/** 行内数组值 `[a, b, c]`（仅当首尾为方括号时视为行内数组；否则返回 null） */
function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 解析声明（规格 §2.1，**最小实现，不引 YAML 依赖**）。
 *
 * 只认 `skills:` 键；未知键一律忽略（向前兼容，不报错）。两种值形态都支持：
 *   ① 行内数组 `skills: [home-rhetoric, acc-eap]`
 *   ② 缩进列表（`skills:` 后各起一行 `  - a`）
 * 名字：去首尾空白、空项丢弃、**保持书写顺序**（注入顺序 = 书写顺序）、同名去重（保留首次位置）。
 *
 * 未定义形态（不在规格的两种值形态内，如 `skills: a` 裸标量）⇒ **视为无声明**：
 * 本函数只认契约里写明的两种形态，猜第三种等于自造契约（规格 §2.1 只列了 ①②）。
 *
 * @param sessionMd SESSION.md 全文
 * @returns 声明的 skill 名（按书写顺序去重）；无 frontmatter / 无 `skills` 键 / 值为空 → `[]`
 */
export function parseDeclaredSkills(sessionMd: string): string[] {
  const fm = extractFrontmatter(sessionMd)
  if (!fm) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (name: string): void => {
    const clean = name.trim()
    if (clean === '' || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }

  for (let i = 0; i < fm.length; i++) {
    const line = fm[i] ?? ''
    const m = /^skills\s*:(.*)$/.exec(line)
    if (!m) continue
    const rest = (m[1] ?? '').trim()
    const inline = parseInlineArray(rest)
    if (inline) {
      for (const name of inline) push(name)
      continue
    }
    if (rest !== '') continue // 未定义形态（裸标量等）⇒ 忽略，不猜（见函数头）
    // ② 缩进列表：紧随其后、匹配 `- <name>` 的行
    for (let j = i + 1; j < fm.length; j++) {
      const item = /^\s*-\s*(.*)$/.exec(fm[j] ?? '')
      if (!item) break
      push(item[1] ?? '')
    }
  }
  return out
}

/** SESSION.md 绝对路径（绑定记录存的是绝对路径；非绝对态按 CCC 根解析——防御旧数据） */
function absoluteMdPath(root: string, mdPath: string): string {
  return mdPath.startsWith(root) ? mdPath : resolve(root, mdPath)
}

/**
 * 注册门（规格 §3「无绑定 / 无声明 ⇒ 完全不注册该 section」）。
 *
 * 返回 true 的两种情况：
 *   · 文件在且**有非空声明** → 注册（有内容可注入）
 *   · 文件**不在 / 读不到** → 同样注册——此时 section 文本是响亮的 `[缺失]` 提示
 *     （规格 §6-6 要求"不静默"；不注册就等于静默）
 * 其余（文件在但无 frontmatter / 无 `skills` 键 / 值为空）⇒ false，不注册、不产生噪声。
 */
export function hasTrajectorySkillsDeclaration(root: string, mdPath: string): boolean {
  const abs = absoluteMdPath(root, mdPath)
  if (!existsSync(abs)) return true
  try {
    return parseDeclaredSkills(readFileSync(abs, 'utf-8')).length > 0
  } catch {
    return true // 读失败 → 交给装配层发响亮提示（不静默）
  }
}

/** 去空白 + 丢空项 + 同名去重（保留首次出现位置）——两条声明来源共用同一规范化 */
function normalizeNames(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const clean = raw.trim()
    if (clean === '' || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * 合并两条声明来源（v1.44.0）：**CCC 级在前，轨迹级追加**，同名去重取首次位置。
 *
 * 两条来源（owner 令 2026-09-20）：
 *   · **CCC 级** = `.opencode/serenity.json` 的 `trajectory.skills`（本 CCC 所有轨迹共有的底座）；
 *   · **轨迹级** = 该轨迹 `SESSION.md` frontmatter 的 `skills:`（这条轨迹额外的）。
 *
 * 为什么是**并集**而不是二选一（R↓）：C1 设计当初否决"纯 CCC 全局"的理由是"会**丢掉
 * per-trajectory**"；并集把两侧都保住——容器给底座，单条轨迹仍可加自己的额外项。
 * 为什么 CCC 级**在前**：底座先立、增量随后，与"入口身份块 order=-50 → 本 section order=-45"
 * 的既有先后观感一致。
 */
export function mergeSkillNames(cccSkills: readonly string[], trajSkills: readonly string[]): string[] {
  return normalizeNames([...cccSkills, ...trajSkills])
}

/**
 * 装配注入正文（规格 §3）：按**合并后的**顺序拼接各 skill 的 `SKILL.md` 全文，每段带来源抬头
 * `=== skill: <name> ===`；拿不到全文的一律以 `[缺失]` 响亮提示占位（**不静默**）。
 *
 * 安全（规格 §3 🔒）：名字来自 CCC 数据（frontmatter / CCC 配置）⇒ **先过 `isSafeSkillName`**；
 * 不安全 ⇒ 按缺失处理，且不调用 `findSkillMd` ⇒ **不发生任何以该名拼出的 fs 访问**。
 *
 * 长度守卫：复用已导出的 `truncateContent`，**在合并之后**统一截断（两条来源共享同一上限，
 * 不是各给 32 KB——否则上限会随来源数翻倍）。
 *
 * @param root CCC 根
 * @param mdPath 轨迹的 SESSION.md 路径（**来自绑定的 `mdPath`**，不用 label 拼）
 * @param maxChars 总长上限（字符）
 * @param cccSkills CCC 级声明（`readTrajectorySkills`；缺省空 = 只有轨迹级，行为与 v1.43 一致）
 * @param onInjectedNames 观测回调（本次请求实际带上的 skill 名；**纯观测**，供用量统计用——
 *        回调抛错被吞，**不影响注入正文**）
 * @returns 注入正文；两条来源皆无声明 → `''`（空串 = 宿主不产出该 section 块）；
 *          SESSION.md 缺失/读失败 → 响亮提示（若同时有 CCC 级声明，则提示在前、正文随后——
 *          **提示不因"别处有内容"而被吞掉**）
 */
export function buildTrajectorySkillsSection(
  root: string,
  mdPath: string,
  maxChars: number = TRAJECTORY_SKILLS_MAX_CHARS,
  cccSkills: readonly string[] = [],
  onInjectedNames?: (names: readonly string[]) => void,
): string {
  const abs = absoluteMdPath(root, mdPath)
  let trajNames: string[] = []
  let notice = ''
  if (!existsSync(abs)) {
    notice = `${SKILL_MISSING_MARK} ${abs}（轨迹的 SESSION.md 不存在——skill 声明无从读取；若刚重建/移动过轨迹，请确认绑定记录）`
  } else {
    try {
      trajNames = parseDeclaredSkills(readFileSync(abs, 'utf-8'))
    } catch (err) {
      notice = `${SKILL_MISSING_MARK} ${abs}（SESSION.md 读取失败：${err instanceof Error ? err.message : String(err)}）`
    }
  }
  const names = mergeSkillNames(cccSkills, trajNames)
  if (names.length === 0) return notice

  // 🆕 用量统计（owner 令 2026-09-22）：把**本次请求真的带上的** skill 名交给观察者。
  // 🔴 纯观测：回调包在 try 里 —— **统计失败绝不影响注入正文**（统计不是注入的一部分）；
  //    放在 `names.length === 0` 之后 ⇒ "空 section 不计数"天然成立（宿主也会丢弃空块）。
  if (onInjectedNames) {
    try {
      onInjectedNames(names)
    } catch {
      /* 静默忽略：统计不得影响注入 */
    }
  }

  const blocks: string[] = []
  for (const name of names) {
    if (!isSafeSkillName(name)) {
      blocks.push(`${SKILL_MISSING_MARK} ${name}（名字不安全，已拒绝解析路径）`)
      continue
    }
    const file = findSkillMd(root, name)
    if (!file) {
      blocks.push(missingNotice(name))
      continue
    }
    try {
      blocks.push(`=== skill: ${name} ===\n${readFileSync(file, 'utf-8')}`)
    } catch {
      blocks.push(missingNotice(name))
    }
  }
  const body = blocks.join('\n\n')
  return truncateContent(notice ? `${notice}\n\n${body}` : body, maxChars)
}
