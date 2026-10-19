/**
 * settings-section-panel.test.ts — **设置面板行的存在性判据**（v1.59.0，2026-10-19 重定向）
 *
 * ## 为什么这件必须有（它来自一次真实的 owner 质问）
 *
 * 2026-10-17 owner 连问三句：「我要的功能呢，ACP 功能呢」→「开关呢？配置呢？我怎么用呢」→
 * 「我功能呢」。当时的实况：**功能代码 518 行全在、端口表在、装配点在、测试 24 例全绿**
 * —— 而 **面板上没有这一行**，配置里也没有能打开它的键。
 *
 * ⇒ **这是一个"全绿但用户拿不到"的缺陷**：所有机械判据都过，唯独**交付面缺了一格**。
 *   既有测试测的是"面能不能跑"，**没有一条测"用户够不够得着"**。
 *
 * ## 2026-10-19 的重定向（不是删掉，是换靶）
 *
 * 那个面（ACP）已被 owner 裁「完整删除整个 ACP 的实现」⇒ 它那一行**本就不该再存在**，
 * 原来的五条断言全部失去靶子。但**判据本身不能跟着功能一起消失** —— 否则下一个功能
 * 会以同样方式"全绿但用户拿不到"。
 * ⇒ 改为对**每一个仍在面板上的开关**逐条钉：数据面声明 ＋ 控件面接线 ＋ 呈现面有那一行。
 *
 * ## 本件的判据（静态文本级 —— 为什么足够）
 *
 * 面板是 React 组件，跑真渲染要拉 DOM 环境（本仓无此投入）。但**这个缺陷的形态是
 * "那一行根本不存在"／"字段没接上控件"**，不是"它渲染错了" ⇒ **静态断言足以捕获它**。
 * 三条对每一行成立：① `SerenitySimpleWire` 里有该键 ② 组件里有 `toggle('<键>'` ③ 有 `<RowCard>` 标题。
 *
 * ⚠️ **本件的边界（如实标注）**：它**不证明**那些行渲染出来好看、也不证明点击真的落盘
 * （后者已由 `settings-section.test.ts` 的优先级用例覆盖）。
 * ⇒ 它钉的是**"存在性"**这一格 —— 正是那次翻车的那一格。
 *
 * 🔴 **判据纪律**：断言**剥注释后**再找（否则注释里提一句键名就会假绿）。
 *    本文件下面还带一条"防假绿对照"，证明 `stripComments` 不是空操作。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = join(here, '..', 'src', 'client', 'SettingsSection.tsx')

/**
 * 剥掉块注释与行注释（**判据必须作用在代码上，不是注释上**）。
 *
 * 🔴 **本函数的第二版**：第一版只剥**整行**注释（以两个斜杠开头的那种）—— 那是照抄仓里既有的
 * 写法，而它是**不完整的**（行尾注释 `const a = 1` 后跟双斜杠的那种漏网）。
 * 本件的"对照用例"当场抓出了它 ⇒ 改成**行内任意位置**的双斜杠也剥。
 *
 * ⚠️ **已知边界（如实标注）**：它不理解字符串字面量 ⇒ 若某行有 `http:` 开头的 URL，
 *    双斜杠之后会被误剥。对**本文件**（面板组件，无 URL 字面量）无影响；
 *    ⛔ **不要**把这个版本直接搬去剥有 URL 的源码（先补字符串感知）。
 *
 * 🔴 **第三版（又一处实测）**：第二版的函数体里写了字面量 `/` 与 `*` 相邻的注释正则 ——
 *    而它**写在块注释里**，于是那个字面量**提前闭合了本段注释**，`tsc`/esbuild 当场报
 *    `Unexpected "."`。⇒ **本仓既有纪律：文档注释里不要写出会闭合注释的字符序列**
 *    （见 SESSION.md §交接断点最后一条；本轮是它的又一次发作）。现改为**拼接**构造该正则。
 */
function stripComments(code: string): string {
  const lineComment = new RegExp('/' + '/.*$', 'gm')
  const blockComment = new RegExp('/' + '\\*[\\s\\S]*?\\*' + '/', 'g')
  return code.replace(blockComment, '').replace(lineComment, '')
}

const raw = readFileSync(srcPath, 'utf8')
const code = stripComments(raw)

