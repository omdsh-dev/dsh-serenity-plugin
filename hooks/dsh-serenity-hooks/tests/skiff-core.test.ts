import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  registerSkiffSession,
  unregisterSkiffSession,
  skiffRoleFor,
  skiffSessionSnapshot,
  skiffTrajectoryEnabled,
  skiffMsmGate,
  askSkiff,
  createSkiffAgent,
} from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX } from '../src/skiff-role.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-core-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

/** fake agent（session + followup；events 可动态扩展） */
function fakeAgent(events: unknown[] = []): { session: { id: string; events: unknown[] }; followup: () => void } {
  return {
    session: { id: `${SKIFF_SESSION_PREFIX}qa-1`, events },
    followup: () => {
      events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'question' }] } },
        {
          type: 'assistant/message',
          data: {
            message: {
              content: [{ type: 'text', text: 'the answer' }],
              tool_calls: [{ name: 'cc_fs', arguments: '{"action":"list"}' }],
            },
          },
        },
        { type: 'tool/result', data: { name: 'cc_fs', content: [{ type: 'text', text: 'tool result' }] } },
      )
    },
  }
}

/** fake ctx：on 立即触发 idle（waitIdle 同步 resolve） */
function fakeCtx(agent: unknown): { on: () => () => void } {
  return {
    on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' })
      return () => {}
    },
  }
}

describe('skiff-core: 会话注册表', () => {
  it('register → roleFor 命中 + snapshot；unregister → 清空', () => {
    const agent = fakeAgent()
    registerSkiffSession(agent.session.id, 'qa-readonly', agent as never)
    expect(skiffRoleFor(agent.session.id)).toBe('qa-readonly')
    expect([...skiffSessionSnapshot().entries()]).toEqual([[agent.session.id, { role: 'qa-readonly' }]])
    unregisterSkiffSession(agent.session.id)
    expect(skiffRoleFor(agent.session.id)).toBeNull()
    expect(skiffSessionSnapshot().size).toBe(0)
  })

  it('未注册会话 → null', () => {
    expect(skiffRoleFor('skiff-unknown-1')).toBeNull()
    expect(skiffRoleFor('normal')).toBeNull()
  })
})

describe('skiff-core: createSkiffAgent（v1.25.3：preset 挂载修复平台工具面）', () => {
  it('挂载 standard preset + 角色模型 + scoped 提示词 + 注册表', async () => {
    const mounted: Array<{ id: string }> = []
    const sections: Array<{ name: string; order: number; text: () => string }> = []
    const created: Array<Record<string, unknown>> = []
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void>; agentOptions?: unknown }) => {
          created.push(opts)
          const agentCtx = {
            get: (name: string) =>
              name === 'agentPresets' ? { mount: async (_c: unknown, id: string) => { mounted.push({ id }) } } : undefined,
            systemPrompt: {
              section: (s: { name: string; order: number; text: () => string }) => sections.push(s),
            },
          }
          await opts.setup?.(agentCtx)
          return {
            agent: {
              ctx: agentCtx,
              session: { id: opts.sessionId, events: [] },
              followup: () => {},
            },
          }
        },
      },
    }
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'qa', {
      model: 'p/m',
      msms: ['x'],
      tools: ['read'],
      systemPrompt: '角色定义',
    })
    // preset 挂载（平台工具面——read/grep/glob/web_search 可用的关键）
    expect(mounted).toEqual([{ id: 'standard' }])
    // meta 记录 agentPreset（重建恢复工具面）
    expect(created[0]?.meta).toEqual({ cwd: dir, agentPreset: 'standard' })
    // 角色模型
    expect(created[0]?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    // scoped 系统提示词（基础段 + CCC 定义段）
    expect(sections[0]?.name).toBe('serenity-skiff')
    expect(sections[0]?.order).toBe(-60)
    expect(sections[0]?.text()).toContain('=== Serenity Skiff ===')
    expect(sections[0]?.text()).toContain('角色定义')
    // 注册表
    expect(skiffRoleFor(ref.sessionId)).toBe('qa')
    unregisterSkiffSession(ref.sessionId)
  })

  it('agentPresets 服务缺失 → 不阻断创建（回退全局工具层）', async () => {
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = { get: () => undefined, systemPrompt: { section: () => {} } }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [] }, followup: () => {} } }
        },
      },
    }
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'qa', { msms: ['x'] })
    expect(ref.sessionId.startsWith(SKIFF_SESSION_PREFIX)).toBe(true)
    unregisterSkiffSession(ref.sessionId)
  })
})

