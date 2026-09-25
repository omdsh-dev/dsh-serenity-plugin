/**
 * lazy-service-access.test.ts — 🔴「lazy 宿主服务不得被直接属性读」的**机械守卫**
 * （2026-09-25 · ⑤ 语义深度 · **衔接面**；对应地图 §3-9 第 7 行）
 *
 * 它解决什么麻烦（白话）：宿主 cordis 的 Context 是个**代理**——读一个**没在插件 `inject`
 * 里声明**的服务（= 我们的 lazy 服务）**会抛错**，而不是给 `undefined`。
 * v1.31.3 正是这么崩的：`cannot get property "subagents" without inject`
 * —— 而**当时全部 fake ctx 单测都是绿的**（普通对象的属性读只返回 undefined）。
 * 唯一正解 = 一律走 `src/host/access.ts` 的 `hostInjected`（它吞掉抛错并回落 `ctx.get`）。
 * ⇒ 本用例把"**除 access.ts 外，谁都不许直接点 lazy 服务**"变成**机械事实**。
 *
 * 判据来源（单真相源）：`src/host/contract.ts` 的 `HOST_SERVICES`（`access === 'lazy'` 那些）
 * —— **不手抄名单**（名单漂了它会跟着变；手抄一份就等于多一处会错的真相）。
 *
 * 🔴 为什么必须先剥注释与字符串：本仓**大量 docstring 里写着 `ctx.subagents`**（那是讲解，
 * 不是访问）⇒ 全文正则会造出**一堆假阳性**。CCC 侧自己踩过同款坑（`hasCliEntry()` 不剥注释
 * ⇒ 4 条"假欠账"）⇒ **剥了才作数**，并且**用两条正控证明"剥得对、且还抓得住真的"**。
 *
 * 🔵 诚实边界（I7）：本守卫只覆盖 **接收者名为 `ctx` / `context` / `c` / `self` / `host`**
 * 的形态（含 `ctx?.x`）；其它接收者（如 `foo.subagents`）**不在覆盖内**——当前仓内不存在。
 * 也未处理**正则字面量**（`/.../ `）：若将来有正则里出现这些名字，会误报，届时按需补。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_SERVICES } from '../../src/host/contract.js'

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_DIR = join(HOOKS_DIR, 'src')

/** 唯一允许直接接触宿主服务的模块（F-06 的收口点） */
const ACCESS_MODULE = 'host/access.ts'

/** lazy 服务名（从契约表派生 —— 单一真相源，不手抄） */
const LAZY_NAMES: string[] = HOST_SERVICES.filter((s) => s.access === 'lazy').map((s) => s.name)

/** 可作接收者的标识符（覆盖仓内真实写法；`this.ctx.subagents` 也落在 `ctx` 上） */
const RECEIVERS = ['ctx', 'context', 'c', 'self', 'host'] as const

/**
 * 去掉**行注释 / 块注释 / 字符串字面量**（模板串按普通串处理——含 `${}` 内的代码会被一起去掉，
 * 对本守卫无害：那只可能**漏报**，不会误报）。
 */
function stripNoise(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === quote) { i++; break }
        i++
      }
      out += ' ' // 用一个分隔符替代整串内容（防左右粘连成新标识符）
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 找 `ctx.subagents` / `ctx?.subagents` 这类**属性读**（已剥噪声的代码上跑） */
function findDirectReads(code: string, names: readonly string[]): string[] {
  const hits: string[] = []
  for (const name of names) {
    const re = new RegExp(`\\b(?:${RECEIVERS.join('|')})\\s*\\??\\.\\s*${name}\\b`)
    if (re.test(code)) hits.push(name)
  }
  return hits
}

function collectTs(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectTs(full, base))
    else if (entry.endsWith('.ts')) out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

describe('宿主 lazy 服务：只有 access.ts 能直接碰（v1.31.3 成因的机械守卫）', () => {
  it('名单自证：lazy 名单非空且含 v1.31.3 的现场（防"扫了个空集"＝假绿）', () => {
    expect(LAZY_NAMES.length).toBeGreaterThan(0)
    expect(LAZY_NAMES).toContain('subagents')
  })

  it('🔴 正控 ①（读数器证明能抓）：真实属性读 ⇒ 抓到', () => {
    const sample = 'function f(ctx: Ctx) { return ctx.subagents?.start("spawn", {}) }'
    expect(findDirectReads(stripNoise(sample), LAZY_NAMES)).toEqual(['subagents'])
    const optional = 'const s = ctx?.subagents'
    expect(findDirectReads(stripNoise(optional), LAZY_NAMES)).toEqual(['subagents'])
  })

  it('🔴 正控 ②（假阳性对照）：只在**注释/字符串**里出现 ⇒ 不抓', () => {
    const sample = [
      '// v1.31.3：ctx.subagents 是 lazy，必须走 hostInjected',
      '/** 说明：`ctx.subagents` 会抛 without inject */',
      "const msg = 'ctx.get(\"subagents\") yielded nothing'",
      'const tag = `ctx.subagents`',
    ].join('\n')
    expect(findDirectReads(stripNoise(sample), LAZY_NAMES)).toEqual([])
  })

  it('🔴 正控 ③（**真实文件**上的双面控）：handyman.ts 原文含 `ctx.subagents`，剥后必须为空', () => {
    const target = 'tools/handyman.ts'
    const raw = readFileSync(join(SRC_DIR, target), 'utf-8')
    expect(raw).toContain('ctx.subagents') // 前提：这份文件**确实**含该形态（否则本控什么都没证明）
    expect(findDirectReads(stripNoise(raw), LAZY_NAMES)).toEqual([]) // 结论：它只在注释里 ⇒ 不抓
  })

  it('🔴 扫描域自证（防"扫了零个文件 ⇒ 永远绿"）：src 下真有大量 .ts，且被排除的那个文件确实在域里', () => {
    const files = collectTs(SRC_DIR, SRC_DIR)
    expect(files.length).toBeGreaterThan(50)
    // 排除规则必须作用在**真实存在**的文件上（否则 `continue` 是空操作，守卫形同虚设）
    expect(files).toContain(ACCESS_MODULE)
  })

  it('🔴 src/**（除 host/access.ts）里 lazy 服务的直接属性读 = 0', () => {
    const offences: string[] = []
    for (const rel of collectTs(SRC_DIR, SRC_DIR)) {
      if (rel === ACCESS_MODULE) continue
      const code = stripNoise(readFileSync(join(SRC_DIR, rel), 'utf-8'))
      for (const name of findDirectReads(code, LAZY_NAMES)) offences.push(`${rel}: ctx.${name}`)
    }
    for (const o of offences) {
      expect(`${o} 直接属性读 lazy 服务（真宿主会抛 cannot get property ... without inject）⇒ 请走 hostInjected`).toBe('via hostInjected')
    }
    expect(offences).toEqual([])
  })
})
