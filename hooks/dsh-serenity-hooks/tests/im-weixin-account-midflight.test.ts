/**
 * im/weixin-account.ts —— **重入窗口的第二种形状**（2026-10-21，S142）。
 *
 * ## 为什么这份文件单独存在（第一份探针只覆盖了一半）
 *
 * `im-weixin-account-reentry.test.ts` 证明的是：旧 loop **阻塞在长轮询**时被标停，
 * 新 loop 会与它并存 —— 但那种形状的后果是**丢弃**（旧 loop 醒来后 `stopped` 判据把它跳过）。
 *
 * 而真实事故的时刻线（12:08:56 那条落在 turn 59 仍在跑时）**不可能是这种形状**：
 * 那时旧 loop 正 `await` 在 `handleIncoming` 里（跟着 `askTrajectory` 等它那一轮跑完），
 * **根本不在长轮询里**。⇒ 于是要单独回答一个问题：
 *
 * > `loop.stopped = true` 能不能打断**已经在 `handleIncoming` 里**的那一条？
 *
 * ## 判别力（D174：两个假设必须产生**不同**观测）
 *
 * | 假设 | 本探针的观测 |
 * |---|---|
 * | 能打断（loop 会放弃在办的那条） | `handleIncoming` 被外部"放弃"，第二个 loop 起时它已结束 |
 * | **不能打断** | 标停后那条**照样跑完**；此时新 loop 已发起 `getUpdates` ⇒ 同一会话**真并发** |
 *
 * ## 这条为什么最贵
 *
 * 若"不能打断"成立，则**重入发生在旧 loop 正在办消息时**，同一会话会真的被两处同时处理。
 * 而这正是 `im/inbound-event.ts` 那把**会话锁**（B）所要防的形状 ⇒
 * **会话锁在这条路径上不是冗余的**（便签曾猜它可能冗余 —— 本探针就是来证伪那个猜测的）。
 *
 * ## 🔴 诚实标注：本文件的第二条判据**无法被代码变异打红**（已实测）
 *
 * 我按 D184 做了变异检验：在 `for (const msg …)` 里插一句"若 stopped 就 return"，
 * 想让"标停可打断在办消息"成真 ⇒ **探针照样绿**。原因不是探针写坏了，而是
 * **JS 没有抢占**：一旦 `await` 进了 `handleIncoming`，没有任何代码能在**那条 await 内部**
 * 把它掐掉。⇒ 这一格钉的是**语言形状**，不是本仓的实现选择。
 *
 * ⇒ 它仍然值得留着（它把"窗口的第二种形状"固定成可复算的读数），但**不许把它算作
 * "我们的实现被验证过"** —— 能被变异打红的是第一条判据（并发确实发生），那一条在
 * `im-weixin-account-reentry.test.ts` 与本文件里都有。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { weixinAccountImpl, installWeixinAccountImpl } from '../src/im/weixin-account.js'
import { __resetImAccountImplsForTest } from '../src/im/accounts.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  __resetImAccountImplsForTest()
})

describe('重入窗口 · 第二种形状 —— 旧 loop 正办着消息时被标停', () => {
  it('🔴 标停**打不断**已经在 handleIncoming 里的那条 ⇒ 同一会话被两处并发处理', async () => {
    // 第一条消息的处理**永不结算**（模拟"那一轮还在跑"），直到我们手动放行
    const firstHandling = deferred<void>()
    const processed: string[] = []
    const handleIncoming = vi.fn(async (_ctx: unknown, _root: string, _acct: string, _cred: unknown, msg: never) => {
      const who = (msg as { from_user_id?: string }).from_user_id ?? ''
      processed.push(who)
      if (who === 'u-first') await firstHandling.promise
    })
    // getUpdates 第一次就带回那条"要跑很久"的消息；之后**一直悬着**（= 真的长轮询）。
    // ⚠️ 之后**绝不能**返回已结算的空数组：循环里"成功即立即续"没有 sleep
    //    ⇒ 立即结算 = 忙等自旋，`flush()` 永远不与它交错 ⇒ 测试进程 OOM（本探针首跑就踩到）。
    const longPollForever = new Promise<{ msgs: unknown[] }>(() => { /* 永不结算 */ })
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ msgs: [{ message_type: 1, from_user_id: 'u-first', item_list: [] }] })
      .mockReturnValue(longPollForever)
    installWeixinAccountImpl({ getUpdates, handleIncoming, handleMachineIncoming: vi.fn() } as never)

    // 第一位 poller：拿到 u-first，卡在 handleIncoming 里
    const oldLoop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()
    expect(processed).toEqual(['u-first']) // 它已经进处理了（此刻旧 loop **不在**长轮询里）

    // ← 模拟 syncCccBridge 重入：标停旧 loop，立刻起新的
    oldLoop.stopped = true
    const newLoop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()

    // 🔴 判据一：新 loop **确实**已经在取消息了（旧的那条还没办完）
    expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    // 🔴 判据二：`stopped=true` **没有**让 u-first 被中途放弃 —— 它仍在 await 里
    //    （若"能打断"成立，这里就已经结算完了）
    expect(processed).toEqual(['u-first'])

    // 放行第一条处理 ⇒ 它走完并（这才是）退出循环
    firstHandling.resolve()
    await flush()
    expect(processed).toEqual(['u-first'])
    // 且退出后**没有**再发起新的长轮询（while 判据在下一圈生效）
    const callsAfterFinish = getUpdates.mock.calls.length
    await flush(10)
    expect(getUpdates.mock.calls.length).toBe(callsAfterFinish)

    newLoop.stopped = true
    await flush()
  })
})
