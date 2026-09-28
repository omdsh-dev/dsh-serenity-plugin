/**
 * host-contract.test.ts — 宿主契约层（S142 review F-04/F-05）
 *
 * 覆盖两部分：
 *  ① 运行时探针 `probeHostContract`：完整 ctx → ok；缺服务/缺成员 → 精确报出；
 *     必需项缺失 → ok:false；可选项缺失 → ok:true 但 issues 非空。
 *  ② 版本范围 `checkHostVersion` / `compareSemver`：下限、上限、预发布、不可解析。
 *  ③ 契约表自洽：每个事件名都在 HOST_EVENT_NAMES 内（编译期已由 `satisfies keyof Events`
 *     保证名字真实存在；此处保证两张表不漂移）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  HOST_EVENTS,
  HOST_EVENT_NAMES,
  HOST_SERVICES,
  REQUIRED_HOST_RANGE,
  VERIFIED_HOST_BANDS,
  checkHostVersion,
  compareSemver,
  probeHostContract,
  summarizeHostContract,
} from '../src/host/contract.js'

/**
 * 一个"档内"的宿主版本字面量，**从档表派生**（v1.31.6 起派生；0.2.0-rc.1 适配轮改从 `VERIFIED_HOST_BANDS`）。
 *
 * 此前本文件散落 `'0.1.2-rc.1'` 字面量：改范围时忘改测试 → 探针测试红，
 * 且红的原因是"测试写死了旧下限"而非"契约真的坏了"——假报警与真报警无法区分。
 * 🔴 **0.2.0-rc.1 适配轮的关键修正**：派生来源**不再是 `REQUIRED_HOST_RANGE` 剥前缀**
 * —— 那招在**联合范围**上会取到垃圾（`^0.1.7-rc.1 || ^0.2.0-rc.1` 的预发布段会吞掉后半），
 * 与 `contract.ts` 里被我修掉的那个 bug **同源**。取档表的 floor 才是稳的。
 */
const IN_RANGE_HOST = VERIFIED_HOST_BANDS[0]!.floor
/** 明确低于下限的版本（用于"低于 floor → ok:false"断言；由 IN_RANGE_HOST 派生，避免写死） */
const BELOW_FLOOR_HOST = '0.0.1-rc.1'

/** 构造"完整"宿主替身：HOST_SERVICES 全部服务 + 成员齐备 */
function completeHost(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  const get: Record<string, unknown> = {}
  for (const svc of HOST_SERVICES) {
    const obj: Record<string, unknown> = {}
    for (const m of svc.members) obj[m.name] = m.kind === 'function' ? () => undefined : 3080
    if (svc.access === 'injected') ctx[svc.name] = obj
    else get[svc.name] = obj
  }
  ctx.get = (name: string) => get[name]
  return ctx
}

describe('host-contract: 探针（服务与成员）', () => {
  it('完整宿主 → ok:true、零 issue、检查项 > 0', () => {
    const report = probeHostContract(completeHost(), IN_RANGE_HOST)
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checked).toBeGreaterThan(20)
    expect(report.versionOk).toBe(true)
  })

  it('必需服务缺失 → ok:false 且 issue 指向该服务（含后果）', () => {
    const ctx = completeHost()
    delete ctx.tools
    const report = probeHostContract(ctx, IN_RANGE_HOST)
    expect(report.ok).toBe(false)
    const issue = report.issues.find((i) => i.id === 'tools')
    expect(issue?.kind).toBe('service')
    expect(issue?.required).toBe(true)
    expect(issue?.impact).toContain('工具无法注册')
  })

  it('服务在但成员被移除 → ok:false 且 issue 指向成员（宿主改名/删除的典型形态）', () => {
    const ctx = completeHost()
    const sessions = ctx.sessions as Record<string, unknown>
    delete sessions.create // 模拟宿主移除 members 之一
    const report = probeHostContract(ctx, IN_RANGE_HOST)
    expect(report.ok).toBe(false)
    const issue = report.issues.find((i) => i.id === 'sessions.create')
    expect(issue?.kind).toBe('member')
    expect(issue?.detail).toContain('missing function "create"')
  })

  it('可选项缺失（sessionTitle 无 rename）→ ok:true 但 issue 记录（降级而非中断）', () => {
    const ctx = completeHost()
    const titles = (ctx.get as (n: string) => unknown)('sessionTitle') as Record<string, unknown>
    delete titles.rename
    const report = probeHostContract(ctx, IN_RANGE_HOST)
    expect(report.ok).toBe(true)
    expect(report.issues.map((i) => i.id)).toContain('sessionTitle.rename')
    expect(report.issues.every((i) => i.required === false)).toBe(true)
  })

  it('lazy 服务缺失（connection）→ 只影响网关，不阻断（ok:true）', () => {
    const ctx = completeHost()
    const get = ctx.get as (n: string) => unknown
    expect(get('connection')).toBeDefined()
    // 移除 lazy 服务
    const empty: Record<string, unknown> = {}
    ctx.get = (name: string) => empty[name]
    const report = probeHostContract(ctx, IN_RANGE_HOST)
    expect(report.ok).toBe(true) // 无 required 缺失
    expect(report.issues.some((i) => i.id === 'connection')).toBe(true)
  })

  it('ctx 为空/非对象 → 不抛错，全部记为缺失', () => {
    expect(() => probeHostContract(undefined)).not.toThrow()
    const report = probeHostContract({})
    expect(report.ok).toBe(false)
    expect(report.issues.length).toBeGreaterThan(0)
  })

  it('summarizeHostContract：ok 与 BROKEN 两种摘要', () => {
    expect(summarizeHostContract(probeHostContract(completeHost(), IN_RANGE_HOST))).toContain('host contract ok')
    const broken = probeHostContract({}, IN_RANGE_HOST)
    expect(summarizeHostContract(broken)).toContain('BROKEN')
  })
})

