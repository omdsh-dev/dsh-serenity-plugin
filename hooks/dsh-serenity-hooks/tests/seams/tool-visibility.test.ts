/**
 * tests/seams/tool-visibility.test.ts — 工具可见性**单点收敛**（方案 C）的判据
 *
 * ## 为什么这些判据必须存在（不是"为了过 coverage-gate"）
 *
 * 这次改动把**六条独立 restrict** 合并成**一次**。风险不在"能不能合并"
 * （宿主契约「Restrictions intersect」保证等价），而在三件具体的事：
 *
 * ① 🔴 **合并会不会放大失败面**：某一个来源读配置抛错，会不会把另外五源一起废掉？
 *    —— 旧行为是"那一格静默不生效"，新行为**必须不低于它**。
 * ② 🔴 **未注册的名字会不会炸掉整次发射**：宿主对 unknown names「整次失败」。
 *    合并后集合里只要有一个不在册的名字，**六个机制全部不生效** —— 这比改动前更糟。
 * ③ 🔴 **幂等**：算出来一模一样还去 restrict，就会重新打开"工具清单闪动"那个洞
 *    （那正是这次要修的缺陷本身）。
 *
 * 三条各有一组承重断言；每条都做过变异检验（见各用例下的「变异」注）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  TOOL_VISIBILITY_DENY_ONLY,
  applyVisibilityDecision,
  collectVisibilityDecision,
  decisionSignature,
  forgetToolVisibility,
  getToolVisibilityDiagnostics,
  type VisibilitySource,
} from '../../src/seams/tool-visibility.js'

/** 替身 agent：记录 restrict 调用、dispose 触发；`present` 控制 `tools.get` 的探活结果 */
function mkAgent(opts: { present?: (n: string) => boolean; throwOnRestrict?: boolean } = {}) {
  const calls: { deny: string[] }[] = []
  let disposed = 0
  const agent = {
    ctx: {
      tools: {
        restrict: (f: { deny: string[] }) => {
          if (opts.throwOnRestrict) throw new Error('restrict unavailable')
          calls.push({ deny: [...f.deny] })
          return () => { disposed++ }
        },
        get: (n: string) => (opts.present ? (opts.present(n) ? {} : undefined) : {}),
      },
    },
  }
  return { agent: agent as never, calls, disposedCount: () => disposed }
}

function src(id: string, deny: string[], ok = true, error?: string): VisibilitySource {
  return { id, deny, ok, ...(error !== undefined ? { error } : {}) }
}

beforeEach(() => {
  // 每个用例用独立 sessionId（避免跨用例串味 —— 模块级 Map 的经典污染，D201 同族）
})

describe('collectVisibilityDecision：纯函数，只合并 deny（并集）', () => {
  it('多源 deny 求并集、去重、排序（排序让签名稳定 ⇒ 幂等判据才成立）', () => {
    const d = collectVisibilityDecision([src('a', ['b', 'a']), src('b', ['c', 'a'])])
    expect(d.deny).toEqual(['a', 'b', 'c'])
    expect(d.hasError).toBe(false)
  })

  it('🔴 判据不成立的来源不贡献 deny（`ok=false` 不是错误，是"它没意见"）', () => {
    const d = collectVisibilityDecision([src('a', ['x'], false), src('b', ['y'])])
    expect(d.deny).toEqual(['y'])
    // 没有 error 字段 ⇒ 不算出错
    expect(d.hasError).toBe(false)
  })

  it('🔴 单源出错不影响其余源（合并**不得**放大失败面）—— 变异：改成出错即清空全部 ⇒ 本格红', () => {
    const d = collectVisibilityDecision([
      src('boom', [], false, 'bad config'),
      src('ok1', ['x']),
      src('ok2', ['y']),
    ])
    expect(d.deny).toEqual(['x', 'y']) // 其余照常生效
    expect(d.hasError).toBe(true) // 但**如实记账**（调用方据此告警）
  })

  it('空串与非字符串被丢弃（deny 里混进 "" 会让整次 restrict 失败）', () => {
    const d = collectVisibilityDecision([src('a', ['', 'x', 42 as unknown as string])])
    expect(d.deny).toEqual(['x'])
  })

  it('签名 = 排序后 join（同一集合的不同顺序 ⇒ 同签名 ⇒ 判为未变化）', () => {
    const a = collectVisibilityDecision([src('a', ['x', 'y'])])
    const b = collectVisibilityDecision([src('a', ['y', 'x'])])
    expect(decisionSignature(a)).toBe(decisionSignature(b))
  })

  it('准入契约：本模块只允许 deny（allow 的"交集"不满足并集律）', () => {
    expect(TOOL_VISIBILITY_DENY_ONLY).toBe(true)
  })
})

