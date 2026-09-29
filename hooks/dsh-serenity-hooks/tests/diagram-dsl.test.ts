/**
 * diagram 标签 DSL —— **接口断裂的回归钉**（2026-09-29，S142）
 *
 * 存在的理由（实测事故）：解析器与渲染器由两个子代理按"冻结接口"并行写，
 * 渲染侧入口用了 `model as unknown as Model` 硬 cast ⇒ **编译器对字段名变瞎**，
 * 两侧四处字段名不同（W/H vs width/height ／ fill vs color ／ ln vs line ／ align vs anchor）
 * 而 `typecheck` **照样绿**。⇒ 本文件的每一条断言都对准**一个具体的字段名**：
 * 名字再被改坏，这里必红。
 *
 * 判据：**"typecheck 通过" ≠ "两侧接口一致"** —— 必须有真渲染。
 */
import { describe, expect, it } from 'vitest'
import { parseDsl } from '../src/diagram/dsl.js'
import { renderDsl } from '../src/diagram/dsl-render.js'

const SRC = [
  '<diagram width="400" height="300" domain="0,0,100,100">',
  '  <color name="海" value="#123456"/>',
  '  <legend x="80" y="50"/>',
  '  <rect id="A" box="0,0,20,20" label="甲" fill="海"/>',
  '  <rect id="B" box="60,60,80,80" label="乙" fill="#654321"/>',
  '  <arrow from="A.e" to="B.w"/>',
  '  <text x="50" y="90" align="center" color="#abcdef">居中字</text>',
  '</diagram>',
].join('\n')

describe('diagram 标签 DSL：解析 → 渲染', () => {
  it('① 解析零错误，且集合都收到了', () => {
    const p = parseDsl(SRC)
    expect(p.errors).toEqual([])
    expect(p.model.rects.map((r) => r.id)).toEqual(['A', 'B'])
    expect(p.model.segments).toHaveLength(1)
    expect(p.model.texts).toHaveLength(1)
    expect(p.model.colors['海']).toBe('#123456')
  })

  it('② 渲染不报错，且**画布尺寸取自 W/H**（回归钉：曾用 width/height 取到 undefined）', () => {
    const r = renderDsl(parseDsl(SRC).model)
    expect(r.errors).toEqual([])
    expect(r.svg).toContain('width="400"')
    expect(r.svg).toContain('height="300"')
    expect(r.svg).not.toContain('width="960"') // 渲染侧自带的缺省值（960×540）不得出现
  })

  it('③ 颜色名解析 ＋ **fill 字段真的被读到**（回归钉：曾读 color ⇒ 全是缺省灰）', () => {
    const r = renderDsl(parseDsl(SRC).model)
    expect(r.svg).toContain('#123456') // 命名色被查表解析
    expect(r.svg).toContain('#654321') // 直接用 #hex
  })

  it('④ **align 字段真的被读到**（回归钉：曾读 anchor ⇒ 恒 start）', () => {
    const r = renderDsl(parseDsl(SRC).model)
    expect(r.svg).toContain('text-anchor="middle"')
    expect(r.svg).toContain('居中字') // 文本内容与 CJK 都到位
  })

  it('⑤ 锚点引用能解析（顺序无关的引用不报错）', () => {
    const r = renderDsl(parseDsl(SRC).model)
    expect(r.errors.join(' / ')).not.toContain('锚点')
    expect(r.svg).toContain('<line ')
  })

  it('⑥ 四项体检的**正控**：造一对重叠块 ⇒ 必须报出来（证明体检不是瞎的）', () => {
    const bad = parseDsl(
      '<diagram width="400" height="300" domain="0,0,100,100">\n<rect box="0,0,20,20" label="甲"/>\n<rect box="10,10,30,30" label="乙"/>\n</diagram>',
    )
    const r = renderDsl(bad.model)
    expect(r.lint.join(' / ')).toContain('块重叠')
  })
})
