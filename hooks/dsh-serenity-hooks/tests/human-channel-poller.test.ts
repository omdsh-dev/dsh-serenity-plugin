/**
 * human-channel-poller.test.ts — P0-2：**一账号一 poller**（方案 §2.6 ／ §11.4 第 2 件）
 *
 * ## 本件钉住的那条不变量
 * 同一个**账号**（= 同一份凭据）在同一时刻**只有一个轮询者**。今天起桥是"按 CCC"的
 * （`for entry of listCccs ⇒ syncCccBridge`）⇒ 两个 CCC 各配同一个微信号就会**两处轮询同一条消息**
 * （重复投递 ＋ 重复落盘）。
 *
 * ## 🔴 本件最容易写错的一处：账号的"身份"不是 `accountId`
 * `accountId` 是**每 CCC 的本地标签**（两处都叫 `wechat-1` 完全可能是两个不同的微信号）
 * ⇒ 跨 CCC 能辨同一 bot 的唯一依据是**凭据内容**。故身份 = `token` 的哈希。
 * 本件用**正控**钉住这条：同 token 跨 CCC ⇒ 同身份；**不同** token ⇒ 不同身份。
 *
 * ## 覆盖三层
 * ① 身份计算（`accountIdentity`）② 归属判定（`planPollerClaims`，纯函数）
 * ③ 归属表（`commit`／`release`）④ **接线**（`syncCccBridge` 真的不给第二个 CCC 起循环）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({ installSettingsSection: () => {}, settingsNamespace: (v: string) => v }))

import {
  accountIdentity,
  planPollerClaims,
  pollerOwners,
  commitPollerClaims,
  releasePollersOf,
  releaseAllPollers,
  __resetPollersForTest,
  type PollerRequest,
} from '../src/human-channel.js'
import { writeWeixinCredential } from '../src/weixin-route.js'
import { __setWeixinFetchForTest } from '../src/weixin-api.js'

/** 造一个请求（`identity` 缺省时按 token 算，与生产同源） */
function req(root: string, accountId: string, token?: string): PollerRequest {
  return { root, accountId, identity: accountIdentity(root, accountId, token) }
}

describe('human-channel: 账号身份（accountIdentity）', () => {
  it('🔴 有 token ⇒ 身份只由**凭据**决定：不同 CCC ／ 不同本地键 ⇒ 同一身份', () => {
    expect(accountIdentity('/ccc-a', 'wechat-1', 'tok-1')).toBe(accountIdentity('/ccc-b', 'wechat-2', 'tok-1'))
  })

  it('🔴 正控：**不同** token ⇒ 不同身份（上面的"相同"不是恒等函数）', () => {
    expect(accountIdentity('/ccc-a', 'wechat-1', 'tok-1')).not.toBe(accountIdentity('/ccc-a', 'wechat-1', 'tok-2'))
  })

  it('身份里**不含 token 原文**（日志/状态面可安全展示）', () => {
    const id = accountIdentity('/ccc-a', 'wechat-1', 'super-secret-token')
    expect(id).not.toContain('super-secret-token')
    expect(id.startsWith('token:')).toBe(true)
  })

  it('无 token（或全空白）⇒ 退化为**每 CCC 唯一**（此时不可能跨 CCC 撞车 ⇒ 不会误判成同一账号）', () => {
    expect(accountIdentity('/ccc-a', 'wechat-1', undefined)).toBe('ccc:/ccc-a|wechat-1')
    expect(accountIdentity('/ccc-a', 'wechat-1', '   ')).toBe('ccc:/ccc-a|wechat-1')
    expect(accountIdentity('/ccc-b', 'wechat-1', undefined)).not.toBe(accountIdentity('/ccc-a', 'wechat-1', undefined))
  })
})

describe('human-channel: 归属判定（planPollerClaims；纯函数）', () => {
  const empty = new Map<string, { root: string; accountId: string }>()

  it('无冲突 ⇒ 全部 claim', () => {
    const plan = planPollerClaims([req('/a', 'wechat-1', 't1'), req('/b', 'wechat-1', 't2')], empty)
    expect(plan.claims).toHaveLength(2)
    expect(plan.skipped).toEqual([])
  })

  it('🔴 跨 CCC 同账号（同一份凭据）⇒ 只 claim 一个，另一个进 skipped 且**写明谁占着**', () => {
    const plan = planPollerClaims([req('/a', 'wechat-1', 'same'), req('/b', 'wechat-9', 'same')], empty)
    expect(plan.claims.map((c) => c.root)).toEqual(['/a'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.ownedBy).toEqual({ root: '/a', accountId: 'wechat-1' })
  })

  it('🔴 **跨批**：身份已被**别的 CCC**占着 ⇒ 跳过（这是"一账号一 poller"的主判据）', () => {
    // ⚠️ 这条与上一条**必须分开**：上一条走的是"同批去重"（判据 ①），
    //    把判据 ② 拿掉它**照样绿** —— 实测（变异正控）确认过这个盲区，故补本条。
    const owners = new Map([['same', { root: '/a', accountId: 'wechat-1' }]])
    const plan = planPollerClaims([{ root: '/b', accountId: 'wechat-9', identity: 'same' }], owners)
    expect(plan.claims).toEqual([])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.ownedBy).toEqual({ root: '/a', accountId: 'wechat-1' })
  })

  it('🔴 同一批内两个请求抢同一身份 ⇒ 后者 skipped（同批也要去重）', () => {
    const plan = planPollerClaims([req('/a', 'wechat-1', 'same'), req('/a', 'wechat-2', 'same')], empty)
    expect(plan.claims).toHaveLength(1)
    expect(plan.skipped).toHaveLength(1)
  })

  it('🔴 身份被**自己**占着 ⇒ 照常 claim（热重建；判成冲突会让配置一改就再也起不来）', () => {
    const owners = new Map([['x', { root: '/a', accountId: 'wechat-1' }]])
    const plan = planPollerClaims([{ root: '/a', accountId: 'wechat-1', identity: 'x' }], owners)
    expect(plan.claims).toHaveLength(1)
    expect(plan.skipped).toEqual([])
  })

  it('🔴 判定是纯函数：不改传入的 owners（正控）', () => {
    const owners = new Map<string, { root: string; accountId: string }>()
    planPollerClaims([req('/a', 'wechat-1', 't1')], owners)
    expect(owners.size).toBe(0)
  })
})

