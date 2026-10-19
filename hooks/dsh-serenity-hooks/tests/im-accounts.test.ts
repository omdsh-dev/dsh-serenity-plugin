/**
 * im/accounts.ts —— **账号实现派发表**的单测（P2）。
 *
 * 判据来源：owner 定向「飞书和微信一样，**只不过是 account 方实现不同**」。
 * ⇒ 装配处不该认识任何具体渠道名；它只该问派发表"这个 channel 谁来实现"。
 *
 * 本文件钉住三件事：
 *  ① 注册/取用/枚举的**基本契约**；
 *  ② **未注册 ⇒ null**（由调用方响亮出声，绝不静默跳过）；
 *  ③ `normalizeAccountChannel` 的缺省（老配置平移不必补字段）。
 *
 * ⚠️ 隐私纪律（D145）：不写任何真实 appId / open_id / 用户 id。
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  registerImAccountImpl,
  getImAccountImpl,
  imAccountChannels,
  normalizeAccountChannel,
  __resetImAccountImplsForTest,
  type ImAccountImpl,
} from '../src/im/accounts.js'

function fakeImpl(channel: string, ready = true): ImAccountImpl {
  return {
    channel,
    isReady: () => ready,
    startLoop: () => ({ stopped: false, lastPollAt: 0 }),
  }
}

beforeEach(() => {
  __resetImAccountImplsForTest()
})

describe('账号实现派发表 —— 基本契约', () => {
  it('注册后能取到；未注册 ⇒ null（不是抛错，由调用方出声）', () => {
    expect(getImAccountImpl('weixin')).toBeNull()
    registerImAccountImpl(fakeImpl('weixin'))
    expect(getImAccountImpl('weixin')?.channel).toBe('weixin')
    expect(getImAccountImpl('feishu')).toBeNull()
  })

  it('多个实现并存，枚举顺序 = 注册顺序（诊断与错误文案依赖它稳定）', () => {
    registerImAccountImpl(fakeImpl('weixin'))
    registerImAccountImpl(fakeImpl('feishu'))
    expect(imAccountChannels()).toEqual(['weixin', 'feishu'])
  })

  it('同 channel 重复注册 ⇒ 后者覆盖（测试与热重载需要它幂等）', () => {
    registerImAccountImpl(fakeImpl('weixin', true))
    expect(getImAccountImpl('weixin')?.isReady({})).toBe(true)
    registerImAccountImpl(fakeImpl('weixin', false))
    expect(getImAccountImpl('weixin')?.isReady({})).toBe(false)
    expect(imAccountChannels()).toEqual(['weixin'])
  })
})

describe('normalizeAccountChannel —— 缺省 weixin（老配置平移不必补字段）', () => {
  it('undefined / 空串 / 纯空白 ⇒ weixin', () => {
    expect(normalizeAccountChannel(undefined)).toBe('weixin')
    expect(normalizeAccountChannel('')).toBe('weixin')
    expect(normalizeAccountChannel('   ')).toBe('weixin')
  })

  it('显式值原样保留（含首尾空白剥离）——这是飞书能接进来的唯一入口', () => {
    expect(normalizeAccountChannel('feishu')).toBe('feishu')
    expect(normalizeAccountChannel('  feishu  ')).toBe('feishu')
  })
})

describe('ImAccountImpl 的凭据判据由实现自己定（派发表不替它做主）', () => {
  it('notReadyReason 是可选面：不给也应能工作（装配处用通用文案）', () => {
    const impl = fakeImpl('feishu', false)
    expect(impl.notReadyReason).toBeUndefined()
    expect(impl.isReady({ appId: 'placeholder' })).toBe(false)
  })

  it('给了就取实现自己的措辞（微信靠它保住既有告警文案）', () => {
    const impl: ImAccountImpl = { ...fakeImpl('weixin', false), notReadyReason: () => '**无 token**（未绑定）' }
    expect(impl.notReadyReason!({})).toBe('**无 token**（未绑定）')
  })
})
