/**
 * human-channel-routing.test.ts — P0-3：**订阅表 ＋ 路由改造**（方案 §3.1 ／ §11.4 第 3 件）
 *
 * ## 本件钉住的那条不变量
 * 入站消息**投到哪里由机器级订阅表决定**（`(账号, 用户) → (CCC, 角色)`），而**不是**
 * "投给默认角色"。三条语义**刻意分档**，本件逐档钉住：
 *
 * | 档 | 触发 | 处置 | 为什么不能合并 |
 * |---|---|---|---|
 * | **未命中** | 表里没有 `(账号, 用户)` | **不投递 ＋ 留痕**（静默档） | 这是"表里没有你"，不是错误 |
 * | **表残缺** | 某行缺字段 | **响亮出声**（`console.error` ＋ 留痕） | 这是"**表本身写错了**" —— 合并会让笔误永远没人去改 |
 * | **目标不存在** | CCC ／ 角色 查不到 | **响亮报错**（`console.error` ＋ 留痕） | 方案 §3.1 / W5'：**不静默丢弃** |
 *
 * ## 🔴 覆盖四层（与 `human-channel-poller.test.ts` 同构）
 * ① 订阅表查询（`lookupSubscription`，纯函数）② 路由决策（`planInboundRoute`，纯函数）
 * ③ 机器级留痕（`appendHumanChannelAudit`）④ **接线**（`handleIncoming` 真的按它走）
 *
 * ## 🔴 本件最要紧的两条测试设计
 *  - **"残缺独立于命中"**：表里同时有一条**完好**行和一条**残缺**行 ⇒ 命中完好行的同时
 *    **仍要**报残缺。只测"残缺 ⇒ 报"会漏掉"命中掩盖了笔误"这一半。
 *  - **正控**（方案 §7 第 6 条明写）：**"建了 skiff 但不在表里的 CCC 收不到"必须配
 *    "加进表就收得到"** —— 只测"收不到"的话，把路由写死成"永不投递"也照样绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

// ── 宿主依赖替身（与 `weixin-bridge-branches.test.ts` 同款；仅为让 weixin-bridge 可加载）──
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

import {
  lookupSubscription,
  planInboundRoute,
  appendHumanChannelAudit,
  humanChannelAuditPath,
} from '../src/human-channel.js'
import { __setSimpleSourceForTest, defaultSimpleSettings, type SerenitySimpleSettings } from '../src/settings-section.js'
import { writeWeixinCredential } from '../src/weixin-route.js'
import { __setWeixinFetchForTest } from '../src/weixin-api.js'
import { registerSkiffSession, unregisterSkiffSession, skiffSessionSnapshot } from '../src/skiff-core.js'

/** 造一行订阅（缺省齐四字段；显式传 `undefined` 即"缺该字段"） */
function sub(account?: string, user?: string, ccc?: string, role?: string) {
  return { account, user, ccc, role }
}

// ════════════════════════════════════════════════════════════════════════════════
// ① 订阅表查询（纯函数）
// ════════════════════════════════════════════════════════════════════════════════

