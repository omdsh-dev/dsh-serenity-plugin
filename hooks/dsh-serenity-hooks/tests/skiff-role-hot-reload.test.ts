import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * skiff 角色工具面 —— **热加载**（owner 2026-10-19 令「工具清单也要热加载」）回归钉
 *
 * ## 它钉的是什么
 *
 * 在 v1.69.3 之前，skiff 的角色白名单**只由运行时守卫拦截**：
 * 工具**全部出现在模型 schema 里**，调用时才被 `tool not allowed in this skiff role` 打回。
 * ⇒ 配置改 `skiff.roles.<r>.tools`，**schema 上永远不生效** —— 模型看得见它不该有的工具。
 *
 * 本件用**真 restrict 契约**（替身 agent 记录收到的 `deny`）钉三条：
 *  ① 白名单之外的工具**真的被 deny**（从 schema 移除，而不是只靠调用时拦截）；
 *  ② **改配置 ⇒ deny 清单当场跟着变**（这就是「热加载」，不需要重启/重建会话）；
 *  ③ 幂等：配置没变时不重复发 restrict（restrict 会重建 schema，没必要每步做）。
 *
 * ⚠️ 替身只证明"我们调了 restrict 且 deny 内容正确"，**证明不了宿主真的把它从 schema 摘掉**。
 *    后者需要真宿主（`bench/` 那一层）。本件的价值在于①的**内容正确性**与②的**热加载语义**。
 */

import { syncSkiffRoleToolVisibility, forgetSkiffRoleToolVisibility } from '../src/seams/guards.js'
import { registerSkiffSession, unregisterSkiffSession } from '../src/role/skiff/registry.js'

const SESSION = 'skiff-demo-role-1234'

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

/** 造一个最小 CCC：只有 `.opencode/serenity.json`（含一个 skiff 角色） */
function makeCcc(tools: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'skiff-role-hot-'))
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(
    join(root, '.opencode', 'serenity.json'),
    JSON.stringify({ skiff: { roles: { 'demo-role': { tools, msms: [] } } } }),
    'utf8',
  )
  return root
}

describe('skiff 角色工具面：白名单之外从 schema 移除 ＋ 改配置当场生效', () => {
  let root: string

  beforeEach(() => {
    root = makeCcc(['read', 'grep'])
    registerSkiffSession(SESSION, 'demo-role', root, {} as never)
  })

  afterEach(() => {
    forgetSkiffRoleToolVisibility(SESSION)
    unregisterSkiffSession(SESSION)
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

    // 只改磁盘上的配置，**不重启、不重建会话、不重新注册**
    writeFileSync(
      join(root, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { 'demo-role': { tools: ['read', 'grep', 'container_fs'], msms: [] } } } }),
      'utf8',
    )
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
    writeFileSync(
      join(root, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { 'demo-role': { tools: ['read', 'grep', 'container_fs'], msms: [] } } } }),
      'utf8',
    )
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.at(-1)).not.toContain('container_fs')
    // 再收回
    writeFileSync(
      join(root, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { 'demo-role': { tools: ['read', 'grep'], msms: [] } } } }),
      'utf8',
    )
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.at(-1), '收回授权后仍可见 —— 只做放开不做收回').toContain('container_fs')
  })

  it('角色被移除 ⇒ 不动（fail-open：守卫仍兜底，不要把工具全删光）', () => {
    const { agent, calls } = fakeAgent(SESSION)
    writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: {} } }), 'utf8')
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length, '角色没了还发 restrict（会把工具面删光）').toBe(0)
  })

  it('非 skiff 会话 ⇒ 直接 return（本函数只管 skiff）', () => {
    const { agent, calls } = fakeAgent('session-ordinary-0001')
    syncSkiffRoleToolVisibility(agent, root)
    expect(calls.length).toBe(0)
  })
})
