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

// dsh-settings 运行时不可解析（peerDep）——mock 宿主设置面（v1.47 起为 SettingsForms.configure）
vi.mock('@deepseek-ai/dsh-settings', () => ({
  default: class {},
}))

import { simpleSettingsFromConfig, defaultSimpleSettings, SERENITY_SETTINGS_NS } from '../src/settings-section.js'

describe('settings-section: 简单配置读取（host 侧）', () => {
  it('命名空间 = profile 条目 id（serenity-hooks；与旧 settings.yaml 段名逐字相同）', () => {
    expect(SERENITY_SETTINGS_NS).toBe('serenity-hooks')
  })

  it('空 Config → 全部内建缺省（gateway off / rebuild on 400K / skiff off 3099 / acp off 3100 / CRO **on**）', () => {
    const d = simpleSettingsFromConfig({})
    expect(d).toEqual({
      gatewayEnabled: false,
      rebuildEnabled: true,
      rebuildThresholdK: 400,
      skiffEnabled: false,
      skiffDebugPort: 3099,
      acpEnabled: false,
      acpHttpPort: 3100,
      publicAskEnabled: false,
      croEnabled: true,
      unattendedEnabled: false,
    })
  })

  it('🔴 部署层（嵌套段）生效 —— 面板层未设时读嵌套段', () => {
    const d = simpleSettingsFromConfig({
      gateway: { enabled: true },
      rebuild: { enabled: false, thresholdK: 500 },
      skiff: { enabled: true, debugPort: 4000 },
      acp: { enabled: true, httpPort: 4100 },
    })
    expect(d).toEqual({
      gatewayEnabled: true,
      rebuildEnabled: false,
      rebuildThresholdK: 500,
      skiffEnabled: true,
      skiffDebugPort: 4000,
      acpEnabled: true,
      acpHttpPort: 4100,
      publicAskEnabled: false,
      croEnabled: true,
      unattendedEnabled: false,
    })
  })

  it('🔴 面板层（扁平键）优先于部署层 —— 旧 settings.yaml 的值压过 cordis.yml 的段', () => {
    const d = simpleSettingsFromConfig({
      gateway: { enabled: false },
      gatewayEnabled: true, // 面板层
      rebuild: { enabled: false, thresholdK: 500 },
      rebuildThresholdK: 700, // 面板层
    })
    expect(d.gatewayEnabled).toBe(true)
    expect(d.rebuildThresholdK).toBe(700)
    // 面板层没设的字段仍走部署层
    expect(d.rebuildEnabled).toBe(false)
  })

  it('部分覆盖保留其余默认', () => {
    const d = simpleSettingsFromConfig({ rebuild: { thresholdK: 700 } })
    expect(d.rebuildThresholdK).toBe(700)
    expect(d.rebuildEnabled).toBe(true)
    expect(d.gatewayEnabled).toBe(false)
  })

  it('三个纯面板层开关（问答页 / CRO / 无人值守）只经扁平键', () => {
    const d = simpleSettingsFromConfig({ publicAskEnabled: true, croEnabled: false, unattendedEnabled: true })
    expect(d.publicAskEnabled).toBe(true)
    expect(d.croEnabled).toBe(false)
    expect(d.unattendedEnabled).toBe(true)
  })

  it('defaultSimpleSettings 与空 Config 一致', () => {
    expect(defaultSimpleSettings()).toEqual(simpleSettingsFromConfig({}))
  })
})
