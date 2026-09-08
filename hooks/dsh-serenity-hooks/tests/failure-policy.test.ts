/**
 * failure-policy.test.ts — 失败策略门禁（S142 review F-07）
 *
 * 规则（与 `docs/failure-policy.md` 一致）：**空的 catch 必须点名它吞掉了什么**。
 * 审计 133+ 处 catch 的实证结论：静默 catch 本身不是 bug，**未命名的静默 catch 才是**
 * ——读代码的人无法判断那是"有意降级"还是"忘了处理"。
 *
 * 本门禁机械检查 src 下每个 catch 块：
 *  - 块体非空 → 通过（有显式处理）
 *  - 块体为空但含注释 → 通过（点名了吞掉的内容）
 *  - 块体为空且无注释 → 失败（列出文件:行）
 *
 * 附：策略文档必须存在（策略与门禁同源，避免文档漂移）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOKS_DIR = resolve(HERE, '..')
const SRC_DIR = join(HOOKS_DIR, 'src')
const POLICY_DOC = resolve(HOOKS_DIR, '..', '..', 'docs', 'failure-policy.md')

function collectTs(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectTs(full, base))
    else if (entry.endsWith('.ts')) out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

/**
 * 去掉字符串与注释后的源码 + **索引映射**（stripped 下标 → raw 下标）。
 * 映射必须保留：否则报出的行号会错位（首版实现即踩此坑）。
 */
function stripLiteralsAndComments(src: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  const push = (idx: number, ch: string): void => {
    text += ch
    map.push(idx)
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    push(i, c as string)
    i++
  }
  return { text, map }
}

interface Offence {
  file: string
  line: number
  snippet: string
}

/** 扫描一个文件的空 catch（保留原注释信息，故用原始文本 + 剥壳后的偏移对照） */
function findUnnamedCatches(file: string, raw: string): Offence[] {
  const { text: stripped, map } = stripLiteralsAndComments(raw)
  const offences: Offence[] = []
  const re = /\bcatch\b(?:\s*\([^)]*\))?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    const openIdx = m.index + m[0].length - 1
    let depth = 1
    let i = openIdx + 1
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '{') depth++
      else if (stripped[i] === '}') depth--
      i++
    }
    const bodyStripped = stripped.slice(openIdx + 1, i - 1)
    if (bodyStripped.trim() !== '') continue // 有显式处理
    const rawOpen = map[openIdx] ?? 0
    const rawClose = map[i - 1] ?? raw.length
    const bodyRaw = raw.slice(rawOpen + 1, rawClose)
    const hasComment = /\/\/|\/\*/.test(bodyRaw)
    if (hasComment) continue
    const line = raw.slice(0, rawOpen).split('\n').length
    offences.push({ file, line, snippet: raw.split('\n')[line - 1]?.trim().slice(0, 100) ?? '' })
  }
  return offences
}

describe('失败策略门禁（F-07）：空 catch 必须点名吞掉了什么', () => {
  it('策略文档存在（策略与门禁同源）', () => {
    expect(existsSync(POLICY_DOC)).toBe(true)
  })

  it('扫描器自证：未命名空 catch 被抓、带注释的放行（防空跑）', () => {
    const bad = ['function f() {', '  try { g() } catch {', '  }', '}', ''].join('\n')
    const good = ['function f() {', '  try { g() } catch {', '    /* 退订失败不影响结算 */', '  }', '}', ''].join('\n')
    const handled = ['function f() {', '  try { g() } catch { return 1 }', '}', ''].join('\n')
    expect(findUnnamedCatches('bad.ts', bad)).toHaveLength(1)
    expect(findUnnamedCatches('bad.ts', bad)[0]?.line).toBe(2)
    expect(findUnnamedCatches('good.ts', good)).toEqual([])
    expect(findUnnamedCatches('handled.ts', handled)).toEqual([])
  })

  it('src 下无"空且无注释"的 catch', () => {
    const offences: Offence[] = []
    for (const rel of collectTs(SRC_DIR)) {
      const raw = readFileSync(join(SRC_DIR, rel), 'utf-8')
      offences.push(...findUnnamedCatches(rel, raw))
    }
    for (const o of offences) {
      expect(`${o.file}:${o.line} 空 catch 未点名（${o.snippet}）`).toBe('named')
    }
    expect(offences).toEqual([])
  })
})
