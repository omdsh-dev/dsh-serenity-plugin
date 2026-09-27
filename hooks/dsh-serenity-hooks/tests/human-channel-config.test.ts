/**
 * human-channel-config.test.ts — 机器级 `humanChannel`：schema ＋ 投影（P0-1）
 *
 * 权威规格 = 插件仓 `docs/human-channel-plan.md`（§2.2 配置拟稿 ／ §2.4 迁移 ／ §11 定案 ／
 * §11.4 开工顺序 **P0-1**）。本件覆盖 P0-1 的三条单测口径：**缺省 ／ 优先级 ／ 旧键忽略（含正控）**。
 *
 * ## 本件钉住的三件事
 *  ① **schema 声明面**：机器级有 `humanChannel`（四段齐）＋ **没有** `weixin` 兼容键；
 *  ② **投影语义**：`humanChannelSettingsFromConfig()` 的缺省与"显式值 > 内建缺省"的优先级；
 *  ③ 🔴 **旧 CCC 侧 `weixin.*` 被忽略** —— 配 **两个方向的正控**（同一份数据换新键拼写就生效；
 *     旧键在旧读取面上**此刻仍是活的**）。
 *
 * ## 🔴 为什么"旧键忽略"必须用**三重**证据，缺一条就是空断言
 *  - **只有"legacy ⇒ 等于缺省"**：若投影压根不看入参（例如写死返回缺省），这条**也绿** ⇒ 空断言；
 *  - **加上"modern ⇒ 不等于缺省"**：排除"投影不看入参"这一类瞎法；
 *  - **再加上"旧键在别处仍是活的"**：排除"旧键根本没人认、所以忽略它毫无内容"这一类瞎法
 *    —— 旧读取面（`readWeixinSettings`）此刻**确实**读得到它，所以"新面不看它"是一条**有内容**的断言。
 *
 * ## 与 `config-volatile.test.ts` 的分工（两条 pin 各管一面，不重叠）
 *  - 那边管 **`.volatile()`**（0.1.7 设置面板硬约定；`volatile` 字段集**恰等于**九个面板键）；
 *  - 本件管 **结构化表的形状与归一** ⇒ `humanChannel` **刻意不标 `.volatile()`**（它是表，不是开关）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── 宿主依赖替身（与 `config-volatile.test.ts` 同款；仅为让 `index.ts` 在 vitest 里可加载）──
// 🔴 **刻意不 mock `@deepseek-ai/schemastery`**：本文件要在**真 schema** 上读 `.dict` / `.meta.default`
//    —— 被 Proxy 链替身一换，"字段在不在"「缺省是多少」就**恒真**（那正是 config-volatile 头注里的假绿）。
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { Config } from '../src/index.ts'
import {
  humanChannelSettingsFromConfig,
  defaultHumanChannelSettings,
  simpleSettingsFromConfig,
  defaultSimpleSettings,
} from '../src/settings-section.js'
import { readWeixinSettings } from '../src/weixin-route.js'

/** schema 里的机器级段（读不到 ⇒ undefined，交给用例断言报错文案） */
function hc() {
  return Config.dict?.humanChannel
}

