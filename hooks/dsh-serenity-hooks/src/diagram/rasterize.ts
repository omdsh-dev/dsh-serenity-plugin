/**
 * diagram 光栅化 —— SVG → PNG（**纯进程内，不起浏览器、不截图**）
 *
 * 为什么是 `@resvg/resvg-wasm`（owner 2026-09-29 裁「内置」，判据 = 可行性调研 §7 的 docker 实测）：
 *   ① **纯 wasm**：无原生二进制、无平台/架构约束、无 postinstall 构建（公开包最怕那三样）；
 *   ② 实测渲染一张图尺寸画布 ≈60 ms ／ ~55 KB PNG。
 *
 * 🔴 **必须喂字体，且这是实测结论不是设计偏好**：docker 里给容器装好中文字体（`fc-list` 认它）
 *   后，resvg-wasm 渲染中文**仍得到空白画布**，且 `loadSystemFonts:true` 与 `false` **逐字节相同**
 *   ⇒ **wasm 对系统字体完全不可见**。只有 `fontBuffers` 才画得出字。
 *   ⇒ 顺带白拿一个好处：**输出与机器无关**（同一份内置字体 ⇒ 逐字节可复现，S↑ 稳定）。
 *
 * 字体资产随包分发：`assets/diagram/DroidSansFallbackFull.ttf`（3.8 MB，Apache-2.0，含许可证与出处）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

/**
 * 包根 = **向上找到含 `package.json` 的那一级**。
 *
 * 🔴 为什么不能照抄 `voyage-page.ts` 的「`..` 一次」：那个文件在 `src/` 根下，一次 `..` 恰好是包根；
 * 本模块在 `src/diagram/` 里 ⇒ 开发态（vitest 直接跑 TS 源码）一次 `..` 只到 `src/`，
 * 于是去找 `src/assets/…` —— **实测 ENOENT**（测试全红，且现象是"字体不在"，与真因"路径层级算错"
 * 长得完全不同）。按 `package.json` 上溯对**开发态（src/diagram）与发布态（lib/diagram）都成立**。
 * @returns 包根绝对路径；四层内找不到 `package.json` 时回落"上一级"（不抛——定位失败由调用方响亮报错）
 */
function packageRootPath(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return join(start, '..')
}

/** 字体资产相对包根的路径（**必须同时出现在 package.json 的 files 白名单里**，pack-check 会核对） */
export const DIAGRAM_FONT_ASSET = 'assets/diagram/DroidSansFallbackFull.ttf'

/** 字体绝对路径（导出以便测试与 pack-check 共用同一判据来源） */
export function diagramFontPath(): string {
  return join(packageRootPath(), DIAGRAM_FONT_ASSET)
}

/**
 * 内置字体的族名。SVG 里声明的 `Noto Sans CJK SC` ／ `Source Han Sans SC` ／ `Microsoft YaHei`
 * 在本机**一个都不存在**（本机 CJK 覆盖只有 AR PL UMing ＋ Droid Sans Fallback）
 * ⇒ 光栅化时必须由这里兜底，否则中文会退化成缺字方框。
 */
export const DIAGRAM_FONT_FAMILY = 'Droid Sans Fallback'

let wasmReady: Promise<void> | null = null
let fontBuf: Uint8Array | null = null

/**
 * wasm 模块路径：**先解析 JS 入口再取同目录的 `.wasm`**。
 * 不直接 resolve `.wasm` 的原因：包的 `exports` 表未必暴露该子路径（解析失败会抛，
 * 而"抛"与"文件不在"在验收上长得一样 —— 故走这条更稳的路）。
 */
function wasmPath(): string {
  const req = createRequire(import.meta.url)
  return join(dirname(req.resolve('@resvg/resvg-wasm')), 'index_bg.wasm')
}

function ensureReady(): Promise<void> {
  if (wasmReady === null) {
    wasmReady = initWasm(readFileSync(wasmPath())).catch((err: unknown) => {
      // 🔴 `initWasm()` 是**进程级一次性**（宿主 API 约束：第二次调用直接抛
      //    `Already initialized. The initWasm() function can be used only once.`）。
      //    而本模块**会被重新加载**：vitest 的用例隔离、插件热重建（面板拨开关 ⇒ 宿主
      //    `fiber.update()` ⇒ 插件 restart）、HMR —— 每次都会让 `wasmReady` 回到 null。
      //    ⇒ 那种抛错**不是失败**（wasm 早已在跑），只吞这一种；其余照抛
      //    （否则真失败会被静默成"图是空白的"，比抛错坏得多）。
      if (/already initialized/iu.test(String((err as Error)?.message ?? err))) return
      throw err
    })
  }
  return wasmReady
}

/** 字体只读一次（3.8 MB，进程内缓存） */
function fontBuffer(): Uint8Array {
  if (fontBuf === null) fontBuf = readFileSync(diagramFontPath())
  return fontBuf
}

export interface RasterResult {
  png: Uint8Array
  /** 实际输出像素宽（= `fitTo width` 的结果；供工具回执如实报尺寸） */
  width: number
  /** 实际输出像素高（按 SVG 自身比例推出） */
  height: number
  /** 渲染耗时（ms）—— 供工具自述与诊断用 */
  ms: number
}

/**
 * SVG → PNG。
 * @param width 输出像素宽（矢量无损放大；高度按 SVG 自身比例推出）
 */
export async function rasterizeSvg(svg: string, width: number): Promise<RasterResult> {
  await ensureReady()
  const t0 = Date.now()
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontBuffers: [fontBuffer()],
      loadSystemFonts: false,
      defaultFontFamily: DIAGRAM_FONT_FAMILY,
    },
  })
  const img = r.render()
  const png = img.asPng()
  return { png, width: img.width, height: img.height, ms: Date.now() - t0 }
}

/** 测试用：清本模块的缓存（**字体缓冲 + 就绪 promise**）。
 *  ⚠️ **wasm 本身无法"重置"**（`initWasm` 进程级一次性）⇒ 清掉后下一次 `rasterizeSvg`
 *  会**重新走一遍 init 并命中共用态**（"already initialized" 由 `ensureReady` 吞掉）。 */
export function resetRasterCache(): void {
  wasmReady = null
  fontBuf = null
}
