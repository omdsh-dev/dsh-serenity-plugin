/**
 * config-volatile.test.ts — 面板层十键**必须**标 `.volatile()`（v1.47.2）
 *
 * ## 为什么值得一条机械 pin（"静默失效"家族的又一员）
 *
 * 0.1.7 的设置面有两条**互相耦合**的硬约定，破坏任一条都**不报错、只是功能悄悄消失**：
 *
 *  ① **`settings.describe()` 只收录 `volatileForm(schema) !== undefined` 的条目**，而
 *     `volatileForm` **只认 `meta.volatile`**（object 递归；一个 volatile 字段都没有 ⇒ `undefined`）
 *     ⇒ **本插件命名空间整个不进 describe** ⇒ 客户端 `configForms.whileServed(['serenity-hooks'])`
 *     永不触发 ⇒ **设置面板那一节一个痕迹都不留**。
 *     🔵 实证（0.1.7-rc.1 真机）：`POST /api/settings/describe` 的 `namespaces` **16 条里没有
 *     `serenity-hooks`** —— 这就是 "配置面板不见了" 的**全部**根因。
 *
 *  ② 标了之后**读取面必须解包**：schemastery 对 volatile 字段**无条件**包 `Volatile<T>` 引用
 *     （"未设置"也是**恒真对象**）⇒ 见 `settings-section.ts` 的 `unwrapVolatile` 与
 *     `settings-section.test.ts` 的回归用例。
 *
 * ## 🔴 为什么这条 pin **必须用真 schemastery**（本文件与其余 index.ts 测试的关键差别）
 *
 * 本仓其余 import `index.ts` 的测试都 `vi.mock('@deepseek-ai/schemastery')`，而那个替身是
 * **"任何属性访问都返回真值"的 Proxy 链** ⇒ 在那里断言 `meta.volatile === true` 会**恒真**
 * —— 拿掉 `.volatile()` 也照样绿 ⇒ **假绿**。本文件**不 mock** schemastery，直接读 schema 元数据。
 */
import { describe, it, expect, vi } from 'vitest'

// ── 仅为让 `index.ts` 的宿主依赖在 vitest 里可加载（与 register.test.ts 同款；**都不 mock schemastery**）──
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { Config } from '../src/index.ts'

/** 设置面板层（扁平键）——**用户能在界面上改的九个字段**（= 必须 volatile 的那批）
 *  🔴 v1.49.0：`rebuildEnabled` 已砍掉（超限重建恒开、无总闸；owner 2026-09-26 裁决）⇒ 十个 → 九个 */
const PANEL_KEYS = [
  'gatewayEnabled',
  'rebuildThresholdK',
  'skiffEnabled',
  'skiffDebugPort',
  'acpEnabled',
  'acpHttpPort',
  'publicAskEnabled',
  'croEnabled',
  'unattendedEnabled',
] as const

/** 部署层（嵌套段）——**不是**用户可改字段，与面板层是同一份数据的两种拼写 */
const DEPLOY_KEYS = ['gateway', 'rebuild', 'skiff', 'acp'] as const

/** 取 schema 字典里的一个字段（`z.object` 的 dict；读不到 ⇒ undefined） */
function field(key: string) {
  return Config.dict?.[key]
}

describe('config-volatile: 设置面板层十键必须标 .volatile()（0.1.7 硬约定）', () => {
  it('🔴 十键都在 schema 里，且 meta.volatile === true（一条不标 ⇒ 整个设置面板消失）', () => {
    const offenders: string[] = []
    for (const key of PANEL_KEYS) {
      const f = field(key)
      expect(f, `schema 里缺字段 ${key}（面板/读取面都会取不到它）`).toBeDefined()
      if (f?.meta.volatile !== true) offenders.push(key)
    }
    expect(offenders, `以下面板键未标 .volatile()：${offenders.join(', ')}`).toEqual([])
  })

  it('schema 的 volatile 字段集**恰等于**十键（多一个少一个都会改变面板渲染）', () => {
    const volatileKeys = Object.entries(Config.dict ?? {})
      .filter(([, schema]) => schema.meta.volatile === true)
      .map(([key]) => key)
      .sort()
    expect(volatileKeys).toEqual([...PANEL_KEYS].sort())
  })

  it('🔴 部署层嵌套段**不得**标 volatile（同一份数据两种拼写：都标 ⇒ 用户看到两个互相打架的控件）', () => {
    for (const key of DEPLOY_KEYS) {
      const parent = field(key)
      expect(parent, `schema 里缺部署段 ${key}`).toBeDefined()
      expect(parent?.meta.volatile, `部署段 ${key} 不该是 volatile（它是部署缺省，不是用户字段）`).toBeFalsy()
      for (const [childKey, child] of Object.entries(parent?.dict ?? {})) {
        expect(child.meta.volatile, `${key}.${childKey} 不该是 volatile`).toBeFalsy()
      }
    }
  })

  it('🔴 十键**不得**带 `.required()` / `.default()`（"未设置"必须可观测；带默认值 ⇒ 部署层被无声压死）', () => {
    for (const key of PANEL_KEYS) {
      const meta = field(key)?.meta
      expect(meta?.required, `${key} 不该 required：面板字段非必填，required 会把"没设过"变成报错`).toBeFalsy()
      expect(meta?.default, `${key} 不该有 default：有默认就永远非 undefined，部署层会被压死`).toBeUndefined()
    }
  })
})