describe('human-channel: 机器级 schema（P0-1）', () => {
  it('🔴 实测形态：解析后 `humanChannel` **恒存在**（各段缺省被物化）—— "没设过"在解析面上不可观测', () => {
    // 锚定 2026-09-26 真 schemastery 实测（本仓 `@deepseek-ai/schemastery`）：
    //   `Config({}).humanChannel` = {"accounts":[],"subscriptions":[],"relay":{},"sending":{"allow":["*"]}}
    // ⇒ 子段对象会被**物化**、数组取各自缺省（与"面板层扁平键刻意无缺省"是**两回事**：
    //    那一类必须可观测，因为它要"让位给部署层"；本段没有第二个拼写，故物化无害）。
    // ⇒ 读取面的缺省与 schema 的缺省**同值**（不是两套），且读取面仍要能处理"整段不存在"
    //    （手写 Config ／ 未走宿主解析的调用方）。
    expect(Config({}).humanChannel).toEqual({
      accounts: [],
      subscriptions: [],
      relay: {},
      sending: { allow: ['*'] },
    })
  })

  it('🔴 显式 `sending.allow: []` **穿过解析仍然存在**（`.default(["*"])` 不吞显式空数组）', () => {
    // 这条钉住"谁都不许"的语义：若 schemastery 把 `[]` 当"未设"⇒ 会变成 `['*']` = **反义**
    expect(Config({ humanChannel: { sending: { allow: [] } } }).humanChannel?.sending?.allow).toEqual([])
  })

  it('🔴 解析结果里**留着**旧键 ≠ 它被声明（schemastery 非 strict 保留未声明键）', () => {
    // 实测：`Config({ weixin: { enabled: true } }).weixin` = {"enabled":true} —— 键**活着**。
    // ⇒ 回归钉**不能**钉"解析结果里没有 weixin"（那会假红）；只能钉**声明面**
    //   （`Config.dict.weixin === undefined`，见上一条）。这条存在的意义就是**解释那个选择**。
    expect(Config({ weixin: { enabled: true } } as never).weixin).toEqual({ enabled: true })
  })

  it('🔴 schema 里有 `humanChannel`，且四段齐（accounts ／ subscriptions ／ relay ／ sending）', () => {
    expect(hc(), 'schema 缺 humanChannel —— 机器级配置无处可落（方案 §2.2）').toBeDefined()
    expect(Object.keys(hc()?.dict ?? {}).sort()).toEqual(['accounts', 'relay', 'sending', 'subscriptions'])
  })

  it('缺省（声明面）：两张表缺省 = 空表；`sending.allow` 缺省 = `["*"]`；`relay.ccc` **刻意无缺省**', () => {
    expect(hc()?.dict?.accounts?.meta.default).toEqual([])
    expect(hc()?.dict?.subscriptions?.meta.default).toEqual([])
    expect(hc()?.dict?.sending?.dict?.allow?.meta.default).toEqual(['*'])
    // 主控无缺省 = 有意：有默认值就永远非 undefined ⇒ "未指定"不可观测 ⇒ 投影的分支恒假
    expect(hc()?.dict?.relay?.dict?.ccc?.meta.default).toBeUndefined()
  })

  it('🔴 旧 CCC 侧 `weixin` **不得**出现在机器级 schema（硬切无别名，方案 §11.2；含正控）', () => {
    expect(
      Config.dict?.weixin,
      '机器级 schema 里出现了 weixin：旧 CCC 侧键被上移成了机器级别名 —— 与"硬切无别名"矛盾',
    ).toBeUndefined()
    // 正控：同一种查法对新键**查得到** ⇒ 上面的 undefined 不是"查法本身取不到东西"的假象
    expect(Config.dict?.humanChannel).toBeDefined()
  })

  it('真解析：方案 §2.2 的拟稿形状被接受，行内缺省生效（`enabled` 缺省 true）', () => {
    const resolved = Config({
      humanChannel: {
        accounts: [{ id: 'wechat-1', channel: 'weixin', token: 't', userId: 'u@im.wechat' }],
        subscriptions: [{ account: 'wechat-1', user: 'yh', ccc: 'home-serenity', role: 'zhaocai' }],
        relay: { ccc: 'home-serenity' },
      },
    })
    const h = resolved.humanChannel
    expect(h?.accounts).toHaveLength(1)
    expect(h?.accounts?.[0]?.id).toBe('wechat-1')
    expect(h?.accounts?.[0]?.enabled).toBe(true)
    expect(h?.subscriptions?.[0]?.role).toBe('zhaocai')
    expect(h?.relay?.ccc).toBe('home-serenity')
    // 未给的子段仍被物化出缺省（实测形态，见本 describe 首条）—— 与读取面的缺省**同值**
    expect(h?.sending?.allow).toEqual(['*'])
  })
})

