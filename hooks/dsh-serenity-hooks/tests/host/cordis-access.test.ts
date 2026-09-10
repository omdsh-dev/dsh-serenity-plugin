/**
 * cordis-access.test.ts — 宿主访问层的**真实 cordis** 回归用例（v1.31.4）
 *
 * 为什么必须用真 cordis（R↓，教训）：v1.31.3 的 handyman foreground 在真机上报
 * `cannot get property "subagents" without inject`，而**全部 fake ctx 单测都是绿的**——
 * 因为 `tests/host/access.test.ts` 里的 ctx 是普通对象（`{ get: ... }`），属性读只是
 * 返回 undefined；真实 cordis 的 Context 是 Proxy，`ReflectService.handler.get`
 * 对**未经 `inject` 声明**的服务名会沿 fiber 链查找、找不到时**抛错**
 * （`vendor/cordis/src/reflect.ts`：`if (!fiber.runtime) throw error`）。
 *
 * 本文件用宿主真实安装的 cordis 复现该行为并钉死修复：
 *  ① 未声明 inject 的服务名 → 直接属性读抛错（回归的**成因**，前提断言）；
 *  ② `hostInjected` / `hostSubagents` → 回落 `ctx.get` 取到服务（修复的**结论**）；
 *  ③ 服务注销 → 返回 undefined 且不抛（访问层契约：不成为单点）；
 *  ④ 声明了 inject 的服务名 → 直接属性读照旧可用（既有 injected 路径未被削弱）。
 *
 * 诚实边界（E↑）：cordis 是**宿主的 peer 依赖**，本仓不安装它（peer-only 打包）。
 * 用例按"离运行时最近"的顺序探测宿主实例；一个都找不到时（CI runner 未装 DSH 宿主）
 * 整体 skip，并由末尾一条用例在本机**明确失败**提醒补路径——避免静默失去保护力。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostInjected, hostService, hostSubagents } from '../../src/host/access.js'
import { probeHostContract } from '../../src/host/contract.js'

type Ctx = Record<string, unknown>

interface CordisContextLike {
  provide: (name: string, value: unknown) => () => void
  plugin: (plugin: unknown) => PromiseLike<unknown>
  get: (name: string, strict?: boolean) => unknown
}

interface CordisInstance {
  label: string
  path: string
  Context: new () => CordisContextLike
}

const HOME = process.env.HOME ?? ''

/** 候选宿主 cordis 实例（按"离运行时最近"排序：插件实际加载的实例优先） */
function candidatePaths(): { label: string; path: string }[] {
  return [
    { label: 'SERENITY_CORDIS_PATH', path: process.env.SERENITY_CORDIS_PATH ?? '' },
    // ① 插件真实运行实例：profile 的模块回落目录（cordis 4.0.0-rc.7）
    { label: 'profile-runtime', path: join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'cordis', 'lib', 'index.js') },
    // ② 宿主全局安装的实例（@deepseek-ai/cordis 4.0.2，与 tsconfig paths 同源）
    { label: 'host-install', path: join(HOME, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js') },
  ].filter((c) => c.path !== '')
}

async function loadCordisInstances(): Promise<CordisInstance[]> {
  const out: CordisInstance[] = []
  for (const c of candidatePaths()) {
    if (!existsSync(c.path)) continue
    try {
      const mod = (await import(pathToFileURL(c.path).href)) as { Context?: CordisInstance['Context'] }
      if (typeof mod.Context === 'function') out.push({ label: c.label, path: c.path, Context: mod.Context })
    } catch {
      // 该实例不可加载（缺失 peer / 平台二进制）→ 试下一个；一个都没有时末尾用例报出
    }
  }
  return out
}

const instances = await loadCordisInstances()

/** 替身 subagents 服务（形状对照宿主 rc.1：`start(name, request)`） */
function fakeSubagents(): { start: (name: string, request: unknown) => Promise<unknown> } {
  return { start: async () => ({ id: 'child-1', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) }
}

/**
 * 构造与真机**同拓扑**的 cordis 场景（这一步是复现的关键）：
 *
 *   根 ctx ──┬─ 宿主服务提供者 fiber（`host-subagents`，provide 'subagents'）
 *            └─ dsp fiber（不声明 inject）          ← 两个 fiber 是**兄弟**关系
 *
 * 真机上 `subagents` 由 dsh-subagent 插件自己的 fiber 提供，**不是 dsp 的祖先**；
 * 只有兄弟拓扑才会让代理的 fiber 链查找走到根 fiber 后抛错（若服务由祖先提供，
 * 链查找会直接命中 `fiber.store` 并正常返回——那正是最初误判"服务缺失"的成因）。
 */
async function makeTopology(
  inst: CordisInstance,
  opts: { provide: boolean; inject?: string[] },
): Promise<{ ctx: Ctx; service: unknown; unprovide: () => void }> {
  const root = new inst.Context()
  const service = fakeSubagents()
  let unprovide: () => void = () => {}
  if (opts.provide) {
    await root.plugin({
      name: 'host-subagents',
      apply: (c: Ctx) => {
        unprovide = (c.provide as (n: string, v: unknown) => () => void)('subagents', service)
      },
    })
  }
  let captured: Ctx | undefined
  await root.plugin({
    name: 'dsp-like',
    ...(opts.inject === undefined ? {} : { inject: opts.inject }),
    apply: (c: Ctx) => { captured = c },
  })
  if (!captured) throw new Error('plugin apply did not run')
  return { ctx: captured, service, unprovide }
}

describe.skipIf(instances.length === 0).each(instances.map((i) => [i.label, i] as const))(
  'host/access × 真实 cordis（%s）',
  (_label, inst) => {
    it('未声明 inject 的服务名：直接属性读抛错（这就是 v1.31.3 的报错来源，非"服务缺失"）', async () => {
      const { ctx } = await makeTopology(inst, { provide: true })
      expect(() => ctx.subagents).toThrow(/without inject/)
    })

    it('hostSubagents / hostInjected 回落 ctx.get 取到服务（v1.31.4 修复）', async () => {
      const { ctx, service } = await makeTopology(inst, { provide: true })
      expect(hostService(ctx, 'subagents')).toBe(service)
      expect(hostInjected(ctx, 'subagents')).toBe(service)
      expect(hostSubagents(ctx)).toBe(service)
      expect(hostSubagents(ctx)?.start).toBeTypeOf('function')
    })

    it('服务注销后 → undefined 且不抛（访问层不是单点）', async () => {
      const { ctx, unprovide } = await makeTopology(inst, { provide: true })
      unprovide()
      expect(() => hostSubagents(ctx)).not.toThrow()
      expect(hostSubagents(ctx)).toBeUndefined()
      expect(hostService(ctx, 'subagents')).toBeUndefined()
    })

    it('声明了 inject 的服务名：直接属性读照旧可用（injected 路径未被削弱）', async () => {
      const { ctx, service } = await makeTopology(inst, { provide: true, inject: ['subagents'] })
      expect(ctx.subagents).toBe(service)
      expect(hostSubagents(ctx)).toBe(service)
    })

    it('probeHostContract 在真实 cordis ctx 上不再把 subagents 记为缺失（契约面与访问面一致）', async () => {
      const { ctx } = await makeTopology(inst, { provide: true })
      const report = probeHostContract(ctx, null)
      expect(report.issues.some((i) => i.id === 'subagents' || i.id === 'subagents.start')).toBe(false)
    })
  },
)

describe('host/access × 真实 cordis：可用性自检', () => {
  it('本机必须能解析到宿主 cordis（否则本文件用例失去保护力）', () => {
    // CI runner 未安装 DSH 宿主（宿主依赖是 peer，不在仓库内）→ 允许跳过；
    // 本机（开发/发布机）必须能解析，否则请设 SERENITY_CORDIS_PATH 指向 cordis/lib/index.js。
    if (process.env.CI) return
    expect(instances.map((i) => i.label), 'set SERENITY_CORDIS_PATH to cordis/lib/index.js').not.toEqual([])
  })
})
