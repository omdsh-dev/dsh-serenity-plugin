/**
 * container-status.test.ts — 容器状态模型（C5「观察面归一」，S142 2026-09-15）
 *
 * 覆盖四组（对应本轮 C5 的验收要求）：
 *  ① **组装**：核心段各分组在给定输入下产出预期形状（含"无 CCC"降级形状）；
 *  ② **两条注册表判据相互独立**：同一份 `mech-registry.json` 上，结构完整性判据与质量契约
 *     判据（DC-M1~M4）**可以给出相反结论**——这是本模型的设计红线（不许合并）；
 *  ③ **`probeHostContract` 收敛后只跑一次**：计数桩证明"启动捕获 → 多个消费者读"不再重复探针；
 *  ④ **时钟字段来自快照而非重算**：改变调度器的进程内模块态 ⇒ 模型输出随之变，且与调度器
 *     自述逐字一致。
 * 另覆盖时间轴分组取数（`containerWakes` / `containerAutopilot`）——它们是 `/serenity/trajectory`
 * 与 `acc-diag` 的共同来源。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkRegistryHealth,
  checkRegistryQuality,
  containerAutopilot,
  containerClocks,
  containerStatus,
  containerWakes,
} from '../src/container-status.js'
import { hostContractReport, probeHostContract, __resetHostContractForTest } from '../src/host/contract.js'
import { runKit } from '../src/kit-ops.js'
import { ACC_VERSION } from '../src/constants.js'
import { registerWakeScheduler, wakeSchedulerState, __resetWakeSchedulerStateForTest } from '../src/wake-scheduler.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

let dir: string

const AGG_REL = '.opencode/skills/t/references/mech-registry.json'
const SCRIPTS_REL = '.opencode/skills/t/scripts'

function write(rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function writeRegistry(entries: unknown[]): void {
  write(AGG_REL, JSON.stringify({ version: 1, entries }, null, 2))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsp-container-status-'))
  writeFileSync(join(dir, '.serenity'), 't\n')
  mkdirSync(join(dir, '.git'), { recursive: true })
  write('.opencode/serenity.json', JSON.stringify({ localstore: { gitTrack: 'allow' } }))
  // 进程内唯一来源是模块级快照 ⇒ 用例之间必须复位（同 __resetWakeSchedulerStateForTest 规格）
  __resetHostContractForTest()
})

afterEach(() => {
  __resetHostContractForTest()
  rmSync(dir, { recursive: true, force: true })
})

// ── ① 组装 ──

describe('container-status: 核心段组装', () => {
  it('身份/三原则/注册表结构/配置 在完整 CCC 上产出预期形状', () => {
    writeRegistry([{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' }])
    write(`${SCRIPTS_REL}/solo.ts`, 'console.log(1)\n')

    const s = containerStatus({ root: dir })
    expect(s.identity.root).toBe(dir)
    expect(s.identity.ccc).toBe('t')
    expect(s.identity.accVersion).toBe(ACC_VERSION)
    expect(s.identity.nodeVersion).toBe(process.version)
    // hostCtx 未给且快照为空 → 不猜、不探（null）
    expect(s.hostContract).toBeNull()

    // 三原则：模型只给事实，不给人读文案（文案归渲染点——见 kit-ops 的 health 渲染）
    expect(s.principles).toEqual({
      rooted: true,
      gitManaged: true,
      gitRoot: dir,
      configPath: '.opencode/serenity.json',
      allPass: true,
    })

    // 注册表：结构判据总在；质量判据默认不跑（它要枚举脚本并逐个读源码）
    expect(s.registry.structure.ok).toBe(true)
    expect(s.registry.structure.present).toBe(true)
    expect(s.registry.quality).toBeNull()

    expect((s.config as { localstore?: { gitTrack?: string } }).localstore?.gitTrack).toBe('allow')
  })

  it('withRegistryQuality: true → 质量判据同时在场（两条判据分别取用）', () => {
    writeRegistry([{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' }])
    write(`${SCRIPTS_REL}/solo.ts`, 'console.log(1)\n')

    const s = containerStatus({ root: dir, withRegistryQuality: true })
    expect(s.registry.structure.ok).toBe(true)
    expect(s.registry.quality).not.toBeNull()
    expect(s.registry.quality!.checked).toBe(1)
  })

  it('无 CCC（root=null）→ 降级形状，不抛错', () => {
    const s = containerStatus({ root: null })
    expect(s.identity.root).toBeNull()
    expect(s.identity.ccc).toBeNull()
    expect(s.principles.allPass).toBe(false)
    expect(s.principles.gitRoot).toBeNull()
    expect(s.principles.configPath).toBeNull()
    expect(s.registry.structure).toEqual({ path: null, ok: true, present: false, issues: [] })
    expect(s.registry.quality).toBeNull()
    expect(s.config).toBeNull()
    expect(s.hostContract).toBeNull()
  })
})

// ── ② 两条注册表判据相互独立 ──

describe('container-status: 两条注册表判据相互独立（同一份表，可给出相反结论）', () => {
  it('结构合法但条目不达标：结构 ok=true ｜ 质量报 M1+M2', () => {
    writeRegistry([{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' }])
    // 脚本存在（结构判据只要求"引用完整"），但没有测试文件、没有 main() 守卫（质量判据不答应）
    write(`${SCRIPTS_REL}/solo.ts`, 'console.log(1)\n')

    const structure = checkRegistryHealth(dir)
    const quality = checkRegistryQuality(dir)
    expect(structure.ok).toBe(true)
    expect(structure.issues).toEqual([])
    expect(quality.issues.map((i) => i.check).sort()).toEqual(['M1', 'M2'])
    // 模型同时携带两条结论（不是一个合并后的 ok）
    const s = containerStatus({ root: dir, withRegistryQuality: true })
    expect(s.registry.structure.ok).toBe(true)
    expect(s.registry.quality!.issues.length).toBe(2)
  })

  it('条目全达标但表结构坏（同名重复）：结构 ok=false ｜ 质量只报去重视角下的 M3', () => {
    const src = 'function main() {}\nmain()\n'
    write(`${SCRIPTS_REL}/a.ts`, src)
    write(`${SCRIPTS_REL}/b.ts`, src)
    write(`${SCRIPTS_REL}/a.test.ts`, 'export {}\n')
    write(`${SCRIPTS_REL}/b.test.ts`, 'export {}\n')
    writeRegistry([
      { name: 'dup', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' },
      { name: 'dup', path: `${SCRIPTS_REL}/b.ts`, skill: 't', category: 'mech' },
    ])

    const structure = checkRegistryHealth(dir)
    const quality = checkRegistryQuality(dir)
    // 结构判据：**读原始文件** ⇒ 看见两条 entry，name 全局唯一被破坏（loadMsmEntries 去重 = 歧义）
    expect(structure.ok).toBe(false)
    expect(structure.issues.some((i) => i.includes('duplicate MSM name'))).toBe(true)
    // 质量判据：**读去重后的条目集**（loadMsmEntries by-name）⇒ 完全没有"唯一性"这一条判据，
    // 它看见的是"b.ts 这份脚本没有任何注册项指向它"（另一类结论、另一类修复动作）
    expect(quality.checked).toBe(1)
    expect(quality.issues.map((i) => i.check)).toEqual(['M3'])
    expect(quality.issues[0]!.name).toBe(`${SCRIPTS_REL}/b.ts`)
    expect(quality.issues.some((i) => /duplicate/i.test(i.detail))).toBe(false)
    // 即：同一份注册表，两条判据的结论与**修复动作**都不同（一条去重、一条补注册）——不许合并
    expect(structure.issues.some((i) => /M3|not registered/i.test(i))).toBe(false)
  })
})

// ── ③ 宿主契约只跑一次 ──

/** 计数桩 ctx：探针每读一次宿主面就 +1（`hostInjected` 走属性读 + `ctx.get` 回落） */
function countingCtx(): { ctx: unknown; reads: () => number } {
  let reads = 0
  const target: Record<string, unknown> = { get: () => undefined }
  const ctx = new Proxy(target, {
    get(t, p, r) {
      reads += 1
      return Reflect.get(t, p, r)
    },
    has(t, p) {
      reads += 1
      return Reflect.has(t, p)
    },
  })
  return { ctx, reads: () => reads }
}

