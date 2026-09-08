import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  registerSkiffSession,
  unregisterSkiffSession,
  skiffRoleFor,
  skiffSessionInfo,
  getSkiffAgent,
  skiffSessionSnapshot,
  skiffTrajectoryEnabled,
  skiffMsmGate,
  askSkiff,
  createSkiffAgent,
  ensureSkiffSession,
  workspaceTrajectoryLine,
} from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX, type SkiffRoleConfig } from '../src/skiff-role.js'
import { getActiveSessionInfo, resetActiveSessionStore } from '../src/session-ops.js'
import { readLastBound } from '../src/session-bound.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-core-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
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
              tool_calls: [{ name: 'container_fs', arguments: '{"action":"list"}' }],
            },
          },
        },
        { type: 'tool/result', data: { name: 'container_fs', content: [{ type: 'text', text: 'tool result' }] } },
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
    registerSkiffSession(agent.session.id, 'qa-readonly', dir, agent as never)
    expect(skiffRoleFor(agent.session.id)).toBe('qa-readonly')
    expect([...skiffSessionSnapshot().entries()]).toEqual([[agent.session.id, { role: 'qa-readonly', ccc: dir }]])
    unregisterSkiffSession(agent.session.id)
    expect(skiffRoleFor(agent.session.id)).toBeNull()
    expect(skiffSessionSnapshot().size).toBe(0)
  })

  it('skiffSessionInfo 返回 role + ccc 绑定（v1.25.10 追问校验）', () => {
    const agent = fakeAgent()
    registerSkiffSession(agent.session.id, 'qa', dir, agent as never)
    expect(skiffSessionInfo(agent.session.id)).toEqual({ role: 'qa', ccc: dir })
    expect(skiffSessionInfo('skiff-ghost-1')).toBeNull()
    unregisterSkiffSession(agent.session.id)
    expect(skiffSessionInfo(agent.session.id)).toBeNull()
  })

  it('getSkiffAgent 进程内会话查询（追问复用；未注册 → undefined）', () => {
    const agent = fakeAgent()
    registerSkiffSession(agent.session.id, 'qa', dir, agent as never)
    expect(getSkiffAgent(agent.session.id)).toBe(agent)
    expect(getSkiffAgent('skiff-ghost-2')).toBeUndefined()
    unregisterSkiffSession(agent.session.id)
    expect(getSkiffAgent(agent.session.id)).toBeUndefined()
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

  it('systemPromptFile 优先：CCC 段取 md 文件内容（v1.25.10）', async () => {
    mkdirSync(join(dir, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skiff', 'qa.md'), '文件版提示词')
    const sections: Array<{ name: string; text: () => string }> = []
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [] }, followup: () => {} } }
        },
      },
    }
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'qa', {
      systemPromptFile: '.opencode/skiff/qa.md',
      systemPrompt: '旧内嵌（不应出现）',
    })
    expect(sections[0]?.text()).toContain('文件版提示词')
    expect(sections[0]?.text()).not.toContain('旧内嵌')
    unregisterSkiffSession(ref.sessionId)
  })

  it('systemPromptFile 缺失 → 降级仅基础段 + 不阻断创建（console.warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sections: Array<{ name: string; text: () => string }> = []
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [] }, followup: () => {} } }
        },
      },
    }
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'qa', { systemPromptFile: '.opencode/skiff/missing.md' })
    expect(sections[0]?.text()).toContain('=== Serenity Skiff ===')
    expect(sections[0]?.text()).not.toContain('CCC 完整定义')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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

