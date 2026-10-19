/**
 * lifecycle.test.ts — 宿主生命周期订阅与资源拆卸（S142 review F-08）
 *
 * 契约：
 *  - `sessionIdOf` 对 Agent / Session / 事件负载三类形状都取得到 id（未知形状 → null）
 *  - `cleanupSessionState` 清 skiff 注册表与活跃 SESSION 作用域，且幂等
 *
 * 🔴 2026-10-19 skiff 重做对本文件的唯一影响：`registerSkiffSession` 的**第 2 参是轨迹目录名**
 * （不再是角色名），`skiffSessionInfo` 回 `{ trajectoryDirName, ccc }`（不再是 `{ role, ccc }`）。
 * 本文件只验"注册 ⇄ 清理"这条生命周期，**不**依赖 skiff 判据（判据在 `trajectory/policy/profile.ts`，
 * 其测试见 `tests/skiff-core.test.ts`）⇒ 这里用目录名常量即可，无需造真实轨迹目录。
 *  - `registerLifecycle` 订阅 `agent/disposed` + `session/disposed`，并在销毁时执行清理；
 *    事件通道缺失 / ctx.effect 缺失都不抛错（apply 不可成为启动单点）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// lifecycle.ts 经 skiff-core 间接引入宿主 peerDep（@deepseek-ai/dsh-llm 等不在插件
// node_modules，仅由宿主提供）——与 skiff-core.test.ts / gateway.test.ts 同款 mock，
// 保证 vitest 可解析（依赖链：lifecycle → skiff-core → cognitive-trajectory-ops → settings-section → schemastery）
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
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

import { sessionIdOf, cleanupSessionState, registerLifecycle } from '../../src/seams/lifecycle.js'
import { registerSkiffSession, skiffSessionInfo } from '../../src/trajectory/session.js'
import { setActiveSessionInfo, getActiveSessionInfo } from '../../src/trajectory/core.js'

const fakeAgent = { id: 'a1' } as never

/** skiff 绑定指向的**轨迹目录名**（🔴 2026-10-19：不再是角色名，见文件头契约注） */
const TRAJ_DIR = '2026-10-19--qa--traj'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('seams/lifecycle: sessionIdOf', () => {
  it('Agent 形状（agent.session.id）', () => {
    expect(sessionIdOf({ session: { id: 's1' } })).toBe('s1')
  })

  it('Session 形状（.id）与 header 形状（.header.id）', () => {
    expect(sessionIdOf({ id: 's2' })).toBe('s2')
    expect(sessionIdOf({ header: { id: 's3' } })).toBe('s3')
  })

  it('未知/空/非字符串 → null', () => {
    expect(sessionIdOf(undefined)).toBeNull()
    expect(sessionIdOf(null)).toBeNull()
    expect(sessionIdOf({})).toBeNull()
    expect(sessionIdOf({ id: '' })).toBeNull()
    expect(sessionIdOf({ id: 42 })).toBeNull()
  })
})

describe('seams/lifecycle: cleanupSessionState', () => {
  it('清 skiff 注册表 + 活跃 SESSION 作用域（幂等）', () => {
    registerSkiffSession('skiff-lifecycle-1', TRAJ_DIR, '/ccc', fakeAgent)
    setActiveSessionInfo('skiff-lifecycle-1', {
      sessionId: 'S999',
      dirName: 'x',
      mdPath: '/ccc/AGENT_SESSIONS/x/SESSION.md',
    })
    expect(skiffSessionInfo('skiff-lifecycle-1')).toEqual({ trajectoryDirName: TRAJ_DIR, ccc: '/ccc' })
    expect(getActiveSessionInfo('skiff-lifecycle-1')).not.toBeNull()

    cleanupSessionState('skiff-lifecycle-1')
    expect(skiffSessionInfo('skiff-lifecycle-1')).toBeNull()
    expect(getActiveSessionInfo('skiff-lifecycle-1')).toBeNull()

    expect(() => cleanupSessionState('skiff-lifecycle-1')).not.toThrow() // 幂等
  })
})

describe('seams/lifecycle: registerLifecycle', () => {
  function fakeCtx() {
    const handlers = new Map<string, (payload: unknown) => void>()
    const effects: Array<() => void> = []
    const ctx = {
      on: vi.fn((name: string, cb: (payload: unknown) => void) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      }),
      effect: vi.fn((cb: () => () => void) => {
        effects.push(cb())
      }),
      emit(name: string, payload: unknown) {
        handlers.get(name)?.(payload)
      },
      disposeAll() {
        for (const d of effects) d()
      },
    }
    return ctx
  }

  it('订阅 disposed 事件 → 销毁时清 per-会话状态；装配资源拆卸 effect', () => {
    const ctx = fakeCtx()
    registerLifecycle(ctx as never)
    const names = ctx.on.mock.calls.map((c) => c[0] as string)
    expect(names).toContain('agent/disposed')
    expect(names).toContain('session/disposed')
    expect(ctx.effect).toHaveBeenCalledTimes(1)

    registerSkiffSession('skiff-lifecycle-2', TRAJ_DIR, '/ccc', fakeAgent)
    ctx.emit('agent/disposed', { agent: { session: { id: 'skiff-lifecycle-2' } } })
    expect(skiffSessionInfo('skiff-lifecycle-2')).toBeNull()

    registerSkiffSession('skiff-lifecycle-3', TRAJ_DIR, '/ccc', fakeAgent)
    ctx.emit('session/disposed', { id: 'skiff-lifecycle-3' })
    expect(skiffSessionInfo('skiff-lifecycle-3')).toBeNull()
  })

  it('无 id 的销毁负载 → 不清理、不抛错', () => {
    const ctx = fakeCtx()
    registerLifecycle(ctx as never)
    expect(() => ctx.emit('agent/disposed', {})).not.toThrow()
    expect(() => ctx.emit('session/disposed', undefined)).not.toThrow()
  })

  it('事件通道缺失（ctx.on 抛错）→ 不阻断装配；ctx.effect 缺失 → 响亮降级', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = {
      on: () => {
        throw new Error('no event channel')
      },
    }
    expect(() => registerLifecycle(ctx as never)).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('资源拆卸未装配'))).toBe(true)
  })

  it('卸载时停掉自起资源（skiff 调试页/微信桥停止函数被调用且不抛错）', () => {
    const ctx = fakeCtx()
    registerLifecycle(ctx as never)
    expect(() => ctx.disposeAll()).not.toThrow()
  })
})
