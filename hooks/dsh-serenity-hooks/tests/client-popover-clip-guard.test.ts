/**
 * client-popover-clip-guard.test.ts — 自绘 popover **定位形态守卫**（S142，2026-09-17）
 *
 * 背景（真机取证全过程见 SESSION.md §0p）：
 *   会话头部状态胶囊展开的卡片 `.sp-pop` 曾是 `position:absolute; right:0`。
 *   v1.36.1 把卡片加宽 340 → 680px（owner：「卡片做成双倍宽」），且 `right:0` 对齐
 *   ⇒ 卡片只向**左**长，左边界落到 274.2px。
 *   而祖先 `pI_x6G_centerCol` / `wSkVaW_root` 是 `overflow:hidden` 且左边界 = **280px**
 *   ⇒ 左边缘 5.8px 被**裁掉**（左边框线与圆角消失）。
 *   用户反馈原文：「下拉 dialog / 弹窗内容过宽后，会被左侧元素遮挡」。
 *
 * 修法（v1.39.1）：`.sp-pop` 改 `position:fixed`（**fixed 子元素不受祖先 overflow 裁切**）
 *   ＋ SafeModePanel 用 `getBoundingClientRect()` 算坐标并夹取进视口。
 *   （本仓 client 侧无 `react-dom` 依赖 ⇒ `createPortal` 不可用。）
 *
 * 本测试**机械守卫该形态**：`.sp-pop` 一旦被改回 absolute 定位（或被"顺手简化"回去），
 * 立即变红——因为那不是样式偏好，而是本 bug 的**成因本身**。
 * 行为面证据（hit-test / 三档宽度）在 **CCC（宁静号仓）** 的
 *   `AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/ui-probe/`
 * （CDP 真机探针：`measure.mjs`（测量唯一真相源）／`probe.mjs`／`verify.mjs`／`mock-probe.mjs` ＋ `artifacts/` 读数），
 * **不在本插件仓** —— 两仓分离（本插件仓只放代码与单测；真机取证链住在 CCC）。
 * ⚠️ 2026-09-25 更正：此行原先只写 `ui-probe/`（**仓内相对路径写法**）⇒ 在本仓找不到，
 * 会被读成"指向一个已删目录"（地图 §3-9 第 9 行当时就是这么判的）。
 * 本单测跑在 node 环境（无 DOM）⇒ 只能守**形态**；行为面必须回上面那条路径取证。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const css = readFileSync(join(clientDir, 'SafeModePanel.css'), 'utf-8')
const tsx = readFileSync(join(clientDir, 'SafeModePanel.tsx'), 'utf-8')

/** 取 `.sp-pop { … }` 基础规则体（注意别匹配到 `.sp-popBody` / `.sp-popVoyage` / `.sp-popVoyage > .sp-popBody`） */
function ruleBody(source: string, selector: string): string {
  const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
  const m = re.exec(source)
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

describe('自绘 popover 定位形态（防"祖先 overflow 裁切"回归）', () => {
  const pop = ruleBody(css, '.sp-pop')

  it('.sp-pop 用 position: fixed（不受祖先 overflow:hidden 裁切）', () => {
    expect(pop).toMatch(/position:\s*fixed/)
    expect(pop).not.toMatch(/position:\s*absolute/)
  })

  it('.sp-pop 不再用 right 锚定（right:0 是"向左长"、撞上祖先裁剪边界的成因）', () => {
    expect(pop).not.toMatch(/^\s*right:\s*0/m)
  })

  it('宽度仍保留视口兜底（窄视口不溢出）', () => {
    expect(pop).toMatch(/width:\s*min\(\s*680px\s*,\s*calc\(100vw\s*-\s*24px\)\s*\)/)
  })

  it('坐标由组件计算：useLayoutEffect + getBoundingClientRect + 视口夹取', () => {
    // 三个要素缺一不可——缺 useLayoutEffect 会闪帧；缺 rect 无法跟随锚点；缺夹取会在窄视口溢出
    expect(tsx).toMatch(/useLayoutEffect\(/)
    expect(tsx).toMatch(/getBoundingClientRect\(\)/)
    expect(tsx).toMatch(/window\.innerWidth/)
    expect(tsx).toMatch(/Math\.max\(POP_VIEW_PAD_PX/) // 视口左/上留白夹取
  })

  it('落位前渲染在屏外（避免未定位时闪现在 0,0）', () => {
    expect(tsx).toMatch(/POP_OFFSCREEN/)
    expect(tsx).toMatch(/popPos\s*\?/)
  })
})