describe('human-channel: 投影（settings-section；P0-1）', () => {
  it('缺省：整个 `humanChannel` 不存在是**合法初始态** ⇒ 空表 ＋ 无主控 ＋ 允许全体发给人', () => {
    expect(humanChannelSettingsFromConfig(undefined)).toEqual({
      accounts: [],
      subscriptions: [],
      relayCcc: null,
      sendingAllow: ['*'],
    })
  })

  it('单一读取入口：`simpleSettingsFromConfig({})` 与 `defaultSimpleSettings()` 的 humanChannel 同源', () => {
    expect(simpleSettingsFromConfig({}).humanChannel).toEqual(defaultHumanChannelSettings())
    expect(defaultSimpleSettings().humanChannel).toEqual(defaultHumanChannelSettings())
  })

  it('🔴 显式值优先于内建缺省：`sending.allow: []` 是"谁都不许"，**不是**回退到 `["*"]`', () => {
    expect(humanChannelSettingsFromConfig({ sending: { allow: [] } }).sendingAllow).toEqual([])
    expect(humanChannelSettingsFromConfig({ sending: { allow: ['home-serenity'] } }).sendingAllow).toEqual([
      'home-serenity',
    ])
  })

  it('主控：有值 ⇒ 取（首尾空白剥掉）；空白 ／ 缺段 ／ 缺键 ⇒ `null`（三种"没有主控"同义）', () => {
    expect(humanChannelSettingsFromConfig({ relay: { ccc: ' home-serenity ' } }).relayCcc).toBe('home-serenity')
    expect(humanChannelSettingsFromConfig({ relay: { ccc: '   ' } }).relayCcc).toBeNull()
    expect(humanChannelSettingsFromConfig({ relay: {} }).relayCcc).toBeNull()
    expect(humanChannelSettingsFromConfig({}).relayCcc).toBeNull()
  })

  it('账号行：`enabled` 归一为**定值布尔**（缺省 true ／ 显式 false 保持）＋ 行内文本去空白', () => {
    const out = humanChannelSettingsFromConfig({
      accounts: [
        { id: ' wechat-1 ', channel: ' weixin ', token: 't', userId: 'u' },
        { id: 'wechat-2', channel: 'weixin', enabled: false },
      ],
    })
    expect(out.accounts).toHaveLength(2)
    expect(out.accounts[0]).toEqual({
      id: 'wechat-1',
      channel: 'weixin',
      enabled: true,
      token: 't',
      userId: 'u',
    })
    expect(out.accounts[1]?.enabled).toBe(false)
  })

  it('🔴 投影**不做清洗**：缺 `id` ／ `channel` 的行**保留**（静默丢行 = 掩盖配置错误；方案 §2.4"不静默"）', () => {
    const out = humanChannelSettingsFromConfig({ accounts: [{ token: 't' }] })
    expect(out.accounts).toHaveLength(1)
    expect(out.accounts[0]?.id).toBeUndefined()
    expect(out.accounts[0]?.channel).toBeUndefined()
    expect(out.accounts[0]?.enabled).toBe(true)
  })

  it('🔴 旧 CCC 侧 `weixin.*` 被忽略（含正控）：同一份数据放旧键**无效**、放新键**生效**', () => {
    // 旧 CCC 侧形态（`serenity.json` 的 `weixin` 段 —— 见 src/ccc.ts 的 WeixinSettings）
    const legacy = {
      weixin: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1', name: '家庭招财', enabled: true }],
        routes: [{ user: 'yh', role: 'zhaocai' }],
      },
    }
    expect(humanChannelSettingsFromConfig(legacy as never)).toEqual(defaultHumanChannelSettings())

    // 正控（排除"投影压根不看入参"这一类瞎法）：同一份数据按**新键的拼写**放进来 ⇒ 投影真的变
    const modern = {
      accounts: [{ id: 'wechat-1', channel: 'weixin', token: 't', userId: 'u' }],
      subscriptions: [{ account: 'wechat-1', user: 'yh', ccc: 'home-serenity', role: 'zhaocai' }],
      relay: { ccc: 'home-serenity' },
    }
    const out = humanChannelSettingsFromConfig(modern)
    expect(out.accounts).toHaveLength(1)
    expect(out.subscriptions).toHaveLength(1)
    expect(out.relayCcc).toBe('home-serenity')
    expect(out).not.toEqual(defaultHumanChannelSettings())
  })

  it('旧键忽略在**读取入口**上同样成立（`Config` 顶层有旧键 ⇒ 入口输出不受影响；含正控）', () => {
    const legacy = { weixin: { enabled: true, routes: [{ user: 'yh', role: 'zhaocai' }] } }
    expect(simpleSettingsFromConfig(legacy as never).humanChannel).toEqual(defaultHumanChannelSettings())
    // 正控（同一条入口）：把同一份数据挂到 `humanChannel` 上 ⇒ 入口输出**真的变**
    // —— 否则上面那条只证明"这个入口对任何入参都返回缺省"（= 空断言）
    const modern = { humanChannel: { relay: { ccc: 'home-serenity' } } }
    expect(simpleSettingsFromConfig(modern).humanChannel.relayCcc).toBe('home-serenity')
  })
})

/**
 * 旧读取面的**时点钉**（P0-1 只立机器级面，不退役 CCC 侧）。
 *
 * 它同时充当上一条"旧键被忽略"的**第二重正控**：旧键在**别处**是活的（真读得到），
 * 所以"新面不看它"是一条有内容的断言；若旧键在全局都无人认，忽略它就不值一提。
 * 🔴 它**预期会红**的那一天 = 旧读取面退役的那天（P0-2~P0-4）⇒ 提醒同批更新本文件的判据链。
 */
describe('human-channel: 旧 CCC 侧读取面的时点钉（P0-1 不退役它）', () => {
  let dir = ''
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('🔴 留档钉：CCC 侧 `weixin.*` **此刻仍被旧读取面读**（`readWeixinSettings`）', () => {
    dir = mkdtempSync(join(tmpdir(), 'human-channel-ccc-'))
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        weixin: {
          enabled: true,
          accounts: [{ accountId: 'wechat-1' }],
          routes: [{ user: 'yh', role: 'zhaocai' }],
        },
      }),
    )
    const w = readWeixinSettings(dir, ['.opencode/serenity.json'])
    expect(w.enabled).toBe(true)
    expect(w.accounts).toHaveLength(1)
    expect(w.accounts?.[0]?.accountId).toBe('wechat-1')
    expect(w.accounts?.[0]?.enabled).toBe(true)
    expect(w.routes).toEqual([{ user: 'yh', role: 'zhaocai' }])

    // 对照：同一时刻，**机器级**投影对这份 CCC 文件一无所知（它只吃插件 Config）
    expect(simpleSettingsFromConfig({}).humanChannel).toEqual(defaultHumanChannelSettings())
  })
})
