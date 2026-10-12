/**
 * skill-layering.ts（库层，零 DSH 依赖）— **EAP 分层抽象树档（A3）的机械判据**
 *
 * 缘起（owner 2026-10-12 令「**根据本次经验完善 serenity-skill-creator；确保未来创建和改进 skill
 * 都保持 EAP 分层抽象树结构**」）：本轮 dsp 开发 skill 的切片**把树倒置了** —— SKILL.md 被切成
 * 3.4 KB 的**导航层**（只指向下、不说顶层的话），而顶层该说的"身份/模型/约束"全沉到了 references/。
 * 那次事故的**形状是机械可查的**，所以把它固化成判据，而不是只写进方法正文（D119 同族：
 * 「写进文档的规则」不会拦住下一次，**能跑起来的判据才会**）。
 *
 * 🔴 **本档与 A1/A2 的分工**：
 *   · A3 判的是**文字住在哪一层**（结构形态）—— **每个 skill 都适用**，与有没有 `skill.ttl` 无关。
 *   · A1/A2 判的是**本体**（结构合法性 ＋ 链上基础链）—— 只有已建模的 skill 适用（J9：未建模不是异常）。
 *
 * 🔴 **只报不改**：本档给的是判据与可行动修法；改写 SKILL.md 是作者/模型的活（语义判断不在机械档）。
 * 🔴 **不重写别人的规则**：references 参考件的**首标题**规则归 `resource-index.ts`（`firstHeading`），
 *    这里只做"列出 references/ 下一级 .md"这一件事。
 *
 * ⚠️ **编号消歧（必读）**：本档叫 **A3**，但**与 v1.54.0 记录里那个"已下线的 A3（引用可兑现）"
 *    不是同一档** —— 那一条是照引擎源码"意图"推断的，实测打假后**决定不写第二实现**。
 *    本条是 2026-10-12 **新立**的**分层形态**档（判"文字住在哪一层"），与"引用可兑现"无关。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REFERENCE_DIR } from './resource-index.js'

/** 顶层正文（去掉 frontmatter 与生成的导航块）的**下限**：低于它 = 顶层只是桩 */
export const TOP_LAYER_MIN_BYTES = 2048

/** 生成块（第二层清单）的哨兵 —— 它由 `skill-lint split` / 生成器产出，**不算顶层正文** */
export const NAV_BLOCK_BEGIN = '<!-- skill-lint:split-nav -->'
export const NAV_BLOCK_END = '<!-- /skill-lint:split-nav -->'

/**
 * "本文件只是导航层"这类**自述** —— 它是树倒置的**直接症状**（顶层自己声明什么都不说）。
 * 正常 skill 不会写这句话 ⇒ 这条判据**几乎不会假阳**。
 */
export const NAV_SELF_DESCRIPTION =
  /(?:只是|仅作|仅仅是|只留|只剩|纯)(?:一个)?导航(?:层|文件|块)|导航(?:层|块)(?:而已|罢了)/

export interface LayeringFinding {
  code: 'A3-1' | 'A3-2' | 'A3-3'
  detail: string
}

export interface LayeringReport {
  /** 是否有 SKILL.md */
  hasSkillMd: boolean
  /** 顶层正文字节（已扣 frontmatter 与导航块） */
  topBodyBytes: number
  /** 被扣掉的导航块字节（用于自证扣了什么） */
  navBlockBytes: number
  /** A3-2 命中行（原文，截断展示） */
  navSelfDescriptions: string[]
  /** references/ 一级下的 .md 名单 */
  referenceDocs: string[]
  /** A3-3：顶层全文里**没被点名**的参考件 */
  notNamedInTop: string[]
  findings: LayeringFinding[]
  ok: boolean
}

/** 去掉 YAML frontmatter（`---` 包起来的那段） */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  const after = text.indexOf('\n', end + 1)
  return after === -1 ? '' : text.slice(after + 1)
}

/** 扣掉生成块；返回 [剩下的正文, 被扣掉的字节数] */
function stripNavBlock(text: string): [string, number] {
  const begin = text.indexOf(NAV_BLOCK_BEGIN)
  if (begin === -1) return [text, 0]
  const end = text.indexOf(NAV_BLOCK_END, begin)
  if (end === -1) return [text, 0]
  const cut = text.slice(begin, end + NAV_BLOCK_END.length)
  return [text.slice(0, begin) + text.slice(end + NAV_BLOCK_END.length), Buffer.byteLength(cut, 'utf-8')]
}