describe('human-channel: 归属表（commit ／ release）', () => {
  beforeEach(() => __resetPollersForTest())
  afterEach(() => __resetPollersForTest())

  it('commit ⇒ 表里可见；**别人的** root 释放时不动它（正控）', () => {
    commitPollerClaims(planPollerClaims([req('/a', 'wechat-1', 't1')], pollerOwners()))
    expect(pollerOwners().size).toBe(1)
    expect(releasePollersOf('/other')).toBe(0)
    expect(pollerOwners().size).toBe(1)
  })

  it('releasePollersOf(root) 只清该 root 的；releaseAllPollers 清空', () => {
    commitPollerClaims(planPollerClaims([req('/a', 'wechat-1', 't1'), req('/b', 'wechat-1', 't2')], pollerOwners()))
    expect(pollerOwners().size).toBe(2)
    expect(releasePollersOf('/a')).toBe(1)
    expect([...pollerOwners().values()].map((o) => o.root)).toEqual(['/b'])
    releaseAllPollers()
    expect(pollerOwners().size).toBe(0)
  })
})

/**
 * 接线面：`syncCccBridge` **真的**不给第二个 CCC 起循环。
 *
 * 夹具：两个临时 CCC 根，各写 `weixin` 配置 ＋ **同一份凭据**；weixin fetch 换成抛错替身
 * （⇒ 循环只做退避重试，不碰网络）。判据 = `weixinBridgeStatus()` 里只有**一个** CCC 有循环。
 */
describe('human-channel: 接线（syncCccBridge 一队账号只起一次）', () => {
  let dirs: string[] = []

  /** 造一个 CCC 根：weixin 启用 ＋ 一个已绑定凭据的账号 */
  function makeCcc(token: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'human-channel-ccc-'))
    dirs.push(dir)
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ weixin: { enabled: true, accounts: [{ accountId: 'wechat-1' }], routes: [{ user: '*', role: 'qa' }] } }),
    )
    writeWeixinCredential(dir, 'wechat-1', { token, baseUrl: 'https://example.invalid' })
    return dir
  }

  beforeEach(() => {
    __resetPollersForTest()
    __setWeixinFetchForTest(async () => {
      throw new Error('offline-test')
    })
  })

  afterEach(async () => {
    const { stopAllBridges } = await import('../src/weixin-bridge.js')
    stopAllBridges()
    __resetPollersForTest()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })

  it('🔴 两个 CCC 配**同一份凭据** ⇒ 只有先来的那个起循环 ＋ 被跳过者留响亮日志', async () => {
    const a = makeCcc('same-token')
    const b = makeCcc('same-token')
    const { syncCccBridge, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const ctx = { on: () => () => {} } as never

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    syncCccBridge(ctx, a)
    syncCccBridge(ctx, b)

    const status = weixinBridgeStatus()
    expect(status.map((s) => s.ccc)).toEqual([a]) // ← 只有 a 有循环
    expect(status[0]?.accounts.map((x) => x.accountId)).toEqual(['wechat-1'])
    // 被跳过**不是静默的**（否则表现为"某个 CCC 的桥莫名其妙不工作"）
    expect(warn.mock.calls.some((c) => String(c[0]).includes('一账号一 poller'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes(b))).toBe(true)
    warn.mockRestore()
  })

  it('正控：两份**不同**凭据 ⇒ 两个 CCC 各起一个循环（去重没有过度生效）', async () => {
    const a = makeCcc('token-a')
    const b = makeCcc('token-b')
    const { syncCccBridge, weixinBridgeStatus } = await import('../src/weixin-bridge.js')
    const ctx = { on: () => () => {} } as never

    syncCccBridge(ctx, a)
    syncCccBridge(ctx, b)

    expect(weixinBridgeStatus().map((s) => s.ccc).sort()).toEqual([a, b].sort())
  })
})
