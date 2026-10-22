import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 轨迹约束 工具面 —— **热加载**（owner 2026-10-19 令「工具清单也要热加载」）回归钉
 *
 * ## 它钉的是什么
 *
 * 在 v1.69.3 之前，轨迹约束的工具白名单**只由运行时守卫拦截**：
 * 工具**全部出现在模型 schema 里**，调用时才被 `tool not allowed in this 轨迹约束 role` 打回。
 * ⇒ 配置改白名单，**schema 上永远不生效** —— 模型看得见它不该有的工具。
 *
 * 本件用**真 restrict 契约**（替身 agent 记录收到的 `deny` 与 dispose 调用）钉四条：
 *  ① 白名单之外的工具**真的被 deny**（从 schema 移除，而不是只靠调用时拦截）；
 *  ② **改配置 ⇒ deny 清单当场跟着变**（这就是「热加载」，不需要重启/重建会话）；
 *  ③ 幂等：配置没变时不重复发 restrict（restrict 会重建 schema，没必要每步做）；
 *  ④ **撤销方向**：`trajectory-constraint.json` 被删 ⇒ 这条轨迹当场不再是 轨迹约束 ⇒ 既有的隐藏必须**撤销**。
 *
 * ⚠️ 替身只证明"我们调了 restrict 且 deny 内容正确"，**证明不了宿主真的把它从 schema 摘掉**。
 *    后者需要真宿主（`bench/` 那一层）。本件的价值在于①的**内容正确性**与②③④的**热加载语义**。
 *
 * ## 🔴 2026-10-19 重做后的前提换法（R↓，别照旧件改回来）
 *
 * 旧件造 CCC 的办法是 `writeConfig({ 轨迹约束: { roles: { 'demo-role': {…} } } })`，
 * **那段配置已退役**（读它得到空 ⇒ 白名单恒空 ⇒ 一次 restrict 都不发）。
 * 新模型里 轨迹约束是一条**带 `trajectory-constraint.json` 的认知轨迹**，判据走
 * `trajectoryConstraintForSession`：**① 会话已 `registerTrajectorySession(sessionId, dirName, ccc)` 登记
 * ② `<root>/AGENT_SESSIONS/<dirName>/trajectory-constraint.json` 真在盘上** ⇒ 两个前提缺一不可。
 * ⇒ 本件用 `tests/helpers/trajectory-constraint-fixture.ts` 造这两样（不重复描述载体）。
 *
 * 旧件的「角色被移除 ⇒ 不动（fail-open）」一条**前提已死**：旧语义是"角色没了还发 restrict
 * 会把工具面删光"，而新语义恰恰相反 —— **删掉 `trajectory-constraint.json` 就是撤销隐藏**（guards 的注释
 * 明写「⛔ 不能只是 return —— 那会把上一步的隐藏永久留在一个已不再是 轨迹约束的会话上」）。
 * ⇒ 它被下面的④取代，且④钉的是**更强的反面**：不只是"不多发 restrict"，而是"**旧 restrict 被 dispose**"。
 */

/** 白名单初始值（`read`/`grep` 是平台常驻工具，白名单外要抽两个 ACC 工具当对照） */
const ALLOWED = ['read', 'grep']

/**
 * 🔴 2026-10-22 方案 C（owner 裁）：\`syncTrajectoryConstraintToolVisibility\` 已并入
 * \`syncToolVisibility\`（六源汇一、只发一次 restrict）。
 *
 * ⚠️ 本文件钉的是**发射时序**（幂等 / 撤销 / 热加载），那是真实行为，必须继续钉；
 * 只是入口从"单源 sync"换成"合并后唯一发射点"。合并后的一个直接后果：
 * \`deny\` 里**还会含有其它源**（safeMode / im-bridge / schedule_*），
 * 所以断言从 \`toEqual\` 改成"包含/不包含"，并**显式说明为什么**（否则下一个人以为判据放松了）。
 */