describe('skiff-core: createSkiffAgent resume-or-create（v1.27.2 微信桥 id collision 修复 + v1.27.3 live 复用）', () => {
  /** fake ctx：agents.create + agents.resume 双路；resume 按模式（成功 / not-found / 缺方法 / live 恢复） */
  function fakeResumeCtx(mode: 'success' | 'not-found' | 'absent' | 'live'): {
    agents: {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void>; agentOptions?: unknown; meta?: unknown }) => Promise<unknown>
      resume?: (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void>; agentOptions?: unknown }) => Promise<unknown>
      get?: (id: string) => unknown
    }
    calls: Array<{ kind: string; id: string }>
  } {
    const calls: Array<{ kind: string; id: string }> = []
    const makeAgent = (id: string): unknown => {
      const agentCtx = { get: () => undefined, systemPrompt: { section: () => {} } }
      return { ctx: agentCtx, session: { id, events: [] }, followup: () => {} }
    }
    const makeHandle = async (kind: 'create' | 'resume', id: string, opts: { setup?: (c: unknown) => Promise<void> }): Promise<unknown> => {
      calls.push({ kind, id })
      await opts.setup?.(makeAgent(id) as never)
      return { agent: makeAgent(id) }
    }
    const agents: {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void>; agentOptions?: unknown; meta?: unknown }) => Promise<unknown>
      resume?: (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void>; agentOptions?: unknown }) => Promise<unknown>
      get?: (id: string) => unknown
    } = {
      create: (opts) => makeHandle('create', opts.sessionId, opts),
    }
    if (mode === 'success') {
      agents.resume = (opts) => makeHandle('resume', opts.resumeSessionId, opts)
    } else if (mode === 'not-found') {
      agents.resume = async (opts) => {
        calls.push({ kind: 'resume', id: opts.resumeSessionId })
        const err = new Error(`session "${opts.resumeSessionId}" not found`)
        err.name = 'SessionPersistenceNotFoundError'
        throw err
      }
    } else if (mode === 'live') {
      // 重启后 DSH 恢复的 live 会话：resume 报 "while it is live"、create 报 "already exists"、
      // get 返回 live agent（v1.27.3 修复的根因场景）
      const liveAgent = makeAgent('skiff-weixin-live-1')
      agents.get = (id) => (id === 'skiff-weixin-live-1' ? liveAgent : undefined)
      agents.resume = async (opts) => {
        calls.push({ kind: 'resume', id: opts.resumeSessionId })
        throw new Error(`cannot prepare session "${opts.resumeSessionId}" while it is live`)
      }
      agents.create = async (opts) => {
        calls.push({ kind: 'create', id: opts.sessionId })
        throw new Error(`session "${opts.sessionId}" already exists`)
      }
    }
    return { agents, calls }
  }

  it('固定 id + 磁盘已有持久化 log → resume（resumed=true，历史延续）', async () => {
    const ctx = fakeResumeCtx('success')
    const ref = await createSkiffAgent(ctx as never, dir, 'qa', { msms: ['x'] }, undefined, 'skiff-weixin-fixed-1')
    expect(ref.resumed).toBe(true)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-1')
    expect(skiffRoleFor(ref.sessionId)).toBe('qa')
    unregisterSkiffSession(ref.sessionId)
  })

  it('固定 id + resume not-found（首次无持久化）→ 降级 create（resumed=false + 新对话语义）', async () => {
    const ctx = fakeResumeCtx('not-found')
    const ref = await createSkiffAgent(ctx as never, dir, 'qa', { msms: ['x'] }, undefined, 'skiff-weixin-fixed-2')
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-2')
    expect(skiffRoleFor(ref.sessionId)).toBe('qa')
    unregisterSkiffSession(ref.sessionId)
  })

  it('固定 id + 会话已 live（重启后 DSH 恢复）→ live 复用，resume/create 均不调用（v1.27.3 修复）', async () => {
    const ctx = fakeResumeCtx('live')
    const ref = await createSkiffAgent(ctx as never, dir, 'qa', { msms: ['x'] }, undefined, 'skiff-weixin-live-1')
    expect(ref.resumed).toBe(true) // 历史延续语义（非新对话）
    expect(ref.sessionId).toBe('skiff-weixin-live-1')
    expect(skiffRoleFor(ref.sessionId)).toBe('qa') // 内存注册表已登记
    // 不经过 resume/create（二者在此场景必抛错——live 会话唯一可行路径 = get 复用）
    expect(ctx.calls).toEqual([])
    unregisterSkiffSession(ref.sessionId)
  })

  it('无固定 id（随机）→ 恒 create，resume 不参与', async () => {
    const ctx = fakeResumeCtx('absent') // 无 resume 方法——随机路径根本不该调
    const ref = await createSkiffAgent(ctx as never, dir, 'qa', { msms: ['x'] })
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId.startsWith(SKIFF_SESSION_PREFIX)).toBe(true)
    unregisterSkiffSession(ref.sessionId)
  })

  it('resume 其他错误（非 not-found）→ 也降级 create + 打堆栈（用户拍板：不静默不唤醒）', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = fakeResumeCtx('not-found')
    // 覆盖 resume 抛任意错误（如 DSH 内部 "Cannot read properties of undefined (reading 'ctx')"）→ 一律降级
    ;(ctx.agents as { resume: (o: { resumeSessionId: string }) => Promise<unknown> }).resume = async () => {
      throw new Error("Cannot read properties of undefined (reading 'ctx')")
    }
    const ref = await createSkiffAgent(ctx as never, dir, 'qa', { msms: ['x'] }, undefined, 'skiff-weixin-fixed-3')
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-3')
    // 堆栈已打印（诊断定位）
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('skiff resume 失败降级 create'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('skiff resume stack'))
    spy.mockRestore()
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
    registerSkiffSession(qa.session.id, 'qa', dir, qa as never)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'keeper')).toBe(false)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'rebuild')).toBe(false)
    expect(skiffTrajectoryEnabled(dir, qa.session.id, 'session')).toBe(false)

    const review = { session: { id: `${SKIFF_SESSION_PREFIX}review-1`, events: [] }, followup: () => {} }
    registerSkiffSession(review.session.id, 'review', dir, review as never)
    expect(skiffTrajectoryEnabled(dir, review.session.id, 'keeper')).toBe(true)
    expect(skiffTrajectoryEnabled(dir, review.session.id, 'rebuild')).toBe(false)
  })
})

