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
import { REGISTERED_TOOLS } from '../../src/kernel/invariant.js'

/** ACC 自己注册的工具名（替身用它模拟"宿主的 unknown-name 整次失败"） */
const REGISTERED_TOOLS_SET = new Set<string>(REGISTERED_TOOLS)

/**
 * 宿主的 **agent-plane 贡献**（不是 ACC 注册的，但真宿主认识）。
 * 名单**逐字来自 v1.87.0 真机日志**——那 12 个被 `tools.get` 误判成"未注册"的名字。
 */
const HOST_AGENT_PLANE_TOOLS = [
  'bash', 'exit_plan_mode', 'interrupt_agent', 'job_kill', 'job_list', 'job_output',
  'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'subagent_fork', 'workflow',
]

/**
 * 替身 agent：记录 restrict 调用、dispose 触发。
 *
 * 🔴 **`get` 一律返回 `undefined`**（2026-10-22 v1.87.1 改钉）：真宿主的 `get(name)` 省略 scope
 * 查的是**全局视图**，而 `bash` / `schedule_*` 是 **agent-plane 贡献**，从那里**恒为 undefined**
 * （v1.87.0 真机实证：12 个在册工具被判成"未注册"）。⇒ 替身按**最不利的真形态**模拟。
 * ⚠️ 这条同时是**反向钉**：谁若重新引入"发射前用 `tools.get` 预探活"，本文件多条用例当场变红。
 *
 * 🔴 **`hostKnown` 必须显式给**（`rejectUnknown` 时）：**替身不知道宿主知道什么** ——
 * 上上版用 `REGISTERED_TOOLS` 当作"宿主认识的全集"，于是连 `bash` 都被它判成未知，
 * 而这恰恰是**被测缺陷本身**换个地方复现（用本地表冒充宿主的在册面）。默认值 = ACC 注册名
 * ＋ {@link HOST_AGENT_PLANE_TOOLS}，即"真宿主认识的那个全集"。
 */
