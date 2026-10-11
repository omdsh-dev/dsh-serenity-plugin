/**
 * resource-index.ts — **两层披露树的第二层**：skill 参考件索引（纯逻辑，零 DSH 依赖）
 *
 * 设计真相源：`docs/serenity-skill-design.md` §4.2（六条硬性规则）＋ §5.1（目录布局）。
 * 一句话：**把 skill 的参考件"有什么"告诉模型，但不把"是什么"塞进去** ——
 * 正文留给第三层（模型按需 `read`）。
 *
 * 为什么由我们生成（R↓，读宿主取证）：宿主 `@deepseek-ai/dsh-skill` 的 `renderSkillContent()`
 * （`lib/index.js` L57-81）**已经**产出 `<skill_resources>` 块，并逐字写着
 * "Load referenced resources only as needed." ⇒ **两层模型是宿主自己给的**；而
 * `SkillSummary` / `SkillDefinition` **没有任何列举子文件的位**（只有 `resourceBase` 一个基址）
 * ⇒ 宿主刻意留给 provider 的正是**这一半：枚举**。
 *
 * 六条硬性规则（逐条对应设计 §4.2，改这里先改那里）：
 *   ① **只枚举，不注入正文** —— 索引里**绝不**出现任何参考文件的正文；
 *   ② **确定性排序** = 相对路径的 **UTF-8 字节序**（🔴 **不用 mtime**：mtime 随检出漂移，
 *      会让每请求的注入文本抖动；对照 `src/cro.ts:101` 那份**落盘快照**用 {name,bytes,mtime} ——
 *      **同一件事两处的取舍相反，那个差异是判据不是巧合**）；
 *   ③ **有界 ＋ 响亮** —— 条数/字符各有上限，超出**必须显式写出还剩多少项**，**绝不静默截断**；
 *   ④ **摘要可复现** —— 取该文件首个 `#` 标题（剥 markdown 记号）；取不到 ⇒ 留空，**不编**；
 *   ⑤ **本体文件特殊标注** —— `skill.ttl` 存在 ⇒ 该行标 🧬 ＋ 顶部加一句"已建模"；
 *   ⑥ **范围 = `references/` 一级条目 ＋ `skill.ttl`** —— 子目录**给名字 ＋ 计数、不展开、不读正文**
 *      （🆕 2026-10-11 由**真实输入**逼出的修订：原写"不进子目录"，实测 `references/` 下确实有内容目录，
 *      只报"有 N 个子目录"不给名字 = **不可行动**；折中仍在裁决 Q2「只披露名字、不注入正文」的意图内）。
 *
 * 🔴 本文件**只认 `<skillDir>/skill.ttl`**（owner 裁决 Q6：静默、只认固定名）。
 *    `references/*-domain.ttl`（旧名）一律当**普通参考件**：不特殊对待、不告警 —— 那 14 份由 CCC 自行改名。
 * 🔴 「未建模」不是异常（裁决 Q6 ／ 判据 J9）：无 `skill.ttl` 的**普通 skill** 照常产出索引，
 *    **零告警、零误差** —— 增强必须对普通 skill 完全向后兼容。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 第二层占位口：本 skill 的本体约束文件（固定名，设计 §5.1） */
export const SKILL_ONTOLOGY_FILE = 'skill.ttl'

/** 参考件根（一级；不进子目录） */
export const REFERENCE_DIR = 'references'

/** 条数上限（超出 ⇒ 写"还有 N 项未列出"） */
export const RESOURCE_INDEX_MAX_ITEMS = 40

/** 字符上限（超出 ⇒ 尾部响亮标记；宿主侧另有更外层的预算） */
export const RESOURCE_INDEX_MAX_CHARS = 4 * 1024

/** 摘要长度上限（防单行超长标题把表格撑坏） */
const EXCERPT_MAX_CHARS = 60

/** 读文件头部字节数上限：摘标题只值读这么些（不为一行标题读整个大文件） */
const HEAD_BYTES = 4 * 1024

export interface ResourceIndexOptions {
  maxItems?: number
  maxChars?: number
}

