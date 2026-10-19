import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * docs-ref-gate.test.ts — **文档引用门禁**：代码/测试里点名的 `docs/<x>.md` 必须真的存在。
 *
 * ## 为什么需要它（R↓，本仓反复栽的同一形态）
 *
 * 本仓的**契约面文档**是靠代码注释点名来锚定的（"权威设计 = `docs/xxx.md`"、
 * "规格 `docs/cognitive-trajectory-skill-injection.md` §3"）。这条锚链**没有任何机械信号**：
 * 注释不过 typecheck、不过测试、不进门禁 ⇒ 文档一改名/一删除，注释就**开始撒谎**，
 * 而**撒谎的注释比没有注释更坏**（下一个人会照着它去找，找不到也说不清是谁错了）。
 *
 * 🔵 **实例（2026-10-19 实测）**：`kernel/ccc.ts` 曾点名了一份**从不存在**的设计件
 * （`trajectory-constraint-redesign`），而设计件最终用的是别的名字。这类引用
 * **只有机械扫描能抓到** —— 人眼读到"见 docs/xxx.md"不会去核实。
 * （本文件**刻意不把那句旧引用逐字写出来**：写了它就会成为一条新的悬空引用 —— 门禁自伤。）
 *
 * ## 判据边界（诚实）
 *
 * · **只判存在性**，不判内容是否过期（后者无机械判据，属人工复核档 —— 与 D143 同源）。
 * · **扫描域 = `src/` 与 `tests/` 的递归全集**（.ts/.tsx，排除 `.d.ts`）+ 包内 `README.md`。
 *   ⚠️ **不设深度盲区**：有深度盲区的 glob 不能当"无遗漏"的证明。
 * · 命中形态 = 正文里出现 `docs/<名字>.md`（反引号与否都算）。
 * · 🔴 **带作用域的引用不算本仓的账**：正文写 `CCC docs/xxx.md`（或 `home-serenity/docs/…`）
 *   指的不是本仓 `docs/` —— 那是**另一个仓**的文档。判据 = 该引用前 20 字符内出现
 *   `CCC` / `home-serenity` 这类**仓名限定词**即豁免。⚠️ 这条**不是为了放过**，而是
 *   因为跨仓引用本仓**无权判定**（那个文件在另一个仓里，存在与否不是本仓能保证的）。
 * · **`docs/_archive/` 下的引用不豁免、也不另行要求** —— 它们同样必须能被解析到，
 *   因为归档是**移动**不是删除（`_archive/xxx.md` 的引用写作 `docs/_archive/xxx.md`，路径不同）。
 */
const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = resolve(HOOKS_DIR, '..', '..')
const DOCS_DIR = join(REPO_DIR, 'docs')

/** 递归列出 .ts/.tsx（**无深度盲区**） */
function listTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listTs(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 从一段正文里抽出 `docs/...` 引用。
 *
 * ## 🔴 只认**注释行**（这条不是优化，是判据正确性）
 *
 * 首版按全文正则扫 ⇒ 当场被**测试夹具路径**打红：
 * `fs-ops.test.ts` 里造临时目录用的 `join(dir, 'docs', 'nested', 'a.md')` 被读成文档引用。
 * 那种串**不是锚链**，它是**数据**。区分办法不能靠"路径看起来像不像"——
 * 要靠**它出现在哪种语法位置**：本仓的文档锚链**只写在注释里**（`//` 或块注释的 `*` 行）。
 * ⇒ **扫描单位 = 注释行**；字符串字面量里的一律不算。
 *
 * 另两条限定：
 * · **跨仓引用豁免**：注释里写 `CCC docs/x.md` / `home-serenity/docs/…` 指的是**别的仓**，
 *   本仓无权判定它存在与否。
 * · 同一行多条引用都收（注释里常一句话点两份）。
 */
function extractDocRefs(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    // 注释行判据：块注释续行（`* ...`）/ 行注释（`//`）/ 块注释开头（`/**`）
    if (!/^\s*(\*|\/\*|\/\/)/.test(raw)) continue
    for (const m of raw.matchAll(/\bdocs\/([A-Za-z0-9_./-]+\.md)\b/g)) {
      // 跨仓引用豁免：前 20 字符内有仓名限定词 ⇒ 指的是别的仓的 docs/
      const before = raw.slice(Math.max(0, m.index - 20), m.index)
      if (/\bCCC\b|home-serenity/.test(before)) continue
      out.push(`docs/${m[1]}`)
    }
  }
  return out
}