describe('host-contract: 宿主版本范围', () => {
  it('compareSemver：主/次/补丁 + 预发布低于正式版', () => {
    expect(compareSemver('0.1.2-rc.1', '0.1.2-rc.1')).toBe(0)
    expect(compareSemver('0.1.1-rc.2', '0.1.2-rc.1')).toBe(-1)
    expect(compareSemver('0.1.2', '0.1.2-rc.1')).toBe(1)
    expect(compareSemver('0.2.0', '0.1.2')).toBe(1)
    expect(compareSemver('garbage', '0.1.2')).toBeNull()
  })

  it('checkHostVersion：下限之下 / 范围内 / 上界之外 / 未知', () => {
    expect(checkHostVersion(BELOW_FLOOR_HOST).ok).toBe(false) // 低于下限
    expect(checkHostVersion(IN_RANGE_HOST).ok).toBe(true) // 恰好等于下限（含预发布）
    // v1.47（0.1.7-rc.1 适配）：原先此处断言 `'0.1.6-rc.1'` 在范围内 —— 它**只是**下限之上
    // 的同线版本，已由下面 `0.1.9` 覆盖；写死一个"刚好落在旧下限之上"的字面量，会在每次抬
    // 下限时变成假报警（与文件头注释里 IN_RANGE_HOST 的教训同族）⇒ 删掉，不再复现该形态。
    expect(checkHostVersion('0.1.9').ok).toBe(true)
    // 🔴 0.2.0-rc.1 适配轮（双档）：`0.2.0` 由"超出范围"**转为在范围内** —— 这是**有意的语义变更**，
    //   不是回归：第二档 `^0.2.0-rc.1` 的 caret 上界是 `<0.3.0`，正式版 `0.2.0` 正落在里面。
    expect(checkHostVersion('0.2.0').ok).toBe(true)
    expect(checkHostVersion('0.2.0-rc.1').ok).toBe(true) // 第二档的下限本身
    expect(checkHostVersion('0.2.5-alpha').ok).toBe(true) // 第二档内的预发布
    expect(checkHostVersion('0.3.0').ok).toBe(false) // 高于全场最高档
    expect(checkHostVersion(null).ok).toBe(false)
    expect(checkHostVersion('not-a-version').ok).toBe(false)
    expect(checkHostVersion(BELOW_FLOOR_HOST).detail).toContain(REQUIRED_HOST_RANGE)
  })

  it('硬切判据：被取代的旧下限不再算通过（0.1.2-rc.1 → false）', () => {
    // v1.31.6：用户裁决硬切 ^0.1.5-rc.1，不做双基线 → 旧宿主必须显式判为"范围外"
    expect(checkHostVersion('0.1.2-rc.1').ok).toBe(false)
    expect(checkHostVersion('0.1.2-rc.1').detail).toContain('below the verified floor')
    expect(checkHostVersion('0.1.4-rc.9').ok).toBe(false)
  })

  it('版本不符 → 记为 issue 但非 required（不降级 health）', () => {
    const report = probeHostContract(completeHost(), BELOW_FLOOR_HOST)
    const issue = report.issues.find((i) => i.id === 'host.version')
    expect(issue?.kind).toBe('version')
    expect(issue?.required).toBe(false)
    expect(report.versionOk).toBe(false)
  })

  it('🔴 档表是单一真相源：每档下限都在范围内、最低档之下不在（逐档判，非单档）', () => {
    // 派生关系本身（防有人把 REQUIRED_HOST_RANGE 又改回硬编码字面量 ⇒ 双真相源复发）
    expect(REQUIRED_HOST_RANGE).toBe(VERIFIED_HOST_BANDS.map((b) => `^${b.floor}`).join(' || '))
    // 逐档：每档下限本身必须在范围内（防"档表加了一档，但判定只看第一档"）
    for (const band of VERIFIED_HOST_BANDS) {
      expect(checkHostVersion(band.floor).ok, `${band.floor} 应在范围内`).toBe(true)
    }
    // 低于**每一档**的下限 ⇒ 必须 false
    const lowest = [...VERIFIED_HOST_BANDS].map((b) => b.floor).sort((a, b) => compareSemver(a, b) ?? 0)[0]!
    const [major, minor, patch] = lowest.split('.')
    const stepDown = `${major}.${minor}.${String(Math.max(0, Number(patch) - 1))}-rc.1`
    if (stepDown !== lowest) {
      expect(checkHostVersion(stepDown).ok).toBe(false)
    }
  })

  it('🔴 跨文件对账：REQUIRED_HOST_RANGE 与 package.json 的 dsh-* peer 范围逐字同串', () => {
    // 为什么必须机械化（R↓）：这个串**就是宿主门拿去跑 `semver.satisfies` 的那一个串**
    // （`@deepseek-ai/dsh-app-boot:evaluatePluginCompatibility`；它**只检查** `@deepseek-ai/dsh` /
    //  `@deepseek-ai/dsh-*` 两类 peer）。它与档表一旦漂移，就是"**声明 union、判定单档**"
    // —— 公告面说 0.2.0-rc.1 可装，运行期却按 0.1.x 判 ⇒ 两个面互相打脸的**静默**不一致。
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(10)
    for (const [name, range] of dshPeers) {
      expect(range, `${name} 的 peer 范围与 contract.ts 的 REQUIRED_HOST_RANGE 不一致`).toBe(REQUIRED_HOST_RANGE)
    }
  })
})