describe('human-channel: 订阅表查询（lookupSubscription）', () => {
  it('精确匹配 `(账号, 用户)` ⇒ 命中该行', () => {
    const r = lookupSubscription([sub('wechat-1', 'yh', 'home-serenity', 'zhaocai')], 'wechat-1', 'yh')
    expect(r.hit).toEqual({ account: 'wechat-1', user: 'yh', ccc: 'home-serenity', role: 'zhaocai' })
    expect(r.defects).toEqual([])
    expect(r.usable).toBe(1)
  })

  it('🔴 `user` 的 `*` 兜底：无精确行时命中通配行（**存量 CCC 级 `routes` 用的就是它**）', () => {
    // 保留 `*` 是**有意的**：P0-4 迁移要把 `{user:'*', role:'zhaocai'}` 逐字平移过来，
    // 否则"迁移"会悄悄改变行为。
    const r = lookupSubscription([sub('wechat-1', '*', 'home-serenity', 'zhaocai')], 'wechat-1', 'someone-else')
    expect(r.hit?.role).toBe('zhaocai')
  })

  it('🔴 精确优先于通配（顺序写反会让所有人被通配吃掉）', () => {
    const r = lookupSubscription([
      sub('wechat-1', '*', 'ccc-wild', 'wild-role'),
      sub('wechat-1', 'yh', 'ccc-exact', 'exact-role'),
    ], 'wechat-1', 'yh')
    expect(r.hit?.ccc).toBe('ccc-exact')
  })

  it('🔴 `account` **不设通配**：写别的账号的行不匹配（账号是显式身份，不是模式）', () => {
    const r = lookupSubscription([sub('*', 'yh', 'ccc', 'role')], 'wechat-1', 'yh')
    expect(r.hit).toBeNull()
    // 而且它是一条**完好**行（不是残缺）⇒ 未命中就是"表里没有你"
    expect(r.usable).toBe(1)
  })

  it('缺字段 ⇒ 进 `defects` 且**不进** `usable`（残缺行不可能被命中）', () => {
    const r = lookupSubscription([sub('wechat-1', 'yh', undefined, 'zhaocai')], 'wechat-1', 'yh')
    expect(r.hit).toBeNull()
    expect(r.usable).toBe(0)
    expect(r.defects).toHaveLength(1)
    expect(r.defects[0]!.index).toBe(0)
    expect(r.defects[0]!.missing).toEqual(['ccc'])
    // 已有字段要**留下来**（人得认得出是哪一行）
    expect(r.defects[0]!.present).toEqual({ account: 'wechat-1', user: 'yh', role: 'zhaocai' })
  })

  it('🔴 空白串 = "没填"（面板空文本框写空串）—— 与"缺这个键"同义', () => {
    const r = lookupSubscription([sub('wechat-1', 'yh', '   ', 'zhaocai')], 'wechat-1', 'yh')
    expect(r.defects[0]!.missing).toEqual(['ccc'])
  })

  it('🔴🔴 残缺**独立于是否命中**：命中一条完好行，**不掩盖**另一行的笔误', () => {
    // 只测"残缺 ⇒ 报"会漏掉这一半：命中之后如果 `continue`/`return` 早了，笔误就永远没人改。
    const r = lookupSubscription([
      sub('wechat-1', 'yh', 'ccc-good', 'role-good'),
      sub('wechat-1', undefined, 'ccc-bad', 'role-bad'), // ← 缺 user
    ], 'wechat-1', 'yh')
    expect(r.hit?.ccc).toBe('ccc-good') // 命中了
    expect(r.defects).toHaveLength(1) // 但残缺仍然报出来
    expect(r.defects[0]!.index).toBe(1)
    expect(r.defects[0]!.missing).toEqual(['user'])
  })

  it('表为空 ⇒ 三项都空（不是"未命中"，调用方据此区分两档）', () => {
    const r = lookupSubscription([], 'wechat-1', 'yh')
    expect(r.hit).toBeNull()
    expect(r.defects).toEqual([])
    expect(r.usable).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// ② 路由决策（纯函数）—— 含过渡期回退（方案 Q5）
// ════════════════════════════════════════════════════════════════════════════════

describe('human-channel: 入站路由决策（planInboundRoute）', () => {
  it('订阅命中 ⇒ `source: machine`（**不看**回退，即使回退也在场）', () => {
    const p = planInboundRoute({
      subscriptions: [sub('wechat-1', 'yh', 'ccc-A', 'role-A')],
      account: 'wechat-1',
      user: 'yh',
      fallback: { ccc: '/ccc-B', role: 'role-B' },
    })
    expect(p.target).toEqual({ ccc: 'ccc-A', role: 'role-A' })
    expect(p.source).toBe('machine')
    expect(p.skipReason).toBeNull()
  })

  it('🔴 未命中 ＋ 有回退 ⇒ `source: ccc-fallback`（**过渡期"不打断在用的微信"**，方案 Q5）', () => {
    const p = planInboundRoute({
      subscriptions: [sub('wechat-1', 'someone', 'ccc-A', 'role-A')],
      account: 'wechat-1',
      user: 'yh',
      fallback: { ccc: '/ccc-B', role: 'role-B' },
    })
    expect(p.target).toEqual({ ccc: '/ccc-B', role: 'role-B' })
    expect(p.source).toBe('ccc-fallback')
    expect(p.skipReason).toBeNull()
  })

  it('🔴 未命中 ＋ 无回退 ⇒ **不投递**（`target === null`）—— 不是"投给默认角色"', () => {
    const p = planInboundRoute({
      subscriptions: [sub('wechat-1', 'someone', 'ccc-A', 'role-A')],
      account: 'wechat-1',
      user: 'yh',
    })
    expect(p.target).toBeNull()
    expect(p.source).toBeNull()
    expect(p.skipReason).toBe('no-match')
  })

  it('🔴 两档未命中的**措辞不同**（排查方向不同：表没建 vs 表里没你）', () => {
    const empty = planInboundRoute({ subscriptions: [], account: 'wechat-1', user: 'yh' })
    expect(empty.skipReason).toBe('no-subscription')
    const nonEmpty = planInboundRoute({ subscriptions: [sub('wechat-1', 'other', 'c', 'r')], account: 'wechat-1', user: 'yh' })
    expect(nonEmpty.skipReason).toBe('no-match')
  })

  it('残缺行**穿透**决策层（命中与否都带出来）', () => {
    const p = planInboundRoute({
      subscriptions: [sub('wechat-1', 'yh', 'ccc-A', 'role-A'), sub('wechat-1', 'yh', undefined, 'r')],
      account: 'wechat-1',
      user: 'yh',
      fallback: { ccc: '/b', role: 'r' },
    })
    expect(p.source).toBe('machine')
    expect(p.defects).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// ③ 机器级留痕（appendHumanChannelAudit）
// ════════════════════════════════════════════════════════════════════════════════

describe('human-channel: 机器级留痕（appendHumanChannelAudit）', () => {
  let dir: string
  let oldAuditEnv: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hc-audit-'))
    oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'audit.jsonl')
  })

  afterEach(() => {
    if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
    rmSync(dir, { recursive: true, force: true })
  })

  /** 读回留痕（逐行 JSON） */
  function lines(): Array<Record<string, unknown>> {
    const p = humanChannelAuditPath()
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('env 覆盖生效（路径不落真机 `~/.dsh`）', () => {
    expect(humanChannelAuditPath()).toBe(join(dir, 'audit.jsonl'))
  })

  it('追加一行（JSONL，带 `ts` ＋ 事件字段）；**目录不存在会自动建**', () => {
    process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'nested', 'deep', 'audit.jsonl')
    appendHumanChannelAudit({ kind: 'inbound-unrouted', account: 'wechat-1', user: 'u1', reason: 'no-match', detail: 'd' })
    const ls = lines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('inbound-unrouted')
    expect(ls[0]!.account).toBe('wechat-1')
    expect(typeof ls[0]!.ts).toBe('string')
  })

  it('追加而非覆盖（多事件累积，供事后查）', () => {
    appendHumanChannelAudit({ kind: 'subscription-defect', account: 'a', index: 0, missing: ['ccc'], present: {} })
    appendHumanChannelAudit({ kind: 'inbound-unrouted', account: 'a', user: 'u', reason: 'no-subscription', detail: 'd' })
    expect(lines().map((l) => l.kind)).toEqual(['subscription-defect', 'inbound-unrouted'])
  })

  it('🔴 永不抛：留痕落点不可写时**静默降级**（不能反过来打断投递）', () => {
    // 真故障形态：把落点指到一个**已存在的文件**之下 ⇒ `mkdirSync` 必失败（EEXIST/ENOTDIR）
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(blocker, 'audit.jsonl')
    expect(() => appendHumanChannelAudit({
      kind: 'inbound-unrouted', account: 'a', user: 'u', reason: 'no-match', detail: 'd',
    })).not.toThrow()
  })

  it('🔴 隐私钉：事件里**没有**消息正文的位置（方案 §3.1 只要"谁发的／为什么没投"）', () => {
    // 这不是"当前实现没写正文"，而是**结构上无处可放** —— 将来若有人加 `text` 字段，本钉会红。
    appendHumanChannelAudit({ kind: 'inbound-unrouted', account: 'wechat-1', user: 'u1', reason: 'no-match', detail: 'd' })
    expect(Object.keys(lines()[0]!).sort()).toEqual(['account', 'detail', 'kind', 'reason', 'ts', 'user'])
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// ④ 接线：handleIncoming 真的按订阅表走
// ════════════════════════════════════════════════════════════════════════════════

describe('human-channel: 接线（handleIncoming 按订阅表投递）', () => {
  let dir: string
  let oldConfigEnv: string | undefined
  let oldAuditEnv: string | undefined
  /** 机器级配置注入（`readSimpleSettings()` 的源） */
  let machineSubscriptions: ReturnType<typeof sub>[]

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  /** CCC 配置：skiff 有 `qa` 角色；`weixin` 段按需给 routes */
  function writeConfig(weixin: unknown): void {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin,
    }))
  }

  /**
   * fake ctx：`get('workspaceRegistry')` 供 `listCccs` 枚举出本 CCC（订阅表按**别名**寻址
   * 时必须能解析）；`agents.create` ＋ `on` 供 skiff 投递（形状同 `weixin-bridge-branches`，
   * 🔴 `on` 必须回传**真 agent 引用**，否则 `waitAgentIdle` 永不结算 ⇒ 用例超时）。
   */
  function fakeCtx() {
    let agent: { session: { id: string; events: unknown[] }; ctx: unknown; followup: (m?: unknown) => void; interrupt?: () => void } | undefined
    const questions: string[] = []
    return {
      get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
      agents: {
        create: async (o: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const a = {
            session: { id: o.sessionId, events: [] as unknown[] },
            ctx: { systemPrompt: { section: () => {} } },
            followup: (m?: { content?: Array<{ type?: string; text?: string }> }) => {
              const q = (m?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
              if (q) questions.push(q)
              a.session.events.push(
                { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
              )
            },
            interrupt: () => {},
          }
          agent = a
          await o.setup?.(a as never)
          return { agent: a }
        },
      },
      on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent, status: 'idle' })
        return () => {}
      },
      questions,
    }
  }

  /** 读回留痕 */
  function auditLines(): Array<Record<string, unknown>> {
    const p = join(dir, 'audit.jsonl')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hc-route-'))
    oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
    process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
    oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'audit.jsonl')
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    machineSubscriptions = []
    // 机器级读取面注入：`humanChannel.subscriptions` 来自本用例的 `machineSubscriptions`
    __setSimpleSourceForTest((): SerenitySimpleSettings => ({
      ...defaultSimpleSettings(),
      humanChannel: { ...defaultSimpleSettings().humanChannel, subscriptions: machineSubscriptions },
    }))
  })

  afterEach(async () => {
    __setSimpleSourceForTest(null)
    __setWeixinFetchForTest(null)
    const { resetWeixinTypingCache } = await import('../src/weixin-bridge.js')
    resetWeixinTypingCache()
    const { __resetWeixinOutputGuardForTest } = await import('../src/weixin-output-guard.js')
    __resetWeixinOutputGuardForTest()
    for (const [id] of skiffSessionSnapshot()) unregisterSkiffSession(id)
    if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
    else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
    if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
    else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
    rmSync(dir, { recursive: true, force: true })
  })

  const MSG = { from_user_id: 'u1@im.wechat', item_list: [{ type: 1, text_item: { text: '你好' } }] }

  it('🔴🔴 正控：订阅表**加进一行** ⇒ 真的投到该 (CCC, 角色)（证明路由不是写死"永不投递"）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] }) // ← 无 CCC 级 routes
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [sub('wechat-1', 'u1@im.wechat', basename(dir), 'qa')] // ← 按**别名**寻址
    const ctx = fakeCtx()
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    expect(skiffSessionSnapshot().size).toBe(1) // ← 会话真的建了
    expect(ctx.questions.join('\n')).toContain('你好') // ← 消息真的到了角色面前
    expect(auditLines()).toHaveLength(0) // 投递成功 ⇒ **不留痕**（留痕只记异常档）
  })

  it('🔴 未命中 ＋ 无回退 ⇒ **不投递 ＋ 留痕**（`inbound-unrouted`）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] }) // ← 无 routes ⇒ 无回退
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [sub('wechat-1', 'someone-else', basename(dir), 'qa')]
    const ctx = fakeCtx()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    expect(skiffSessionSnapshot().size).toBe(0) // ← 没有投递
    expect(ctx.questions).toHaveLength(0)
    const ls = auditLines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('inbound-unrouted')
    expect(ls[0]!.reason).toBe('no-match')
    expect(ls[0]!.user).toBe('u1@im.wechat')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('不投递'))).toBe(true)
    warn.mockRestore()
  })

  it('🔴 目标 CCC 不存在 ⇒ **响亮报错**（`console.error`）＋ 留痕，不静默丢弃', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [sub('wechat-1', 'u1@im.wechat', 'no-such-ccc', 'qa')]
    const ctx = fakeCtx()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    expect(skiffSessionSnapshot().size).toBe(0)
    const ls = auditLines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('inbound-target-missing')
    expect(ls[0]!.ccc).toBe('no-such-ccc')
    expect(err.mock.calls.some((c) => String(c[0]).includes('no-such-ccc'))).toBe(true)
    err.mockRestore()
  })

  it('🔴 目标**角色**不存在 ⇒ **响亮报错** ＋ 留痕（CCC 解析得到，角色没有）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [sub('wechat-1', 'u1@im.wechat', basename(dir), 'no-such-role')]
    const ctx = fakeCtx()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    expect(skiffSessionSnapshot().size).toBe(0)
    const ls = auditLines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('inbound-target-missing')
    expect(ls[0]!.role).toBe('no-such-role')
    expect(err.mock.calls.some((c) => String(c[0]).includes('no-such-role'))).toBe(true)
    err.mockRestore()
  })

  it('🔴 表残缺 ⇒ **响亮出声** ＋ 留痕（**即使同一张表里有别的行命中了**）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [
      sub('wechat-1', 'u1@im.wechat', basename(dir), 'qa'), // ← 这条会命中
      sub('wechat-1', undefined, 'x', 'y'), // ← 这条缺 user（笔误）
    ]
    const ctx = fakeCtx()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    // 命中照常投递
    expect(skiffSessionSnapshot().size).toBe(1)
    // 残缺照常出声（**不被命中掩盖**）
    const ls = auditLines()
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('subscription-defect')
    expect(ls[0]!.missing).toEqual(['user'])
    expect(err.mock.calls.some((c) => String(c[0]).includes('残缺'))).toBe(true)
    err.mockRestore()
  })

  it('🔴 过渡期回退（方案 Q5）：机器级表**空** ＋ CCC 级 routes 在 ⇒ 照旧投递', async () => {
    // 这是**行为保持**钉：P0-3 落地后，机器级还没配的 CCC **必须**仍然按老路走，
    // 否则"上移 ACC 层"这一步会当场打断在用的微信。
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }], routes: [{ user: '*', role: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    machineSubscriptions = [] // ← 机器级为空
    const ctx = fakeCtx()
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, MSG)

    expect(skiffSessionSnapshot().size).toBe(1)
    expect(ctx.questions.join('\n')).toContain('你好')
    expect(auditLines()).toHaveLength(0)
  })
})
