import { describe, it, expect, vi } from 'vitest'

// schemastery 运行时不可解析（peerDep 全局提供）——mock 纯逻辑测试所需面
vi.mock('@deepseek-ai/schemastery', () => {
  // 统一链：任何属性访问/函数调用都返回链自身（.min().max().default() 无限链）
  // 作为值使用（expect 比较）时经 valueOf/toString 返回；schema 定义只测形状不测值
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

// dsh-settings 运行时不可解析（peerDep）——mock installSettingsSection/settingsNamespace
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { entryDefaults, defaultSimpleSettings, SERENITY_SETTINGS_NS } from '../src/settings-section.js'

describe('settings-section: 简单配置 entry 默认（host 侧）', () => {
  it('namespace 固定为 serenity-hooks', () => {
    expect(SERENITY_SETTINGS_NS).toBe('serenity-hooks')
  })

  it('空 Config → 全部默认（gateway off / rebuild on 0.9 / skiff off 3099 / acp off 3100 / autopilot off）', () => {
    const d = entryDefaults({})
    expect(d).toEqual({
      gatewayEnabled: false,
      rebuildEnabled: true,
      rebuildThreshold: 0.9,
      skiffEnabled: false,
      skiffDebugPort: 3099,
      acpEnabled: false,
      acpHttpPort: 3100,
      publicAskEnabled: false,
      autopilotEnabled: false,
    })
  })

  it('Config 覆盖生效', () => {
    const d = entryDefaults({
      gateway: { enabled: true },
      rebuild: { enabled: false, thresholdRatio: 0.5 },
      skiff: { enabled: true, debugPort: 4000 },
      acp: { enabled: true, httpPort: 4100 },
    })
    expect(d).toEqual({
      gatewayEnabled: true,
      rebuildEnabled: false,
      rebuildThreshold: 0.5,
      skiffEnabled: true,
      skiffDebugPort: 4000,
      acpEnabled: true,
      acpHttpPort: 4100,
      publicAskEnabled: false,
      autopilotEnabled: false,
    })
  })

  it('部分覆盖保留其余默认', () => {
    const d = entryDefaults({ rebuild: { thresholdRatio: 0.7 } })
    expect(d.rebuildThreshold).toBe(0.7)
    expect(d.rebuildEnabled).toBe(true)
    expect(d.gatewayEnabled).toBe(false)
  })

  it('defaultSimpleSettings 与空 Config entry 一致', () => {
    expect(defaultSimpleSettings()).toEqual(entryDefaults({}))
  })
})