describe('container-status: 宿主契约收敛为进程内唯一来源', () => {
  it('启动捕获一次 → health / containerStatus 多次读同一份快照（触达 ctx 次数不再增长）', async () => {
    const { ctx, reads } = countingCtx()

    // ① apply 时的启动探针 = **唯一计算点**
    const captured = hostContractReport(ctx, null)
    expect(captured).not.toBeNull()
    const afterCapture = reads()
    expect(afterCapture).toBeGreaterThan(0) // 探针确实跑了（桩是活的）

    // ② dashboard health 两次：不再触发探针
    const h1 = (await runKit(dir, { action: 'health' }, ctx)) as Record<string, unknown>
    const h2 = (await runKit(dir, { action: 'health' }, ctx)) as Record<string, unknown>
    expect(reads()).toBe(afterCapture)
    expect(h1.hostContract).toBeDefined()
    expect(h2.hostContract).toBeDefined()
    expect(h1.hostContract).toEqual(captured)

    // ③ 模型直接取也用同一份
    const s = containerStatus({ root: dir, hostCtx: ctx })
    expect(s.hostContract).toEqual(captured)
    expect(reads()).toBe(afterCapture)

    // ④ 反向对照：真探针会增长计数（证明 ①②③ 的"不增长"来自快照而非桩失效）
    probeHostContract(ctx, null)
    expect(reads()).toBeGreaterThan(afterCapture)
  })

  it('快照未捕获且未给 ctx → 返回 null（不猜、不暗跑探针）', () => {
    const { ctx, reads } = countingCtx()
    expect(hostContractReport()).toBeNull()
    expect(reads()).toBe(0)
    // 给了 ctx 才捕获
    expect(hostContractReport(ctx, null)).not.toBeNull()
    expect(reads()).toBeGreaterThan(0)
  })

  it('health 未给 hostCtx 且无快照 → 不含 hostContract 字段（wire 形状与旧行为一致）', async () => {
    const h = (await runKit(dir, { action: 'health' })) as Record<string, unknown>
    expect(h).not.toHaveProperty('hostContract')
  })
})

