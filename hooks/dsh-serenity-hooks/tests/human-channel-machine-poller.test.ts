/**
 * human-channel-machine-poller.test.ts — P0-3 A：**机器级账号表 ⇒ 起 poller**（= P0-2 的后半）
 *
 * ## 本件钉住的那条不变量
 * **poller 属于"账号"，不属于 CCC**（方案 §2.6）。今天起桥是"按 CCC"的
 * （`for entry of listCccs ⇒ syncCccBridge`）⇒ 同一个 bot 在两处被轮询。
 *
 * ## 模式由谁决定（方案 §11.3 **Q5** 过渡期语义）
 * | 机器级账号表 | 模式 | 起 poller | 路由 |
 * |---|---|---|---|
 * | **非空** | 机器级 | 按**账号**（与 CCC 无关） | **只认订阅表**（未命中 ⇒ 不投递） |
 * | **空** | 回退 | 按 **CCC**（今天的形态） | 先查订阅表，未命中回退 CCC 级 `routes` |
 * 🔴 **两种模式互斥** —— 各自进入时先停掉另一种。**不互斥的后果 = 同一个 bot 两处轮询**
 * （正是本件要消灭的东西）⇒ 本件用"切模式后 `weixinBridgeStatus()` 里旧那一侧消失"来钉它。
 *
 * ## 🔴 为什么"能收不能投"是这个件的反面
 * 机器级 poller 收到消息时**不知道它属于哪个 CCC**（那个答案在订阅表里）。⇒ 若只做
 * "按账号起 poller"而不做路由，就会出现"**消息收得到、没处投**"。本件两个方向都钉：
 * ① 未命中 ⇒ **不投递 ＋ 留痕**；② **正控**：加进订阅表 ⇒ **真的投到该 (CCC, 角色)**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

// ── 宿主依赖替身（与 `human-channel-routing.test.ts` 同款；仅为让 weixin-bridge 可加载）──
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({ installSettingsSection: () => {}, settingsNamespace: (v: string) => v }))

import { __setSimpleSourceForTest, defaultSimpleSettings, type SerenitySimpleSettings } from '../src/settings-section.js'
import { __resetPollersForTest, pollerOwners } from '../src/human-channel.js'
import { writeWeixinCredential } from '../src/weixin-route.js'
import { __setWeixinFetchForTest } from '../src/weixin-api.js'
import { registerSkiffSession, unregisterSkiffSession, skiffSessionSnapshot } from '../src/skiff-core.js'

/** 机器级账号行 */
function acct(id: string, channel: string | undefined, token: string | undefined, enabled = true) {
  return { id, channel, enabled, token }
}
/** 机器级订阅行 */
function sub(account: string, user: string, ccc: string, role: string) {
  return { account, user, ccc, role }
}

