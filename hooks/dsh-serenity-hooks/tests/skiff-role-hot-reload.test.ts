import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * skiff 工具面 —— **热加载**（owner 2026-10-19 令「工具清单也要热加载」）回归钉
 *
 * ## 它钉的是什么
 *
 * 在 v1.69.3 之前，skiff 的工具白名单**只由运行时守卫拦截**：
 * 工具**全部出现在模型 schema 里**，调用时才被 `tool not allowed in this skiff role` 打回。
 * ⇒ 配置改白名单，**schema 上永远不生效** —— 模型看得见它不该有的工具。
 *
 * 本件用**真 restrict 契约**（替身 agent 记录收到的 `deny` 与 dispose 调用）钉四条：
 *  ① 白名单之外的工具**真的被 deny**（从 schema 移除，而不是只靠调用时拦截）；
 *  ② **改配置 ⇒ deny 清单当场跟着变**（这就是「热加载」，不需要重启/重建会话）；
 *  ③ 幂等：配置没变时不重复发 restrict（restrict 会重建 schema，没必要每步做）；
 *  ④ **撤销方向**：`skiff.json` 被删 ⇒ 这条轨迹当场不再是 skiff ⇒ 既有的隐藏必须**撤销**。
 *
 * ⚠️ 替身只证明"我们调了 restrict 且 deny 内容正确"，**证明不了宿主真的把它从 schema 摘掉**。
 *    后者需要真宿主（`bench/` 那一层）。本件的价值在于①的**内容正确性**与②③④的**热加载语义**。
 *
 * ## 🔴 2026-10-19 重做后的前提换法（R↓，别照旧件改回来）
 *
 * 旧件造 CCC 的办法是 `writeConfig({ skiff: { roles: { 'demo-role': {…} } } })`，
 * **那段配置已退役**（读它得到空 ⇒ 白名单恒空 ⇒ 一次 restrict 都不发）。
 * 新模型里 skiff 是一条**带 `skiff.json` 的认知轨迹**，判据走
 * `skiffProfileForSession`：**① 会话已 `registerSkiffSession(sessionId, dirName, ccc)` 登记
 * ② `<root>/AGENT_SESSIONS/<dirName>/skiff.json` 真在盘上** ⇒ 两个前提缺一不可。
 * ⇒ 本件用 `tests/helpers/skiff-fixture.ts` 造这两样（不重复描述载体）。
 *
 * 旧件的「角色被移除 ⇒ 不动（fail-open）」一条**前提已死**：旧语义是"角色没了还发 restrict
 * 会把工具面删光"，而新语义恰恰相反 —— **删掉 `skiff.json` 就是撤销隐藏**（guards 的注释
 * 明写「⛔ 不能只是 return —— 那会把上一步的隐藏永久留在一个已不再是 skiff 的会话上」）。
 * ⇒ 它被下面的④取代，且④钉的是**更强的反面**：不只是"不多发 restrict"，而是"**旧 restrict 被 dispose**"。
 */

/** 白名单初始值（`read`/`grep` 是平台常驻工具，白名单外要抽两个 ACC 工具当对照） */
const ALLOWED = ['read', 'grep']

import { syncSkiffRoleToolVisibility, forgetSkiffRoleToolVisibility, getSkiffRoleVisibilityDiagnostics } from '../src/seams/guards.js'
import { registerSkiffSession, resetSkiffSessions } from '../src/trajectory/policy/window.js'
import { SKIFF_PROFILE_FILENAME } from '../src/trajectory/policy/profile.js'
import { makeTrajectory, skiffJson } from './helpers/skiff-fixture.js'

const SESSION = 'skiff-demo-role-1234'
const CODE = 'demo-role'