interface ResourceItem {
  /** 相对 skill 目录的路径（如 `references/00-x.md` ／ `skill.ttl`）—— 模型据此 `read` */
  rel: string
  kind: 'file' | 'dir'
  /** 文件字节；目录 = 其下文件的总字节 */
  bytes: number
  /** 首个 `#` 标题（仅 `.md` 尝试；取不到 ⇒ ''）；目录 ⇒ 摘要写"子目录 · N 个文件" */
  excerpt: string
  /** 本体文件（固定名命中） */
  ontology: boolean
  /** 排序键：相对路径的 UTF-8 字节 */
  key: Buffer
}

/** 目录计数上限：防病态大树把一次注入拖慢（超出 ⇒ 报 `≥N`，仍然响亮） */
const DIR_SCAN_MAX_FILES = 1000

/**
 * 递归统计目录下的文件数与总字节（**只统计，不读内容**）。
 * 为什么递归：设计原写"不进子目录"，而**真实输入**显示 `references/` 下确有内容目录
 * （`home-rhetoric/references/corpus-subject-own`／`family-profiles/references/baby-handlebook`／
 * `home-serenity/references/diagram-lab`）⇒ 只报"有 N 个子目录"而**不给名字**是不可行动的。
 * 折中：**给名字 ＋ 计数，仍不展开、仍不读正文**（= 裁决 Q2「只披露名字、不注入正文」的意图内）。
 */
function scanDirStats(dir: string): { files: number; bytes: number; capped: boolean } {
  let files = 0
  let bytes = 0
  let capped = false
  const walk = (d: string): void => {
    if (capped || files >= DIR_SCAN_MAX_FILES) {
      capped = true
      return
    }
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (files >= DIR_SCAN_MAX_FILES) {
        capped = true
        return
      }
      const abs = join(d, name)
      let isDir = false
      let size = 0
      try {
        const st = statSync(abs)
        isDir = st.isDirectory()
        size = st.size
      } catch {
        continue
      }
      if (isDir) walk(abs)
      else {
        files++
        bytes += size
      }
    }
  }
  walk(dir)
  return { files, bytes, capped }
}

/** 按 UTF-8 **字节序**比较两个相对路径（规则②；不是 locale 比较、不是 mtime） */
function byByteOrder(a: ResourceItem, b: ResourceItem): number {
  return Buffer.compare(a.key, b.key)
}

/**
 * 千分位分组（规则②的延伸：**不依赖 locale**）。
 * 为什么不用 `toLocaleString()`：它随宿主 locale 变 ⇒ 同一目录在不同机器上产出**不同的注入文本**
 * （本仓已有一条「locale 稳健性」的挂账，不再添一处）。
 */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 取 markdown 首个 `#` 标题作摘要（规则④）。
 *
 * 细节（都由"可复现"推导）：
 *   · **跳过 YAML frontmatter**（`---` 开头到下一 `---`）—— 否则题名行会被当成正文标题；
 *   · 只读文件**头部** `HEAD_BYTES`（一行标题不值得读整个大文件）；
 *   · 剥掉行内记号（`*` `` ` `` `_` `#`）与首尾空白，压平内部连续空白；
 *   · 取不到 ⇒ `''`（**留空，不编** —— 编一个摘要等于让索引说假话）；
 *   · 超长截断时**留省略号**（与规则③同一精神：截断要看得见）。
 */
export function firstHeading(file: string): string {
  let head: string
  try {
    head = readFileSync(file, 'utf-8').slice(0, HEAD_BYTES)
  } catch {
    return ''
  }
  const lines = head.split(/\r?\n/)
  let start = 0
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        start = i + 1
        break
      }
    }
  }
  for (let i = start; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i] ?? '')
    if (!m) continue
    const clean = (m[1] ?? '')
      .replace(/[*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean === '') continue
    return clean.length > EXCERPT_MAX_CHARS ? `${clean.slice(0, EXCERPT_MAX_CHARS - 1)}…` : clean
  }
  return ''
}