describe('host-contract: 契约表自洽', () => {
  it('HOST_EVENTS 与 HOST_EVENT_NAMES 一一对应（名字真实存在由 satisfies keyof Events 保证）', () => {
    expect(HOST_EVENTS.map((e) => e.name).sort()).toEqual([...HOST_EVENT_NAMES].sort())
  })

  it('每个服务契约都有 impact + 唯一 id', () => {
    const ids = HOST_SERVICES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const svc of HOST_SERVICES) expect(svc.impact.length).toBeGreaterThan(0)
  })

  it('必需项覆盖 ACC 核心面（工具注册/守卫/会话/agent/设置）', () => {
    const required = HOST_SERVICES.filter((s) => s.required).map((s) => s.id)
    expect(required).toEqual(expect.arrayContaining(['tools', 'sessions', 'agents', 'webServer', 'settings']))
  })

  // ── 🔴 跨版本纪律（2026-09-24 加，来自一次**我自己引入的回归**）──
  // 事故：修 0.1.7 适配时，我把 `settings` 的 members 写成 `configure`/`describe`/`update`，
  //   而 **`configure` 只存在于 0.1.7**（`SettingsForms`）；老宿主（0.1.5-rc.2）的
  //   `SettingsProvider` 里**根本没有它** ⇒ 契约在**老宿主上恒报 BROKEN** ⇒ `settings` 判不可用
  //   ⇒ 两条功能**又**静默跳过（**修好新宿主、弄坏老宿主**）。
  // ⇒ 机械判据：**`settings` 的 required 成员必须是"两代都提供"的交集**（此处 = describe/update）。
  it('🔴 settings 的 members 不得含只在 0.1.7 存在的成员（configure）—— 跨版本交集纪律', () => {
    const settings = HOST_SERVICES.find((s) => s.id === 'settings')
    expect(settings).toBeDefined()
    const names = (settings?.members ?? []).map((m) => m.name)
    // 两代共有的读/写面必须在
    expect(names).toEqual(expect.arrayContaining(['describe', 'update']))
    // 只在 0.1.7 存在的页策略成员**不得**进表（调用点自己用可选链守卫）
    expect(names).not.toContain('configure')
    // 0.1.7 已删的两个成员也不得回来
    expect(names).not.toContain('installSection')
    expect(names).not.toContain('get')
  })
})
