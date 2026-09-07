import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** fake agent：session 支持 append（bound 持久化 push 进 events）+ id */
  function sessionAgent(id: string, events: unknown[] = []): { session: { id: string; events: unknown[]; append: (t: string, d: unknown) => void }; followup: () => void } {
    const s = {
      id,
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
    // bound 持久化（note auto-created 标记）
    expect(agent.session.events.some((e) => e.type === 'serenity/bound' && e.data?.note?.startsWith('auto-created for skiff role'))).toBe(true)
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
    expect(agent.session.events.some((e) => e.type === 'serenity/bound')).toBe(false)
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
    // 各自 bound
    expect(userA.session.events.filter((e) => e.type === 'serenity/bound')).toHaveLength(1)
    expect(userB.session.events.filter((e) => e.type === 'serenity/bound')).toHaveLength(1)
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

  it('workspaceTrajectoryLine：systemPrompt 指引含 SESSION.md 路径（agent 上下文）', () => {
    const line = workspaceTrajectoryLine('/x/AGENT_SESSIONS/2026-09-07--S160--zhaocai skiff/SESSION.md')
    expect(line).toContain('SESSION.md: /x/AGENT_SESSIONS/2026-09-07--S160--zhaocai skiff/SESSION.md')
    expect(line).toContain('logbook rebuild resumes from this SESSION')
  })

  it('createSkiffAgent 集成：session 能力角色 → 自动建 + 提示词注入工作台行', async () => {
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
    } as never)
    // 提示词含工作台指引
    expect(sections[0]?.text()).toContain('Your trajectory workspace')
    expect(sections[0]?.text()).toContain('SESSION.md:')
    expect(sections[0]?.text()).toContain('角色人格')
    // 激活命中
    expect(getActiveSessionInfo(ref.sessionId)).not.toBeNull()
    unregisterSkiffSession(ref.sessionId)
    // cleanup 内置 afterEach 已 rm dir；此处 reset active 防污染
  })
})
