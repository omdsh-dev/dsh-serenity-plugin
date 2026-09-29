import type { DslModel } from './dsl.js'
import { DIAGRAM_FONT_STACK } from './fonts.js'

export interface DslRender {
  svg: string
  lint: string[]
  errors: string[]
  marks: number
}

const TITLE_BAND = 68
const EPS = 0.35
const DEF_W = 960
const DEF_H = 540
const DEF_PAD = 24
const DEF_SIZE = 14
const DEF_FILL = '#cccccc'
const DEF_INK = '#111111'

// 内部容错视图：字段缺失/类型不符都不抛异常
type Rect = { id: string, label?: string, x0: number, y0: number, x1: number, y1: number, color?: string, size?: number }
type Seg = { kind?: string, from: string, to: string, color?: string, width?: number, dash?: string, free?: boolean, line?: number }
type Txt = { x: number, y: number, text: string, size?: number, color?: string, anchor?: string }
type Legend = { x?: number, y?: number, size?: number }
type Pt = { x: number, y: number, numeric: boolean }
interface Model {
  title?: string
  subtitle?: string
  width?: number
  height?: number
  pad?: number
  x0?: number
  x1?: number
  y0?: number
  y1?: number
  rects?: Rect[]
  segs?: Seg[]
  texts?: Txt[]
  legend?: Legend
  colors?: Record<string, string>
}

const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const r2 = (v: number): number => Math.round(v * 100) / 100
const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const textWidth = (s: string, size: number): number => {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.55
  return w
}
const lineNo = (s: { line?: number }, i: number): number =>
  typeof s.line === 'number' && Number.isFinite(s.line) ? s.line : i + 1
