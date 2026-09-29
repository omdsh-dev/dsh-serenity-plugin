/**
 * diagram 字体事实源（**唯一真相源**：资产路径 ＋ 家族名 ＋ CSS 家族栈）
 *
 * 为什么单独成模块（R↓）：两处都要它，而它们的依赖面**必须**保持不同 ——
 *   · `dsl-render.ts` 只生成 SVG 字符串（**纯函数、零 fs**），它需要在 SVG 里写 `font-family` 栈；
 *   · `rasterize.ts` 要读字体文件喂给 wasm，并设 `defaultFontFamily`。
 * ⇒ 谁都不该从对方 import（前者会被拖进 `node:fs`／wasm，后者不该定义 SVG 措辞）。
 *
 * ## 为什么是**三个**字型（每一个都由一张实测图证明，不是偏好，也不是"多带点保险"）
 *
 * | 字型 | 覆盖 | 它修好了什么（实测） |
 * |---|---|---|
 * | `DroidSansFallbackFull.ttf` | 汉字 | 没有它 ⇒ 中文全是方框（docker 实测：wasm 对系统字体**完全不可见**） |
 * | `NotoSans-Regular.ttf` | 拉丁 | 没有它 ⇒ `diagram` ／ `parseDsl` 全变方框（Droid 是 **CJK 兜底字型**，**不含拉丁**） |
 * | `DejaVuSans.ttf` | 符号 | 没有它 ⇒ `① ② ③` ／ `⇒ ⇒` ／ `→` 仍是方框（**前两个都没有这些字形**，实测对照图见 `docs/diagram-tool-feasibility.md`） |
 *
 * 🔴 **上一版的判据漏洞**（v1.51.1 修的）：那条"有字 vs 无字逐字节不同"只证明**有墨**，
 * 没证明**墨是那个字** —— 方框也是墨 ⇒ 拉丁全变方框时它**照样绿**。
 * ⇒ 现在每条覆盖声明都配一条**点名字符集**的差分用例：同长度不同字形 ⇒ 必须出不同墨。
 *
 * ## 家族名是**量出来的**，不是猜的
 * 下表取自各文件 `name` 表 `nameID=1`（平台 3 ／ UTF-16BE）：
 * `Droid Sans Fallback` ／ `Noto Sans` ／ `DejaVu Sans`。
 * 写错名字时 resvg 的自动回退仍可能把字画出来（**图上看不出来**）⇒ 名字正确与否只能这样证明。
 */
export const DIAGRAM_CJK_FONT_ASSET = 'assets/diagram/DroidSansFallbackFull.ttf'
export const DIAGRAM_LATIN_FONT_ASSET = 'assets/diagram/NotoSans-Regular.ttf'
export const DIAGRAM_SYMBOL_FONT_ASSET = 'assets/diagram/DejaVuSans.ttf'
/** 汉字字型的家族名（**字体文件自报的族名**，写错就取不到） */
export const DIAGRAM_CJK_FONT_FAMILY = 'Droid Sans Fallback'
/** 拉丁字型的家族名 */
export const DIAGRAM_LATIN_FONT_FAMILY = 'Noto Sans'
/** 符号字型的家族名 */
export const DIAGRAM_SYMBOL_FONT_FAMILY = 'DejaVu Sans'
/**
 * SVG 里写的家族栈（**顺序即回退顺序**）：拉丁优先取 Noto，符号落 DejaVu，其余字形落到 Droid。
 * ⚠️ 末尾的通用名（`sans-serif`）只是兜底惯例：本部署里 resvg **不带系统字体**
 * （`loadSystemFonts: false`）⇒ 它取不到任何东西，真正的兜底是上面三个内置字型。
 */
export const DIAGRAM_FONT_STACK =
  `'${DIAGRAM_LATIN_FONT_FAMILY}', '${DIAGRAM_SYMBOL_FONT_FAMILY}', '${DIAGRAM_CJK_FONT_FAMILY}', sans-serif`
