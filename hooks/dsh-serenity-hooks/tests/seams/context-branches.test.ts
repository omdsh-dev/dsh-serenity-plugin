/**
 * context-branches.test.ts — `seams/context.ts` 的**恢复链 ①/③ 层与退化分支**（⑤ 第 46 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `seams/context.ts` = 分支 **72%（54/75）**，是 `src/**` 中**最低的未被做过**的文件
 * （`diag-ops` 43、`compact` 44、`lifecycle` 45 已做完）。语句 88.42%（252/285）。
 *
 * ── 🔴 本件补的是「文档写了三层、测试只做了中间一层」────────────────────────
 * 源码 `:172-173` 自述恢复链是**三层**：
 *
 *   > v1.0 恢复链（方案：**bound 权威 → 文本扫回退 → 标题 reconcile 兼容**）
 *
 * 而既有 `context-register.test.ts` 的四个恢复用例**全部只打 ② 文本扫回退**
 * （用例名逐字写着「② 文本扫回退」…）⇒ **① 与 ③ 从未被任何测试执行**。
 * 🔴 这两层恰是"重启后找回用户上下文"这件机制的**权威层**与**兼容层**：
 *   · ① 是**权威** —— 有它就不该看后面的（allocation 错位会静默取错会话）
 *   · ③ 是**兼容** —— 老会话没有 bound 事件时唯一的救回路径
 *   ⇒ 两者皆零覆盖 = 机制的一半没有回归钉。
 *
 * ── 本件覆盖（对准未覆盖分支）──────────────────────────────────────────────
 *   T1 `:177` `if (bound)` **真侧** —— ① bound 权威层生效（并证明它**优先于** ②）
 *   T2 `:178` `mdPath.startsWith(root)` **假侧** —— 相对 mdPath 时走 `resolve(root,…)`
 *   T3 `:192` `if (title)` **真侧** —— ③ 标题 reconcile 生效（并 `appendBound` 持久化）
 *   T4 `:204-205` `sessionId` 缺省 + 目录名正则派生（含**派不出**时的 `?? dirName` 兜底）
 *   T5 `:45`   `readDshSessionTitle` 的 catch（`sessionEvents` 真抛）
 *   T6 `:152`  `seed` 的 cwd 缺省（agent 无 `header.cwd` ⇒ 回落 `process.cwd()`）
 *   T7 `:221/227` 播种期两个可见性同步的 catch（真故障形态注入）
 *   T8 `:260/266/272` pre-step 期三个可见性同步的 catch
 *   T9 `:74`  Phase2 提示文件存在但**读不到** ⇒ 吞掉（不破坏身份正文）
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：每个 describe 的第一条即 happy path。
 *  · **真故障形态注入**：用 `vi.mock(importActual)` 只替换被调方，被测模块真跑。
 *  · 断言「**取到哪一条**」而非仅"取到了" —— 三层链的价值在于**优先级**。
 *  · `it()` 标题内不用直引号（用「」）。红色即停：先分诊再改。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('@deepseek-ai/schemastery', () => {
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

// ── 可注入抛错的桩（只换被调方，不 mock 被测模块）─────────────────────────
const throwSet = new Set<string>()

vi.mock('../../src/seams/guards.js', async (orig) => {
  const actual = await orig<typeof import('../../src/seams/guards.js')>()
  const make = (name: string) => (a: unknown, r: string) => {
    if (throwSet.has(name)) throw new Error(`boom: ${name}`)
    return (actual as unknown as Record<string, (a: unknown, r: string) => unknown>)[name](a, r)
  }
  return {
    ...actual,
    syncSafeModeRestriction: make('syncSafeModeRestriction'),
    syncImBridgeVisibility: make('syncImBridgeVisibility'),
    syncExclusiveToolsVisibility: make('syncExclusiveToolsVisibility'),
  }
})

vi.mock('../../src/seams/system-prompt.js', async (orig) => {
  const actual = await orig<typeof import('../../src/seams/system-prompt.js')>()
  return {
    ...actual,
    registerEntrySkillSection: (a: unknown, r: string) => {
      if (throwSet.has('registerEntrySkillSection')) throw new Error('boom: entry-section')
      return actual.registerEntrySkillSection(a as never, r)
    },
    registerTrajectorySkillSection: (a: unknown, r: string) => {
      if (throwSet.has('registerTrajectorySkillSection')) throw new Error('boom: traj-section')
      return actual.registerTrajectorySkillSection(a as never, r)
    },
  }
})

import { registerContext, accIdentityText } from '../../src/seams/context.js'
import { getActiveSessionInfo, setActiveSessionInfo } from '../../src/trajectory-ops.js'

type Handler = (payload: unknown, next?: () => Promise<unknown>) => unknown

function fakeCtx(): { handlers: Map<string, Handler[]>; on: (n: string, f: Handler) => unknown } {
  const handlers = new Map<string, Handler[]>()
  const ctx = {
    handlers,
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return ctx
    },
  }
  return ctx
}

/** 造一个真实存在的会话目录 */
function makeSessionDir(name: string): { dirName: string; mdPath: string } {
  const sessDir = join(dir, 'AGENT_SESSIONS', name)
  mkdirSync(sessDir, { recursive: true })
  const mdPath = join(sessDir, 'SESSION.md')
  writeFileSync(mdPath, '# test')
  return { dirName: name, mdPath }
}