/** 替身 agent：记录每次 restrict 的 deny 清单与 dispose 调用 */
function fakeAgent(sessionId: string) {
  const calls: string[][] = []
  let disposed = 0
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
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

describe('skiff 工具面：白名单之外从 schema 移除 ＋ 改配置当场生效 ＋ 撤销', () => {
  let root: string
  /** 该 skiff 轨迹的 `skiff.json` 绝对路径（热加载就是改这一个文件） */
  let profilePath: string

  /** 重写该轨迹的 `skiff.json`（= 生产里"改了约束面"的唯一动作） */
  function writeTools(tools: string[]): void {
    writeFileSync(profilePath, JSON.stringify(skiffJson({ tools, msms: [] })), 'utf-8')
  }

  beforeEach(() => {
    resetSkiffSessions()
    root = mkdtempSync(join(tmpdir(), 'skiff-role-hot-'))
    writeFileSync(join(root, '.serenity'), 'test')
    // 前提①②：一条带 skiff.json 的轨迹 ＋ 会话到它的登记
    const traj = makeTrajectory(root, CODE, skiffJson({ tools: ALLOWED, msms: [] }))
    profilePath = join(traj.dir, SKIFF_PROFILE_FILENAME)
    registerSkiffSession(SESSION, traj.dirName, root)
  })

  afterEach(() => {
    forgetSkiffRoleToolVisibility(SESSION)
    resetSkiffSessions()
    rmSync(root, { recursive: true, force: true })
  })

  it('🔴 白名单之外的工具真被 deny（不是只靠调用时拦截）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncSkiffRoleToolVisibility(agent, root)
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
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls[0]).toContain('container_fs') // 初始：未授权 ⇒ 被 deny

    // 只改磁盘上的 `skiff.json`，**不重启、不重建会话、不重新注册**
    writeTools([...ALLOWED, 'container_fs'])
    syncSkiffRoleToolVisibility(agent, root) // 下一次 pre-step

    expect(calls.length, '配置变了却没有重新发 restrict —— 这就是"不热加载"').toBe(2)
    expect(calls[1], '新授权的工具仍被 deny').not.toContain('container_fs')
    // 且本来就没授权的仍在 deny 里（不是"全清空"）
    expect(calls[1]).toContain('cognitive_trajectory')
  })

  it('幂等：配置没变 ⇒ 不重复发 restrict（deny 相同就跳过）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncSkiffRoleToolVisibility(agent, root)
    syncSkiffRoleToolVisibility(agent, root)
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length, '每步都重发 restrict —— 会把 schema 反复重建').toBe(1)
  })

  it('撤销授权 ⇒ 重新 deny（两个方向都钉，防只做"放开"不做"收回"）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    syncSkiffRoleToolVisibility(agent, root) // 初始不含 container_fs
    // 先放开
    writeTools([...ALLOWED, 'container_fs'])
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.at(-1)).not.toContain('container_fs')
    // 再收回
    writeTools(ALLOWED)
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.at(-1), '收回授权后仍可见 —— 只做放开不做收回').toContain('container_fs')
  })

  it('🔴 删掉 `skiff.json` ⇒ 这条轨迹不再是 skiff ⇒ **既有的隐藏被撤销**（dispose，不是 return）', () => {
    // ⚠️ 不解构 `disposed`：它是 **getter**，解构会在此刻把值拷成 0（后续再读永远是 0）。
    //   （旧件的 `fakeAgent` 就是这个形状，但旧件从未断言 dispose ⇒ 这个坑第一次现形。）
    const probe = fakeAgent(SESSION)
    const { agent, calls } = probe
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length, '前置：先真发过一次 restrict').toBe(1)
    expect(getSkiffRoleVisibilityDiagnostics().keys).toContain(SESSION)

    // 🔴 owner 语义：目录下有没有 `skiff.json` **就是**全部判据 ⇒ 删文件 = 撤销约束
    unlinkSync(profilePath)
    syncSkiffRoleToolVisibility(agent, root)

    // ① 旧 restrict 必须被 dispose（⛔ 只是 `return` 会把隐藏永久留在这个会话上）
    expect(probe.disposed, '删掉 skiff.json 后旧 restrict 未被撤销 —— 工具面永久收窄在一条普通轨迹上').toBe(1)
    // ② 且不得**再发**一次（不是"换个更小的 deny 清单"）
    expect(calls.length, '已不是 skiff 却还在发 restrict').toBe(1)
    // ③ 内部状态里这条会话的键必须消失（否则下次同值会被幂等判据误判为"已是目标态"）
    expect(getSkiffRoleVisibilityDiagnostics().keys).not.toContain(SESSION)
    // ④ 后续再同步仍不发（已回到无约束态 ⇒ 幂等）
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length).toBe(1)
    expect(probe.disposed).toBe(1)

    // ⑤ 反向可逆性：把 `skiff.json` 放回去 ⇒ 约束**重新生效**（撤销不是单向闩锁）
    writeTools(ALLOWED)
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length, 'skiff.json 放回后工具面没有重新收窄').toBe(2)
    expect(calls[1]).toContain('container_fs')
    expect(getSkiffRoleVisibilityDiagnostics().keys).toContain(SESSION)
  })

  it('非 skiff 会话（未登记到任何轨迹）⇒ 直接 return（本函数只管 skiff）', () => {
    const { agent, calls } = fakeAgent('session-ordinary-0001')
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length).toBe(0)
  })

  it('会话登记到**普通轨迹**（该轨迹没有 `skiff.json`）⇒ 判"不是 skiff" ⇒ 不发 restrict', () => {
    // ⚠️ 用 `makeTrajectory(root, code, null)`：夹具里 `makeSkiffSession` 的 `profile ?? {}`
    //    会把 null 变成 {} = 写出一份空 skiff.json（那样它**就是** skiff 了）⇒ 这里必须显式造。
    const plain = makeTrajectory(root, 'plain-traj', null)
    const other = 'session-plain-0001'
    registerSkiffSession(other, plain.dirName, root)
    try {
      const { agent, calls } = fakeAgent(other)
      syncSkiffRoleToolVisibility(agent, root)
      expect(calls.length, '普通轨迹被当成了 skiff').toBe(0)
    } finally {
      forgetSkiffRoleToolVisibility(other)
    }
  })
})