describe('human-channel: P0-3 A —— 机器级账号表 ⇒ 起 poller', () => {
  let dir: string
  let oldConfigEnv: string | undefined
  let oldAuditEnv: string | undefined
  let machine: { accounts: ReturnType<typeof acct>[]; subscriptions: ReturnType<typeof sub>[] }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  /** 造一个 CCC 根：`weixin` 启用 ＋ 一个已绑定凭据的账号 ＋ `qa` 角色 */
  function makeCcc(token: string): string {
    const d = mkdtempSync(join(tmpdir(), 'hc-machine-ccc-'))
    mkdirSync(join(d, '.opencode'), { recursive: true })
    writeFileSync(join(d, '.serenity'), 'test')
    writeFileSync(join(d, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: true, accounts: [{ accountId: 'wechat-1' }], routes: [{ user: '*', role: 'qa' }] },
    }))
    writeWeixinCredential(d, 'wechat-1', { token, baseUrl: 'https://x' })
    return d
  }

  /** 机器级读取面注入 */
  function injectMachine(): void {
    __setSimpleSourceForTest((): SerenitySimpleSettings => ({
      ...defaultSimpleSettings(),
      humanChannel: {
        accounts: machine.accounts,
        subscriptions: machine.subscriptions,
        relayCcc: null,
        sendingAllow: ['*'],
      },
    }))
  }

  function auditLines(): Array<Record<string, unknown>> {
    const p = join(dir, 'audit.jsonl')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hc-machine-'))
    oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
    process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
    oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'audit.jsonl')
    machine = { accounts: [], subscriptions: [] }
    injectMachine()
    __resetPollersForTest()
    // 循环里的 getUpdates 一律抛错 ⇒ 只做退避重试，**不碰网络**（同 human-channel-poller 的做法）
    __setWeixinFetchForTest(async () => { throw new Error('offline-test') })
  })

  afterEach(async () => {
    const { stopAllBridges } = await import('../src/weixin-bridge.js')
    stopAllBridges()
    __resetPollersForTest()
    __setSimpleSourceForTest(null)
    __setWeixinFetchForTest(null)
    const { resetWeixinTypingCache } = await import('../src/weixin-bridge.js')
    resetWeixinTypingCache()
    for (const [id] of skiffSessionSnapshot()) unregisterSkiffSession(id)
    if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
    else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
    if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
    rmSync(dir, { recursive: true, force: true })
  })

  const ctx = () => ({ on: () => () => {}, get: () => undefined }) as never

  // ── 模式选择与互斥 ────────────────────────────────────────────────────────────

  it('🔴 机器级账号表非空 ⇒ 起**机器级** poller（`weixinBridgeStatus()` 出现哨兵行，且**不带任何 CCC**）', async () => {
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    syncHumanChannel(ctx())

    const status = weixinBridgeStatus()
    expect(status).toHaveLength(1)
    expect(status[0]!.ccc).toBe('<machine>') // ← 哨兵：它**不属于任何 CCC**，不伪装成某个 CCC 的行
    expect(status[0]!.accounts.map((a) => a.accountId)).toEqual(['wechat-1'])
  })

  it('🔴 回退（方案 Q5）：机器级表**空** ⇒ 仍按 **CCC** 起桥（不打断在用的微信）', async () => {
    const a = makeCcc('tok-a')
    machine.accounts = []
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    // 枚举面：让 listCccs 看得到 a（`get('workspaceRegistry')`）
    const c = { on: () => () => {}, get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: a }] } : undefined) } as never
    syncHumanChannel(c)
    // 回退路径是**异步**的（要 await listCccs）⇒ 等它落地
    await vi.waitFor(() => { expect(weixinBridgeStatus().some((s) => s.ccc === a)).toBe(true) }, { timeout: 3000 })
    rmSync(a, { recursive: true, force: true })
  })

  it('🔴🔴 两种模式**互斥**：先 CCC 模式起桥，再切机器级 ⇒ CCC 那一侧**被停掉**', async () => {
    const a = makeCcc('tok-a')
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const c = { on: () => () => {}, get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: a }] } : undefined) } as never

    machine.accounts = []
    syncHumanChannel(c)
    await vi.waitFor(() => { expect(weixinBridgeStatus().some((s) => s.ccc === a)).toBe(true) }, { timeout: 3000 })

    // 切机器级
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    syncHumanChannel(c)
    const status = weixinBridgeStatus()
    expect(status.map((s) => s.ccc)).toEqual(['<machine>']) // ← CCC 那一侧消失（**没有两处轮询**）
    rmSync(a, { recursive: true, force: true })
  })

  it('🔴 机器级表里**两行绑同一个 bot**（同 token）⇒ 只起**一个** poller（复用 P0-2 的同一套判据）', async () => {
    machine.accounts = [acct('wechat-1', 'weixin', 'same-tok'), acct('wechat-2', 'weixin', 'same-tok')]
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    syncHumanChannel(ctx())

    const status = weixinBridgeStatus()
    expect(status[0]!.accounts.map((a) => a.accountId)).toEqual(['wechat-1']) // ← 只有先来的
    expect(warn.mock.calls.some((c) => String(c[0]).includes('同一个 bot'))).toBe(true) // 跳过**不静默**
    warn.mockRestore()
  })

  it('无 token（未绑定）⇒ **不起** poller ＋ 出声', async () => {
    machine.accounts = [acct('wechat-1', 'weixin', undefined)]
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    syncHumanChannel(ctx())
    expect(weixinBridgeStatus()).toHaveLength(0)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('无 token'))).toBe(true)
    warn.mockRestore()
  })

  it('渠道未实现 ⇒ 不起 poller ＋ 出声（且**只出声一次**，不随每次重扫刷屏）', async () => {
    machine.accounts = [acct('feishu-1', 'feishu', 'tok-x')]
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    syncHumanChannel(ctx())
    syncHumanChannel(ctx())
    syncHumanChannel(ctx())
    expect(weixinBridgeStatus()).toHaveLength(0)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('未实现')).length).toBe(1)
    warn.mockRestore()
  })

  it('`enabled: false` 的账号 ⇒ 不起 poller（与 CCC 级账号表同款语义）', async () => {
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-1', false)]
    const { syncHumanChannel, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    syncHumanChannel(ctx())
    expect(weixinBridgeStatus()).toHaveLength(0)
  })

  it('🔴 归属表里记的是**哨兵根**（不是某个 CCC 根）—— 机器级与 CCC 级不会互相误判', async () => {
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    const { syncHumanChannel } = await import('../src/weixin-bridge.js')
    syncHumanChannel(ctx())
    expect([...pollerOwners().values()].map((o) => o.root)).toEqual(['<machine>'])
  })

  // ── 单条消息：机器级入口（未命中 ⇒ 不投递；命中 ⇒ 投到订阅表指定的 CCC）──────────

  it('🔴 机器级未命中订阅 ⇒ **不投递 ＋ 留痕**（没有"投给默认角色"这回事）', async () => {
    const a = makeCcc('tok-a')
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    machine.subscriptions = [sub('wechat-1', 'someone-else', basename(a), 'qa')] // ← 不是发信人
    const { handleMachineIncoming } = await import('../src/weixin-bridge.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await handleMachineIncoming(ctx(), 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(skiffSessionSnapshot().size).toBe(0) // ← 一条会话都没建
    const ls = auditLines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('inbound-unrouted')
    expect(ls[0]!.account).toBe('wechat-1')
    warn.mockRestore()
    rmSync(a, { recursive: true, force: true })
  })

  it('🔴🔴 正控：订阅表**命中** ⇒ 真的投到该 (CCC, 角色) —— 证明"未命中不投递"不是写死的不投递', async () => {
    const a = makeCcc('tok-a')
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    machine.subscriptions = [sub('wechat-1', 'u1@im.wechat', basename(a), 'qa')] // ← 按**别名**寻址
    const { handleMachineIncoming } = await import('../src/weixin-bridge.js')
    const questions: string[] = []
    let agent: unknown
    const c = {
      get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: a }] } : undefined),
      agents: {
        create: async (o: { sessionId: string; setup?: (x: unknown) => Promise<void> }) => {
          const ag = {
            session: { id: o.sessionId, events: [] as unknown[] },
            ctx: { systemPrompt: { section: () => {} } },
            followup: (m?: { content?: Array<{ type?: string; text?: string }> }) => {
              const q = (m?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
              if (q) questions.push(q)
              ag.session.events.push(
                { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
              )
            },
            interrupt: () => {},
          }
          agent = ag
          await o.setup?.(ag as never)
          return { agent: ag }
        },
      },
      // 🔴 必须回传真 agent 引用，否则 waitAgentIdle 永不结算 ⇒ 用例超时
      on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    } as never
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    await handleMachineIncoming(c, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(skiffSessionSnapshot().size).toBe(1) // ← 会话真的建了
    expect(questions.join('\n')).toContain('你好') // ← 消息真的到了角色面前
    expect(auditLines()).toHaveLength(0) // 投递成功 ⇒ 不留痕
    rmSync(a, { recursive: true, force: true })
  })

  it('🔴 机器级模式**不看目标 CCC 的 `weixin.enabled`**（起 poller 与路由已上移机器级）', async () => {
    const a = makeCcc('tok-a')
    // 把目标 CCC 的 weixin 段整体关掉（甚至删掉）——机器级模式**照样投得到**
    writeFileSync(join(a, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: false },
    }))
    machine.accounts = [acct('wechat-1', 'weixin', 'tok-machine')]
    machine.subscriptions = [sub('wechat-1', 'u1@im.wechat', basename(a), 'qa')]
    const { handleMachineIncoming } = await import('../src/weixin-bridge.js')
    let agent: unknown
    const c = {
      get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: a }] } : undefined),
      agents: {
        create: async (o: { sessionId: string; setup?: (x: unknown) => Promise<void> }) => {
          const ag = {
            session: { id: o.sessionId, events: [] as unknown[] },
            ctx: { systemPrompt: { section: () => {} } },
            followup: () => {
              ag.session.events.push(
                { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
              )
            },
            interrupt: () => {},
          }
          agent = ag
          await o.setup?.(ag as never)
          return { agent: ag }
        },
      },
      on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    } as never
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    await handleMachineIncoming(c, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
    expect(skiffSessionSnapshot().size).toBe(1) // ← 机器级模式**投到了**（没被 enabled:false 挡住）

    // 🔴 **对照（缺了它这条断言就是空的）**：同一份 CCC 配置走 **CCC 模式**（`handleIncoming`）
    //    会被 `enabled:false` 挡在门外 ⇒ 证明上面那一格"投到了"**确实是机器级模式带来的**，
    //    不是"这个 CCC 反正都能投"。
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(c, a, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u2@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
    expect(skiffSessionSnapshot().size).toBe(1) // ← 仍是 1：CCC 模式**一条都没建**

    rmSync(a, { recursive: true, force: true })
  })
})
