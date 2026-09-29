/**
 * diagram 光栅化 —— **真渲染**用例（2026-09-29，S142 D104；v1.51.1 补第二条字型）
 *
 * ## 为什么必须真跑一次
 * `rasterize.ts` 是本件唯一引**运行时外部依赖**（`@resvg/resvg-wasm`，纯 wasm）＋**随包字体资产**
 * 的模块，而"能不能画出中文"**不是设计偏好问题**：docker 实测里，装了系统中文体的容器
 * **照样渲染空白画布**（`loadSystemFonts` 两种取值的 PNG 逐字节相同）⇒ wasm 对系统字体完全不可见，
 * 只有 `fontBuffers` 才画得出字。
 *
 * ⇒ 本文件把那条结论变成**机械判据**（判据 ㉜：一个 cast ／ 一次"看起来对"都不能当证据）：
 *   ① 链路真通：`parseDsl → renderDsl → rasterizeSvg` 出 PNG，且尺寸 = 请求宽；
 *   ② **字真的画进去了**：同一张图"有字 vs 无字"逐字节**必须不同**。
 *
 * ## 🔴 v1.51.1 补的那一刀：②这条判据有漏洞
 * ②只证明**有墨**，**没证明墨是那个字** —— v1.51.0 只带了 CJK 兜底字型
 * （`DroidSansFallbackFull.ttf` **不含拉丁字母**），于是图里 `diagram`／`parseDsl`／`①`／`·`
 * 全渲染成**方框**（owner 实测肉眼可见），而 ②**照样绿**（方框也是墨）。
 *
 * ⇒ 补两条**点名覆盖字符集**的判据（本文件 ⑥⑦⑧）：
 *   · **同长度不同字形逐字节必须不同**（`AAAA` vs `WWWW`）—— 缺字形时两者是**同一批方框**
 *     （或都是空白）⇒ PNG 相等 ⇒ 本条红。这比"有字 vs 无字"强：它要求**取到的是那两个特定的字形**。
 *   · **家族栈顺序**（拉丁在前、汉字兜底）—— 顺序即回退顺序，写反了拉丁字符先落到 CJK 字型 ⇒ 又变方框。
 *
 * ## 🔴 视觉取证又推翻了"补一个拉丁就够"（D108）
 * 补完拉丁后**真看一眼图**才发现：`① ② ③` 与 `⇒`／`→` **仍是方框** —— 前两个字型
 * **都没有这些字形**（Droid 有汉字但无象征符号；Noto Sans 有拉丁但无带圈数字与箭头）。
 * ⇒ 再补第三个（`DejaVuSans.ttf`，实测覆盖 `①⇒→←▲●★✓✗≥≠×`；`NotoSansSymbols2` 实测**不够**）。
 * ⇒ 判据因此**按字符集分格点名**：拉丁 / 符号 / 汉字 各一条，缺哪格就红哪格。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { parseDsl } from '../src/diagram/dsl.js'
import { renderDsl } from '../src/diagram/dsl-render.js'
import {
  DIAGRAM_CJK_FONT_FAMILY,
  DIAGRAM_LATIN_FONT_FAMILY,
  DIAGRAM_SYMBOL_FONT_FAMILY,
  DIAGRAM_FONT_STACK,
} from '../src/diagram/fonts.js'
import {
  DIAGRAM_FONT_ASSET,
  DIAGRAM_FONT_ASSET_LATIN,
  DIAGRAM_FONT_ASSET_SYMBOL,
  diagramFontPath,
  diagramLatinFontPath,
  diagramSymbolFontPath,
  rasterizeSvg,
  resetRasterCache,
} from '../src/diagram/rasterize.js'

/** 有字的一份（CJK ＋ 一个块 ＋ 一条箭头） */
const WITH_TEXT = [
  '<diagram width="400" height="300" domain="0,0,100,100">',
  '  <rect id="A" box="10,10,40,40" label="德国" fill="#3366cc"/>',
  '  <arrow from="A.e" to="A.s"/>',
  '  <text x="50" y="80" align="center">中文标注</text>',
  '</diagram>',
].join('\n')

/** 同尺寸、同画布、**只有文字被拿掉**的一份（差分对照） */
const NO_TEXT = [
  '<diagram width="400" height="300" domain="0,0,100,100">',
  '  <rect id="A" box="10,10,40,40" label="" fill="#3366cc"/>',
  '  <arrow from="A.e" to="A.s"/>',
  '</diagram>',
].join('\n')