import { syncToolVisibility, forgetTrajectoryConstraintToolVisibility, computeVisibilitySources } from '../src/seams/guards.js'
import { forgetToolVisibility, getToolVisibilityDiagnostics } from '../src/seams/tool-visibility.js'
import { registerTrajectorySession, resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import { TRAJECTORY_CONSTRAINT_FILENAME } from '../src/trajectory/policy/profile.js'
import { makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

const SESSION = '轨迹约束-demo-role-1234'
const CODE = 'demo-role'

/**
 * 替身 agent：记录每次 restrict 的 deny 清单与 dispose 调用。
 *
 * 🔴 2026-10-22（方案 C）：**必须提供 `get`**。合并发射前会逐个探活
 * （宿主契约：unknown names ⇒ 整次 restrict 失败），没 `get` 的实现会走"不探活"的兼容分支；
 * 而**真宿主有 `get`** ⇒ 替身不补就等于用一个不存在的宿主形态来验（D144 同族）。
 */
function fakeAgent(sessionId: string) {
  const calls: string[][] = []
  let disposed = 0
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
        /** 探活：真宿主会返回未注册名 ⇒ undefined；这里按"全部在册"模拟 */
        get: (_n: string) => ({}),
        restrict: (opts: { deny: string[] }) => {
          calls.push([...opts.deny])
          return () => {
            disposed += 1
          }
        },
      },
    },
  }
  return { agent: agent as never, calls, get disposed() { return disposed } }
}