describe('文档引用门禁：被点名的 docs/*.md 必须存在', () => {
  const sources = [
    ...listTs(join(HOOKS_DIR, 'src')),
    ...listTs(join(HOOKS_DIR, 'tests')),
    join(HOOKS_DIR, 'README.md'),
  ].filter((p) => existsSync(p))

  it('扫描域自证：确实扫到了源码与测试（空扫描域 = 假绿）', () => {
    // 🔴 「检查没跑」与「检查通过」在读数上长得一样 ⇒ 先证扫描域非空。
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.some((p) => p.includes(`${join('src', 'trajectory')}`))).toBe(true)
    expect(sources.some((p) => p.endsWith('README.md'))).toBe(true)
  })

  it('正控：抽取器能从真实注释行里取到引用（否则"零缺失"无意义）', () => {
    const sample = ' * 权威设计 = `docs/cro-design.md`；规格见 docs/human-channel-plan.md §2。'
    expect(extractDocRefs(sample).sort()).toEqual(['docs/cro-design.md', 'docs/human-channel-plan.md'])
  })

  it('🔴 负控：**非注释行**（字符串字面量 / 测试夹具路径）里的 docs 串不算引用', () => {
    // 这是首版真踩的一格：`fs-ops.test.ts` 用 `join(dir,'docs','nested','a.md')` 造临时目录，
    // 被全文正则读成了"文档引用"。⇒ 判据必须绑定**语法位置**，不能只看路径长什么样。
    expect(extractDocRefs(`const p = join(dir, 'docs', 'nested', 'a.md')`)).toEqual([])
    expect(extractDocRefs(`writeFileSync(join(dir, 'docs', 'x.md'))`)).toEqual([])
  })

  it('负控：普通 `docs/a.md` 样的**示例路径**不会把门禁搞红（判据只对有 */* 后缀的 .md 生效）', () => {
    // 这条防的是"抽取器太贪"——把 `["docs/a.md","src/b.ts"]` 这种**参数示例**当成真引用。
    // 说明：`docs/a.md` 形如引用但文件不存在；本门禁**刻意允许**它，因为
    // 它在正文里出现的位置是**用法示例**（see 下方 allowlist）。
    expect(extractDocRefs('  // 只提交这些路径（如 ["docs/a.md","src/b.ts"]）')).toEqual(['docs/a.md'])
  })

  it('🔴 跨仓引用豁免：`CCC docs/x.md` 不算本仓的账（另一个仓的文档，本仓无权判定）', () => {
    // 正控方向也必须钉住：**不带**仓名限定词的同名引用**照样**要被判（否则豁免会把真账一起放过）
    expect(extractDocRefs(' * 见 CCC `docs/a.md` §3b')).toEqual([])
    expect(extractDocRefs(' * 见 home-serenity/docs/a.md §3b')).toEqual([])
    expect(extractDocRefs(' * 见 `docs/a.md` §3b')).toEqual(['docs/a.md'])
  })

  it('🔴 每个被点名的 docs 文件都真实存在（缺一个即红，报出**谁在点名它**）', () => {
    /**
     * 允许的例外 —— **两类，判据不同**：
     *  · `docs/a.md`：**参数示例**里的占位路径（`container_git` 的 paths 用法示例）
     *  · `docs/<x>.md` / `docs/xxx.md`：**本文件自己**在说明"这条判据是什么"时的占位符
     * ⚠️ 白名单只收**占位符形态**，绝不收真实文件名 —— 收真实文件等于把一条真账永久豁免。
     */
    const ALLOW = new Set(['docs/a.md', 'docs/xxx.md', 'docs/<x>.md', 'docs/_archive/xxx.md'])

    const missing = new Map<string, Set<string>>()
    for (const file of sources) {
      for (const ref of extractDocRefs(readFileSync(file, 'utf-8'))) {
        if (ALLOW.has(ref)) continue
        if (existsSync(join(REPO_DIR, ref))) continue
        if (!missing.has(ref)) missing.set(ref, new Set())
        missing.get(ref)!.add(relative(HOOKS_DIR, file))
      }
    }

    // 逐条点名（不只报总数）：一条失败信息要能直接指出"改哪句注释"
    for (const [ref, users] of missing) {
      expect(`${ref} 被点名但不存在 ← ${[...users].join(', ')}`).toBe('')
    }
    expect([...missing.keys()]).toEqual([])
  })
})