/** references/ **一级**下的 .md（子目录不展开 —— 与第二层披露同口径：子目录按"名字＋文件数"入表） */
export function listReferenceDocs(skillDir: string): string[] {
  const dir = join(skillDir, REFERENCE_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
}

/**
 * 对一个 skill 目录跑 A3 档。
 * 🔴 三条判据各自**独立**（一条不过不掩盖另一条），全部机械、全部可复跑。
 */
export function analyzeSkillLayering(skillDir: string): LayeringReport {
  const skillMd = join(skillDir, 'SKILL.md')
  const findings: LayeringFinding[] = []
  if (!existsSync(skillMd)) {
    return {
      hasSkillMd: false,
      topBodyBytes: 0,
      navBlockBytes: 0,
      navSelfDescriptions: [],
      referenceDocs: listReferenceDocs(skillDir),
      notNamedInTop: [],
      findings: [{ code: 'A3-1', detail: '没有 SKILL.md —— skill 的身份与顶层都无处安放' }],
      ok: false,
    }
  }

  const raw = readFileSync(skillMd, 'utf-8')
  const [withoutNav, navBlockBytes] = stripNavBlock(stripFrontmatter(raw))
  const topBodyBytes = Buffer.byteLength(withoutNav.trim(), 'utf-8')

  // A3-1 顶层非桩
  if (topBodyBytes < TOP_LAYER_MIN_BYTES) {
    findings.push({
      code: 'A3-1',
      detail:
        `顶层正文只有 ${topBodyBytes} B（< ${TOP_LAYER_MIN_BYTES}）—— 顶层必须自己说清`
        + '「身份与边界 ／ 用途与触发 ／ 领域模型（形状）／ 永远成立的约束 ／ 抽象树读法」，'
        + '不能只列文件名把读者转手给下层（EAP：顶层说顶层的话）',
    })
  }

  // A3-2 顶层不许自述"我只是导航层"
  const navSelfDescriptions: string[] = []
  for (const line of withoutNav.split('\n')) {
    if (NAV_SELF_DESCRIPTION.test(line)) {
      const t = line.trim()
      navSelfDescriptions.push(t.length > 160 ? `${t.slice(0, 160)}…` : t)
    }
  }
  if (navSelfDescriptions.length > 0) {
    findings.push({
      code: 'A3-2',
      detail:
        `顶层自称"只是导航层/只剩下导航" ×${navSelfDescriptions.length} —— 这是**树倒置的直接症状**：`
        + '顶层声明自己什么都不说，读者拿不到任何上层陈述。修法 = 把下层的**顶层陈述**上提'
        + '（hoist：从原处**删除并留指针**，一条内容只有一个家），不是加一句话辩解',
    })
  }

  // A3-3 树可下潜：references/ 一级 .md 必须被 SKILL.md 点名（导航块里点名也算 —— 那是生成物）
  const referenceDocs = listReferenceDocs(skillDir)
  const notNamedInTop = referenceDocs.filter((d) => !raw.includes(d))
  if (notNamedInTop.length > 0) {
    findings.push({
      code: 'A3-3',
      detail:
        `references/ 下有 ${notNamedInTop.length} 件没在 SKILL.md 里点名：${notNamedInTop.join(' ／ ')}`
        + ' —— 顶层是**抽象树的地图**：不点名，读者就不知道存在这棵子树（第二层清单会自动补，'
        + '但顶层该说"什么时候该下潜到哪一件"）',
    })
  }

  return {
    hasSkillMd: true,
    topBodyBytes,
    navBlockBytes,
    navSelfDescriptions,
    referenceDocs,
    notNamedInTop,
    findings,
    ok: findings.length === 0,
  }
}

/** 渲染给人/模型看的一段（工具面直接用） */
export function formatLayeringReport(skillName: string, r: LayeringReport): string {
  const head = r.ok
    ? `✅ A3 分层档：通过（顶层正文 ${r.topBodyBytes} B ／ 导航块 ${r.navBlockBytes} B ／ 参考件 ${r.referenceDocs.length} 件全部点名）`
    : `❌ A3 分层档：${r.findings.length} 条不过`
  const lines = [head]
  for (const f of r.findings) lines.push(`   · [${f.code}] ${f.detail}`)
  if (r.ok) {
    lines.push(
      `   （判据：顶层非桩 ≥ ${TOP_LAYER_MIN_BYTES} B ／ 顶层不自述"只是导航" ／ references/ 一级 .md 全部被点名）`,
    )
  }
  if (!r.ok) {
    lines.push('   👉 修完重跑 `check`。方法正文见 `guide` 的「分层抽象树」一节。')
  }
  return lines.join('\n')
}
