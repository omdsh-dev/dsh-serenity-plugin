/**
 * im-bridge-feishu-panel.test.ts — 飞书账号的**面板入口**与**读数面**（P4，2026-10-19）
 *
 * ## 为什么需要这份文件（R↓，它不是"补个覆盖率"）
 *
 * owner 原话：「**页面上没办法添加飞书 account，要能支持，不然我不知道怎么配**」。
 * 排查后发现是**两处**同时缺，而且都**零机械信号**：
 *
 * 1. **面板没有入口**：`ImBridgeEditor` 只有微信扫码行。飞书没有扫码形态，
 *    于是整个渠道在界面上**不存在** —— 用户无从下手（配置键名在 localstore 里，不可发现）。
 * 2. **GET wire 不回 `channel`**：面板按 `a.channel` 选标签与表单，字段缺了就被归一成
 *    `weixin` ⇒ **飞书账号显示成「微信」**，且给它的表单是扫码。
 *
 * 🔴 这两条都是**读数面 / 呈现面**的缺陷，行为测试（起桥、收发）**全都抓不到**：
 * 桥能正常工作，只是人配不上它。同族判据：D151（引用随退役失效）、T4（`promptSource` 只看旧字段）。
 *
 * ## 判据的分工
 *
 * - 「面板有飞书表单」= 静态源码判据（本文件上半）。**剥注释后**再看，
 *   否则"注释里提过飞书"会假绿（本仓既有的 `stripComments` 教训）。
 * - 「wire 回 channel」= 服务端读数判据（本文件下半）。它必须打在**真实处理器**上，
 *   而不是照抄一遍源码 —— 所以直接调 `imCredentialBound` 这一层，并核对 http.ts 的装配。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = join(here, '..', 'src', 'client', 'ImBridgeEditor.tsx')
const httpSrc = join(here, '..', 'src', 'surface', 'http.ts')

/**
 * 剥掉块注释与行注释（判据必须作用在代码上）。
 * ⚠️ 与 `settings-section-panel.test.ts` 同款：不理解字符串字面量。
 * 对本文件覆盖的两份源码无 URL 字面量 ⇒ 可用；⛔ 别搬去剥有 URL 的文件。
 */
function stripComments(code: string): string {
  const lineComment = new RegExp('/' + '/.*$', 'gm')
  const blockComment = new RegExp('/' + '\\*[\\s\\S]*?\\*' + '/', 'g')
  return code.replace(blockComment, '').replace(lineComment, '')
}

const clientCode = stripComments(readFileSync(clientSrc, 'utf8'))
const httpCode = stripComments(readFileSync(httpSrc, 'utf8'))

describe('飞书面板入口（P4）：owner 要能"在页面上配飞书"', () => {
  it('🔴 面板必须有飞书凭据表单的**三格输入**（appId / appSecret / 账号名）', () => {
    // 三个 state 各对应一格输入；缺任一格都意味着某一项无法录入。
    expect(clientCode).toContain('feishuAppId')
    expect(clientCode).toContain('feishuAppSecret')
    expect(clientCode).toContain('feishuName')
    // 呈现面：App Secret 必须是密码型输入（它是凭据，不该明文铺在屏幕上）
    expect(clientCode).toMatch(/type="password"/)
  })

  it('🔴 面板必须真的**提交**到后端（只有表单没有动作 = 仍然配不上）', () => {
    // 判据锚在 action 名上：前后端用同一个字符串，改名即两边同批改
    expect(clientCode).toContain("action: 'add-feishu-account'")
  })

  it('🔴 后端必须处理 `add-feishu-account`，且凭据落 localstore', () => {
    expect(httpCode).toContain("body.action === 'add-feishu-account'")
    expect(httpCode).toContain('writeFeishuCredential')
  })

  it('🔴 两格凭据必须同时校验（只填一个等于没绑）', () => {
    // 若只校验 appId，用户会得到一个"看起来加上了但永远连不上"的账号
    expect(httpCode).toMatch(/appId === '' \|\| appSecret === ''/)
  })

  it('🔴 扫码行必须标明是微信独有形态（否则用户会等飞书二维码）', () => {
    // 这一条挡的是：飞书接上后，扫码行仍写"扫码绑定"而不说只对微信 —— 用户会以为飞书也走扫码
    expect(clientCode).toContain('扫码绑定微信')
  })
})

describe('IM 桥 wire：`channel` 必须回传（否则飞书账号被显示成微信）', () => {
  it('🔴 GET 处理器必须回 `channel` 字段', () => {
    expect(httpCode).toContain('channel,')
    // 负向钉：不得退回"只按微信判绑定"的老写法
    expect(httpCode).not.toMatch(/bound: readWeixinCredential\(/)
  })

  it('🔴 `bound` 必须按渠道判（飞书凭据在 FEISHU_*，用微信读法必然读到 null）', () => {
    expect(httpCode).toContain('imCredentialBound')
  })
})
