/**
 * diagram **几何与坐标**用例（2026-09-29，S142 **v1.51.1**）
 *
 * ## 本文件的存在理由（owner 实测引出，值得整篇留档）
 * owner 在**另一个 CCC** 里让模型画图，得到一张**近乎空白**的图，然后那个模型开始反复试错
 * （连试 4 轮 ＋ 去读 SVG）。根因**不在模型**：
 *
 * `dsl.ts` 的默认坐标系是**从旧 mini-SVG 移植时原样带过来的内部约定**
 * （`0~100 × −19~72`，而且 **y 向上**），而工具描述里**只写了 `box="x0,y0,x1,y1"`，
 * 既没写单位、也没写量程**。模型按常识写"画布像素" ⇒ 渲染器把它塞进那个 100 宽的域里
 * ⇒ **所有坐标飞出画布**（实测 SVG：`x=990 y=-919 w=2940`），而 `errors`／`lint` **全空**。
 *
 * ⇒ 判据：**"静默的空白"是最坏的失败形态**（模型只能靠试错）。本文件把修复钉成机械断言：
 *   ① **默认坐标系 = 画布像素 ＋ y 向下**（`domain=` 仍可选）；
 *   ② **出窗口的图元必须报错并被跳过**（出声，而不是画到看不见的地方）；
 *   ③ `<rect name="…">` 兼作 `id`（模型天然写 `name`），且锚点报错**限量**；
 *   ④ `align=left|center|right` 真的生效（v1.51.0 里三种取值全落进 `middle`）。
 */
import { describe, expect, it } from 'vitest'
import { parseDsl } from '../src/diagram/dsl.js'
import { renderDsl } from '../src/diagram/dsl-render.js'

/** 取 SVG 里第 n 个 `<rect …>` 的属性（画布背景那份是第 0 个） */
function rectAttrs(svg: string, n: number): Record<string, number> {
  const all = [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)]
  const m = all[n]
  if (m === undefined) throw new Error(`SVG 里没有第 ${n} 个带坐标的 rect`)
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
}

describe('diagram 几何：默认坐标系 = 画布像素 ＋ y 向下（v1.51.1）', () => {
  it('① owner 那条"最自然的写法"现在**直接就对**：box 用画布像素、不写 domain ⇒ 零错误且全在画布内', () => {
    const src = [
      '<diagram width="1000" height="600">',
      '  <rect id="A" box="100,100,400,200" label="甲"/>',
      '  <rect id="B" box="100,350,400,450" label="乙"/>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors).toEqual([])
    const a = rectAttrs(r.svg, 0)
    const b = rectAttrs(r.svg, 1)
    for (const q of [a, b]) {
      expect(q.x).toBeGreaterThanOrEqual(0)
      expect(q.y).toBeGreaterThanOrEqual(0)
      expect(q.x + q.w).toBeLessThanOrEqual(1000)
      expect(q.y + q.h).toBeLessThanOrEqual(600)
    }
    // y 向下：**y 小的那块在上边**（v1.51.0 的 y 向上会把它们倒过来）
    expect(a.y).toBeLessThan(b.y)
    expect(a.w).toBeGreaterThan(250) // 300 单位宽的块 ≈ 300px 量级（不再是"2940px"那种离谱值）
    expect(a.w).toBeLessThan(400)
  })

  it('② `domain=` 仍然可选且被尊重（显式声明坐标窗口时按窗口映射）', () => {
    const src = [
      '<diagram width="1000" height="600" domain="0,0,100,60">',
      '  <rect id="A" box="10,10,40,20" label="甲"/>',
      '  <rect id="B" box="60,30,90,50" label="乙"/>',
      '  <arrow from="A.e" to="B.w"/>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors).toEqual([])
    expect(r.svg).toContain('<line ') // 箭头真画了（锚点 A.e / B.w 解析得到）
    const a = rectAttrs(r.svg, 0)
    const b = rectAttrs(r.svg, 1)
    expect(a.y).toBeLessThan(b.y) // 同样是 y 向下
  })

  it('③ 🔴 出窗口 ⇒ **报错 ＋ 跳过**（无声空白变响亮；这是 v1.51.0 最坏的失败形态）', () => {
    // 声明了 1000 宽画布却写 1400 的坐标 ⇒ 出窗口
    const src = [
      '<diagram width="1000" height="600">',
      '  <rect id="A" box="100,100,1400,200" label="出界块"/>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors.join(' / ')).toContain('绘图窗口外')
    expect(r.errors.join(' / ')).toContain('坐标窗口')
    // 被跳过 ⇒ SVG 里没有这个块（只剩背景那份 rect）
    expect([...r.svg.matchAll(/<rect x="/g)]).toHaveLength(0)
  })

  it('③b 端点出窗口的线同样报错并跳过（半截线画到画布外只会让人误判）', () => {
    const src = [
      '<diagram width="1000" height="600">',
      '  <line from="100,100" to="100,900"/>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors.join(' / ')).toContain('端点')
    expect(r.svg).not.toContain('<line ')
  })

  it('④ 文字出窗口同样报错并跳过', () => {
    const src = '<diagram width="1000" height="600">\n<text x="50" y="900">飘了</text>\n</diagram>'
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors.join(' / ')).toContain('文字')
    expect(r.svg).not.toContain('飘了')
  })

  it('⑤ `<rect name="…">` 兼作 id：锚点能引用它（模型天然写 name，v1.51.0 只认 id ⇒ 锚点全废）', () => {
    const src = [
      '<diagram width="1000" height="600">',
      '  <rect name="A" box="100,100,400,200" label="甲"/>',
      '  <rect name="B" box="100,350,400,450" label="乙"/>',
      '  <arrow from="A.s" to="B.n"/>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(src).model)
    expect(r.errors).toEqual([])
    expect(r.svg).toContain('<line ')
  })

  it('⑥ 锚点报错**限量**（v1.51.0 会把整串 label 当 id 打出来，刷一屏）', () => {
    const marks = Array.from({ length: 12 }, (_, i) =>
      `  <rect id="r${i}" box="${20 + i * 5},10,${40 + i * 5},30" label="很长很长的一个标签名字${i}"/>`).join('\n')
    const src = ['<diagram width="1000" height="600">', marks, '  <arrow from="nope.e" to="r0.w"/>', '</diagram>'].join('\n')
    const r = renderDsl(parseDsl(src).model)
    const msg = r.errors.join(' / ')
    expect(msg).toContain('锚点引用解析不了')
    expect(msg).toContain('共 12 个') // 限量提示在场
    expect(msg).toContain('id="…"') // 并告诉它怎么写才对
    expect(msg.length).toBeLessThan(400) // 不再是一屏
  })
})

describe('diagram 对齐词表：align=left|center|right 真的生效（v1.51.1）', () => {
  const cases: Array<[string, string]> = [
    ['left', 'start'],
    ['center', 'middle'],
    ['right', 'end'],
  ]
  for (const [dslWord, svgWord] of cases) {
    it(`align="${dslWord}" ⇒ text-anchor="${svgWord}"`, () => {
      const src = `<diagram width="1000" height="600">\n<text x="500" y="300" align="${dslWord}">甲</text>\n</diagram>`
      const r = renderDsl(parseDsl(src).model)
      expect(r.errors).toEqual([])
      expect(r.svg).toContain(`text-anchor="${svgWord}"`)
    })
  }
})