describe('applyVisibilityDecision：唯一发射点', () => {
  it('🔴 幂等：判决不变 ⇒ **一次 restrict 都不发**（这正是"清单闪动"的修法）', () => {
    const { agent, calls } = mkAgent()
    const d = collectVisibilityDecision([src('a', ['x'])])
    expect(applyVisibilityDecision(agent, 's-idem', d).status).toBe('applied')
    expect(calls).toHaveLength(1)
    // 同一判决再来两次
    expect(applyVisibilityDecision(agent, 's-idem', d).status).toBe('unchanged')
    expect(applyVisibilityDecision(agent, 's-idem', d).status).toBe('unchanged')
    expect(calls).toHaveLength(1) // ⚠️ 变异：去掉签名判断 ⇒ 这里变 3
  })

  it('判决变了 ⇒ 先撤旧的再发新的（不是叠加）', () => {
    const { agent, calls, disposedCount } = mkAgent()
    applyVisibilityDecision(agent, 's-change', collectVisibilityDecision([src('a', ['x'])]))
    const r = applyVisibilityDecision(agent, 's-change', collectVisibilityDecision([src('a', ['y'])]))
    expect(r.status).toBe('applied')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.deny).toEqual(['y'])
    expect(disposedCount()).toBe(1) // 旧的那条被撤销过
  })

  it('🔴 未注册的名字被剔掉，其余照常发射（宿主 unknown names ⇒ 整次失败）', () => {
    const { agent, calls } = mkAgent({ present: (n) => n !== 'ghost' })
    const r = applyVisibilityDecision(agent, 's-ghost', collectVisibilityDecision([src('a', ['x', 'ghost'])]))
    expect(r.status).toBe('applied')
    expect(calls[0]!.deny).toEqual(['x']) // ghost 被剔
    expect(r.dropped).toEqual(['ghost']) // 且如实上报（不静默）
  })

  it('🔴 全被剔光 ⇒ 不发射（但记成"空目标态"，下次同判决仍是 unchanged）', () => {
    const { agent, calls } = mkAgent({ present: () => false })
    const d = collectVisibilityDecision([src('a', ['ghost1', 'ghost2'])])
    expect(applyVisibilityDecision(agent, 's-allghost', d).status).toBe('applied')
    expect(calls).toHaveLength(0)
    expect(applyVisibilityDecision(agent, 's-allghost', d).status).toBe('unchanged')
  })

  it('restrict 抛错 ⇒ 返回 failed 且**不记账**（下一轮会重试，不留错误目标态）', () => {
    const { agent } = mkAgent({ throwOnRestrict: true })
    const d = collectVisibilityDecision([src('a', ['x'])])
    const r = applyVisibilityDecision(agent, 's-boom', d)
    expect(r.status).toBe('failed')
    expect(r.error).toContain('restrict unavailable')
    // 不记账的证据：再发一次仍然走"尝试"分支（不是 unchanged）
    expect(applyVisibilityDecision(agent, 's-boom', d).status).toBe('failed')
  })

  it('无 tools.get（旧宿主）⇒ 不探活，原样发射（向前兼容）', () => {
    const calls: { deny: string[] }[] = []
    const agent = { ctx: { tools: { restrict: (f: { deny: string[] }) => { calls.push({ deny: [...f.deny] }); return () => {} } } } } as never
    const r = applyVisibilityDecision(agent, 's-noget', collectVisibilityDecision([src('a', ['x'])]))
    expect(r.status).toBe('applied')
    expect(calls[0]!.deny).toEqual(['x'])
  })

  it('不同会话互不影响（per-会话状态，一个的隐藏不会波及另一个）', () => {
    const a = mkAgent()
    const b = mkAgent()
    applyVisibilityDecision(a.agent, 's-a', collectVisibilityDecision([src('x', ['t'])]))
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(0)
    expect(getToolVisibilityDiagnostics().keys).toContain('s-a')
    expect(getToolVisibilityDiagnostics().keys).not.toContain('s-b')
  })
})

describe('forgetToolVisibility：会话销毁清理', () => {
  it('撤销那条 restrict 并清状态；重复调用幂等（不重复 dispose —— 那会抛）', () => {
    const { agent, disposedCount } = mkAgent()
    applyVisibilityDecision(agent, 's-gone', collectVisibilityDecision([src('a', ['x'])]))
    expect(getToolVisibilityDiagnostics().keys).toContain('s-gone')
    forgetToolVisibility('s-gone')
    expect(disposedCount()).toBe(1)
    expect(getToolVisibilityDiagnostics().keys).not.toContain('s-gone')
    forgetToolVisibility('s-gone') // 幂等
    expect(disposedCount()).toBe(1)
  })

  it('disposer 自己抛错也不影响清理（会话已销毁时常见）', () => {
    const agent = {
      ctx: { tools: { restrict: () => () => { throw new Error('disposed already') }, get: () => ({}) } },
    } as never
    applyVisibilityDecision(agent, 's-throwdisp', collectVisibilityDecision([src('a', ['x'])]))
    expect(() => forgetToolVisibility('s-throwdisp')).not.toThrow()
    expect(getToolVisibilityDiagnostics().keys).not.toContain('s-throwdisp')
  })
})

describe('诊断面：能回答"某工具为什么不可见"', () => {
  it('denyByKey 给出该会话实际生效的 deny 清单', () => {
    const { agent } = mkAgent()
    applyVisibilityDecision(agent, 's-diag', collectVisibilityDecision([src('a', ['alpha', 'beta'])]))
    expect(getToolVisibilityDiagnostics().denyByKey['s-diag']).toEqual(['alpha', 'beta'])
  })
})
