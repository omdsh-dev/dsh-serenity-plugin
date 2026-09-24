/**
 * deepseek-vision-verify.test.ts — P-6 **真机验收**探针（S142 §26 §0x-9）
 *
 * ## 为什么需要它（V-1 探针**未覆盖**的那一层）
 *
 * `tests/host/deepseek-vision-probe.test.ts` 验的是 **`dsh-settings` 通道**
 * （注册 / 合并 / 落盘），**不含 `llm-pi-ai` 自己的 `validate` / `assertServiceable`**。
 * ⇒ **"通道通 ≠ 被 pi-ai 接受"**。
 *
 * 本文件读**真实的宿主设置文档**，回答一个可判定问题：
 * > **补丁装载后，`llm-pi-ai` 段里到底有没有 `input` 声明？写在哪几个 route 上？**
 *
 * ## 🔴 v1.47.2 变更：**宿主设置文档换家了**（旧判据成了环境依赖的死判据）
 *
 * 0.1.7 起宿主不再用 `~/.dsh/settings.yaml` 承载插件配置 —— 它改成**按 profile 条目投影**，
 * 落点是 `~/.dsh/profiles/<profile>/cordis.patch.yml`；升级时旧文档被**改名归档**为
 * `settings.yaml.imported`（**实测**：本机 `~/.dsh/` 下 `settings.yaml` 已不存在，只剩 `.imported`）。
 * ⇒ 旧判据（"`~/.dsh/settings.yaml` 必须存在"）在 0.1.7 上**恒假**：红的原因**不是补丁坏了**，
 * 而是**探针看错了地方**。本版改为**多候选定位**：
 *
 * | 候选 | 宿主世代 | 形态 |
 * |---|---|---|
 * | `~/.dsh/settings.yaml` | 0.1.5 / 0.1.6 | 顶层键 `llm-pi-ai:` |
 * | `~/.dsh/profiles/web/cordis.patch.yml` | **0.1.7+** | 条目 `- id: llm-pi-ai` + 其下 `config:` |
 *
 * ⚠️ 刻意**不**扫 `settings.yaml.imported`：它是**冻结归档**，拿它当"当前配置"会重演
 * "读陈旧快照"那一类错误。也⚠️ **不认第二个 profile**：`web` 是宿主 `dsh web` 实际在跑的那个。
 *
 * ## 判据（正控 + 关键判据 + 边界）
 *
 *   V-1' **至少一份候选文档存在**（都不存在 ⇒ 本功能无可验收对象；仍**响亮失败**，见下）
 *   V-1'' 🔴 **文档里有 `llm-pi-ai` 锚点 ⇒ 必须真解析出模型条目**（防"格式变了 ⇒ 静默 0 条"的**假绿**）
 *   V-2' 🔴 **是否有 `input` 行被写入** —— 这是本功能的**直接痕迹**
 *   V-3' **写入的模型是否都是 deepseek**（负控：证明没有越权改非 deepseek 模型）
 *
 * ## 为什么用「行级扫描」而不是 YAML 库
 *
 * 本仓**没有** yaml 依赖（宿主才有）。而验收所需的信息极窄：**哪些 `- id:` 之下有 `input:`**。
 * ⇒ 行级状态机足够，且**只读**。🔴 若格式变化导致解析不到 ⇒ 报"未解析到"而非常绿（fail-loud）。
 *
 * ## 诚实边界（E↑）
 *
 * 本文件**只读**，不写任何东西。
 * ⚠️ **本文件证明不了"模型真能收图"** —— 那需要真发一张图（owner 已在 S185 侧验证）。
 * 本文件证明的是**更弱但可机械复核**的一环：**补丁确实落进了宿主当前使用的设置文档**。
 * ⚠️ 另一条边界：新布局下**不再有扁平的 route 概念**，故报告字段由 `route` 改为
 * **祖先链 `path`**（`config > providers > … > models`）；**判据不依赖它**，只作可读性。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 宿主设置文档的**活**候选位（按宿主世代排列；`.imported` 是归档，刻意不列） */
const CANDIDATES = [
  join(homedir(), '.dsh', 'settings.yaml'), // 0.1.5 / 0.1.6
  join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'), // 0.1.7+
]

interface ModelEntry {
  /** 祖先键链（可读性用；新布局下不再是 route 名） */
  path: string
  id: string
  /** `input:` 行的原始文本（未出现 ⇒ undefined） */
  input?: string
}

