/**
 * identifier-ascii.test.ts — **标识符位不得出现非 ASCII 字符**（2026-10-19）
 *
 * ## 为什么需要这条判据（它是一次真实事故的沉淀）
 *
 * 2026-10-19 `skiff` → 「轨迹约束」的批量改名，把规则**应用到了标识符位置**，
 * 于是代码里长出了 `interface 轨迹约束MsmGate` / `function 轨迹约束ToolWhitelist` /
 * `const 轨迹约束Keeper` 这样的标识符（实测 **10 处 / 3 文件**）。
 *
 * ## 🔴 为什么四道门一个都没抓到（这是本条判据存在的全部理由）
 *
 * | 门 | 为什么漏 |
 * |---|---|
 * | `typecheck` | **TS 允许中文标识符**（ECMAScript ID_Start 含 CJK）⇒ 完全合规 |
 * | `test` | 行为零变化 ⇒ 全绿 |
 * | `pack-check` | 只核文件集与产物清单 ⇒ 看不见标识符 |
 * | `privacy-scan` | 只查真实路径/私有名 ⇒ 中文标识符不在它管的面 |
 *
 * ⇒ **"合法"与"可维护"是两件事**。编译器认为它合法，而人类读者会被绊住；
 * 更糟的是它**看起来像已完成**（能跑能测），实际留了尾巴。
 *
 * ## 判据的边界（⚠️ 只查标识符位，不查字符串/注释）
 *
 * 中文**可以**出现在：注释、字符串字面量（用户可见文案）、模板字符串。
 * 那些是**内容**，本来就应该能写中文。**只有标识符位**被禁。
 *
 * 这也是为什么本文件用**结构化匹配**而不是 `grep 中文` ——
 * 后者会把注释与文案里的中文全部打红（本仓注释几乎全中文，那样等于判据恒红 = 判据失效）。
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(here, '..', 'src')

/** 递归收集 src 下的 .ts/.tsx（与 coverage-gate 同款扫描域：**发布物的真实边界**） */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(abs, out)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(abs)
    }
  }
  return out
}

/**
 * 剥掉注释与字符串字面量（**判据必须作用在"代码"上，不是内容上**）。
 *
 * ⚠️ 这是个**够用的近似**，不是完整词法器：它不理解嵌套模板字符串的 `${...}`。
 * 对本判据足够，因为违规形态（`function 中文名`）**一定不在字符串里** ——
 * 若某个中文标识符恰好被误剥，那它本来也不是真标识符。
 *
 * 🔴 已知边界：字符串里的 `//` 会被误当注释起点（本仓源码无 URL 字面量，实测无影响）。
 */
function stripCommentsAndStrings(code: string): string {
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < code.length) {
    const c = code[i]!
    const n = code[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'single'; i++; continue }
      if (c === '"') { mode = 'double'; i++; continue }
      if (c === '`') { mode = 'template'; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue } i++; continue }
    if (mode === 'single') { if (c === '\\') { i += 2; continue } if (c === "'") mode = 'code'; i++; continue }
    if (mode === 'double') { if (c === '\\') { i += 2; continue } if (c === '"') mode = 'code'; i++; continue }
    if (mode === 'template') { if (c === '\\') { i += 2; continue } if (c === '`') mode = 'code'; i++; continue }
  }
  return out
}

/**
 * 一个声明关键字后面紧跟的名字必须是 ASCII。
 *
 * 覆盖本仓实际出现过的全部形态：`interface` / `function` / `const` / `let` / `var` / `class` / `type`。
 *
 * 🔴 **`\w` 不能用来吃名字的后半截**（本判据的第一版就栽在这里）：JS 的 `\w` = `[A-Za-z0-9_]`，
 * **不匹配 CJK** ⇒ `(非ASCII)([\w$]*)` 只会抓到第一个汉字（`轨迹约束MsmGate` 被抓成 `轨`）。
 * ⇒ 名字体用**"非分隔符"的宽集**：`[^\s;{}(),=:<>\[\]]*`（够吃到 `轨迹约束MsmGate` 整串）。
 */
const DECLARATION_NON_ASCII = new RegExp(
  String.raw`(?:^|[\s;{}(])(?:export\s+)?(?:declare\s+)?(?:default\s+)?` +
    String.raw`(?:interface|function|const|let|var|class|type)\s+` +
    String.raw`([^\x00-\x7F][^\s;{}(),=:<>\[\]]*)`,
  'gm',
)