function fakeAgent(id: string, extra: Record<string, unknown> = {}): { agent: unknown } {
  return {
    agent: { session: { id, ...extra }, inject: () => {} },
  }
}

async function fireCreated(ctx: ReturnType<typeof fakeCtx>, agent: unknown): Promise<void> {
  for (const h of ctx.handlers.get('agent/created') ?? []) await h({ agent })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctxbranch-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  throwSet.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  // 🔴 进程内存态是模块级 Map ⇒ 必须清，否则用例间串味（假绿/假红）
  for (const id of ['br-1', 'br-2', 'br-3', 'br-4', 'br-5', 'br-6', 'br-nocwd', 'br-noid']) {
    try { setActiveSessionInfo(id, null as never) } catch { /* 清不掉忽略 */ }
  }
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('context 恢复链: ① bound 权威层（T1/T2）', () => {
  it('【正控】无任何恢复来源 ⇒ 内存保持空（证明夹具不瞎）', async () => {
    const id = 'br-nosource'
    const { agent } = fakeAgent(id, { header: { cwd: dir }, events: [] })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })
    await fireCreated(ctx, agent)
    expect(getActiveSessionInfo(id)).toBeNull()
  })

  it('🔴 T1：会话日志含旧形态 `serenity/bound` ⇒ ① 权威层生效并恢复', async () => {
    const { dirName, mdPath } = makeSessionDir('2026-01-01--S101--bound-authority')
    const id = 'br-1'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [
        { type: 'serenity/bound', data: { dirName, mdPath, sessionId: 'S101' } },
      ],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    // ① 生效 ⇒ 用 bound 里的 sessionId（**不是**从目录名派生的）
    expect(getActiveSessionInfo(id)).toEqual({ sessionId: 'S101', dirName, mdPath })
  })

  it('🔴 T1 优先级：bound **与** 文本标记同时在场 ⇒ 取 bound（权威压过后备）', async () => {
    const a = makeSessionDir('2026-01-01--S111--from-bound')
    const b = makeSessionDir('2026-01-01--S222--from-text')
    const id = 'br-2'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [
        // ② 的证据（文本）在前，① 的证据（bound）在后——latest-wins 取 ①
        { type: 'user/message', text: `SESSION.md path: ${b.mdPath}` },
        { type: 'serenity/bound', data: { dirName: a.dirName, mdPath: a.mdPath, sessionId: 'S111' } },
      ],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    // 🔴 本用例的判据 = **取到哪一条**：若优先级写反，会静默取回 ② 的 b
    expect(getActiveSessionInfo(id)?.dirName).toBe(a.dirName)
    expect(getActiveSessionInfo(id)?.sessionId).toBe('S111')
  })

  it('🔴 T2：bound 的 mdPath 是**相对路径** ⇒ 走 `resolve(root, …)` 拼绝对（仍能恢复）', async () => {
    const { dirName } = makeSessionDir('2026-01-01--S121--relpath')
    const id = 'br-3'
    const relMd = join('AGENT_SESSIONS', dirName, 'SESSION.md')
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'serenity/bound', data: { dirName, mdPath: relMd, sessionId: 'S121' } }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    const info = getActiveSessionInfo(id)
    expect(info?.dirName).toBe(dirName)
    // 落库的 mdPath 应是**绝对**的（相对路径已被 resolve 掉）
    expect(info?.mdPath).toBe(join(dir, relMd))
  })

  it('T1 反侧：bound 指向的 mdPath **不存在** ⇒ 不采用它，且回落 ②（existsSync 拦污染）', async () => {
    const good = makeSessionDir('2026-01-01--S131--real')
    const id = 'br-4'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [
        { type: 'serenity/bound', data: { dirName: 'ghost', mdPath: join(dir, 'AGENT_SESSIONS', 'ghost', 'SESSION.md') } },
        { type: 'user/message', text: `SESSION.md path: ${good.mdPath}` },
      ],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    // bound 被 existsSync 否掉 ⇒ 落到 ②，取 good
    expect(getActiveSessionInfo(id)?.dirName).toBe(good.dirName)
  })
})