/** 收集候选（`references/` 一级条目 ＋ 固定名本体），并按字节序排好 */
function collectItems(skillDir: string): ResourceItem[] {
  const items: ResourceItem[] = []

  const add = (rel: string, abs: string, ontology: boolean): void => {
    let bytes: number
    try {
      bytes = statSync(abs).size
    } catch {
      return // 读不到就不列（宁可少列，也不列出读不到的项）
    }
    items.push({
      rel,
      kind: 'file',
      bytes,
      excerpt: rel.endsWith('.md') ? firstHeading(abs) : '',
      ontology,
      key: Buffer.from(rel, 'utf-8'),
    })
  }

  const refDir = join(skillDir, REFERENCE_DIR)
  if (existsSync(refDir)) {
    let names: string[] = []
    try {
      names = readdirSync(refDir).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      const abs = join(refDir, name)
      let isDir = false
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        continue
      }
      const rel = `${REFERENCE_DIR}/${name}`
      if (isDir) {
        // 子目录：**给名字 ＋ 计数，不展开内容**（见 scanDirStats 的理由）
        const { files, bytes, capped } = scanDirStats(abs)
        items.push({
          rel,
          kind: 'dir',
          bytes,
          excerpt: `子目录 · ${capped ? `≥${groupThousands(files)}` : groupThousands(files)} 个文件`,
          ontology: false,
          key: Buffer.from(rel, 'utf-8'),
        })
        continue
      }
      add(rel, abs, false)
    }
  }

  const ontoAbs = join(skillDir, SKILL_ONTOLOGY_FILE)
  if (existsSync(ontoAbs)) add(SKILL_ONTOLOGY_FILE, ontoAbs, true)

  items.sort(byByteOrder)
  return items
}

/** 该 skill 是否已建模（只有固定名算 —— 裁决 Q6） */
export function hasSkillOntology(skillDir: string): boolean {
  return existsSync(join(skillDir, SKILL_ONTOLOGY_FILE))
}

/**
 * 生成第二层索引正文。
 *
 * @param skillDir skill 目录绝对路径
 * @param options 上限覆盖（缺省用本模块常量）
 * @returns 索引正文；**无可列项 ⇒ `''`**（规则⑥的一般化：`references/` 与 `skill.ttl` 都没有
 *          ⇒ 整块不产出 —— 空标题是噪声）。调用方按"空串不产出该块"处理。
 */
export function buildResourceIndex(skillDir: string, options: ResourceIndexOptions = {}): string {
  const maxItems = options.maxItems ?? RESOURCE_INDEX_MAX_ITEMS
  const maxChars = options.maxChars ?? RESOURCE_INDEX_MAX_CHARS

  const items = collectItems(skillDir)
  if (items.length === 0) return ''

  const modeled = items.some((i) => i.ontology)
  const shown = items.slice(0, maxItems)
  const hidden = items.length - shown.length

  const lines: string[] = [
    '### 本 skill 的参考件（第二层 · 按需读取）',
    '> 这里只有**清单**，没有正文：需要时用 `read` 打开下列路径（相对本 skill 目录）。',
  ]
  if (modeled) lines.push('> 🧬 **本 skill 已建模**：文字内容以 `skill.ttl` 为总约束。')
  lines.push('', '| 文件 | 摘要 | 字节 |', '|---|---|---|')
  for (const item of shown) {
    const label = item.kind === 'dir' ? `${item.rel}/` : item.rel
    const excerpt = item.ontology ? '🧬 本 skill 的本体约束（已建模）' : item.excerpt
    lines.push(`| ${label} | ${excerpt} | ${groupThousands(item.bytes)} |`)
  }
  if (hidden > 0) {
    // 规则③：**响亮** —— 必须说清还剩多少项，绝不静默截断
    lines.push('', `…**还有 ${hidden} 项未列出**（本层单次上限 ${maxItems} 项）。`)
  }

  const body = lines.join('\n')
  if (body.length <= maxChars) return body
  // 字符上限：**照样响亮**（截断可见，且不改排序/条目内容）
  return `${body.slice(0, maxChars)}\n…(第二层索引已按 ${groupThousands(maxChars)} 字符上限截断，原文 ${groupThousands(body.length)} 字符)`
}
