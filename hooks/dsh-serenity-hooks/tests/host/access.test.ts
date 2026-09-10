/**
 * host/access.test.ts — 宿主访问收口层（S142 review F-06）
 *
 * 这是 dsp 与宿主之间的**唯一读取入口**，它的失败模式决定全插件的降级行为，
 * 因此必须逐条钉死：
 *  - 服务缺失 → 返回 undefined（不抛错）——apply 抛错 = 整个 dsh 启动失败
 *  - getter 抛错 → 视为不可用（吞掉，返回 undefined）
 *  - injected 属性优先，缺失回落 ctx.get（两种访问风格并存，宿主两种都有）
 *  - 形状不符（list 返回非数组 / 元素缺 header）→ 空数组而非抛错
 */
import { describe, it, expect } from 'vitest'
import {
  hostService,
  hostInjected,
  hostSessions,
  hostAgents,
  hostWebServer,
  hostSettings,
  hostSubagents,
  hostSessionCwds,
} from '../../src/host/access.js'

describe('host/access: 通用读取', () => {
  it('hostService 走 ctx.get；ctx 缺失/非对象/get 非函数 → undefined', () => {
    const ctx = { get: (n: string) => (n === 'sessions' ? { list: () => [] } : undefined) }
    expect(hostService(ctx, 'sessions')).toEqual({ list: expect.any(Function) })
    expect(hostService(ctx, 'nope')).toBeUndefined()
    expect(hostService(undefined, 'sessions')).toBeUndefined()
    expect(hostService({}, 'sessions')).toBeUndefined()
    expect(hostService({ get: 42 }, 'sessions')).toBeUndefined()
  })

  it('hostService：getter 抛错 → 吞掉返回 undefined（访问层不是单点）', () => {
    const ctx = {
      get: (n: string) => {
        throw new Error(`boom ${n}`)
      },
    }
    expect(() => hostService(ctx, 'sessions')).not.toThrow()
    expect(hostService(ctx, 'sessions')).toBeUndefined()
  })

  it('hostInjected：直接属性优先，缺失回落 ctx.get', () => {
    const direct = { list: () => [] }
    const viaGet = { list: () => [] }
    expect(hostInjected({ agents: direct, get: () => viaGet }, 'agents')).toBe(direct)
    expect(hostInjected({ get: (n: string) => (n === 'agents' ? viaGet : undefined) }, 'agents')).toBe(viaGet)
    expect(hostInjected({}, 'agents')).toBeUndefined()
  })

  it('hostInjected：属性存在但为 undefined → 回落 ctx.get（宿主惰性装配形态）', () => {
    const viaGet = { list: () => [] }
    const ctx = { agents: undefined, get: (n: string) => (n === 'agents' ? viaGet : undefined) }
    expect(hostInjected(ctx, 'agents')).toBe(viaGet)
  })

  /**
   * v1.31.4 回归（S142）：cordis 的 Context 是 Proxy，对**未经 inject 声明**的服务名
   * 直接属性读会**抛错**（`cannot get property "<name>" without inject`），不是返回
   * undefined。此处用"属性读抛错"的替身钉死该契约——否则本模块的回落分支永不执行，
   * 异常直接逃逸（v1.31.3 handyman foreground 真机报错即此）。
   * 权威用例（真实 cordis 兄弟拓扑）见 tests/host/cordis-access.test.ts。
   */
  it('hostInjected：属性读抛错（cordis 未声明 inject 形态）→ 吞掉并回落 ctx.get', () => {
    const viaGet = { start: () => undefined }
    const cordisLike = new Proxy({ get: (n: string) => (n === 'subagents' ? viaGet : undefined) } as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === 'subagents') throw new Error('cannot get property "subagents" without inject')
        return Reflect.get(target, prop, receiver)
      },
    })
    expect(() => hostInjected(cordisLike, 'subagents')).not.toThrow()
    expect(hostInjected(cordisLike, 'subagents')).toBe(viaGet)
    expect(hostSubagents(cordisLike)).toBe(viaGet)
  })

  it('hostInjected：属性读抛错且 ctx.get 也不可用 → undefined（不抛）', () => {
    const cordisLike = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === 'get') return undefined
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
    expect(hostInjected(cordisLike, 'subagents')).toBeUndefined()
    expect(hostSubagents(cordisLike)).toBeUndefined()
  })
})

describe('host/access: 类型化读取器', () => {
  it('五个读取器命中/未命中形状正确', () => {
    const sessions = { list: () => [] }
    const agents = { get: () => undefined }
    const webServer = { port: 3080 }
    const settings = { installSection: () => undefined }
    const ctx = { sessions, agents, webServer, settings, get: () => undefined }
    expect(hostSessions(ctx)).toBe(sessions)
    expect(hostAgents(ctx)).toBe(agents)
    expect(hostWebServer(ctx)).toBe(webServer)
    expect(hostSettings(ctx)).toBe(settings)
    expect(hostSessions({})).toBeUndefined()
    expect(hostAgents({})).toBeUndefined()
    expect(hostWebServer({})).toBeUndefined()
    expect(hostSettings({})).toBeUndefined()
  })

  it('hostSessionCwds：取 header.cwd；非数组/元素缺 header → 过滤为空数组', () => {
    const ctx = {
      sessions: {
        list: () => [
          { id: 'a', header: { cwd: '/ccc/a' } },
          { id: 'b' },
          { id: 'c', header: { cwd: 42 } },
          { id: 'd', header: { cwd: '/ccc/d' } },
        ],
      },
    }
    expect(hostSessionCwds(ctx)).toEqual(['/ccc/a', '/ccc/d'])
  })

  it('hostSessionCwds：list 缺失/非数组/抛错 → 空数组（不抛）', () => {
    expect(hostSessionCwds({})).toEqual([])
    expect(hostSessionCwds({ sessions: { list: () => undefined } })).toEqual([])
    expect(hostSessionCwds({ sessions: { list: () => 'nope' } })).toEqual([])
    expect(() => hostSessionCwds({ sessions: { list: () => { throw new Error('boom') } } })).not.toThrow()
    expect(hostSessionCwds({ sessions: { list: () => { throw new Error('boom') } } })).toEqual([])
  })
})