describe('context 恢复链: ③ 标题 reconcile（T3/T4）', () => {
  it('🔴 T3：无 bound、无文本标记、**标题指向真实 SESSION** ⇒ ③ 生效', async () => {
    const { dirName, mdPath } = makeSessionDir('2026-01-01--S141--by-title')
    const id = 'br-5'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [
        // 会话有历史（否则 shouldRestoreActive=false 直接不进恢复链）
        { type: 'user/message', text: 'hello' },
        // 标题事件（latest-wins）——resolveSessionByTitle 需要它命中目录名
        { type: 'session/title', data: { title: dirName } },
      ],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    const info = getActiveSessionInfo(id)
    expect(info?.dirName).toBe(dirName)
    // T4：③ 层不设 sessionId ⇒ 从目录名 `--S141--` 派生
    expect(info?.sessionId).toBe('S141')
    expect(info?.mdPath).toBe(mdPath)
  })

  it('🔴 T4 兜底：目录名**派不出 S###**（无 `--xxx--` 段）⇒ sessionId 回落为 dirName 本身', async () => {
    const { dirName } = makeSessionDir('no-code-segment')
    const id = 'br-6'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [
        { type: 'user/message', text: 'hello' },
        { type: 'session/title', data: { title: dirName } },
      ],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    const info = getActiveSessionInfo(id)
    expect(info?.dirName).toBe(dirName)
    // 正则不命中 ⇒ `?? dirName` 兜底（不得是 undefined —— 该字段是必填展示码）
    expect(info?.sessionId).toBe(dirName)
  })

  it('🔴 T5：`sessionEvents` **真抛** ⇒ 标题读取吞掉异常返回 null（不阻断播种）', async () => {
    const id = 'br-7'
    // session 上挂一个会抛的 events getter —— readDshSessionTitle / sessionEvents 内部 catch
    const badSession: Record<string, unknown> = { id, header: { cwd: dir } }
    Object.defineProperty(badSession, 'events', {
      get() {
        throw new Error('boom: events access')
      },
      enumerable: true,
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    // 不抛即可（播种仍应完成）
    await expect(fireCreated(ctx, { session: badSession, inject: () => {} })).resolves.toBeUndefined()
  })
})

describe('context 退化分支: cwd 缺省与可见性异常（T6~T8）', () => {
  it('🔴 T6：agent **无 `header.cwd`** ⇒ 回落 `process.cwd()`（不抛）', async () => {
    const { agent } = fakeAgent('br-nocwd', {})
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })
    await expect(fireCreated(ctx, agent)).resolves.toBeUndefined()
    expect(getActiveSessionInfo('br-nocwd')).toBeNull()
  })

  it('🔴 T7：播种期三个可见性同步**全抛** ⇒ 逐个吞掉，播种仍完成', async () => {
    const { dirName, mdPath } = makeSessionDir('2026-01-01--S151--vis-throw')
    throwSet.add('syncSafeModeRestriction')
    throwSet.add('syncImBridgeVisibility')
    throwSet.add('syncExclusiveToolsVisibility')

    const id = 'br-8'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'serenity/bound', data: { dirName, mdPath, sessionId: 'S151' } }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await expect(fireCreated(ctx, agent)).resolves.toBeUndefined()
    // 可见性失败**不得**连带取消恢复（两者互不拖累）
    expect(getActiveSessionInfo(id)?.dirName).toBe(dirName)
  })

  it('🔴 T8：pre-step 期可见性同步全抛 ⇒ 吞掉且**仍委托 next()**（短路会跳过后续监听器）', async () => {
    throwSet.add('syncSafeModeRestriction')
    throwSet.add('syncImBridgeVisibility')
    throwSet.add('syncExclusiveToolsVisibility')

    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })
    const { agent } = fakeAgent('br-9', { header: { cwd: dir } })

    let nextCalled = false
    const downstream = { kind: 'skip-downstream', messages: [] }
    const next = async (): Promise<unknown> => {
      nextCalled = true
      return downstream
    }
    const handler = (ctx.handlers.get('agent/pre-step') ?? [])[0]!
    const out = await handler({ agent, messages: [] }, next)

    expect(nextCalled).toBe(true) // 🔴 必判据：可见性抛错不得导致不委托
    expect(out).toEqual(downstream)
  })
})

describe('context 文本构建: Phase2 读取失败（T9）', () => {
  it('🔴 T9：`.dsh/PHASE2-PROMPT.md` **存在但不可读**（是目录）⇒ 吞掉，正文仍含 Phase2 提示行', () => {
    // 用「目录冒充文件」造真故障（readFileSync 对目录抛 EISDIR）
    mkdirSync(join(dir, '.dsh', 'PHASE2-PROMPT.md'), { recursive: true })

    const text = accIdentityText(dir)

    // 提示行**仍须**出现（那是 existsSync 分支的产物，与读取成败无关）
    expect(text).toContain('Phase 2 cognitive alignment interview pending')
    // 且不得因读取失败而漏掉身份头
    expect(text).toContain('[ACC] Serenity cognitive container active')
  })

  it('T9 正控：`.dsh/PHASE2-PROMPT.md` **不存在** ⇒ 正文**不含** Phase2 行', () => {
    const text = accIdentityText(dir)
    expect(text).not.toContain('Phase 2 cognitive alignment interview pending')
    expect(text).toContain('[ACC] Serenity cognitive container active')
  })
})