describe('标识符形态：不得出现非 ASCII（改名事故的机械判据）', () => {
  const files = collectSourceFiles(SRC_DIR)

  it('扫描域非空（防假绿：扫不到文件时下面的断言会"全过"）', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('🔴 src 下没有任何「声明位用非 ASCII 标识符」的代码', () => {
    const violations: string[] = []
    for (const file of files) {
      const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'))
      for (const m of stripped.matchAll(DECLARATION_NON_ASCII)) {
        const line = stripped.slice(0, m.index).split('\n').length
        violations.push(`${relative(SRC_DIR, file)}:${line} → ${JSON.stringify(m[1])}`)
      }
    }
    expect(violations, `发现 ${violations.length} 处中文/非 ASCII 标识符：\n${violations.join('\n')}`).toEqual([])
  })

  /**
   * 🔴 **对照（防假绿，本仓纪律：否定性判据必须自带正控）**：
   * 把一段必然违规的样本喂给同一个检测器，它**必须**抓得到。
   * 没有这一条，上面那个 `toEqual([])` 可能因为正则写错而永远为真。
   */
  it('对照：检测器能抓到样本里的违规（证明它不是空操作）', () => {
    const sample = [
      'interface 轨迹约束MsmGate { a: string }',
      'export function 轨迹约束ToolWhitelist(): void {}',
      'const 轨迹约束Sessions = new Map()',
      'export type 轨迹约束Kind = string',
    ].join('\n')
    const hits = [...sample.matchAll(DECLARATION_NON_ASCII)].map((m) => m[1])
    expect(hits).toEqual(['轨迹约束MsmGate', '轨迹约束ToolWhitelist', '轨迹约束Sessions', '轨迹约束Kind'])
  })

  it('对照：注释与字符串里的中文**不算违规**（判据只作用在标识符位）', () => {
    const sample = [
      '// 这是中文注释：interface 轨迹约束Fake {}',
      "const msg = '中文文案：function 轨迹约束AlsoFake()'",
      'const t = `模板里的 轨迹约束 不算`',
      'const legit = 1',
    ].join('\n')
    const stripped = stripCommentsAndStrings(sample)
    expect([...stripped.matchAll(DECLARATION_NON_ASCII)]).toEqual([])
    // 正控：剥完之后代码本体还在（否则上面的"无命中"可能是剥太狠）
    expect(stripped).toContain('const legit = 1')
  })

  /**
   * ## 🔴 「文案混排」这条判据**我试了三版，最后决定不要它** —— 过程必须留档
   *
   * 起因：事故里有一句 `'register/deregister is not allowed in 轨迹约束 sessions'`，
   * 我把它抽象成"英文错误文案不得中英混排"，试图机械化。三版全错：
   *
   * | 版 | 定义 | 结果 |
   * |---|---|---|
   * | ① | 含 CJK ＋ 含 ≥3 字母 ASCII 词 | **误伤 6 处**（`'CRO 执行失败（bun 与 node 均不可用）'` 等） |
   * | ② | `ASCII词 CJK ASCII词` 的形态 | 误伤 1 处（`'飞书 SDK 缺少 im.v1.message.create'`） |
   * | ③ | 以英文起句且含 CJK | **仍误伤 4 处**（`'target 为空（须 S###…）'` 正是正常中文） |
   *
   * **为什么全错（根因，比判据本身值钱）**：中文技术文案里**本来就会嵌 ASCII 术语**
   * （`target` / `appId` / `bun` / `node` / `SDK`），而且它们**经常出现在句首**。
   * ⇒ **「中英混排」不是一个可由句子形态判定的属性**。想机械化它，只能得到
   *   「要么漏、要么误伤一大片」的判据 —— 而**误伤的中文提示语本身是正确的**。
   *
   * **正确的做法**：只查**标识符位**（上面第一条判据，形态明确、零误伤，已做变异对照）。
   * 那句事故文案的根因是「**标识符被改名机改成了中文**」——标识符判据已经覆盖了它的来源；
   * 文案本身**作为中文提示语是完全合法的**，不该被判据追杀。
   *
   * ⇒ **本条判据不是"漏了"，是"判定为不可机械化，因此不做"**（本仓纪律：否定性结论要写清扫描域与上限）。
   */

  /**
   * 🔴 反面对照（保住上面那段结论不腐烂）：若谁将来又想加"文案混排"判据，
   * 这两条对照会立刻告诉他"这个方向会误伤"。
   */
  it('对照：为什么「文案混排」不可机械化（保留反例，防止后人重走这条路）', () => {
    /** 任何"含 CJK 就算混排"的判据，都会把这些**正确的中文提示语**打红 */
    const legitimateChineseMessages = [
      'CRO 执行失败（bun 与 node 均不可用）',
      'appId 与 appSecret 都必须填（只填一个等于没绑）',
      'target 为空（须 S### 或 AGENT_SESSIONS 目录名）',
      'message 为空（唤醒必须携带一条信息）',
      '飞书 SDK 缺少 im.v1.message.create',
    ]
    // 它们全都含 CJK 与 ASCII —— 若判据只看"是否两者兼有"，就会全部误伤
    for (const msg of legitimateChineseMessages) {
      expect(/[\u4e00-\u9fff]/.test(msg), `${msg} 应含中文`).toBe(true)
      expect(/[A-Za-z]{2,}/.test(msg), `${msg} 应含英文术语`).toBe(true)
    }
    // ⇒ 结论：这些是正确的，**不得**被判据打红。据此，文案混排判据不成立。
    expect(legitimateChineseMessages.length).toBeGreaterThan(0)
  })
})
