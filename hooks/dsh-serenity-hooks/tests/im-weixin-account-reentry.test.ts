/**
 * im/weixin-account.ts —— **重入窗口**判据（2026-10-21，S142）。
 *
 * ## 这份文件回答的是什么问题
 *
 * `syncCccBridge`（`im/bridge.ts`）在热重建时对旧 loop 只做一件事：
 * `loop.stopped = true` 然后 `bridges.delete(root)`，**紧接着**就起新 loop。
 * 而旧 loop 很可能**正阻塞在 35 s 长轮询里**（`getUpdates` 的 `timeoutMs`）。
 * ⇒ 结构上存在一个"**同一账号两个 poller 并存**"的窗口。
 *
 * ## 为什么必须用探针而不是读源码（D119／D174）
 *
 * "旧 loop 会继续持有一次 getUpdates" 与 "旧 loop 会在下一个 await 点醒来并立刻退出"
 * 这两种假设，**在源码字面上都能读出来** —— 只有把 `getUpdates` 换成**不自动结算**的
 * 受控 Promise，让时间真的悬在那里，才能二分：
 *
 * | 假设 | 本探针的观测 |
 * |---|---|
 * | 窗口存在（旧 loop 仍占着长轮询） | 第一次 `getUpdates` 尚未结算时，**第二次就被发起** ⇒ 并发数 = 2 |
 * | 窗口不存在（旧 loop 立刻退出） | 第二次 `getUpdates` 要等第一次结算后才出现 ⇒ 并发数恒 = 1 |
 *
 * 两个假设产生**不同的**观测 ⇒ 本探针有判别力（D174）。
 *
 * ## 顺带钉住的一件事（这决定窗口的**后果**）
 *
 * 旧 loop 拿到消息后**不处理**（`if (loop.stopped) break`）⇒ 窗口的后果**不是重复处理**，
 * 而是**丢弃**（消息被拿到、被跳过、且游标已推进）＋ **新 loop 从空游标重开始**。
 * ⚠️ 这条与"同一句话被答复两轮"的已修缺陷**不是同一件事** —— 那个的根因是
 * `sentThisTurn` 被下一条入站抹掉（见 `2026-10-21T1220-a3f1-weixin-duplicate-inbound-rootcause.md`）。
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

/** 让出若干微任务轮（循环是 async while，需要它转起来） */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  __resetImAccountImplsForTest()
})

describe('重入窗口 —— syncCccBridge 热重建时旧 loop 仍占着长轮询', () => {
  it('🔴 旧 loop 阻塞在 getUpdates 时被标 stopped ⇒ 新 loop 与它**并发**（窗口确实存在）', async () => {
    const first = deferred<{ get_updates_buf?: string; msgs?: unknown[] }>()
    const second = deferred<{ get_updates_buf?: string; msgs?: unknown[] }>()
    const pending = [first, second]
    let callIndex = 0
    const getUpdates = vi.fn(() => pending[callIndex++]!.promise)
    const handleIncoming = vi.fn().mockResolvedValue(undefined)
    installWeixinAccountImpl({ getUpdates, handleIncoming, handleMachineIncoming: vi.fn() } as never)

    // 第一位 poller（热重建**之前**的那条）
    const oldLoop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()
    expect(getUpdates).toHaveBeenCalledTimes(1) // 它已在长轮询里

    // ← 模拟 syncCccBridge 重入：只标 stopped，不 await 它退出
    oldLoop.stopped = true
    const newLoop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()

    // 🔴 判据：第一次**尚未结算**，第二次就已经发起 ⇒ 同一账号两个 poller 并存
    expect(getUpdates).toHaveBeenCalledTimes(2)
    // 且两位用的游标各自独立（新 loop 从空游标开始）——
    //   这是"窗口内两条 long-poll 用不同游标打同一个账号"的直接读数
    expect(getUpdates.mock.calls[0]![0]).toMatchObject({ getUpdatesBuf: '' })
    expect(getUpdates.mock.calls[1]![0]).toMatchObject({ getUpdatesBuf: '' })

    first.resolve({ get_updates_buf: 'buf-old', msgs: [] })
    second.resolve({ get_updates_buf: 'buf-new', msgs: [] })
    await flush()

    oldLoop.stopped = true
    newLoop.stopped = true
    await flush()
  })

  it('🔴 窗口的后果 = **丢弃**而不是重复处理：旧 loop 拿到消息也不处理', async () => {
    const first = deferred<{ get_updates_buf?: string; msgs?: unknown[] }>()
    const getUpdates = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ veryslow: true, msgs: [] })
    const handleIncoming = vi.fn().mockResolvedValue(undefined)
    installWeixinAccountImpl({ getUpdates, handleIncoming, handleMachineIncoming: vi.fn() } as never)

    const loop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()

    // 在长轮询**悬着的时候**被标停（正是重入的形态）
    loop.stopped = true
    // 然后那条在飞的请求**带着一条用户消息**回来了
    first.resolve({
      get_updates_buf: 'buf-1',
      msgs: [{ message_type: 1, from_user_id: 'u-a', item_list: [] }],
    })
    await flush()

    // 🔴 判据：消息**没有被交给** handleIncoming ⇒ 窗口里拿到的东西是**丢了**，不是处理两遍
    expect(handleIncoming).not.toHaveBeenCalled()
    // 且它拿到了**推进后的游标**（`buf = resp.get_updates_buf` 在跳过判据**之前**执行）
    //   ⇒ 这条消息在服务端游标上算"已投递"，而本端把它扔了 = 丢失，不是重复
    expect(getUpdates).toHaveBeenCalledTimes(1)

    await flush()
  })
})