describe('轨迹约束 工具面：白名单之外从 schema 移除 ＋ 改配置当场生效 ＋ 撤销', () => {
  let root: string
  /** 该 轨迹约束轨迹的 `trajectory-constraint.json` 绝对路径（热加载就是改这一个文件） */
  let profilePath: string

  /** 重写该轨迹的 `trajectory-constraint.json`（= 生产里"改了约束面"的唯一动作） */
  function writeTools(tools: string[]): void {
    writeFileSync(profilePath, JSON.stringify(轨迹约束Json({ tools, msms: [] })), 'utf-8')
  }

  beforeEach(() => {
    resetTrajectorySessions()
    root = mkdtempSync(join(tmpdir(), 'trajectory-constraint-hot-'))
    writeFileSync(join(root, '.serenity'), 'test')
    // 前提①②：一条带 trajectory-constraint.json 的轨迹 ＋ 会话到它的登记
    const traj = makeTrajectory(root, CODE, 轨迹约束Json({ tools: ALLOWED, msms: [] }))
    profilePath = join(traj.dir, TRAJECTORY_CONSTRAINT_FILENAME)
    registerTrajectorySession(SESSION, traj.dirName, root)
  })

  afterEach(() => {
    // 🔴 2026-10-22 方案 C：**必须清新模块的发射状态**。
    //    `applied` 是模块级 Map（按会话 id），而本文件所有用例共用同一个 SESSION ⇒
    //    不清的话，第二个用例起都会被判成 `unchanged`（一次 restrict 都不发），
    //    表现为"工具面根本没同步"—— 那是**测试串味**，不是实现坏（D201 同族）。
    forgetToolVisibility(SESSION)
    forgetTrajectoryConstraintToolVisibility(SESSION)
    resetTrajectorySessions()
    rmSync(root, { recursive: true, force: true })
  })

  it('🔴 白名单之外的工具真被 deny（不是只靠调用时拦截）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncToolVisibility(agent, root)
    expect(calls.length, '一次 restrict 都没发 —— 工具面根本没同步').toBe(1)
    const deny = calls[0]!
    // 白名单内的不得出现在 deny 里
    expect(deny).not.toContain('read')
    expect(deny).not.toContain('grep')
    // 白名单外的必须出现（抽两个恒在册的常驻工具）
    expect(deny).toContain('container_fs')
    expect(deny).toContain('cognitive_trajectory')
  })

  it('🔴 改配置 ⇒ deny 清单当场跟着变（热加载的核心判据，不重启不重建）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncToolVisibility(agent, root)
    expect(calls[0]).toContain('container_fs') // 初始：未授权 ⇒ 被 deny

    // 只改磁盘上的 `trajectory-constraint.json`，**不重启、不重建会话、不重新注册**
    writeTools([...ALLOWED, 'container_fs'])
    syncToolVisibility(agent, root) // 下一次 pre-step

    expect(calls.length, '配置变了却没有重新发 restrict —— 这就是"不热加载"').toBe(2)
    expect(calls[1], '新授权的工具仍被 deny').not.toContain('container_fs')
    // 且本来就没授权的仍在 deny 里（不是"全清空"）
    expect(calls[1]).toContain('cognitive_trajectory')
  })

  it('幂等：配置没变 ⇒ 不重复发 restrict（deny 相同就跳过）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncToolVisibility(agent, root)
    syncToolVisibility(agent, root)
    syncToolVisibility(agent, root)
    expect(calls.length, '每步都重发 restrict —— 会把 schema 反复重建').toBe(1)
  })

  it('撤销授权 ⇒ 重新 deny（两个方向都钉，防只做"放开"不做"收回"）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncToolVisibility(agent, root) // 初始不含 container_fs
    // 先放开
    writeTools([...ALLOWED, 'container_fs'])
    syncToolVisibility(agent, root)
    expect(calls.at(-1)).not.toContain('container_fs')
    // 再收回
    writeTools(ALLOWED)
    syncToolVisibility(agent, root)
    expect(calls.at(-1), '收回授权后仍可见 —— 只做放开不做收回').toContain('container_fs')
  })

  it('🔴 删掉 `trajectory-constraint.json` ⇒ 这条轨迹不再是 轨迹约束 ⇒ **既有约束被撤销**', () => {
    const probe = fakeAgent(SESSION)
    const { agent, calls } = probe
    syncToolVisibility(agent, root)
    expect(calls.length, '前置：先真发过一次 restrict').toBe(1)
    // 🔴 方案 C：诊断真相源已迁到统一表（`getToolVisibilityDiagnostics`）。
    //    这里判"该会话当前确实被收窄了"，而不是去问旧 Map 的键。
    expect(getToolVisibilityDiagnostics().denyByKey[SESSION] ?? []).toContain('container_fs')

    // 🔴 owner 语义：目录下有没有 `trajectory-constraint.json` **就是**全部判据 ⇒ 删文件 = 撤销约束
    unlinkSync(profilePath)
    syncToolVisibility(agent, root)

    // ① 旧 restrict 必须被 dispose（⛔ 只是 `return` 会把隐藏永久留在这个会话上）
    expect(probe.disposed, '删掉 trajectory-constraint.json 后旧 restrict 未被撤销 —— 工具面永久收窄在一条普通轨迹上').toBe(1)
    // ② 收窄面里不得再有轨迹约束带来的那部分（`container_fs` 不再被 deny）
    expect((getToolVisibilityDiagnostics().denyByKey[SESSION] ?? []).includes('container_fs')).toBe(false)
    // ③ 后续再同步仍幂等（已回到新目标态 ⇒ 不再发射）
    const before = calls.length
    syncToolVisibility(agent, root)
    expect(calls.length).toBe(before)
    expect(probe.disposed).toBe(1)

    // ④ 反向可逆性：把 `trajectory-constraint.json` 放回去 ⇒ 约束**重新生效**（撤销不是单向闩锁）
    writeTools(ALLOWED)
    syncToolVisibility(agent, root)
    expect((getToolVisibilityDiagnostics().denyByKey[SESSION] ?? []).includes('container_fs')).toBe(true)
  })

  it('🔴 非轨迹约束会话 ⇒ 该**源**不贡献 deny（合并后不再能"数发射次数"）', () => {
    const { agent } = fakeAgent('session-ordinary-0001')
    syncToolVisibility(agent, root)
    // 方案 C 语义变化（如实记录，D184②）：合并发射意味着"就算轨迹约束不生效，
    // 只要别的源有意见（如宿主 schedule_*）仍会发一次 restrict"⇒ 旧断言"calls.length=0"不再成立。
    // 真正该钉的是**这个源贡献了什么**：
    const src = computeVisibilitySources('session-ordinary-0001', root).find((s) => s.id === 'trajectoryConstraint')!
    expect([...src.deny], '非轨迹约束会话却被收窄了工具面').toEqual([])
  })

  it('🔴 会话登记到**普通轨迹**（无 trajectory-constraint.json）⇒ 判"不是轨迹约束" ⇒ 该源不贡献 deny', () => {
    const plain = makeTrajectory(root, 'plain-traj', null)
    const other = 'session-plain-0001'
    registerTrajectorySession(other, plain.dirName, root)
    try {
      const src = computeVisibilitySources(other, root).find((s) => s.id === 'trajectoryConstraint')!
      expect([...src.deny], '普通轨迹被当成了轨迹约束').toEqual([])
    } finally {
      forgetTrajectoryConstraintToolVisibility(other)
    }
  })
})