const ANCHOR_RE = /^(.+)\.(ne|nw|se|sw|n|s|e|w|c)(?:([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?))?$/
const NUM_PAIR_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/
/** 点是否在块内或贴块边（eps = EPS） */
const inBox = (p: Pt, r: Rect): boolean =>
  p.x >= n(r.x0, 0) - EPS && p.x <= n(r.x1, 0) + EPS && p.y >= n(r.y0, 0) - EPS && p.y <= n(r.y1, 0) + EPS

/** Liang-Barsky：线段与轴对齐盒是否相交 */
const segHitsBox = (ax: number, ay: number, bx: number, by: number, box: [number, number, number, number]): boolean => {
  const p = [ax - bx, bx - ax, ay - by, by - ay]
  const q = [ax - box[0], box[2] - ax, ay - box[1], box[3] - ay]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    const pi = p[i] ?? 0
    const qi = q[i] ?? 0
    if (pi === 0) {
      if (qi < 0) return false
      continue
    }
    const r = qi / pi
    if (pi < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else if (r < t0) return false
    else if (r < t1) t1 = r
  }
  return true
}

/** 把模型渲染成 SVG，并做四项体检。绝不抛异常：出错的图元跳过、记 errors、其余照画。 */
/**
 * 🔴 **适配层（2026-09-29 加，修一处真缺陷）**
 *
 * 本文件此前用 `model as unknown as Model` 把 `DslModel` **硬 cast** 成自己的内部形状
 * ⇒ **编译器对字段名彻底变瞎**。而两侧字段名实际不同：
 * `W/H` vs `width/height` ／ `fill` vs `color` ／ `ln` vs `line` ／ `align` vs `anchor`
 * ⇒ 运行期整片取到 `undefined`，**而 `typecheck` 照样绿**（那个绿是假信号）。
 *
 * 现在改为**逐字段显式搬运**：类型系统会核对每一个名字 ⇒ 再对不上就**编译不过**。
 * 🆕 判据：**"typecheck 通过"≠"两侧接口一致"** —— 一个 cast 就足以让类型检查失效；
 * 这一层在，`typecheck` 才是证据。
 */
function adapt(model: DslModel): Model {
  return {
    title: model.title,
    subtitle: model.subtitle,
    width: model.W,
    height: model.H,
    pad: model.pad,
    x0: model.x0, x1: model.x1, y0: model.y0, y1: model.y1,
    colors: model.colors,
    legend: model.legend,
    rects: model.rects.map((r) => ({ id: r.id, label: r.label, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, color: r.fill, size: r.size })),
    segs: model.segments.map((s) => ({ kind: s.kind, from: s.from, to: s.to, color: s.color, width: s.width, dash: s.dash, free: s.free, line: s.ln })),
    texts: model.texts.map((t) => ({ x: t.x, y: t.y, text: t.text, size: t.size, color: t.color, anchor: t.align })),
  }
}

export function renderDsl(model: DslModel): DslRender {
  const m = adapt(model)
  const lint: string[] = []
  const errors: string[] = []
  const rects: Rect[] = m.rects ?? []
  const segs: Seg[] = m.segs ?? []
  const texts: Txt[] = m.texts ?? []
  const colors: Record<string, string> = m.colors ?? {}
  const ids = rects.map((r) => r.id)

  const col = (v: unknown, d: string): string => {
    const s = typeof v === 'string' ? v : ''
    if (s === '') return d
    if (s.charAt(0) === '#') return s
    return colors[s] ?? s
  }

  const W = n(m.width, DEF_W)
  const H = n(m.height, DEF_H)
  const pad = n(m.pad, DEF_PAD)

  const gx: number[] = []
  const gy: number[] = []
  for (const r of rects) gx.push(n(r.x0, 0), n(r.x1, 0))
  for (const r of rects) gy.push(n(r.y0, 0), n(r.y1, 0))
  for (const t of texts) gx.push(n(t.x, 0))
  for (const t of texts) gy.push(n(t.y, 0))
  const hasBox = gx.length > 0 && gy.length > 0
  const x0 = n(m.x0, hasBox ? Math.min(...gx) : 0)
  const x1 = n(m.x1, hasBox ? Math.max(...gx) : 100)
  const y0 = n(m.y0, hasBox ? Math.min(...gy) : 0)
  const y1 = n(m.y1, hasBox ? Math.max(...gy) : 100)

  const scaleX = (W - 2 * pad) / (x1 - x0 || 1)
  const scaleY = (H - TITLE_BAND - pad) / (y1 - y0 || 1)
  const px = (x: number): number => r2(pad + (x - x0) * scaleX)
  // 🔴 **y 向下**（v1.51.1）：与 `dsl.ts` 的默认域（画布像素）同批改 ——
  //    旧的 `y1 - y` 是"数学坐标系（y 向上）"的写法，与模型/人类的画布直觉相反。
  const py = (y: number): number => r2(TITLE_BAND + (y - y0) * scaleY)

  /** 绘图窗口 = 声明的域（默认就是画布）。出窗口的图元**报错并跳过**，不静默画到看不见的地方。 */
  const tolX = Math.abs(x1 - x0) * 0.01
  const tolY = Math.abs(y1 - y0) * 0.01
  const outside = (x: number, y: number): boolean =>
    x < x0 - tolX || x > x1 + tolX || y < y0 - tolY || y > y1 + tolY
  const windowText = `坐标窗口 x ${r2(x0)}..${r2(x1)} ／ y ${r2(y0)}..${r2(y1)}（y 向下；不写 domain 时＝画布）`

  // 锚点：`x,y` 数字对 或 `<id>.<n|s|e|w|c|ne|nw|se|sw>[±dx,±dy]`
  const resolve = (token: unknown): Pt | null => {
    const t = String(token ?? '').trim()
    const np = NUM_PAIR_RE.exec(t)
    if (np) return { x: Number(np[1]), y: Number(np[2]), numeric: true }
    const mt = ANCHOR_RE.exec(t)
    if (!mt) return null
    const ref = rects.find((r) => r.id === mt[1])
    if (!ref) return null
    const rx0 = n(ref.x0, 0)
    const rx1 = n(ref.x1, 0)
    const ry0 = n(ref.y0, 0)
    const ry1 = n(ref.y1, 0)
    const cx = (rx0 + rx1) / 2
    const cy = (ry0 + ry1) / 2
    const table: Record<string, [number, number]> = {
      // 🔴 y 向下（v1.51.1）：north = **y 最小**的那条边（= 视觉上的上边），south = y 最大
      n: [cx, ry0], s: [cx, ry1], e: [rx1, cy], w: [rx0, cy], c: [cx, cy],
      ne: [rx1, ry0], nw: [rx0, ry0], se: [rx1, ry1], sw: [rx0, ry1]
    }
    const base = table[mt[2] ?? '']
    if (!base) return null
    const dx = mt[3] === undefined ? 0 : Number(mt[3])
    const dy = mt[4] === undefined ? 0 : Number(mt[4])
    return { x: base[0] + dx, y: base[1] + dy, numeric: false }
  }

  // 体检 1 —— 块重叠（数据单位）
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const A = rects[i]!
      const B = rects[j]!
      const ix = Math.min(n(A.x1, 0), n(B.x1, 0)) - Math.max(n(A.x0, 0), n(B.x0, 0))
      const iy = Math.min(n(A.y1, 0), n(B.y1, 0)) - Math.max(n(A.y0, 0), n(B.y0, 0))
      if (ix > 0 && iy > 0) lint.push(`块重叠：${A.label ?? A.id} × ${B.label ?? B.id} ⇒ 相交 ${r2(ix)}×${r2(iy)}（面积 ${r2(ix * iy)} 平方数据单位）`)
    }
  }
  // 体检 2 —— 标签溢出（px）
  for (const r of rects) {
    if (!r.label) continue
    const need = textWidth(r.label, n(r.size, DEF_SIZE))
    const boxPx = Math.abs(n(r.x1, 0) - n(r.x0, 0)) * scaleX
    if (need > boxPx - 6) lint.push(`标签溢出：${r.label}（需 ≈${r2(need)}px，块宽 ${r2(boxPx)}px）`)
  }

  const headEls: string[] = [], rectEls: string[] = [], segEls: string[] = []
  const textEls: string[] = [], legendEls: string[] = [], l3: string[] = [], l4: string[] = []
  let marks = 0

  headEls.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${DIAGRAM_FONT_STACK}">`)
  headEls.push(`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`)
  marks += 2
  if (m.title) headEls.push(`<text x="10" y="34" font-size="21" font-weight="bold" fill="#111">${esc(m.title)}</text>`)
  if (m.title) marks += 1
  if (m.subtitle) headEls.push(`<text x="10" y="58" font-size="13" fill="#666">${esc(m.subtitle)}</text>`)
  if (m.subtitle) marks += 1

  for (const r of rects) {
    // 🔴 出窗口 ⇒ **报错并跳过**（v1.51.1 新增；owner 实测里正是"整片坐标飞出画布而一声不吭"
    //    导致模型反复试错 ⇒ 判据：**静默的空白是最坏的失败形态**，宁可少画一个也要出声）
    if (outside(n(r.x0, 0), n(r.y0, 0)) || outside(n(r.x1, 0), n(r.y1, 0))) {
      errors.push(`矩形「${r.label ?? r.id}」在绘图窗口外：box=${r2(n(r.x0, 0))},${r2(n(r.y0, 0))},${r2(n(r.x1, 0))},${r2(n(r.y1, 0))} ／ ${windowText} ⇒ 该图元已跳过`)
      continue
    }
    // y 向下（v1.51.1）：**y0 是上边**、y1 是下边
    const X = px(n(r.x0, 0))
    const Y = py(n(r.y0, 0))
    const bw = r2(px(n(r.x1, 0)) - X)
    const bh = r2(py(n(r.y1, 0)) - Y)
    rectEls.push(`<rect x="${X}" y="${Y}" width="${bw}" height="${bh}" rx="2" fill="${esc(col(r.color, DEF_FILL))}" stroke="#ffffff" stroke-width="1.5"/>`)
    marks += 1
    if (!r.label) continue
    const cx = px((n(r.x0, 0) + n(r.x1, 0)) / 2)
    const cy = py((n(r.y0, 0) + n(r.y1, 0)) / 2)
    rectEls.push(`<text x="${cx}" y="${cy}" font-size="${n(r.size, DEF_SIZE)}" font-weight="bold" fill="#1b1b1b" text-anchor="middle" dominant-baseline="middle">${esc(r.label)}</text>`)
    marks += 1
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const kind = s.kind === 'arrow' ? 'arrow' : 'line'
    const a = resolve(s.from)
    const b = resolve(s.to)
    if (!a || !b) {
      const bad = !a ? s.from : s.to
      // 🔴 错误里**只列真正的 id**，且**限量**（v1.51.1）：v1.51.0 会把整串 label 当 id 打出来，
      //    owner 那个会话里刷了一屏（`rect` 缺 id 时 id 回落到 label ⇒ 报错信息爆炸）。
      const shown = ids.slice(0, 8).join('、')
      errors.push(`第 ${lineNo(s, i)} 行 ${kind}：锚点引用解析不了（${esc(bad)}）；已知 id = ${shown}${ids.length > 8 ? ` …（共 ${ids.length} 个）` : ''}；rect 要能被引用请写 id="…"（name="…" 亦可）⇒ 该图元已跳过`)
      continue
    }
    // 出窗口的线同样**报错并跳过**（半截线画到画布外只会让人误判）
    if (outside(a.x, a.y) || outside(b.x, b.y)) {
      errors.push(`第 ${lineNo(s, i)} 行 ${kind}：端点在绘图窗口外 (${r2(a.x)},${r2(a.y)})→(${r2(b.x)},${r2(b.y)}) ／ ${windowText} ⇒ 该图元已跳过`)
      continue
    }
    const X0 = px(a.x)
    const Y0 = py(a.y)
    const X1 = px(b.x)
    const Y1 = py(b.y)
    // 体检 3 —— 端点悬空（只查数字端点，free 的线整条免检）
    if (s.free !== true) {
      if (a.numeric && !rects.some((r) => inBox(a, r))) l3.push(`端点悬空：${kind} 起点 (${r2(a.x)}, ${r2(a.y)}) 不在任何块内、也不贴任何块边`)
      if (b.numeric && !rects.some((r) => inBox(b, r))) l3.push(`端点悬空：${kind} 终点 (${r2(b.x)}, ${r2(b.y)}) 不在任何块内、也不贴任何块边`)
    }
    // 体检 4 —— 线压标签（px 空间的 AABB × 线段）
    for (const r of rects) {
      if (!r.label) continue
      const size = n(r.size, DEF_SIZE)
      const hw = textWidth(r.label, size) / 2 + 1
      const hh = size / 2 + 1
      const bx = px((n(r.x0, 0) + n(r.x1, 0)) / 2)
      const by = py((n(r.y0, 0) + n(r.y1, 0)) / 2)
      if (!segHitsBox(X0, Y0, X1, Y1, [bx - hw, by - hh, bx + hw, by + hh])) continue
      l4.push(`线压标签：${kind}(${r2(a.x)},${r2(a.y)})→(${r2(b.x)},${r2(b.y)}) 穿过「${r.label}」⇒ 把该线挪开，或用锚点偏移（如 ${r.id}.n+3,0）`)
    }
    const stroke = esc(col(s.color, DEF_INK))
    const dash = typeof s.dash === 'string' && s.dash !== '' ? ` stroke-dasharray="${esc(s.dash)}"` : ''
    if (kind === 'arrow') {
      const ang = Math.atan2(Y1 - Y0, X1 - X0)
      const L = 13
      const Wd = 6.5
      const vx = X1 - Math.cos(ang) * L
      const vy = Y1 - Math.sin(ang) * L
      segEls.push(`<line x1="${X0}" y1="${Y0}" x2="${r2(vx)}" y2="${r2(vy)}" stroke="${stroke}" stroke-width="${n(s.width, 2.2)}"${dash}/>`)
      segEls.push(`<polygon points="${X1},${Y1} ${r2(vx - Math.sin(ang) * Wd)},${r2(vy + Math.cos(ang) * Wd)} ${r2(vx + Math.sin(ang) * Wd)},${r2(vy - Math.cos(ang) * Wd)}" fill="${stroke}"/>`)
      marks += 2
    } else {
      segEls.push(`<line x1="${X0}" y1="${Y0}" x2="${X1}" y2="${Y1}" stroke="${stroke}" stroke-width="${n(s.width, 1.5)}"${dash}/>`)
      marks += 1
    }
  }

  for (const t of texts) {
    if (outside(n(t.x, 0), n(t.y, 0))) {
      errors.push(`文字「${t.text}」在绘图窗口外：(x ${r2(n(t.x, 0))}, y ${r2(n(t.y, 0))}) ／ ${windowText} ⇒ 该图元已跳过`)
      continue
    }
    // 🔴 `align` 词表对齐（v1.51.1）：DSL 产出的词是 `left/center/right`，而 v1.51.0 这里只认
    //    `start/end` ⇒ **三种取值全落进 `middle`**（即"写了 left/right 也没用，一律居中"）。
    const anchor = t.anchor === 'left' || t.anchor === 'start' ? 'start'
      : t.anchor === 'right' || t.anchor === 'end' ? 'end'
        : 'middle'
    textEls.push(`<text x="${px(n(t.x, 0))}" y="${py(n(t.y, 0))}" font-size="${n(t.size, DEF_SIZE)}" fill="${esc(col(t.color, '#4a4a4a'))}" text-anchor="${anchor}" dominant-baseline="middle">${esc(t.text)}</text>`)
    marks += 1
  }

  if (m.legend) {
    const size = n(m.legend.size, DEF_SIZE)
    // 🔴 坐标改成**域单位**（v1.51.1）：v1.51.0 这里直接当 px 用 ⇒ rect/text 用域、legend 用 px，
    //    两套坐标混在一张图里（写对了也别扭，写错了没人告诉你）。
    const LX = px(n(m.legend.x, 0))
    const LY = py(n(m.legend.y, 0))
    // 标题不再硬编码（v1.51.0 写死"阵营"，对多数图都是错的话）；只画色块 ＋ 色名
    const entries = Object.entries(colors)
    for (let i = 0; i < entries.length; i++) {
      const row = LY + i * (size + 6)
      legendEls.push(`<rect x="${LX}" y="${r2(row - 8)}" width="12" height="12" rx="2" fill="${esc(entries[i]![1])}"/>`)
      legendEls.push(`<text x="${r2(LX + 18)}" y="${r2(row)}" font-size="${size}" fill="#333" dominant-baseline="middle">${esc(entries[i]![0])}</text>`)
      marks += 2
    }
  }

  lint.push(...l3, ...l4)
  const svg = [...headEls, ...rectEls, ...segEls, ...textEls, ...legendEls, '</svg>'].join('\n') + '\n'
  return { svg, lint, errors, marks }
}
