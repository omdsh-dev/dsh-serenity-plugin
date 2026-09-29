/**
 * diagram 光栅化 —— **真渲染**用例（2026-09-29，S142 D104）
 *
 * ## 为什么必须真跑一次
 * `rasterize.ts` 是本件唯一引**运行时外部依赖**（`@resvg/resvg-wasm`，纯 wasm）＋**随包 3.8 MB 字体资产**
 * 的模块，而"能不能画出中文"**不是设计偏好问题**：docker 实测里，装了系统中文体的容器
 * **照样渲染空白画布**（`loadSystemFonts` 两种取值的 PNG 逐字节相同）⇒ wasm 对系统字体完全不可见，
 * 只有 `fontBuffers` 才画得出字。
 *
 * ⇒ 本文件把那条结论变成**机械判据**（判据 ㉜：一个 cast ／ 一次"看起来对"都不能当证据）：
 *   ① 链路真通：`parseDsl → renderDsl → rasterizeSvg` 出 PNG，且尺寸 = 请求宽；
 *   ② **字真的画进去了**：同一张图"有字 vs 无字"逐字节**必须不同** ——
 *      若字体缓冲没喂进 wasm（或喂错），字形无源可依 ⇒ 有字那份会与无字那份**完全一致**，本条即红。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { parseDsl } from '../src/diagram/dsl.js'
import { renderDsl } from '../src/diagram/dsl-render.js'
import { DIAGRAM_FONT_ASSET, diagramFontPath, rasterizeSvg, resetRasterCache } from '../src/diagram/rasterize.js'

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
})
