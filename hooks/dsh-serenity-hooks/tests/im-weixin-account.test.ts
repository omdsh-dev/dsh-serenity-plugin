/**
 * im/weixin-account.ts —— 微信账号实现（P2：既有轮询循环包成 `ImAccountImpl`）。
 *
 * 本文件钉住三件事（都是"移动"过程中最容易悄悄改变行为的地方）：
 *  ① **轮询照旧**：`getUpdates` 被调用、回来的消息被逐条交给 `handleIncoming`；
 *  ② **只处理用户消息**（`message_type === 1`）——bot 自己/系统消息必须被跳过；
 *  ③ **停止信号真的停**（`stopped = true` 后不再继续取消息）。
 *
 * 🔴 为什么用**注入的替身**而不是真 iLink：这一层只负责"循环怎么转"，
 * 协议正确性归 `ilink.ts` 的测试。替身必须**给返回值**（本轨踩过"替身不给返回值"的坑）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { weixinAccountImpl, installWeixinAccountImpl } from '../src/im/weixin-account.js'
import { getImAccountImpl, __resetImAccountImplsForTest } from '../src/im/accounts.js'

/** 让出若干微任务轮（循环是 async while，需要它转起来） */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  __resetImAccountImplsForTest()
})

describe('isReady —— 有 token 才算绑定（与既有装配判据逐字同义）', () => {
  it('有非空 token ⇒ ready；空/空白/缺失 ⇒ 不 ready', () => {
    expect(weixinAccountImpl.isReady({ token: 'placeholder-token' })).toBe(true)
    expect(weixinAccountImpl.isReady({ token: '   ' })).toBe(false)
    expect(weixinAccountImpl.isReady({ token: '' })).toBe(false)
    expect(weixinAccountImpl.isReady({})).toBe(false)
  })

  it('notReadyReason 保住既有告警措辞（既有测试按「无 token」找它）', () => {
    expect(weixinAccountImpl.notReadyReason!({})).toContain('无 token')
  })
})

describe('startLoop —— 轮询循环照旧转', () => {
  it('🔴 取到消息 ⇒ 逐条交给 handleIncoming（且只处理 message_type===1）', async () => {
    const getUpdates = vi.fn().mockResolvedValue({
      get_updates_buf: 'buf-2',
      msgs: [
        { message_type: 1, from_user_id: 'u-a', item_list: [] },
        { message_type: 2, from_user_id: 'bot-self', item_list: [] }, // 非用户消息 ⇒ 必须跳过
      ],
    })
    const handleIncoming = vi.fn().mockResolvedValue(undefined)
    const handleMachineIncoming = vi.fn().mockResolvedValue(undefined)
    installWeixinAccountImpl({ getUpdates, handleIncoming, handleMachineIncoming } as never)

    const loop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()
    loop.stopped = true
    await flush()

    expect(getUpdates).toHaveBeenCalled()
    expect(handleIncoming).toHaveBeenCalledTimes(1)
    const call = handleIncoming.mock.calls[0]!
    expect(call[1]).toBe('/ccc')
    expect(call[2]).toBe('acct-1')
    expect(handleMachineIncoming).not.toHaveBeenCalled()
    expect(loop.lastPollAt).toBeGreaterThan(0)
  })

  it('机器级模式：交给 handleMachineIncoming（不碰 CCC 根）', async () => {
    const getUpdates = vi.fn().mockResolvedValue({
      msgs: [{ message_type: 1, from_user_id: 'u-a', item_list: [] }],
    })
    const handleIncoming = vi.fn().mockResolvedValue(undefined)
    const handleMachineIncoming = vi.fn().mockResolvedValue(undefined)
    installWeixinAccountImpl({ getUpdates, handleIncoming, handleMachineIncoming } as never)

    const loop = weixinAccountImpl.startLoop({
      ctx: {}, root: '<machine>', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: true,
    })
    await flush()
    loop.stopped = true

    expect(handleMachineIncoming).toHaveBeenCalled()
    expect(handleIncoming).not.toHaveBeenCalled()
  })

  it('🔴 停止信号真的停：`stopped=true` 后不再发起新的 getUpdates', async () => {
    const getUpdates = vi.fn().mockResolvedValue({ msgs: [] })
    installWeixinAccountImpl({
      getUpdates,
      handleIncoming: vi.fn(),
      handleMachineIncoming: vi.fn(),
    } as never)

    const loop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()
    loop.stopped = true
    const callsAfterStop = getUpdates.mock.calls.length
    await flush(10)
    expect(getUpdates.mock.calls.length).toBe(callsAfterStop)
  })

  it('取消息抛错 ⇒ 记进 lastError（面板可见），循环不炸', async () => {
    const getUpdates = vi.fn().mockRejectedValue(new Error('ilink boom'))
    installWeixinAccountImpl({
      getUpdates,
      handleIncoming: vi.fn(),
      handleMachineIncoming: vi.fn(),
    } as never)

    const loop = weixinAccountImpl.startLoop({
      ctx: {}, root: '/ccc', accountId: 'acct-1', cred: { token: 't', baseUrl: '' }, machine: false,
    })
    await flush()
    loop.stopped = true
    expect(loop.lastError).toContain('ilink boom')
  })
})

describe('installWeixinAccountImpl —— 幂等登记进派发表', () => {
  it('登记后能从派发表取到（装配处靠它）；重复登记不产生第二份', () => {
    expect(getImAccountImpl('weixin')).toBeNull()
    installWeixinAccountImpl({ getUpdates: vi.fn(), handleIncoming: vi.fn(), handleMachineIncoming: vi.fn() } as never)
    expect(getImAccountImpl('weixin')?.channel).toBe('weixin')
    installWeixinAccountImpl({ getUpdates: vi.fn(), handleIncoming: vi.fn(), handleMachineIncoming: vi.fn() } as never)
    expect(getImAccountImpl('weixin')).toBe(weixinAccountImpl)
  })
})