/** 端到端取 SVG（与工具同一条链：DSL → SVG） */
function svgOf(source: string): string {
  const r = renderDsl(parseDsl(source).model)
  expect(r.errors).toEqual([])
  return r.svg
}

/**
 * 只放一行文字的图（**固定 400×300 画布、默认坐标系**）——两份源码唯一的差别只有那行字。
 * 固定尺寸是为了让两张 PNG 的像素尺寸一致 ⇒ 逐字节差异**只能来自字形本身**。
 */
function textOnly(text: string): string {
  return [
    '<diagram width="400" height="300">',
    `  <text x="40" y="150" align="left">${text}</text>`,
    '</diagram>',
  ].join('\n')
}

/** 两张 PNG 是否逐字节不同 */
function differs(a: { png: Uint8Array }, b: { png: Uint8Array }): boolean {
  return Buffer.compare(Buffer.from(a.png), Buffer.from(b.png)) !== 0
}

describe('diagram 光栅化：SVG → PNG（进程内，内置字体）', () => {
  it('① 真渲染成功：出真 PNG（签名 89 50 4E 47）且尺寸 = 请求宽', async () => {
    const out = await rasterizeSvg(svgOf(WITH_TEXT), 320)
    // PNG 魔数：这是"它真是 PNG"的最低判据（不是"函数没抛错"）
    expect(Array.from(out.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(out.width).toBe(320)
    expect(out.height).toBeGreaterThan(0)
    expect(out.ms).toBeGreaterThanOrEqual(0)
  })

  it('② 字真的画进去了（差分：有字 vs 无字逐字节不同 —— 字体没喂进去本条必红）', async () => {
    const withText = await rasterizeSvg(svgOf(WITH_TEXT), 320)
    const noText = await rasterizeSvg(svgOf(NO_TEXT), 320)
    // 尺寸一致 ⇒ 差异只能来自"墨"（画布 + 块 + 箭头两份相同）
    expect(withText.width).toBe(noText.width)
    expect(withText.height).toBe(noText.height)
    expect(Buffer.compare(Buffer.from(withText.png), Buffer.from(noText.png))).not.toBe(0)
  })

  it('③ 内置字体资产在位（运行时与 pack-check 共用同一个判据来源）', () => {
    expect(DIAGRAM_FONT_ASSET).toBe('assets/diagram/DroidSansFallbackFull.ttf')
    const p = diagramFontPath()
    expect(existsSync(p)).toBe(true)
    // 大小下限：真字体（3.8 MB 量级），不是占位文件
    expect(statSync(p).size).toBeGreaterThan(1_000_000)
  })

  it('④ 缓存清掉后仍能重建（wasm 与字体各自重新加载；第二次渲染同样成功）', async () => {
    await rasterizeSvg(svgOf(WITH_TEXT), 200)
    resetRasterCache()
    const again = await rasterizeSvg(svgOf(WITH_TEXT), 200)
    expect(again.width).toBe(200)
    expect(Array.from(again.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('⑤ 宽度参数真的生效（不同宽度 ⇒ 不同像素尺寸，不是恒出同一张）', async () => {
    const small = await rasterizeSvg(svgOf(WITH_TEXT), 160)
    const large = await rasterizeSvg(svgOf(WITH_TEXT), 480)
    expect(small.width).toBe(160)
    expect(large.width).toBe(480)
    expect(large.height).toBeGreaterThan(small.height)
  })

  it('⑥ 三个字型资产都在位（v1.51.1 新增两个；与 pack-check 共用同一个判据来源）', () => {
    expect(DIAGRAM_FONT_ASSET).toBe('assets/diagram/DroidSansFallbackFull.ttf')
    expect(DIAGRAM_FONT_ASSET_LATIN).toBe('assets/diagram/NotoSans-Regular.ttf')
    expect(DIAGRAM_FONT_ASSET_SYMBOL).toBe('assets/diagram/DejaVuSans.ttf')
    // 大小下限 = 真字体（不是占位文件）；**上界** = 它是"那一个"字型
    // （把 3.8 MB 的 CJK 字型复制一份当拉丁/符号用，过不了上界 —— 那样覆盖根本没变）
    const bounds: Array<[string, number, number]> = [
      [diagramFontPath(), 1_000_000, 8_000_000], // 汉字 3.8 MB 量级
      [diagramLatinFontPath(), 50_000, 2_000_000], // 拉丁 0.5 MB 量级
      [diagramSymbolFontPath(), 50_000, 2_000_000], // 符号 0.74 MB 量级
    ]
    const paths: string[] = []
    for (const [p, lo, hi] of bounds) {
      expect(existsSync(p)).toBe(true)
      const size = statSync(p).size
      expect(size).toBeGreaterThan(lo)
      expect(size).toBeLessThan(hi)
      paths.push(p)
    }
    // 三个**互不相同**的文件（同一个文件喂三遍 ⇒ 覆盖一个字型都没多）
    expect(new Set(paths).size).toBe(3)
  })

  it('⑦ SVG 家族栈 = 拉丁 → 符号 → 汉字（**顺序即回退顺序**，写反了拉丁又变方框）', () => {
    // 顺序判据（不用"等于某个字面量"——那只是把源码抄一遍，不同源）
    const at = [
      DIAGRAM_FONT_STACK.indexOf(DIAGRAM_LATIN_FONT_FAMILY),
      DIAGRAM_FONT_STACK.indexOf(DIAGRAM_SYMBOL_FONT_FAMILY),
      DIAGRAM_FONT_STACK.indexOf(DIAGRAM_CJK_FONT_FAMILY),
    ]
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
    expect(at[0]).toBeLessThan(at[1])
    expect(at[1]).toBeLessThan(at[2])
    // 三个家族名必须互不相同：同名 ⇒ 栈里后面那个永远取不到（回退形同虚设）
    expect(new Set([DIAGRAM_LATIN_FONT_FAMILY, DIAGRAM_SYMBOL_FONT_FAMILY, DIAGRAM_CJK_FONT_FAMILY]).size).toBe(3)
    // 渲染器必须把它**逐字**写进 SVG 的根元素（否则 resvg 只认 defaultFontFamily = CJK ⇒ 拉丁全方框）
    expect(svgOf(WITH_TEXT)).toContain(`font-family="${DIAGRAM_FONT_STACK}"`)
  })

  it('⑧ 🔴 按字符集点名的差分：**同长度不同字形必须出不同墨**（缺哪格的红哪格）', async () => {
    const blank = await rasterizeSvg(svgOf(textOnly('')), 320)

    /**
     * 一格一判：同一画布、同一字号、**只有那一个字不同** ⇒ 两图必须不同。
     * 缺字形时两侧渲染成**同一批方框**（或都是空白）⇒ PNG 相等 ⇒ 该格红。
     */
    const charsets: Array<[string, string, string]> = [
      ['拉丁', 'AAAA', 'WWWW'], // v1.51.0 的漏洞就在这一格
      ['符号', '①①②②', '⇒⇒→→'], // v1.51.1 视觉取证才发现的那一格（D108）
      ['汉字', '德国', '法国'], // 回归：补前面两格时不得把 CJK 回退挤掉
    ]
    for (const [label, a, b] of charsets) {
      const x = await rasterizeSvg(svgOf(textOnly(a)), 320)
      const y = await rasterizeSvg(svgOf(textOnly(b)), 320)
      expect(x.width, `${label}：两张的像素宽必须一致（否则差异来自画布而非字形）`).toBe(y.width)
      expect(x.height, `${label}：两张的像素高必须一致`).toBe(y.height)
      expect(differs(x, y), `${label}：「${a}」与「${b}」渲染结果逐字节相同 ⇒ 字形没取到（方框/空白）`).toBe(true)
      // 反向对照：光"两侧不同"可能是两边**都没有墨**而画布本身有别的差异 ⇒ 再钉一次"确实有墨"
      expect(differs(x, blank), `${label}：与空白图相同 ⇒ 这一格根本没画出东西`).toBe(true)
    }
  })

  it('⑨ v1.51.1 的验收场景：**拉丁 ＋ 汉字混排**一图到底（owner 那条"英文全变方框"的现场）', async () => {
    const mixed = [
      '<diagram width="500" height="260">',
      '  <rect id="A" box="40,60,220,120" label="parseDsl" fill="#3366cc"/>',
      '  <rect id="B" box="260,60,440,120" label="解析器" fill="#cc6633"/>',
      '  <arrow from="A.e" to="B.w"/>',
      '  <text x="40" y="200" align="left">Serenity · 宁静号 ①</text>',
      '</diagram>',
    ].join('\n')
    const r = renderDsl(parseDsl(mixed).model)
    expect(r.errors).toEqual([])
    const out = await rasterizeSvg(r.svg, 600)
    expect(Array.from(out.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(out.width).toBe(600)
  })
})
