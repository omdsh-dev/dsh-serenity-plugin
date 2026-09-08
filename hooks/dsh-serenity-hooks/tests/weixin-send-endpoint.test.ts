import { describe, it, expect, beforeEach } from 'vitest'
import {
  setWeixinSendEndpoint,
  weixinSendEndpoint,
  resetWeixinSendEndpointForTest,
} from '../src/weixin-send-endpoint.js'

/**
 * weixin-send-endpoint 镜像测试（v1.30.9，S142）
 *
 * 这个叶模块的存在理由 = 让 `msm-ops`（MSM env 注入）**零依赖**地读到入口地址，
 * 不必 import 整条微信桥栈。因此测试重点是：读写解耦 + 未启动语义 + 可重置（测试隔离）。
 */
describe('weixin-send-endpoint: 入口地址叶模块（零依赖读写解耦）', () => {
  beforeEach(() => {
    resetWeixinSendEndpointForTest()
  })

  it('未启动 → null（MSM env 不注入 SERENITY_WEIXIN_API）', () => {
    expect(weixinSendEndpoint()).toBeNull()
  })

  it('set → 读到同一地址；stop（set null）→ 回到 null', () => {
    setWeixinSendEndpoint('http://127.0.0.1:3082')
    expect(weixinSendEndpoint()).toBe('http://127.0.0.1:3082')
    setWeixinSendEndpoint(null)
    expect(weixinSendEndpoint()).toBeNull()
  })

  it('重复 set 覆盖（进程内单例；最后一次生效）', () => {
    setWeixinSendEndpoint('http://127.0.0.1:3082')
    setWeixinSendEndpoint('http://127.0.0.1:3182')
    expect(weixinSendEndpoint()).toBe('http://127.0.0.1:3182')
  })

  it('reset 清空（测试间隔离）', () => {
    setWeixinSendEndpoint('http://127.0.0.1:3082')
    resetWeixinSendEndpointForTest()
    expect(weixinSendEndpoint()).toBeNull()
  })
})