/**
 * 面板上**当前必须存在**的每一行。
 * `bind` = 该键在组件里的**接线写法**（开关是 `toggle(...)`，数值是 `setXxx(...)`）——
 * 逐行写死是有意的：它是本文件判据的靶，靶必须能一眼核对，不能从源码里"推导"出来。
 */
const PANEL_ROWS: ReadonlyArray<{ key: string; bind: string; title: string }> = [
  { key: 'gatewayEnabled', bind: "toggle('gatewayEnabled'", title: '双端口网关' },
  { key: 'rebuildThresholdK', bind: 'setThreshold(', title: '重建阈值' },
  // ⛔ 2026-10-19：`skiffEnabled` / `skiffDebugPort` 两行已删 —— Skiff 调试面（3099）整条退役
  //    （owner 令「面板里 Skiff 的内容不要了」）。靶表必须**同批**删掉这两行，
  //    否则本文件会去要求一个**已经不存在的面板行** ⇒ 恒红（本次实测就是这样红的）。
  { key: 'croEnabled', bind: "toggle('croEnabled'", title: 'CRO' },
  { key: 'diagramEnabled', bind: "toggle('diagramEnabled'", title: '图（diagram）' },
]

describe('设置面板：每个开关都必须"数据面 ＋ 控件面 ＋ 呈现面"三面俱到', () => {
  it('🔴 数据面：`SerenitySimpleWire` 必须声明每一个面板键（漏声明 ⇒ 面板读不到值）', () => {
    const at = code.indexOf('interface SerenitySimpleWire')
    expect(at, '找不到 SerenitySimpleWire 接口 —— 判据的前提没满足').toBeGreaterThan(-1)
    const block = code.slice(at, code.indexOf('}', at))
    for (const { key } of PANEL_ROWS) {
      expect(block, `${key} 不在 SerenitySimpleWire 里`).toContain(key)
    }
  })

  it('🔴 控件面：每个键都必须有接线（只声明字段而不接控件 = 用户改不了）', () => {
    for (const { key, bind } of PANEL_ROWS) {
      expect(code, `${key} 没有接到任何控件上`).toContain(bind)
    }
  })

  it('🔴 呈现面：每一行都必须有 `<RowCard>` 标题（用户能看见的那一格）', () => {
    for (const { title } of PANEL_ROWS) {
      // 标题里有全角括号 ⇒ 转义后当普通字符用（`（`/`）` 在正则里本来就无特殊含义，
      // 这里只把半角括号换成通配，避免以后标题微调就红）
      const pattern = title.replace(/[()]/g, '.')
      expect(code, `面板上找不到标题含「${title}」的 RowCard`).toMatch(
        new RegExp(`<RowCard[\\s\\S]{0,400}?title="${pattern}`),
      )
    }
  })

  it('🔴 已删除的 ACP 面不得在面板上复活（整面删除的机械守卫）', () => {
    // 双方向都挡：数据面留字段 / 呈现面留行，任一残留都说明"删了一半"。
    expect(code).not.toContain('acpFaceEnabled')
    expect(code).not.toContain('acpFacePort')
    expect(code).not.toContain('ACP 面')
  })

  it('🔴 已退役的 Skiff 调试面不得在面板上复活（2026-10-19 整面退役的机械守卫）', () => {
    // owner 令「面板里 Skiff 的内容不要了，下掉吧，功能也检查下，应该下掉了」
    // ⇒ 面本体（surface/debug.ts）＋ 装配 ＋ 两个配置键 ＋ 面板行 一起走。
    // 本判据挡的是"**只删了面、面板行又长回来**"这种半删 —— 它没有任何机械信号。
    expect(code).not.toContain('skiffEnabled')
    expect(code).not.toContain('skiffDebugPort')
    expect(code).not.toContain('Skiff 调试')
  })

  it('对照（防假绿）：`stripComments` 真的会剥掉注释（证明它不是空操作）', () => {
    // 若 stripComments 是个 no-op，上面几条就可能靠"注释里写了"而假绿
    const sample = 'const a = 1 // gatewayEnabled\n/* toggle(\'gatewayEnabled\' */ const b = 2'
    const stripped = stripComments(sample)
    expect(stripped).not.toContain('gatewayEnabled')
    expect(stripped).toContain('const a = 1')
    expect(stripped).toContain('const b = 2')
    // 真文件里确实有注释被剥掉（两个变量都在用）
    expect(raw.length).toBeGreaterThan(code.length)
  })
})