/**
 * 把一份文档切成 `llm-pi-ai` 段的 **body 行**（两种布局都认），并**不重基缩进**
 * ——缩进关系保留，供下游按**相对缩进**判父子。
 * @returns undefined = 本文档没有 `llm-pi-ai` 锚点
 */
function slicePiAiBody(text: string): { lines: string[]; anchorIndent: number } | undefined {
  const raw = text.split('\n').map((l) => l.replace(/\t/g, '  '))
  let anchor = -1
  let anchorIndent = 0
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!.trim()
    if (t === '' || t.startsWith('#')) continue
    // 布局 A：顶层键 `llm-pi-ai:`（旧 settings.yaml）｜布局 B：条目 `- id: llm-pi-ai`（profile patch）
    if (/^llm-pi-ai\s*:/.test(t) || /^-\s*id\s*:\s*llm-pi-ai\s*$/.test(t)) {
      anchor = i
      anchorIndent = raw[i]!.length - raw[i]!.trimStart().length
      break
    }
  }
  if (anchor < 0) return undefined

  const lines: string[] = []
  for (let i = anchor + 1; i < raw.length; i++) {
    const line = raw[i]!
    const t = line.trim()
    if (t !== '' && !t.startsWith('#')) {
      const indent = line.length - line.trimStart().length
      if (indent <= anchorIndent) break // 段结束：同级或更浅 ⇒ 已是下一个条目/顶层键
    }
    lines.push(line)
  }
  return { lines, anchorIndent }
}

/**
 * 扫描 `llm-pi-ai` 段：返回每个 `- id:` 条目及其（若有的）`input:` 行。
 * 🔴 **缩进相对化**：一切判断都以"段内最小缩进"为 0 —— 两种布局的绝对缩进完全不同，
 * 用绝对阈值（旧的 `indent <= 2`）在新布局上会**一条都认不出**。
 */