describe('skiff-core: skiffMsmGate msm 白名单门控', () => {
  const qaId = `${SKIFF_SESSION_PREFIX}qa-1`

  beforeEach(() => {
    writeConfig({ skiff: { roles: { qa: { msms: ['cognitive-qa', 'meta-x'], tools: [] } } } })
    registerSkiffSession(qaId, 'qa', dir, { session: { id: qaId, events: [] } } as never)
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
              tool_calls: [{ name: 'container_fs', arguments: '{"action":"list"}' }],
            },
          },
        },
        { type: 'tool/result', data: { name: 'container_fs', content: [{ type: 'text', text: 'tool result' }] } },
      )
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'question')
    expect(result.answer).toBe('the answer')
    expect(result.sessionId).toBe(agent.session.id)
    // 轨迹 = 本轮新增（before = 0 → 全量）
    expect(result.trajectory.length).toBeGreaterThanOrEqual(3)
    expect(result.trajectory[0]).toEqual({ role: 'user', text: 'question' })
    expect(result.trajectory.some((t) => t.role === 'assistant' && t.text.includes('container_fs'))).toBe(true)
    expect(result.trajectory.some((t) => t.role === 'tool' && t.text.includes('tool result'))).toBe(true)
  })

  it('无 assistant 文本 → 空答案（轨迹尽力而为）', async () => {
    const events: unknown[] = []
    const agent = { session: { id: `${SKIFF_SESSION_PREFIX}qa-1`, events }, followup: () => {} }
    agent.followup = () => {
      events.push({ type: 'tool/result', data: { name: 'container_fs', content: [{ type: 'text', text: 'r' }] } })
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('')
    expect(result.trajectory).toEqual([{ role: 'tool', text: 'r', tool: 'container_fs' }])
  })
})