function mkAgent(opts: { rejectUnknown?: boolean; throwOnRestrict?: boolean; hostLacks?: string[] } = {}) {
  const calls: { deny: string[] }[] = []
  let disposed = 0
  // 默认真宿主形态 = ACC 注册名 ∪ agent-plane 贡献；`hostLacks` 用来模拟**真的没装某个包**的宿主
  const hostKnown = new Set<string>(
    [...REGISTERED_TOOLS_SET, ...HOST_AGENT_PLANE_TOOLS].filter((n) => !(opts.hostLacks ?? []).includes(n)),
  )
  const agent = {
    ctx: {
      tools: {
        restrict: (f: { deny: string[] }) => {
          if (opts.throwOnRestrict) throw new Error('restrict unavailable')
          // 真故障形态注入：宿主对 unknown name 是**整次失败**（不是"剔掉那一个"）
          if (opts.rejectUnknown === true) {
            const unknown = f.deny.filter((n) => !hostKnown.has(n))
            if (unknown.length > 0) throw new Error(`unknown tool: ${unknown.join(', ')}`)
          }
          calls.push({ deny: [...f.deny] })
          return () => { disposed++ }
        },
        get: (_n: string) => undefined,
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

  it('🔴 全量被拒 ⇒ 退到「只发 ACC 已注册的」一档，其余仍生效 ＋ 放弃的名字如实记账', () => {
    // 🔴 D184 判据变更记录：本用例原钉"发射前用 tools.get 预探活、把 ghost 剔掉"。
    //     那个前提**真的变了**（v1.87.0 真机实测：`tools.get` 省略 scope = 全局视图，
    //     查不出 agent-plane 贡献的 bash/schedule_*，把 12 个**在册**工具判成未注册 ⇒
    //     safe mode 的 bash 隐藏直接失效）。改钉**没有预探活**的现行契约：
    //     直接发全量 → 宿主整次拒绝 → 退到 ACC-only 档并记账。
    const { agent, calls } = mkAgent({ rejectUnknown: true })
    const r = applyVisibilityDecision(
      agent,
      's-ghost',
      collectVisibilityDecision([src('a', ['container_fs', 'ghost'])]),
    )
    expect(r.status).toBe('applied')
    expect(calls).toHaveLength(1) // 只发了退档那一次（全量那次被拒、没进 calls）
    expect(calls[0]!.deny).toEqual(['container_fs']) // ghost 被放弃
    expect(r.dropped).toEqual(['ghost']) // 且如实上报（不静默）
  })

  it('🔴 名字在册与否**不由本地判断**：非 ACC 注册的名字照样发出去（agent-plane 工具也是）', () => {
    // 🔴 这条是 v1.87.0 真机事故的**反向钉**。事故形态：`tools.get` 预探活把 bash / schedule_*
    // 等 12 个**在册**工具判成"未注册"并剔掉 ⇒ safe mode 的 bash 隐藏直接失效。
    // 现契约：deny 里给什么就发什么，**本地不查表**（`bash` 不在 REGISTERED_TOOLS 里，但真宿主认识）。
    const { agent, calls } = mkAgent({ rejectUnknown: true })
    const r = applyVisibilityDecision(
      agent,
      's-allknown',
      collectVisibilityDecision([src('a', ['container_fs', 'bash'])]),
    )
    expect(r.status).toBe('applied')
    expect(calls[0]!.deny).toEqual(['bash', 'container_fs']) // ⚠️ bash 必须**原样出现**
    expect(r.dropped).toEqual([]) // 没退档
  })

  it('🔴 退档的代价：非 ACC 注册的名字被**整体放弃**（已知缺口，不是修复）', () => {
    // v1.87.1 复盘的第二个发现，如实钉住 —— 别让它悄悄"看起来好了"。
    // 宿主没装 `dsh-tool-schedule` 时 deny 里含 4 个 schedule_* ⇒ 整次被拒 ⇒ 退到 ACC-only
    // ⇒ **schedule_* 那一格的屏蔽不生效**（旧实现同样不生效，未回归）。
    // 🔧 修法候选（未做，需 owner 点头）：二分/逐类重试，或向宿主问 scope。
    const { agent, calls } = mkAgent({
      rejectUnknown: true,
      hostLacks: ['schedule_create', 'schedule_list'], // 真·没装该包的宿主（另一种形态）
    })
    const r = applyVisibilityDecision(
      agent,
      's-degrade-cost',
      collectVisibilityDecision([src('hostSchedule', ['schedule_create', 'schedule_list']), src('a', ['container_fs'])]),
    )
    expect(r.status).toBe('applied')
    expect(calls[0]!.deny).toEqual(['container_fs']) // schedule_* 被放弃
    expect(r.dropped).toEqual(['schedule_create', 'schedule_list']) // 但如实记账（不静默）
  })

  it('🔴 全量被拒且 ACC-only 为空 ⇒ status=failed 且**不记账**（下轮重试）', () => {
    // 🔴 D184 判据变更记录：原用例名「全被剔光 ⇒ 不发射」，前提是"有预探活 ⇒ ghost 全被剔 ⇒ 空集合"。
    //     预探活已删 ⇒ ghost 会被**真的发出去**，那个前提不复存在。改钉现行契约的失败路径。
    const { agent, calls } = mkAgent({ rejectUnknown: true })
    const d = collectVisibilityDecision([src('a', ['ghost1', 'ghost2'])])
    const r = applyVisibilityDecision(agent, 's-allghost', d)
    expect(r.status).toBe('failed')
    expect(r.error).toContain('unknown tool')
    expect(calls).toHaveLength(0)
    // 不记账的证据：同判决再来仍是 failed（走"尝试"分支，不是 unchanged）
    expect(applyVisibilityDecision(agent, 's-allghost', d).status).toBe('failed')
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

  it('🔴 无 `tools.get`（旧宿主形态）⇒ 行为完全一致（`get` 已不参与任何判断）', () => {
    // 这条钉的是"删掉 get 之后没有留下分支残留"：有 get / 无 get 必须**逐字同行为**。
    const calls: { deny: string[] }[] = []
    const agent = { ctx: { tools: { restrict: (f: { deny: string[] }) => { calls.push({ deny: [...f.deny] }); return () => {} } } } } as never
    const r = applyVisibilityDecision(agent, 's-noget', collectVisibilityDecision([src('a', ['container_fs'])]))

    // 正控：有 `get`（且恒 undefined —— 真宿主全局视图的形态）的替身必须给出同一结果
    const withGet = mkAgent()
    const r2 = applyVisibilityDecision(withGet.agent, 's-withget', collectVisibilityDecision([src('a', ['container_fs'])]))

    expect(r.status).toBe('applied')
    expect(calls[0]!.deny).toEqual(['container_fs'])
    expect(r.status).toBe(r2.status)
    expect(calls[0]!.deny).toEqual(withGet.calls[0]!.deny)
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
