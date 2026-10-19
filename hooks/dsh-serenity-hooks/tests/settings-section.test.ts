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

import { simpleSettingsFromConfig, defaultSimpleSettings, SERENITY_SETTINGS_NS, unwrapVolatile } from '../src/surface/settings.js'

describe('settings-section: 简单配置读取（host 侧）', () => {
  it('命名空间 = profile 条目 id（serenity-hooks；与旧 settings.yaml 段名逐字相同）', () => {
    expect(SERENITY_SETTINGS_NS).toBe('serenity-hooks')
  })

  it('空 Config → 全部内建缺省（gateway off / rebuild 400K / skiff off 3099 / CRO **on**）', () => {
    const d = simpleSettingsFromConfig({})
    expect(d).toEqual({
      gatewayEnabled: false,
      rebuildThresholdK: 400,
      skiffEnabled: false,
      skiffDebugPort: 3099,
      croEnabled: true,
      diagramEnabled: false,
      // 2026-09-26（P0-1）：机器级 human-channel 搭本结构出（读取入口唯一）；缺省见 human-channel-config.test.ts
      humanChannel: { accounts: [], subscriptions: [], relayCcc: null, sendingAllow: ['*'] },
    })
  })

  it('🔴 2026-10-15 面 E 退役回归钉：结构里**不再有** acp 三键（旧配置残留也不进结构）', () => {
    // owner 裁「砍掉外部问答」⇒ 扁平键与嵌套 `acp.*` 双双退场（同 `rebuildEnabled` 的处置）。
    // 用"键在不在"断言（而非 toBeUndefined）——契约是**无该键**，不是"值为 undefined"。
    for (const key of ['acpEnabled', 'acpHttpPort', 'publicAskEnabled']) {
      expect(key in simpleSettingsFromConfig({}), `${key} 仍在结构里`).toBe(false)
    }
    const stale = simpleSettingsFromConfig({
      acpEnabled: true,
      acpHttpPort: 4100,
      publicAskEnabled: true,
      acp: { enabled: true, httpPort: 4100 },
    } as never)
    for (const key of ['acpEnabled', 'acpHttpPort', 'publicAskEnabled']) {
      expect(key in stale, `${key} 被旧配置复活了`).toBe(false)
    }
  })

  it('🔴 v1.49.0 砍闸回归钉：简单配置里**不再有** rebuildEnabled（旧配置残留该键也不进结构）', () => {
    // owner 2026-09-26 裁决：超限重建总开关已砍掉 ⇒ 扁平键与嵌套 `rebuild.enabled` 双双退场。
    // 用"键在不在"断言（而非 toBeUndefined）——契约是**无该键**，不是"值为 undefined"。
    expect('rebuildEnabled' in simpleSettingsFromConfig({})).toBe(false)
    const stale = simpleSettingsFromConfig({ rebuildEnabled: true, rebuild: { enabled: true } } as never)
    expect('rebuildEnabled' in stale).toBe(false)
    // 阈值这条仍在（要调敏感度改它）
    expect(stale.rebuildThresholdK).toBe(400)
  })

  it('🔴 部署层（嵌套段）生效 —— 面板层未设时读嵌套段', () => {
    const d = simpleSettingsFromConfig({
      gateway: { enabled: true },
      rebuild: { thresholdK: 500 },
      skiff: { enabled: true, debugPort: 4000 },
    })
    expect(d).toEqual({
      gatewayEnabled: true,
      rebuildThresholdK: 500,
      skiffEnabled: true,
      skiffDebugPort: 4000,
      croEnabled: true,
      diagramEnabled: false,
      humanChannel: { accounts: [], subscriptions: [], relayCcc: null, sendingAllow: ['*'] },
    })
  })

  it('🔴 面板层（扁平键）优先于部署层 —— 旧 settings.yaml 的值压过 cordis.yml 的段', () => {
    const d = simpleSettingsFromConfig({
      gateway: { enabled: false },
      gatewayEnabled: true, // 面板层
      rebuild: { thresholdK: 500 },
      rebuildThresholdK: 700, // 面板层
    })
    expect(d.gatewayEnabled).toBe(true)
    expect(d.rebuildThresholdK).toBe(700)
  })

  it('部分覆盖保留其余默认', () => {
    const d = simpleSettingsFromConfig({ rebuild: { thresholdK: 700 } })
    expect(d.rebuildThresholdK).toBe(700)
    expect(d.gatewayEnabled).toBe(false)
  })

  it('CRO 是纯面板层开关，只经扁平键', () => {
    const d = simpleSettingsFromConfig({ croEnabled: false })
    expect(d.croEnabled).toBe(false)
  })

  it('🔴 v1.63.3 砍无人值守回归钉：简单配置里**不再有** unattendedEnabled（旧配置残留也不进结构）', () => {
    // owner 2026-10-18 裁「砍掉无人值守功能，整个砍掉，已经证实没意义了」⇒ 机制层 + 拦截缝 +
    // 面板键 + 出站账本一并退役。用"键在不在"断言（而非 toBeUndefined）——契约是**无该键**。
    expect('unattendedEnabled' in simpleSettingsFromConfig({})).toBe(false)
    const stale = simpleSettingsFromConfig({ unattendedEnabled: true } as never)
    expect('unattendedEnabled' in stale).toBe(false)
  })

  it('🆕 D104 diagram：面板层 > 部署层，且两端都缺省**关**（两个方向都钉）', () => {
    expect(simpleSettingsFromConfig({}).diagramEnabled).toBe(false) // 缺省关
    expect(simpleSettingsFromConfig({ diagram: { enabled: true } }).diagramEnabled).toBe(true) // 部署层
    // 面板层为真 ⇒ 压过部署层的 false
    expect(simpleSettingsFromConfig({ diagram: { enabled: false }, diagramEnabled: true }).diagramEnabled).toBe(true)
    // 面板层为假 ⇒ 压过部署层的 true（**两个方向都钉**：只测单向会漏掉 `??` 写成 `||` 的错法）
    expect(simpleSettingsFromConfig({ diagram: { enabled: true }, diagramEnabled: false }).diagramEnabled).toBe(false)
  })

  it('🔴 2026-10-19 面 E 整面删除回归钉：结构里**不再有** acpFace 两键（旧配置残留也不进结构）', () => {
    // owner 裁「完整删除整个 ACP 的实现」（实测理由：dsh-acp 无 session/load 且 resume 不回放历史
    // ⇒ 客户端每次连上只能新建会话）。用"键在不在"断言（而非 toBeUndefined）——契约是**无该键**。
    for (const key of ['acpFaceEnabled', 'acpFacePort']) {
      expect(key in simpleSettingsFromConfig({}), `${key} 仍在结构里`).toBe(false)
    }
    const stale = simpleSettingsFromConfig({
      acpFace: { enabled: true, port: 3300 },
      acpFaceEnabled: true,
      acpFacePort: 3300,
    } as never)
    for (const key of ['acpFaceEnabled', 'acpFacePort']) {
      expect(key in stale, `${key} 被旧配置复活了`).toBe(false)
    }
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

  it('🔴 回归（正控）：多个"未设置"的包装**不得**让开关被打开 —— 结果必须与全缺省逐字相同', () => {
    // 修复前形态：包装对象恒真 ⇒ `config.gatewayEnabled ?? …` 直接短路 ⇒ 开关被无意打开
    // ⚠️ 2026-10-15：原含 `acpEnabled` / `publicAskEnabled` 两条，随面 E 退役删除；
    //    2026-10-18：再删 `unattendedEnabled`（无人值守整条退役）——本用例的**判据不变**
    //    （未设置的包装必须让位给缺省），仍由余下三个键承担。
    const d = simpleSettingsFromConfig({
      gatewayEnabled: ref<boolean | undefined>(undefined),
      skiffEnabled: ref<boolean | undefined>(undefined),
      croEnabled: ref<boolean | undefined>(undefined),
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
