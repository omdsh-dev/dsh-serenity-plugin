/**
 * config-volatile.test.ts — 面板层各键**必须**标 `.volatile()`（v1.47.2）
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

/** 设置面板层（扁平键）——**用户能在界面上改的字段**（= 必须 volatile 的那批）
 *  🔴 v1.49.0：`rebuildEnabled` 已砍掉（超限重建恒开、无总闸；owner 2026-09-26 裁决）⇒ 十个 → 九个
 *  🔴 v1.51（D104）：新增 `diagramEnabled`（图工具总闸，缺省关）⇒ 九个 → 十个
 *  🔴 2026-10-15：**旧面 E 退役** ⇒ `acpEnabled` / `acpHttpPort` / `publicAskEnabled` 三个面板键删除
 *     （owner 裁「砍掉外部问答」）⇒ 十个 → **七个**。
 *  🔴 2026-10-16：**新面 E 上线**（官方 ACP，跑在 web 进程内；owner 令，P0′ 实测 8/8）
 *     ⇒ 新增 `acpFaceEnabled` / `acpFacePort` ⇒ 七个 → **九个**。
 *     ⚠️ **键名带 `Face` 是有意的**：`acpEnabled`/`acpHttpPort` 是**旧面 E** 的名字、现被静默忽略；
 *     复用会让旧配置在新面上复活（判据：**退役要连名字一起守**）。
 *     本表**不含**旧名是**判据的一部分**（下一节有条专门的回归钉）。
 *  🔴 2026-10-18（v1.63.3）：**无人值守整条退役**（owner 裁「已经证实没意义了」）⇒ `unattendedEnabled`
 *     删除 ⇒ 九个 → **八个**。⚠️ 同批消失的还有 `unattended-ops.ts` / `unattended-seam.ts` 与
 *     那两个测试文件 ⇒ 本表少一格**是预期**，不是漏登记。
 *  🔴 2026-10-19：**新面 E（官方 ACP）整面删除**（owner 裁「完整删除整个 ACP 的实现」）
 *     ⇒ `acpFaceEnabled` / `acpFacePort` 删除 ⇒ 八个 → **六个**。⚠️ 与 10-15 那次退役同形：
 *     **表少两格是预期**，且**旧名与 `acpFace` 名都要继续守着**（下一节有专门的回归钉）。 */
const PANEL_KEYS = [
  'gatewayEnabled',
  'rebuildThresholdK',
  'skiffEnabled',
  'skiffDebugPort',
  'croEnabled',
  'diagramEnabled',
] as const

/** 部署层（嵌套段）——**不是**用户可改字段，与面板层是同一份数据的两种拼写
 *  🔴 v1.51（D104）：新增 `diagram`（缺省关）。**它必须在这里被钉住"不标 volatile"**：
 *  同义键两端都标 ⇒ 面板出现两个互相打架的控件。
 *  🔴 2026-10-15：旧面 E 退役 ⇒ `acp` 嵌套段删除。
 *  🔴 2026-10-19：新面 E 也整面删除 ⇒ `acpFace` 嵌套段随之删除（该面已无任何配置入口）。 */
const DEPLOY_KEYS = ['gateway', 'rebuild', 'skiff', 'diagram'] as const

/** 取 schema 字典里的一个字段（`z.object` 的 dict；读不到 ⇒ undefined） */
function field(key: string) {
  return Config.dict?.[key]
}

describe('config-volatile: 设置面板层各键必须标 .volatile()（0.1.7 硬约定）', () => {
  it('🔴 各键都在 schema 里，且 meta.volatile === true（一条不标 ⇒ 整个设置面板消失）', () => {
    const offenders: string[] = []
    for (const key of PANEL_KEYS) {
      const f = field(key)
      expect(f, `schema 里缺字段 ${key}（面板/读取面都会取不到它）`).toBeDefined()
      if (f?.meta.volatile !== true) offenders.push(key)
    }
    expect(offenders, `以下面板键未标 .volatile()：${offenders.join(', ')}`).toEqual([])
  })

  it('schema 的 volatile 字段集**恰等于**面板键（多一个少一个都会改变面板渲染）', () => {
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

  it('🔴 各键**不得**带 `.required()` / `.default()`（"未设置"必须可观测；带默认值 ⇒ 部署层被无声压死）', () => {
    for (const key of PANEL_KEYS) {
      const meta = field(key)?.meta
      expect(meta?.required, `${key} 不该 required：面板字段非必填，required 会把"没设过"变成报错`).toBeFalsy()
      expect(meta?.default, `${key} 不该有 default：有默认就永远非 undefined，部署层会被压死`).toBeUndefined()
    }
  })
})

/**
 * 🔴 **面 E 的名字守卫**（2026-10-16 立，"新面 E 上线"时写的；2026-10-19 整面删除后**继续守**）。
 *
 * **为什么留着它**：owner 2026-10-15 裁「砍掉外部问答」⇒ 旧面 E（自造 HTTP＋HTML）整组退役，
 * 其三个键进"静默忽略"状态（schemastery 非 strict ⇒ 旧配置里的残留键**不会报错**）。
 * 2026-10-16 owner 又令做**新面 E**（官方 ACP），用了 `acpFace*` 这组新名以避开旧名；
 * 2026-10-19 owner 再裁「完整删除整个 ACP 的实现」⇒ **两组名字现在都无主**。
 *
 * ⇒ 判据：**退役的是功能，名字必须继续守着**（"无人读"要能被机械验证，不能靠人记得）。
 * 两个失效方向都要挡：① 旧名复活 ⇒ 当年那份 `acpEnabled: true` 会静默打开一个已不存在的面；
 * ② 新名残留 ⇒ 配置面写着一个已删功能的开关，用户改了却什么都不会发生。
 */
describe('config-volatile: 两个面 E 的键名都不得回到 schema 里', () => {
  it('🔴 旧面 E 的三个键**不在** schema 里（复用同名 ⇒ 旧配置静默复活一个已不存在的面）', () => {
    for (const retired of ['acpEnabled', 'acpHttpPort', 'publicAskEnabled']) {
      expect(field(retired), `${retired} 不该在 schema 里：它是旧面 E 的退役键`).toBeUndefined()
    }
  })

  it('🔴 两个面 E 的部署段（`acp` 与 `acpFace`）**都不在** schema 里', () => {
    expect(field('acp'), '`acp` 嵌套段是旧面 E 的退役键，不该复活').toBeUndefined()
    expect(field('acpFace'), '`acpFace` 属已整面删除的新面 E，不该残留').toBeUndefined()
  })
})
