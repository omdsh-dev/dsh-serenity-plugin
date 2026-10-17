/**
 * settings-section-panel.test.ts — **设置面板行的存在性判据**（v1.59.0）
 *
 * ## 为什么这件必须有（它来自一次真实的 owner 质问）
 *
 * 2026-10-17 owner 连问三句：「我要的功能呢，ACP 功能呢」→「开关呢？配置呢？我怎么用呢」→
 * 「我功能呢」。当时的实况：**面 E 代码 518 行全在、端口表在、装配点在、测试 24 例全绿**
 * —— 而 **面板上没有这一行**，配置里也没有能打开它的键。
 *
 * ⇒ **这是一个"全绿但用户拿不到"的缺陷**：所有机械判据都过，唯独**交付面缺了一格**。
 *   既有测试测的是"面能不能跑"，**没有一条测"用户够不够得着"**。
 *
 * ## 本件的判据（静态文本级 —— 为什么足够）
 *
 * 面板是 React 组件，跑真渲染要拉 DOM 环境（本仓无此投入）。但**这个缺陷的形态是
 * "那一行根本不存在"**，不是"它渲染错了" ⇒ **静态断言足以捕获它**：
 * ① `SerenitySimpleWire` 里必须有 `acpFaceEnabled` / `acpFacePort`（数据面）
 * ② 组件里必须有一个绑到 `acpFaceEnabled` 的 `Toggle`（控件面）
 * ③ 该行必须在 JSX 里（`<RowCard>` 的 title 含 "ACP"）（呈现面）
 *
 * ⚠️ **本件的边界（如实标注）**：它**不证明**那一行渲染出来好看、也不证明点击真的落盘
 * （后者已由 `settings-section.test.ts` 的优先级用例覆盖）。
 * ⇒ 它钉的是**"存在性"**这一格 —— 正是这次翻车的那一格。
 *
 * 🔴 **判据纪律**：断言**剥注释后**再找（否则注释里提一句 `acpFaceEnabled` 就会假绿）。
 *    同族先例：`acp-face.test.ts` 的 `stripComments`（本仓既有的做法）。
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
 * `acp-face.test.ts` 写法，而它是**不完整的**（行尾注释 `const a = 1` 后跟双斜杠的那种漏网）。
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

describe('设置面板：面 E（ACP）那一行必须存在（owner 质问的回归钉）', () => {
  it('🔴 数据面：`SerenitySimpleWire` 必须声明 `acpFaceEnabled`', () => {
    expect(code).toContain('acpFaceEnabled')
  })

  it('🔴 数据面：必须声明 `acpFacePort`（端口可在面板上调）', () => {
    expect(code).toContain('acpFacePort')
  })

  it('🔴 控件面：必须有绑到 `acpFaceEnabled` 的 Toggle（不是只声明了字段）', () => {
    // 判据：出现过 `toggle('acpFaceEnabled'` —— 这是本文件里开关的**唯一**写法
    expect(code).toContain("toggle('acpFaceEnabled'")
  })

  it('🔴 呈现面：必须有一行 `<RowCard>` 标题提到 ACP（用户能看见的那一格）', () => {
    expect(code).toMatch(/<RowCard[\s\S]{0,400}?title="[^"]*ACP/)
  })

  it('🔴 面板必须说清"协议无认证"这条前提（不许让用户看到 active 就以为它安全）', () => {
    // ⚠️ 不用 `</RowCard>` 收尾 —— 本文件的 RowCard 是**自闭合**（`/>`），没有闭合标签
    //    （第一版就是这么写错的：正则恒不匹配，看起来像"面板没写"，其实是**判据自己错了**。
    //     同族：'判据报红先证"我喂给它的输入满足前提"'  —— 本轮实测又踩一次。）
    const at = code.indexOf('title="ACP 面')
    expect(at).toBeGreaterThan(-1)
    const block = code.slice(at, at + 4000)
    expect(block).toMatch(/不做认证|无认证/)
    // 并且要给出**怎么办**（否则用户知道不安全却不知道去哪配）
    expect(block).toMatch(/IM_ACP_TOKEN|token/)
  })

  it('对照（防假绿）：`stripComments` 真的会剥掉注释（证明它不是空操作）', () => {
    // 若 stripComments 是个 no-op，上面几条就可能靠"注释里写了"而假绿
    const sample = 'const a = 1 // acpFaceEnabled\n/* toggle(\'acpFaceEnabled\' */ const b = 2'
    const stripped = stripComments(sample)
    expect(stripped).not.toContain('acpFaceEnabled')
    expect(stripped).toContain('const a = 1')
    expect(stripped).toContain('const b = 2')
    // 真文件里确实有注释被剥掉（两个变量都在用）
    expect(raw.length).toBeGreaterThan(code.length)
  })
})