describe('skiff-core: skiffTrajectoryEnabled 轨迹纪律子集', () => {
  it('非 skiff 会话恒 true（正常参与所有轨迹机制）', () => {
    expect(skiffTrajectoryEnabled(dir, 'normal-session', 'keeper')).toBe(true)
    expect(skiffTrajectoryEnabled(dir, 'handyman-x', 'rebuild')).toBe(true)
    expect(skiffTrajectoryEnabled(dir, undefined, 'session')).toBe(true)
  })

  it('skiff 会话未注册（注册表缺失）→ 保守旁路 false', () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['x'] } } } })
    expect(skiffTrajectoryEnabled(dir, 'skiff-qa-noreg', 'keeper')).toBe(false)
  })

  it('skiff 会话按角色 trajectory 子集：缺省全关（完全独立）；keeper=true 开启', () => {
    writeConfig({
      skiff: {
        roles: {
          qa: { msms: ['x'] },
          review: { msms: ['y'], trajectory: { keeper: true, rebuild: false, session: false } },
        },
      },
    })
    const qa = fakeAgent()
    registerSkiffSession(qa.session.id, 'qa', qa as never)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'keeper')).toBe(false)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'rebuild')).toBe(false)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'session')).toBe(false)

    const review = { session: { id: `${SKIFF_SESSION_PREFIX}review-1`, events: [] }, followup: () => {} }
    registerSkiffSession(review.session.id, 'review', review as never)
    expect(skiffTrajectoryEnabled(dir, review.session.id, 'keeper')).toBe(true)
    expect(skiffTrajectoryEnabled(dir, review.session.id, 'rebuild')).toBe(false)
  })
})

describe('skiff-core: skiffMsmGate acc_msm 白名单门控', () => {
  const qaId = `${SKIFF_SESSION_PREFIX}qa-1`

  beforeEach(() => {
    writeConfig({ skiff: { roles: { qa: { msms: ['cognitive-qa', 'meta-x'], tools: [] } } } })
    registerSkiffSession(qaId, 'qa', { session: { id: qaId, events: [] } } as never)
  })

  it('非 skiff 会话恒放行（无 reject 无 whitelist）', () => {
    expect(skiffMsmGate(dir, 'normal', 'exec', 'anything')).toEqual({})
    expect(skiffMsmGate(dir, undefined, 'register', 'x')).toEqual({})
  })

  it('exec：白名单内放行 / 白名单外拒绝（不列名单）', () => {
    expect(skiffMsmGate(dir, qaId, 'exec', 'cognitive-qa')).toEqual({})
    const g = skiffMsmGate(dir, qaId, 'exec', 'not-allowed')
    expect(g.reject).toBeDefined()
    expect(g.reject).toContain('MSM not allowed')
    expect(g.reject).not.toContain('not-allowed')
  })

  it('register/deregister 必拒', () => {
    expect(skiffMsmGate(dir, qaId, 'register', 'x').reject).toContain('not allowed in skiff')
    expect(skiffMsmGate(dir, qaId, 'deregister', 'x').reject).toContain('not allowed in skiff')
  })

  it('list → 白名单过滤（whitelist 集合）', () => {
    const g = skiffMsmGate(dir, qaId, 'list')
    expect(g.reject).toBeUndefined()
    expect([...g.whitelist!].sort()).toEqual(['cognitive-qa', 'meta-x'])
  })

  it('check/guide/ccc-config 只读放行', () => {
    expect(skiffMsmGate(dir, qaId, 'check')).toEqual({})
    expect(skiffMsmGate(dir, qaId, 'guide')).toEqual({})
    expect(skiffMsmGate(dir, qaId, 'ccc-config')).toEqual({})
  })

  it('skiff 会话未注册（进程重启遗留）→ 拒绝', () => {
    expect(skiffMsmGate(dir, 'skiff-ghost-1', 'exec', 'cognitive-qa').reject).toContain('not allowed in this skiff session')
  })
})

describe('skiff-core: askSkiff 会话核心', () => {
  it('followup → idle → 答案 + 本轮轨迹（含工具调用与结果）', async () => {
    const events: unknown[] = []
    const agent = { session: { id: `${SKIFF_SESSION_PREFIX}qa-1`, events }, followup: () => {} }
    // 手动模拟 followup 行为：提问 + 模型回复 + 工具调用 + 结果
    const realFollowup = agent.followup
    agent.followup = () => {
      realFollowup()
      events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'question' }] } },
        {
          type: 'assistant/message',
          data: {
            message: {
              content: [{ type: 'text', text: 'the answer' }],
              tool_calls: [{ name: 'cc_fs', arguments: '{"action":"list"}' }],
            },
          },
        },
        { type: 'tool/result', data: { name: 'cc_fs', content: [{ type: 'text', text: 'tool result' }] } },
      )
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'question')
    expect(result.answer).toBe('the answer')
    expect(result.sessionId).toBe(agent.session.id)
    // 轨迹 = 本轮新增（before = 0 → 全量）
    expect(result.trajectory.length).toBeGreaterThanOrEqual(3)
    expect(result.trajectory[0]).toEqual({ role: 'user', text: 'question' })
    expect(result.trajectory.some((t) => t.role === 'assistant' && t.text.includes('cc_fs'))).toBe(true)
    expect(result.trajectory.some((t) => t.role === 'tool' && t.text.includes('tool result'))).toBe(true)
  })

  it('无 assistant 文本 → 空答案（轨迹尽力而为）', async () => {
    const events: unknown[] = []
    const agent = { session: { id: `${SKIFF_SESSION_PREFIX}qa-1`, events }, followup: () => {} }
    agent.followup = () => {
      events.push({ type: 'tool/result', data: { name: 'cc_fs', content: [{ type: 'text', text: 'r' }] } })
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('')
    expect(result.trajectory).toEqual([{ role: 'tool', text: 'r', tool: 'cc_fs' }])
  })
})
