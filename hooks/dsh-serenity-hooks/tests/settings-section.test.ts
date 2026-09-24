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

import { simpleSettingsFromConfig, defaultSimpleSettings, SERENITY_SETTINGS_NS, unwrapVolatile } from '../src/settings-section.js'

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

/**
 * v1.47.2：0.1.7 起**面板层字段必须是 volatile**（否则整个命名空间不进 `describe`，
 * 设置面板那一节消失），而 volatile 字段在运行期是 schemastery 的 `Volatile<T>` **引用包装** ——
 * 🔴 **"用户没设过"也是恒真对象**（`.get()` 返回 undefined），**不是 `undefined`**。
 * ⇒ 本组用例钉住"**必须解包**"这条硬约束：不解包时 `?? ` 链会短路在包装上 ⇒ 开关被**无意打开**。
 */
describe('settings-section: volatile 包装解包（v1.47.2）', () => {
  /** 造一个 `createVolatile` 同形的引用（只保留可观察形状：有 `get()`，与生产实现同判据） */
  const ref = <T>(value: T) => ({ get: () => value })

  it('裸值原样返回（部署 bundle ／ 手写 Config ／ 老宿主都走这条）', () => {
    expect(unwrapVolatile(true)).toBe(true)
    expect(unwrapVolatile(false)).toBe(false)
    expect(unwrapVolatile(700)).toBe(700)
    expect(unwrapVolatile(undefined)).toBeUndefined()
  })

  it('引用 ⇒ 取 `.get()`（含"未设置"那种 `get()` 返回 undefined 的包装）', () => {
    expect(unwrapVolatile(ref(true))).toBe(true)
    expect(unwrapVolatile(ref(false))).toBe(false)
    expect(unwrapVolatile(ref(700))).toBe(700)
    expect(unwrapVolatile(ref<boolean | undefined>(undefined))).toBeUndefined()
  })

  it('🔴 回归（正控）：四个"未设置"的包装**不得**让开关被打开 —— 结果必须与全缺省逐字相同', () => {
    // 修复前形态：包装对象恒真 ⇒ `config.gatewayEnabled ?? …` 直接短路 ⇒ 开关被无意打开
    const d = simpleSettingsFromConfig({
      gatewayEnabled: ref<boolean | undefined>(undefined),
      skiffEnabled: ref<boolean | undefined>(undefined),
      acpEnabled: ref<boolean | undefined>(undefined),
      publicAskEnabled: ref<boolean | undefined>(undefined),
    })
    expect(d).toEqual(defaultSimpleSettings())
  })

  it('包装里的"未设置"让位给部署层；包装里的真值压过部署层', () => {
    expect(
      simpleSettingsFromConfig({ gateway: { enabled: true }, gatewayEnabled: ref<boolean | undefined>(undefined) })
        .gatewayEnabled,
    ).toBe(true)
    expect(simpleSettingsFromConfig({ gateway: { enabled: false }, gatewayEnabled: ref(true) }).gatewayEnabled).toBe(true)
    expect(simpleSettingsFromConfig({ gatewayEnabled: ref(false), gateway: { enabled: true } }).gatewayEnabled).toBe(false)
  })
})
