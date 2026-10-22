/**
 * tests/tools/im-docs.test.ts — 「IM 桥手册」正文的内容判据
 *
 * ## 为什么这份测试必须有（判据各不相同，不是为了过 coverage-gate）
 *
 * 这一章是 owner 点名补的：「ACC 没提供 IM 桥使用说明和账户查询方法，
 * 导致 CCC 没办法自己配路由」⇒ 它**是** CCC 配路由的唯一说明面。
 * 它最坏的失效形态不是"写得不好"，而是**教了一个不存在的动作**：
 * 读者照着做，工具回 `CHANNEL_UNKNOWN`／`ACTION_UNSUPPORTED`，而手册里没提这种情况。
 *
 * ⇒ 本文件的核心判据是 **D179 的机械化**：
 *    **手册里出现的每个 action 名，必须真的在该工具的 action 枚举里**（反向也钉）。
 *
 * 🔵 与 `container-admin.test.ts` 的分工：
 *    那边钉「章在不在菜单里、取不取得到」；**本文件钉「取到的正文里有什么、对不对」**。
 *    与 `im/contacts.test.ts` 的分工：那边钉 `contacts` 的**行为**；本文件钉**描述该行为的文字**。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IM_BRIDGE_GUIDE } from '../../src/tools/im-docs.js'

const HOOKS_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const IM_BRIDGE_SRC = join(HOOKS_DIR, 'src', 'tools', 'im-bridge.ts')

/**
 * 从工具源码里**读出** action 枚举（而不是在这里再抄一份）。
 *
 * 🔴 抄一份就是第二真相源：源码加一个动作而手册没跟上时，
 *    抄来的那份会让测试照样绿 —— 那正是本文件要防的事。
 */
function actionsOfTool(): string[] {
  const src = readFileSync(IM_BRIDGE_SRC, 'utf-8')
  const m = /const ACTIONS = \[([^\]]+)\] as const/.exec(src)
  if (!m) throw new Error('im-bridge.ts 里找不到 ACTIONS 常量（判据的前提没了，先修探针）')
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

describe('im-docs：IM 桥手册（手册描述的必须是已建成的东西，D179）', () => {
  it('🔴 ① 手册与实现的 action 集合**互为子集** —— 少写一个 = 有动作不可发现，多写一个 = 教一个不存在的动作', () => {
    const real = actionsOfTool()
    // ⚠️ 扫描域自证：先钉"靶确实非空"，否则下面两个 every 会永远绿
    expect(real.length).toBeGreaterThanOrEqual(5)

    // 手册里每个 action 名都得真在枚举里（多写 = 教假动作）
    const phantom = real.filter((a) => !IM_BRIDGE_GUIDE.includes(a))
    expect(phantom, `手册漏讲了这些真动作：${phantom.join(', ')}`).toEqual([])

    // 反向：手册"五个动作"这一节的表格行必须与枚举**等数**
    //    （只数该节内的表格行，不扫全文 —— 全文里 `send` 出现在别处是正常的）
    const section = IM_BRIDGE_GUIDE.slice(
      IM_BRIDGE_GUIDE.indexOf('## 二、五个动作'),
      IM_BRIDGE_GUIDE.indexOf('## 三、'),
    )
    const rows = [...section.matchAll(/^\| `([a-z-]+)`/gm)].map((x) => x[1]!)
    expect(rows).toEqual(real)
  })

  it('🔴 ② `contacts` 必须讲到三样 —— 只列名字的话，这个动作等于没做', () => {
    const g = IM_BRIDGE_GUIDE
    expect(g).toContain('contacts')
    // ① 对方 id（配路由要复制的那一格）
    expect(g).toContain('userId')
    // ② 有往来但没配路由（该配的）
    expect(g).toContain('unrouted')
    // ③ 配了路由却从没出现（id 可能写错）
    expect(g).toContain('orphanRoutes')
    // ④ 扫描域（否定性结论的可信度上限）
    expect(g).toContain('sources')
  })

  it('🔴 ③ 配路由三步法必须写全（contacts → 写 → status 自检），且自检要给出判读方法', () => {
    const g = IM_BRIDGE_GUIDE
    // 三步各自的动作名都在
    expect(g).toContain('action:"contacts"')
    expect(g).toContain('routes')
    expect(g).toContain('action:"status"')
    // 🔴 自检那一格的判读：写错编码**不会报错**，只会静默不投递 —— 这句才是这一节的价值
    expect(g).toContain('targetExists')
    expect(g).toContain('不会有任何报错')
  })

  it('🔴 ④ 落盘路径：新路径正确，且必须说明老路径仍被读取（认族不认名，D167）', () => {
    const g = IM_BRIDGE_GUIDE
    expect(g).toContain('_im-logs/<channel>/')
    // 老路径必须出现且被判为"读侧仍认"——只写新名 = 迁移前的历史静默读不到
    expect(g).toContain('_weixin-logs/')
    expect(g).toContain('只往新路径写')
  })

  it('🔴 ⑤ 错误码表里的码必须是真的会出现的码（手册不是愿望清单）', () => {
    const g = IM_BRIDGE_GUIDE
    // 这几个码在 channels.ts 里逐字存在；钉住它们，防止手册写一套、实现发另一套
    for (const code of ['CHANNEL_NOT_CONFIGURED', 'ALIAS_UNKNOWN', 'ACTION_UNSUPPORTED', 'FILE_ESCAPE']) {
      expect(g, `手册缺了这个真实错误码：${code}`).toContain(code)
    }
  })

  it('⑥ 边界（明确不做什么）必须写明 —— 否则读者会去试跨 CCC 发送', () => {
    const g = IM_BRIDGE_GUIDE
    expect(g).toContain('边界')
    expect(g).toContain('跨 CCC')
    // "只作用于本容器"是这条边界的一句话形态，两处都得在
    expect(g).toContain('只作用于本容器')
  })

  it('🔵 正控：正文非空且量级合理（防"扫了空串"式假绿）', () => {
    expect(IM_BRIDGE_GUIDE.length).toBeGreaterThan(2000)
    expect(IM_BRIDGE_GUIDE).toContain('IM 桥')
    // 至少 5 个二级标题 —— 骨架塌了（比如整段被误删）这里会先红
    expect(IM_BRIDGE_GUIDE.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })
})
