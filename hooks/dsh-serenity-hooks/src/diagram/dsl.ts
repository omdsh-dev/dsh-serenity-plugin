/**
 * 标签式图表 DSL —— 解析器（只收集，不做几何）。
 *
 * 为什么是标签形式（owner 2026-09-29 裁决）：图是正文的附加层，一段
 * <diagram>…</diagram> 嵌在文档里就能出图，作者不必为画一张图切到另一种文档结构去维护坐标；
 * 属性 / 文本双形态（<rect .../> 声明几何，<text ...>正文</text> 承载文案）覆盖两类信息，
 * 与 HTML/SVG 直觉一致，人写机器读都省事；自闭合 + 未知标签只报错不崩 = 前向兼容。
 * 本文件只「收集」：不解析锚点（`ID.锚点[±dx,±dy]`）、不做几何——那是渲染侧的事；绝不抛异常。
 */

export interface DslRect { id: string; x0: number; y0: number; x1: number; y1: number; label?: string; size: number; fill: string }
export interface DslSeg { kind: 'line' | 'arrow'; from: string; to: string; color?: string; width?: number; dash?: string; free: boolean; ln: number }
export interface DslText { x: number; y: number; text: string; align: 'left' | 'center' | 'right'; size: number; color?: string; ln: number }
export interface DslLegend { x: number; y: number; size: number }
export interface DslModel {
  W: number; H: number; x0: number; y0: number; x1: number; y1: number; pad: number
  title: string; subtitle: string
  colors: Record<string, string>
  rects: DslRect[]; segments: DslSeg[]; texts: DslText[]; legend?: DslLegend
}
export interface DslParse { model: DslModel; errors: string[] }

/** 文本形态的标签（其余标签自闭合、无文本内容） */
const TEXT_TAGS = ['title', 'subtitle', 'text']

/** 四角坐标（未归一） */
interface Quad { x0: number; y0: number; x1: number; y1: number }

/** 属性值 → 数字；缺失或非数字返回 undefined（不抛） */
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 逗号分隔的 4 个数字；不合法返回 undefined */
function quad(v: string): Quad | undefined {
  const parts = v.split(',')
  if (parts.length !== 4) return undefined
  const [x0, y0, x1, y1] = parts.map(num)
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined
  return { x0, y0, x1, y1 }
}

/** 剥离 <!-- ... -->（可跨行）；用空格占位以保住行号 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const start = src.indexOf('<!--', i)
    if (start < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, start)
    const end = src.indexOf('-->', start + 4)
    const stop = end < 0 ? src.length : end + 3
    out += src.slice(start, stop).replace(/[^\n]/g, ' ')
    i = stop
  }
  return out
}

/** 索引处字符所在行（1-based） */
function lineAt(src: string, idx: number): number {
  let ln = 1
  for (let i = 0; i < idx; i++) if (src[i] === '\n') ln++
  return ln
}