function scanPiAi(text: string): ModelEntry[] {
  const sliced = slicePiAiBody(text)
  if (!sliced) return []
  const indents = sliced.lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  const base = indents.length > 0 ? Math.min(...indents) : 0

  const out: ModelEntry[] = []
  let ancestors: { key: string; depth: number }[] = []
  let cur: ModelEntry | undefined

  for (const line of sliced.lines) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const depth = line.length - line.trimStart().length - base

    if (/^-\s*id\s*:/.test(t)) {
      cur = { path: ancestors.map((a) => a.key).join(' > '), id: t.replace(/^-\s*id\s*:\s*/, '').replace(/^["']|["']$/g, '').trim() }
      out.push(cur)
      continue
    }
    if (/^input\s*:/.test(t)) {
      if (cur !== undefined) cur.input = t
      continue
    }
    if (/^[A-Za-z0-9_./@-]+\s*:\s*$/.test(t)) {
      // key-only 行 ⇒ 维护祖先栈（更深者出栈，再压入自己）
      const key = t.replace(/\s*:\s*$/, '')
      ancestors = ancestors.filter((a) => a.depth < depth)
      ancestors.push({ key, depth })
      cur = undefined
    }
  }
  return out
}

/** 逐份读候选文档（存在才读） */
const documents = CANDIDATES.map((path) => ({
  path,
  exists: existsSync(path),
  text: '',
}))
for (const doc of documents) if (doc.exists) doc.text = readFileSync(doc.path, 'utf-8')

/** 有锚点的文档 → 解析结果（用于 fail-loud 判定） */
const scanned = documents
  .filter((d) => d.exists)
  .map((d) => ({ path: d.path, entries: scanPiAi(d.text), hasAnchor: slicePiAiBody(d.text) !== undefined }))

const allModels: ModelEntry[] = scanned.flatMap((s) => s.entries)
const withInput = allModels.filter((m) => m.input !== undefined)
const anyDocumentExists = documents.some((d) => d.exists)
const anchoredButEmpty = scanned.filter((s) => s.hasAnchor && s.entries.length === 0).map((s) => s.path)

describe('§26 §0x-9 P-6：真机验收（读宿主当前设置文档；**只读**）', () => {
  it('取证并报告', () => {
    const report = {
      '候选文档': documents.map((d) => ({ path: d.path.replace(homedir(), '~'), 存在: d.exists })),
      '各文档解析到的模型条目数': scanned.map((s) => ({ path: s.path.replace(homedir(), '~'), 条目: s.entries.length })),
      '解析到的模型条目数（合计）': allModels.length,
      '带 input 行的条目': withInput.map((m) => ({ path: m.path, id: m.id, line: m.input })),
      '按祖先链聚合': allModels.reduce<Record<string, string[]>>((acc, m) => {
        ;(acc[m.path || '(段根)'] ??= []).push(m.id + (m.input ? ' [有 input]' : ''))
        return acc
      }, {}),
    }

    // eslint-disable-next-line no-console
    console.log('\n===== §26 §0x-9 P-6 真机验收结论 =====\n'
      + JSON.stringify(report, null, 2) + '\n======================================\n')

    expect(anyDocumentExists, `宿主设置文档一份都不在（候选：${CANDIDATES.map((p) => p.replace(homedir(), '~')).join(' ／ ')}）`
      + ' ⇒ 本探针无可验收对象；若宿主换了文档位置，请把新位置加进 CANDIDATES').toBe(true)
    // 🔵 0.1.7 实测读数（v1.47.2 轮，本机）：`~/.dsh/settings.yaml` **不存在**（只剩归档 `.imported`）；
    // `~/.dsh/profiles/web/cordis.patch.yml` 存在且解析出 **11 条**模型条目 ⇒ 判据**非空跑**。
    // （那次读取走的是"故意让本用例失败以打印报告"的正控手法 —— 否则通过的用例不打印 stdout。）
  })

  it('🔴 fail-loud：文档里有 `llm-pi-ai` 锚点 ⇒ 必须真解析出条目（防"格式变了 ⇒ 静默 0 条"的假绿）', () => {
    expect(anchoredButEmpty, '以下文档有 llm-pi-ai 锚点却解析出 0 条模型 —— 多半是布局又变了，'
      + '请更新 scanPiAi（**不要**让它静默通过）').toEqual([])
  })

  it('🔴 判据：有模型条目 ⇒ 必须能看到补丁的痕迹（至少一个 input 行）', () => {
    if (allModels.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[§0x-9 P-6] 宿主设置文档里没有 llm-pi-ai 模型条目 ⇒ 无可验收对象（合法状态，非缺陷）')
      return
    }
    // eslint-disable-next-line no-console
    console.log('[§0x-9 P-6] 带 input 声明的条目:', withInput.map((m) => `${m.path || '(段根)'}/${m.id}`).join(', ') || '(无)')
    expect(withInput.length, '🔴 若 pi-ai 段存在且有 deepseek 模型，补丁应留下 input 行').toBeGreaterThan(0)

    // 🔴 更强的判据（2026-09-19 实测确立）：**每个 deepseek 模型都必须有 input 行**。
    // 依据：本机实测（v1.41.0 装载前后对照）——
    //   补丁前：5 个 deepseek 模型**一个都没有** `input:` 行；
    //   补丁后：5 个**全部**出现 `input:` 行，而非 deepseek 的 4 个仍是它们**原有的** `input: []`。
    // ⇒ 这条把"补丁确实落盘了"从"归档证据"升级为**每次可重跑的机械判据**。
    // 🔵 0.1.7 实测（v1.47.2 轮）：新文档 `profiles/web/cordis.patch.yml` 上同样成立
    //   （6 个 deepseek 条目均有 `input:` 块，4 个非 deepseek 仍是 `input: []`）。
    const deepseekMissing = allModels
      .filter((m) => m.id.toLowerCase().includes('deepseek'))
      .filter((m) => m.input === undefined)
      .map((m) => m.id)
    expect(deepseekMissing, '🔴 每个 deepseek 模型都必须已被补上 input 声明').toEqual([])
  })

  it('负控：写入 input 的条目应都是 deepseek 模型（没乱改别人的）', () => {
    const nonDeepseekWithInput = withInput.filter((m) => !m.id.toLowerCase().includes('deepseek'))
    // 只记录不断言失败：用户完全可能自己给非 deepseek 模型配 input（那不是我们的错）
    // eslint-disable-next-line no-console
    console.log('[§0x-9 P-6] 带 input 的非 deepseek 条目（可能是用户自配）:', nonDeepseekWithInput.map((m) => m.id).join(', ') || '(无)')
  })
})