// ── ④ 时钟来自快照 ──

describe('container-status: 时钟读进程内快照（不重算）', () => {
  let timer: { fn: () => void } | null
  let listeners: Record<string, Array<() => void>>
  let disposers: Array<() => void>

  /** 最小 scheduler ctx（同 wake-registry.test.ts 的规格：注册/事件/拆卸三通道齐备） */
  function makeSchedulerCtx(): unknown {
    return {
      sessions: { list: () => [] },
      agents: { get: () => undefined },
      get: () => undefined,
      on: (name: string, fn: () => void) => {
        ;(listeners[name] ??= []).push(fn)
      },
      effect: (cb: () => () => void) => {
        disposers.push(cb())
      },
    }
  }

  beforeEach(() => {
    timer = null
    listeners = {}
    disposers = []
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), wakeSchedulerEnabled: true }))
    vi.spyOn(global, 'setInterval').mockImplementation((((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as unknown) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {
      timer = null
    })
  })

  afterEach(() => {
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  it('快照改变 → 模型输出随之变；且与调度器自述逐字一致（同源，非同形异值）', () => {
    // 复位态
    expect(containerClocks().wake.armed).toBe(false)
    expect(containerClocks().wake.armedAt).toBeNull()

    // 改变**模块级快照**（armed/armedAt 只存在于调度器的运行时对象里，无法从配置推导）
    registerWakeScheduler(makeSchedulerCtx() as never)
    expect(timer).not.toBeNull()

    const c = containerClocks()
    expect(c.wake.armed).toBe(true)
    expect(c.wake.armedAt).not.toBeNull()
    // 同源断言：模型给的正是调度器自述的那份快照（两次同步调用之间无 await，不存在交错）
    expect(c.wake).toEqual(wakeSchedulerState())
    // 未参与的另一条时钟保持自己的快照
    expect(c.autopilot.armed).toBe(false)
  })

  it('containerStatus 不自行携带时钟（时间轴分组按需取——见 containerClocks）', () => {
    const s = containerStatus({ root: dir }) as unknown as Record<string, unknown>
    expect(s).not.toHaveProperty('clocks')
  })
})

// ── 时间轴分组取数 ──

describe('container-status: 时间轴分组取数', () => {
  it('containerWakes：原始条目 + 在办计数（投影归渲染点）', () => {
    write('AGENT_SESSIONS/wake-registry.json', JSON.stringify({
      version: 1,
      entries: [
        { id: 'w-1', target: 'S142', at: '2026-09-15T10:00:00Z', message: 'm1', state: 'pending', createdBy: 'S142', createdAt: '2026-09-15T09:00:00Z', attempts: 0 },
        { id: 'w-2', target: 'S151', at: '2026-09-15T09:00:00Z', message: 'm2', state: 'delivered', createdBy: 'S112', createdAt: '2026-09-15T08:00:00Z', attempts: 1, lastResult: 'ok' },
      ],
    }))

    const w = containerWakes(dir)
    expect(w.error).toBeNull()
    expect(w.entries).toHaveLength(2)
    expect(w.pending).toBe(1)
    // 条目按 at 升序（单一真相源的既有语义）
    expect(w.entries[0]!.id).toBe('w-2')
    // 原始条目带 message —— 面板要它、acc-diag 不要；这是**投影**差异，取数只给一份
    expect(w.entries[0]).toHaveProperty('message', 'm2')
  })

  it('containerAutopilot：root=null → null；CCC 未配置 → configured:false', () => {
    expect(containerAutopilot(null)).toBeNull()
    const s = containerAutopilot(dir)
    expect(s).not.toBeNull()
    expect(s!.configured).toBe(false)
    expect(s!.target).toBeNull()
  })
})
