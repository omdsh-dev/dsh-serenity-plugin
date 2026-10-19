/**
 * 统一 IM 配置（`im` 段）—— 2026-10-19 owner 定向的落地判据。
 *
 * owner 原话：「飞书继承可以很方便的加到当前的体系里，和微信一样，**只不过是 account 方实现不同**。
 * **要整合到统一的配置中**。」
 *
 * ⇒ 本文件钉三件事，每件都是**换实现时最容易静默坏掉**的那一格：
 *  ① **回退等价**：旧 `weixin` 段经新入口读出来的结果，必须与升级前**逐字段相同**；
 *  ② **优先级**：`im` 段存在且形状可判别 ⇒ 以它为准；删掉 ⇒ 立刻回退（双向验，不单向）；
 *  ③ 🔴 **退役 ACP 残留不得被误认**：本 CCC 的配置里**曾经**有过
 *    `im: {channel:"acp", acp:{enabled, accounts:[…]}}` —— 若判据写成"段存在"，
 *    它会被当成新配置读，表现为**"配置没生效"且不报错**。
 *
 * ⚠️ 隐私纪律（D145）：夹具里不写任何真实 appId/open_id/用户 id，一律通用占位。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readImSettings, readWeixinSettings } from '../src/im/route.js'

let dir = ''

function writeConfig(obj: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(obj))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'im-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readImSettings —— 未配置', () => {
  it('没有任何段 ⇒ 归一默认（默认关、空数组）', () => {
    expect(readImSettings(dir)).toEqual({ enabled: false, accounts: [], routes: [] })
  })
})

describe('readImSettings —— 与旧 weixin 段逐字段等价（P1 纯重构的判据）', () => {
  it('旧段经新入口读，结果与 readWeixinSettings 完全一致', () => {
    writeConfig({
      weixin: {
        enabled: true,
        botType: '3',
        hook: 'scripts/im-hook.ts',
        autoReplyWithLastMessage: false,
        fallbackOnNoSend: true,
        accounts: [
          { accountId: 'wechat-1', name: '占位甲', enabled: true },
          { accountId: 'wechat-2', enabled: false },
          { accountId: '' }, // 残缺行 → 丢弃
        ],
        routes: [
          { user: 'u-a@example', trajectory: 'traj-a' },
          { user: 'u-b@example', role: 'traj-b' }, // 旧写法（过渡别名）
          { user: '', role: 'x' }, // 残缺行 → 丢弃
        ],
        aliases: { ALICE: 'PLACEHOLDER_ALICE' },
      },
    })
    expect(readImSettings(dir)).toEqual(readWeixinSettings(dir))
  })

  it('🔴 账号行**缺 channel** ⇒ 缺省 weixin（老配置平移到 im 段不必补字段）', () => {
    writeConfig({ weixin: { enabled: true, accounts: [{ accountId: 'wechat-1' }] } })
    const s = readImSettings(dir)
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts![0]!.channel).toBe('weixin')
  })

  it('三个布尔缺省不写反：autoReply 缺省 true ／ fallbackOnNoSend 缺省 false ／ enabled 缺省 false', () => {
    writeConfig({ weixin: {} })
    const s = readImSettings(dir)
    expect(s.enabled).toBe(false)
    expect(s.autoReplyWithLastMessage).toBe(true)
    expect(s.fallbackOnNoSend).toBe(false)
  })
})

describe('readImSettings —— 统一段优先（双向验）', () => {
  it('im 段存在且可判别 ⇒ 以 im 为准，旧 weixin 段被忽略', () => {
    writeConfig({
      weixin: { enabled: false, routes: [{ user: 'old@example', trajectory: 'legacy-traj' }] },
      im: {
        enabled: true,
        accounts: [
          { accountId: 'wechat-1', channel: 'weixin', name: '占位甲' },
          { accountId: 'feishu-1', channel: 'feishu', name: '占位乙' },
        ],
        routes: [{ user: 'u-a@example', trajectory: 'traj-a' }],
      },
    })
    const s = readImSettings(dir)
    expect(s.enabled).toBe(true)
    expect(s.accounts!.map((a) => a.channel)).toEqual(['weixin', 'feishu'])
    expect(s.routes!.map((r) => r.trajectory)).toEqual(['traj-a'])
  })

  it('反控：把 im 段删掉 ⇒ 立刻回退到旧段（证明回退路径真被走过）', () => {
    const legacy = { enabled: true, routes: [{ user: 'old@example', trajectory: 'legacy-traj' }] }
    writeConfig({ weixin: legacy, im: { enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu' }] } })
    expect(readImSettings(dir).accounts!.some((a) => a.channel === 'feishu')).toBe(true)

    writeConfig({ weixin: legacy })
    const s = readImSettings(dir)
    expect(s.accounts).toEqual([])
    expect(s.routes!.map((r) => r.trajectory)).toEqual(['legacy-traj'])
  })
})

describe('🔴 退役 ACP 残留不得被误认（这条是本次最容易静默坏掉的一格）', () => {
  it('im 段只有退役 ACP 形状（有 acp 对象、无 accounts 数组）⇒ 不认，回退旧 weixin 段', () => {
    writeConfig({
      // 本 CCC 真实经历过的残留形态（值已去具体化）
      im: { channel: 'acp', acp: { enabled: true, accounts: [{ accountId: 'acct-1', name: '占位' }] } },
      weixin: { enabled: true, routes: [{ user: 'u-a@example', trajectory: 'traj-a' }] },
    })
    const s = readImSettings(dir)
    // 若误认残留 ⇒ enabled 取到的是残留的 true 但 routes 为空 ⇒ 这里会红
    expect(s.routes!.map((r) => r.trajectory)).toEqual(['traj-a'])
    expect(s.accounts).toEqual([])
  })

  it('im 段顶层 channel === "acp" ⇒ 同样判为残留（即使它碰巧有 accounts 数组）', () => {
    writeConfig({
      im: { channel: 'acp', accounts: [{ accountId: 'acct-1' }] },
      weixin: { enabled: true, routes: [{ user: 'u-a@example', trajectory: 'traj-a' }] },
    })
    const s = readImSettings(dir)
    expect(s.accounts).toEqual([])
    expect(s.routes!.map((r) => r.trajectory)).toEqual(['traj-a'])
  })

  it('正控：没有残留时，同形状的 im 段**会被认**（防止上两条因为别的原因恒绿）', () => {
    writeConfig({ im: { enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu' }] } })
    const s = readImSettings(dir)
    expect(s.enabled).toBe(true)
    expect(s.accounts!.map((a) => a.channel)).toEqual(['feishu'])
  })
})

describe('readImSettings —— 坏配置不炸（fail-open，与既有口径一致）', () => {
  it('JSON 损坏 ⇒ 归一默认，不抛错', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), '{ 这不是 JSON')
    expect(readImSettings(dir)).toEqual({ enabled: false, accounts: [], routes: [] })
  })
})
