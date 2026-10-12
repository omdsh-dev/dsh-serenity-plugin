/**
 * resource-index-catalog.test.ts — **目录面**（`SkillSummary.description`）的名字清单判据
 *
 * 缘起（owner 裁决 O2，2026-10-12）：`available_skills` 里看不到 `references/`。
 * 取证结论 = 宿主契约里 `SkillSummary` **只有 name/description/whenToUse**（无资源清单字段）
 * ⇒ 参考件只能挂 `description`，且**必须自动生成**（手写必漂）。
 *
 * 🔴 本件要钉的性质里有一条**别的测法都钉不住**：**目录面不读任何文件正文**。
 *    目录面是"**每请求 × 每个 skill**"的路径（38 个 skill 每轮都算一遍），而摘要（`firstHeading`）
 *    要为每个 `.md` 读文件头 —— 把每请求预算烧在目录面没人看的摘要上，是这条通路唯一真实的成本风险。
 *    ⇒ 这里**插桩 `readFileSync` 计数**，并用**差分正控**判"探针不瞎"：
 *       同一个目录，**载入面必须读 > 0 次**，**目录面必须 0 次**。
 *    （`vi.spyOn(node:fs, …)` 在本仓不可用 —— 内置模块导出是不可重定义属性 ⇒ 走 `vi.mock`。）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildResourceIndex, buildResourceNames, buildResourceNameSuffix, REFERENCE_DIR, SKILL_ONTOLOGY_FILE } from '../src/skills/resource-index.js'

/** `readFileSync` 调用计数（差分正控用；只计**被测模块**发起的读 —— 见 mock 说明） */
const reads = { n: 0 }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      reads.n++
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.readFileSync,
  }
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'res-idx-cat-'))
  reads.n = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ref(name: string, body: string): void {
  mkdirSync(join(dir, REFERENCE_DIR), { recursive: true })
  writeFileSync(join(dir, REFERENCE_DIR, name), body)
}

describe('目录面 · 参考件名字清单（O2）', () => {
  // ── 🔴 差分正控：这条是"不读正文"的**唯一可机械判的形状** ──────────────────
  it('🔴 成本形态：同一目录上，**目录面 0 次读正文**，而**载入面必读**（探针不瞎的正控）', () => {
    ref('00-a.md', '# 甲标题\n正文\n')
    ref('10-b.md', '# 乙标题\n正文\n')

    // 目录面：绝不能读（它是每请求 × 每 skill 的路径）
    buildResourceNames(dir)
    buildResourceNameSuffix(dir)
    expect(reads.n).toBe(0)

    // 正控：同一个目录上，载入面（要取首标题当摘要）**必然读** ⇒ 计数探针确实在工作
    const before = reads.n
    const idx = buildResourceIndex(dir)
    expect(reads.n).toBeGreaterThan(before)
    expect(idx).toContain('甲标题') // 顺带证明"读到的确实是那些正文"
  })

  // ── 正控：名字与顺序 ────────────────────────────────────────────────────
  it('名字 = 基名；顺序同索引（UTF-8 字节序）；子目录带尾 `/`；本体文件在列', () => {
    ref('00-a.md', '# A\n')
    ref('10-b.md', '# B\n')
    mkdirSync(join(dir, REFERENCE_DIR, 'sub'), { recursive: true })
    writeFileSync(join(dir, REFERENCE_DIR, 'sub', 'inner.md'), '# 内层\n')
    writeFileSync(join(dir, SKILL_ONTOLOGY_FILE), '@prefix sr: <x> .\n')

    const { names, hidden } = buildResourceNames(dir)
    // `references/*` 的 rel 以 'r' 开头，`skill.ttl` 以 's' 开头 ⇒ 字节序上参考件全在本体文件之前
    expect(names).toEqual(['00-a.md', '10-b.md', 'sub/', SKILL_ONTOLOGY_FILE])
    expect(hidden).toBe(0)

    // 与索引**同源**：索引里出现的条目，目录面一件不少（只少了摘要与字节这两列）
    const idx = buildResourceIndex(dir)
    for (const n of names) expect(idx).toContain(n.replace(/\/$/, '') + (n.endsWith('/') ? '/' : ''))
    // 负控：内层文件仍然不展开（规则⑥，两个面都不展开）
    expect(names).not.toContain('inner.md')
  })

  it('后缀 = 可直接接在 `description` 后面的一段（含"参考件"标记与分隔符）', () => {
    ref('00-a.md', '# A\n')
    ref('10-b.md', '# B\n')
    expect(buildResourceNameSuffix(dir)).toBe('（参考件：00-a.md / 10-b.md）')
  })

  // ── 负控：J9 向后兼容（普通 skill 零噪声）────────────────────────────────
  it('🔴 J9 负控：无 references/ 且无 skill.ttl ⇒ **空串**（普通 skill 的 description 一字不改）', () => {
    expect(buildResourceNames(dir)).toEqual({ names: [], hidden: 0 })
    expect(buildResourceNameSuffix(dir)).toBe('')
  })

  // ── 规则③：有界 ＋ 响亮 ────────────────────────────────────────────────
  it('🔴 规则③：超条数上限 ⇒ `hidden` 计数 ＋ 后缀里**响亮**写出"另有 N 项"', () => {
    for (let i = 0; i < 5; i++) ref(`${i}0-f.md`, `# F${i}\n`)
    const { names, hidden } = buildResourceNames(dir, { maxItems: 2 })
    expect(names).toHaveLength(2)
    expect(hidden).toBe(3)
    expect(buildResourceNameSuffix(dir, { maxItems: 2 })).toContain('…另有 3 项')
  })

  it('🔴 规则③负控：未超限 ⇒ **不得**出现"另有"（否则"响亮"退化成噪声）', () => {
    ref('00-a.md', '# A\n')
    expect(buildResourceNameSuffix(dir)).not.toContain('另有')
  })

  // ── 规则①：只枚举，不注入正文（目录面同理）──────────────────────────────
  it('🔴 规则①：后缀含文件名，但**绝不含**正文，也**不含**首标题摘要（那是载入面的活）', () => {
    const SECRET = 'REFERENCE-BODY-SENTINEL-cat-4b7e'
    ref('00-alpha.md', `# 这个摘要不该出现在目录面\n\n${SECRET}\n`)
    const suffix = buildResourceNameSuffix(dir)
    expect(suffix).toContain('00-alpha.md')
    expect(suffix).not.toContain(SECRET)
    expect(suffix).not.toContain('这个摘要不该出现在目录面')
  })
})