/** 解析标签格式源码。**绝不抛异常**：看不懂的行记进 errors 并跳过，其余照收。 */
export function parseDsl(source: string): DslParse {
  const src = stripComments(source)
  const errors: string[] = []
  const model: DslModel = {
    W: 1000, H: 780, x0: 0, y0: -19, x1: 100, y1: 72, pad: 10,
    title: '', subtitle: '', colors: {},
    rects: [], segments: [], texts: [] }
  const ids = new Set<string>()
  let rectOrdinal = 0
  let tagIndex = 0
  let i = 0
  const fail = (n: number, ln: number, msg: string) => {
    errors.push(`第 ${n} 个标签（第 ${ln} 行）：${msg}`)
  }

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break

    // 找标签结束的 '>'（引号内的 '>' 不算）
    let j = lt + 1
    let inQuote = false
    while (j < src.length) {
      const c = src[j]
      if (c === '"') inQuote = !inQuote
      else if (c === '>' && !inQuote) break
      j++
    }
    const ln = lineAt(src, lt)
    if (j >= src.length) {
      tagIndex++
      fail(tagIndex, ln, '标签未闭合（属性值引号未闭合）')
      const gt = src.indexOf('>', lt + 1)
      if (gt < 0) break
      i = gt + 1
      continue
    }

    const raw = src.slice(lt + 1, j)
    if (/^\s*\//.test(raw)) {
      // 容器标签的闭合形式（如 </diagram>）：静默跳过，不占「第 N 个标签」序号
      i = j + 1
      continue
    }
    tagIndex++

    const selfClosing = /\/\s*$/.test(raw)
    const body = raw.replace(/\/\s*$/, '')

    const head = /^\s*([A-Za-z_][\w-]*)/.exec(body)
    const tag = head ? head[1] : undefined
    if (tag === undefined) {
      fail(tagIndex, ln, '标签名缺失或非法')
      i = j + 1
      continue
    }

    const attrs: Record<string, string> = {}
    const attrRe = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(body)) !== null) {
      const [k, val] = [a[1], a[2]]
      if (k !== undefined && val !== undefined) attrs[k] = val
    }

    // 文本形态：取 <tag> … </tag> 之间的内容（剥首尾空白，保留内部空格）
    let content = ''
    let next = j + 1
    if (!selfClosing && TEXT_TAGS.indexOf(tag) >= 0) {
      const close = src.indexOf(`</${tag}`, next)
      if (close < 0) {
        fail(tagIndex, ln, `缺少 </${tag}> 闭合标签`)
        i = next
        continue
      }
      content = src.slice(next, close).trim()
      const gt = src.indexOf('>', close)
      next = gt < 0 ? src.length : gt + 1
    }
    i = next

    if (tag === 'diagram') {
      const w = num(attrs.width)
      const h = num(attrs.height)
      if (w !== undefined) model.W = w
      if (h !== undefined) model.H = h
      if (attrs.domain !== undefined) {
        const d = quad(attrs.domain)
        if (d) {
          model.x0 = d.x0
          model.y0 = d.y0
          model.x1 = d.x1
          model.y1 = d.y1
        } else fail(tagIndex, ln, `domain 不是 4 个数字：${attrs.domain}（已忽略）`)
      }
      continue
    }

    if (tag === 'title' || tag === 'subtitle') {
      if (tag === 'title') model.title = content
      else model.subtitle = content
      continue
    }

    if (tag === 'color') {
      const name = attrs.name
      const value = attrs.value
      if (!name || value === undefined) {
        fail(tagIndex, ln, 'color 缺 name 或 value')
        continue
      }
      model.colors[name] = value
      continue
    }

    if (tag === 'legend') {
      model.legend = { x: num(attrs.x) ?? 0, y: num(attrs.y) ?? 0, size: num(attrs.size) ?? 12 }
      continue
    }

    if (tag === 'rect') {
      rectOrdinal++
      if (attrs.box === undefined) {
        fail(tagIndex, ln, 'rect 缺 box')
        continue
      }
      const b = quad(attrs.box)
      if (!b) {
        fail(tagIndex, ln, `box 不是 4 个数字：${attrs.box}`)
        continue
      }
      const label = attrs.label
      const id = attrs.id || label || `rect${rectOrdinal}`
      if (ids.has(id)) {
        fail(tagIndex, ln, `rect id 重复：${id}`)
        continue
      }
      ids.add(id)
      const rect: DslRect = {
        id,
        x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1),
        x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1),
        size: num(attrs.size) ?? 13,
        fill: attrs.fill ?? '',
      }
      if (label !== undefined) rect.label = label
      model.rects.push(rect)
      continue
    }

    if (tag === 'line' || tag === 'arrow') {
      const from = attrs.from
      const to = attrs.to
      if (!from || !to) {
        fail(tagIndex, ln, `${tag} 缺 from 或 to`)
        continue
      }
      const seg: DslSeg = { kind: tag, from, to, free: attrs.free === '1', ln }
      if (attrs.color !== undefined) seg.color = attrs.color
      const w = num(attrs.width)
      if (w !== undefined) seg.width = w
      if (attrs.dash !== undefined) seg.dash = attrs.dash
      model.segments.push(seg)
      continue
    }

    if (tag === 'text') {
      const x = num(attrs.x)
      const y = num(attrs.y)
      if (x === undefined || y === undefined) {
        fail(tagIndex, ln, 'text 缺 x 或 y')
        continue
      }
      const al = attrs.align
      const align: DslText['align'] = al === 'center' || al === 'right' ? al : 'left'
      const t: DslText = { x, y, text: content, align, size: num(attrs.size) ?? 12.5, ln }
      if (attrs.color !== undefined) t.color = attrs.color
      model.texts.push(t)
      continue
    }

    fail(tagIndex, ln, `未知标签：<${tag}>`)
  }

  return { model, errors }
}