describe('skiff-core: ensureSkiffSession 专属 SESSION（v1.30.3，S142 用户拍板：自动创建/恢复/per 用户隔离）', () => {
  /** fake agent：session 带 header（真实 Session 形态——绑定文件经 cwd 定位 CCC 根）+ events 记录 */
  function sessionAgent(id: string, events: unknown[] = []): { session: { id: string; header: { id: string; cwd: string }; events: unknown[]; append: (t: string, d: unknown) => void }; followup: () => void } {
    const s = {
      id,
      header: { id, cwd: dir },
      events,
      append: (t: string, d: unknown) => {
        events.push({ type: t, data: d })
      },
    }
    return { session: s, followup: () => {} }
  }

  /** 角色：开启 session 能力（用户拍板 zhaocai 形态） */
  const sessionRole = (): SkiffRoleConfig => ({ msms: ['memory-tool'], tools: ['read', 'write', 'logbook', 'msm'], trajectory: { session: true, keeper: true, rebuild: true } })
  /** 未开 session 能力的角色 */
  const noSessionRole = (): SkiffRoleConfig => ({ msms: ['memory-tool'], tools: ['read'] })

  it('trajectory.session=true + 无 bound → 自动创建专属 SESSION + 激活 + bound 持久化', () => {
    const agent = sessionAgent('skiff-weixin-user-a')
    const mdPath = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole())
    // 自动创建：AGENT_SESSIONS/ 新增 <date>--S###--zhaocai skiff/ 含 SESSION.md
    expect(mdPath).not.toBeNull()
    expect(mdPath).toContain('AGENT_SESSIONS')
    expect(mdPath).toContain('zhaocai skiff')
    expect(existsSync(mdPath!)).toBe(true)
    expect(readFileSync(mdPath!, 'utf-8')).toContain('# SESSION:')
    // 激活（scope = skiff 会话 id）
    const active = getActiveSessionInfo(agent.session.id)
    expect(active?.mdPath).toBe(mdPath)
    // bound 持久化（note auto-created 标记；v1.30.6 起写 CCC 内 .bindings.json）
    expect(readLastBound(agent.session)?.note?.startsWith('auto-created for skiff role')).toBe(true)
  })

  it('已有 auto-created bound → 恢复不重复建（幂等）', () => {
    const agent = sessionAgent('skiff-weixin-user-a')
    const first = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole())
    // 模拟进程重启：新 events（空）但 readLastBound 需从持久化恢复——真实场景 events 在磁盘
    // 此处直接再跑一次 ensure（同 agent，events 已含 bound）→ 恢复同一 mdPath 不新建
    const second = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole())
    expect(second).toBe(first)
    // 只建了一个 SESSION 目录
    const sessions = readdirSync(join(dir, 'AGENT_SESSIONS')).filter((n) => n.includes('zhaocai skiff'))
    expect(sessions).toHaveLength(1)
  })

  it('trajectory.session=false → 零变化（无创建/无激活/无 bound）', () => {
    const agent = sessionAgent('skiff-qa-1')
    const mdPath = ensureSkiffSession(dir, agent as never, 'qa', noSessionRole())
    expect(mdPath).toBeNull()
    expect(getActiveSessionInfo(agent.session.id)).toBeNull()
    expect(readLastBound(agent.session)).toBeNull()
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(false)
  })

  it('两个 skiff 会话（模拟两微信用户）→ 各自独立 SESSION，互不覆盖', () => {
    const userA = sessionAgent('skiff-weixin-user-a')
    const userB = sessionAgent('skiff-weixin-user-b')
    const mdA = ensureSkiffSession(dir, userA as never, 'zhaocai', sessionRole())
    const mdB = ensureSkiffSession(dir, userB as never, 'zhaocai', sessionRole())
    expect(mdA).not.toBe(mdB)
    // 各自激活隔离
    expect(getActiveSessionInfo('skiff-weixin-user-a')?.mdPath).toBe(mdA)
    expect(getActiveSessionInfo('skiff-weixin-user-b')?.mdPath).toBe(mdB)
    // 各自 bound（文件记录，按会话 id 隔离）
    expect(readLastBound(userA.session)?.mdPath).toBe(mdA)
    expect(readLastBound(userB.session)?.mdPath).toBe(mdB)
  })

  it('旧手工 bound（S159，note 非 auto-created）→ 不认，新建专属 SESSION（S159 退役语义）', () => {
    const events: unknown[] = [
      { type: 'serenity/bound', data: { dirName: '2026-09-06--S159--zhaocai 独立轨迹', mdPath: join(dir, 'AGENT_SESSIONS', '2026-09-06--S159--zhaocai 独立轨迹', 'SESSION.md'), sessionId: 'S159', action: 'activate', at: 1 } },
    ]
    const agent = sessionAgent('skiff-weixin-user-a', events)
    const mdPath = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole())
    // 新建（不延续 S159）
    expect(mdPath).not.toContain('S159')
    expect(mdPath).toContain('zhaocai skiff')
  })

  // ── v1.30.9：S142 用户报「zhaocai skiff SESSION 爆炸」根治（实证：每条消息一个 SESSION）──

  it('跨消息形态：新 agent（空 events，模拟重启）+ 既有 .bindings.json → 恢复同一 SESSION，不新建', () => {
    const first = sessionAgent('skiff-weixin-user-a')
    const mdPath = ensureSkiffSession(dir, first as never, 'zhaocai', sessionRole())
    expect(mdPath).not.toBeNull()
    // 模拟下一条消息：进程内 agent 重建（空 events——旧事件形态不落盘时的真实形态）
    const second = sessionAgent('skiff-weixin-user-a')
    const restored = ensureSkiffSession(dir, second as never, 'zhaocai', sessionRole())
    expect(restored).toBe(mdPath)
    const sessions = readdirSync(join(dir, 'AGENT_SESSIONS')).filter((n) => n.includes('zhaocai skiff'))
    expect(sessions).toHaveLength(1)
  })

  it('绑定文件失效（②b 自愈）：删掉 .bindings.json 后同 scope 再 ensure → 复用内存活跃 SESSION 并补写绑定', () => {
    const first = sessionAgent('skiff-weixin-user-a')
    const mdPath = ensureSkiffSession(dir, first as never, 'zhaocai', sessionRole())
    // 模拟绑定持久化失效（旧形态事件未落盘 / 文件被删）——内存活跃仍在
    rmSync(join(dir, 'AGENT_SESSIONS', '.bindings.json'), { force: true })
    const second = sessionAgent('skiff-weixin-user-a')
    const restored = ensureSkiffSession(dir, second as never, 'zhaocai', sessionRole())
    expect(restored).toBe(mdPath)
    expect(readdirSync(join(dir, 'AGENT_SESSIONS')).filter((n) => n.includes('zhaocai skiff'))).toHaveLength(1)
    // 自愈：绑定已补写（下次进程重启可恢复）
    const healed = JSON.parse(readFileSync(join(dir, 'AGENT_SESSIONS', '.bindings.json'), 'utf-8')) as { sessions: Record<string, { mdPath: string; action: string; note?: string }> }
    expect(healed.sessions['skiff-weixin-user-a']?.mdPath).toBe(mdPath)
    expect(healed.sessions['skiff-weixin-user-a']?.action).toBe('reconcile')
    expect(healed.sessions['skiff-weixin-user-a']?.note?.startsWith('auto-created for skiff role')).toBe(true)
  })

  it('临时身份（persistent=false，ACP/调试页随机 id）→ 不建工作台（零熵增）', () => {
    const agent = sessionAgent('skiff-qa-random-uuid')
    const mdPath = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole(), false)
    expect(mdPath).toBeNull()
    expect(getActiveSessionInfo(agent.session.id)).toBeNull()
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(false)
  })

  it('workspaceTrajectoryLine：完整纪律块含 SESSION.md 路径 + 绑定/rebuild 约束', () => {
    const line = workspaceTrajectoryLine('/x/AGENT_SESSIONS/2026-09-07--S160--zhaocai skiff/SESSION.md')
    expect(line).toContain('SESSION.md: /x/AGENT_SESSIONS/2026-09-07--S160--zhaocai skiff/SESSION.md')
    // 用户点破的缺口：不只是路径——含「已自动绑定（无需 use）+ 使用纪律 + rebuild 续接」约束
    expect(line).toContain('AUTO-BOUND')
    expect(line).toContain('no logbook use needed')
    expect(line).toContain('logbook rebuild')
    // v1.30.13（D5）：不点名具体工具——zhaocai 已无 write/edit（写能力归 CCC 的 session-write MSM），
    // 旧文案 "with write/edit" 指向它没有的工具（注入纪律与能力面矛盾）
    expect(line).not.toContain('write/edit')
    expect(line).toContain('write channel')
    expect(line).toContain('never assume')
  })

  it('createSkiffAgent 集成：持久身份（固定 sessionId）→ 自动建 + 工作台纪律独立提示词段（v1.30.13 单一注入点）', async () => {
    const sections: Array<{ name: string; text: () => string }> = []
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [], append: (t: string, d: unknown) => events.push({ type: t, data: d }) }, followup: () => {} } }
        },
      },
    }
    const events: unknown[] = []
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'zhaocai', {
      ...sessionRole(),
      systemPrompt: '角色人格',
    } as never, undefined, 'skiff-weixin-fixed-workspace')
    // 基础段（角色面）与工作台段分离——工作台纪律只挂一处（微信桥不再每轮拼 question）
    const base = sections.find((s) => s.name === 'serenity-skiff')
    const ws = sections.find((s) => s.name === 'serenity-skiff-workspace')
    expect(base?.text()).toContain('角色人格')
    expect(base?.text()).not.toContain('Serenity Session Workspace')
    expect(ws?.text()).toContain('Serenity Session Workspace')
    expect(ws?.text()).toContain('AUTO-BOUND')
    expect(ws?.text()).toContain('SESSION.md:')
    // 激活命中
    expect(getActiveSessionInfo(ref.sessionId)).not.toBeNull()
    unregisterSkiffSession(ref.sessionId)
    // cleanup 内置 afterEach 已 rm dir；此处 reset active 防污染
  })

  it('createSkiffAgent 集成：临时身份（无 sessionId）→ 不建工作台、提示词无工作台行（v1.30.9）', async () => {
    const sections: Array<{ name: string; text: () => string }> = []
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [], append: () => {} }, followup: () => {} } }
        },
      },
    }
    const ref = await createSkiffAgent(fakeCtx as never, dir, 'zhaocai', { ...sessionRole(), systemPrompt: '角色人格' } as never)
    expect(sections[0]?.text()).not.toContain('Serenity Session Workspace')
    expect(sections[0]?.text()).toContain('角色人格')
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(false)
    unregisterSkiffSession(ref.sessionId)
  })

  // ── v1.30.15 方案 A：类型二分 × 提示词注入时机（S142 用户拍板）──

  /** 建一个可写角色提示词文件的 fake ctx（返回 sections + 文件路径） */
  function promptFileCtx(): { ctx: unknown; sections: Array<{ name: string; text: () => string }>; promptPath: string } {
    const sections: Array<{ name: string; text: () => string }> = []
    const promptPath = join(dir, '.opencode', 'skiff', 'live.md')
    mkdirSync(dirname(promptPath), { recursive: true })
    writeFileSync(promptPath, '第一版角色提示词')
    const ctx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session: { id: opts.sessionId, events: [], append: () => {} }, followup: () => {} } }
        },
      },
    }
    return { ctx, sections, promptPath }
  }

  it('persistent（稳定 sessionId）→ 角色提示词每轮重读文件：改文件即生效（无需重启）', async () => {
    const { ctx, sections, promptPath } = promptFileCtx()
    const ref = await createSkiffAgent(ctx as never, dir, 'zhaocai', {
      ...sessionRole(),
      systemPromptFile: '.opencode/skiff/live.md',
    } as never, undefined, 'skiff-weixin-hot-reload')
    const base = sections.find((s) => s.name === 'serenity-skiff')!
    expect(base.text()).toContain('第一版角色提示词')
    // 热更：直接改文件（模拟 CCC 编辑角色提示词）
    writeFileSync(promptPath, '第二版角色提示词（热更后）')
    expect(base.text()).toContain('第二版角色提示词（热更后）')
    expect(base.text()).not.toContain('第一版角色提示词')
    unregisterSkiffSession(ref.sessionId)
  })

  it('temporary（无 sessionId）→ 角色提示词为创建时快照（改文件不影响本轮 agent）', async () => {
    const { ctx, sections, promptPath } = promptFileCtx()
    const ref = await createSkiffAgent(ctx as never, dir, 'zhaocai', {
      ...sessionRole(),
      systemPromptFile: '.opencode/skiff/live.md',
    } as never)
    const base = sections.find((s) => s.name === 'serenity-skiff')!
    expect(base.text()).toContain('第一版角色提示词')
    writeFileSync(promptPath, '第二版角色提示词（热更后）')
    // 临时型 = 注入一次（快照语义）
    expect(base.text()).toContain('第一版角色提示词')
    expect(base.text()).not.toContain('第二版角色提示词（热更后）')
    unregisterSkiffSession(ref.sessionId)
  })

  it('显式 kind 覆盖隐式推断：kind=temporary + 稳定 sessionId → 不建工作台 + 快照提示词', async () => {
    const { ctx, sections, promptPath } = promptFileCtx()
    const ref = await createSkiffAgent(ctx as never, dir, 'zhaocai', {
      ...sessionRole(),
      kind: 'temporary',
      systemPromptFile: '.opencode/skiff/live.md',
    } as never, undefined, 'skiff-explicit-temporary')
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(false) // 不建工作台
    const base = sections.find((s) => s.name === 'serenity-skiff')!
    writeFileSync(promptPath, '改了也不该生效')
    expect(base.text()).toContain('第一版角色提示词')
    unregisterSkiffSession(ref.sessionId)
  })

  it('显式 kind 覆盖隐式推断：kind=persistent + 无 sessionId → 建工作台 + 热更提示词', async () => {
    const { ctx, sections, promptPath } = promptFileCtx()
    const ref = await createSkiffAgent(ctx as never, dir, 'zhaocai', {
      ...sessionRole(),
      kind: 'persistent',
      systemPromptFile: '.opencode/skiff/live.md',
    } as never)
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(true) // 建工作台
    const base = sections.find((s) => s.name === 'serenity-skiff')!
    writeFileSync(promptPath, '热更生效')
    expect(base.text()).toContain('热更生效')
    unregisterSkiffSession(ref.sessionId)
  })
})
