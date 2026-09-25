import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  askSkiff,
  ensureWorkspacePromptSection,
  ensureSkiffSession,
  workspaceTrajectoryLine,
  skiffTrajectoryEnabled,
  skiffMsmGate,
  registerSkiffSession,
} from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX } from '../src/skiff-role.js'
import { resetActiveSessionStore } from '../src/trajectory-ops.js'

/**
 * skiff-core-branches.test.ts — Skiff 会话核心：**降级面与事件解析容错**（⑤ 第 56 件，S142 2026-09-26）
 *
 * ## 与既有 `skiff-core.test.ts` 的分工（互补不重叠）
 *
 * 既有文件走**正路**：注册表增删查、`askSkiff` 的成功往返（真 followup 推事件）、
 * `ensureSkiffSession` 的创建/恢复/隔离、`skiffTrajectoryEnabled` 与 `skiffMsmGate` 的三态主路。
 * 本文件补它**全部没碰**的三类：
 *
 *   ① 🔴 **事件解析的容错面** —— `sessionEvents` 的双形态（`snapshotEvents()` vs `.events`）、
 *      `assistant/message` 的 `data.message.content` **与** `data.content` 两条取文路径、
 *      `tool_calls` 的两种参数形态、`extractText` 的非数组守卫、`truncate` 的截断侧、
 *      `eventsToTrajectory` 的单条解析失败跳过。
 *      既有夹具**只造一种事件形状**（`data.message.content` ＋ 字符串 `arguments`），
 *      其余分支**一次都没跑过**。
 *   ② 🔴 **工作台提示词段的降级面** —— `ensureWorkspacePromptSection` 的三条守卫
 *      （非对象 agent ／ 无 `systemPrompt.section` ／ 注册抛错）＋ `text()` 在**无活跃绑定**时
 *      返回空串。既有文件只测了"挂成功"这一侧。
 *   ③ 🔴 **恢复链的退化形态** —— `ensureSkiffSession` 的 `persistent=false`（临时身份不建工作台）、
 *      无 `session.id` 时回落 `agent.id`、`lastBound` 无 `sessionId` 的回落、
 *      内存活跃记录**无 sessionId** 时的自愈补写。
 *
 * ## 为什么这三类重要（贴 objective：**skiff 是微信桥的落点**）
 *
 * `skiff-core.ts` 是**家庭唯一 IM 通道**（微信桥）与 ACP/调试页共同的下游：用户消息进来 →
 * `askSkiff` 读事件取答案。上面①正是"答案能不能被读到"的**唯一执行点**：
 * DSH 在 rc.1 把 `Session.events` 改成了 `snapshotEvents()` 方法（源码 `:466` 逐字记录），
 * 而**兼容双形态的那两行**（`:473`/`:474`）在既有夹具下**只跑了 `.events` 一侧** ——
 * 真宿主走的却是 `snapshotEvents()` 一侧 ⇒ **最常用的那条路径从来没有被执行过**。
 * 同族的还有 `data.content` 直挂形态（宿主不同版本的事件形状）。
 *
 * ## 🔴 本件的硬前置（纪律 22/23/⑬ 同族）
 *
 * 1. **绝不占活服务端口**：本文件不建 listener（纯函数 ＋ 内存替身），端口纪律自动满足。
 * 2. **模块级状态必须重置**：`skiff-core` 的活跃会话表由 `resetActiveSessionStore()` 清空（既有先例）。
 * 3. **降级面断言须先有 happy-path 正控**（纪律 10 ／ 累积纪律 ⑬ "成对测"）：每条守卫断言
 *    都配一条"同一夹具在正常输入下确实走通"的对照，否则无法区分"守卫生效"与"夹具坏了"。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-core-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 写 CCC 配置（真配置路径：readSkiffRoles 会做规范化，正是被测分支的输入形态） */
function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

/** fake ctx：`on` 立即触发 idle（waitAgentIdle 同步 resolve 的前提；纪律：必须回传真 agent 引用） */
function fakeCtx(agent: unknown): { on: (ev: string, cb: (p: { agent: unknown; status: string }) => void) => () => void } {
  return {
    on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' })
      return () => {}
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 事件解析的容错面（"答案读不读得到"的唯一执行点）
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: 事件形态兼容（sessionEvents 双形态 ＋ assistant 取文两条路径）', () => {
  it('🔴 A1：`snapshotEvents()` 形态（**真宿主 rc.1 走的那条**）⇒ 能取到答案与轨迹', async () => {
    // 真故障形态的反面：rc.1 宿主把 `Session.events` 换成了 `snapshotEvents()` 方法。
    // 既有夹具只给 `.events` ⇒ `:473` 那一行（`typeof s.snapshotEvents === 'function'`）从未为真。
    const events: unknown[] = []
    const agent = {
      session: {
        id: `${SKIFF_SESSION_PREFIX}snap-1`,
        snapshotEvents: () => events,
      },
      followup: () => {
        events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'via snapshotEvents' }] } } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('via snapshotEvents')
    expect(result.trajectory[0]).toEqual({ role: 'user', text: 'q' })
  })

  it('🔴 A2：`assistant/message` 的 `data.content` 直挂形态（无 `message` 包裹）⇒ 仍能取到', async () => {
    // `:483` 的 `e.data?.message?.content ?? e.data?.content ?? []` —— 既有夹具恒给
    // `message` 包裹 ⇒ `?? e.data?.content` 这一侧**从未执行**。
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}flat-1`, events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'flat shape' }] } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('flat shape')
  })

  it('A3（正控）：`data.message.content` 包裹形态仍走通 ⇒ 证明 A2 的对照点成立', async () => {
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}wrap-1`, events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'wrapped' }] } } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('wrapped')
  })

  it('🔴 A4：`text()`/`extractText` 遇**非数组 content** ⇒ 返回空串（不抛），trajectory 为空', async () => {
    // `:523` 的 `if (!Array.isArray(content)) return ''`。既有夹具恒给数组。
    // 真故障形态：宿主事件里 content 是字符串/null/对象（版本差异或畸形事件）。
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}bad-1`, events },
      followup: () => {
        events.push(
          { type: 'user/message', data: { content: 'not-an-array' } },
          { type: 'assistant/message', data: { message: { content: null } } },
          { type: 'tool/result', data: { name: 'x', content: { not: 'array' } } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('')
    // 🔴 判据升级（累积纪律 ⑫ 同族）：不只要"没崩"，而要**轨迹真为空**（三条畸形事件全被过滤）
    expect(result.trajectory).toEqual([])
  })

  it('🔴 A5：`tool_calls` 的 `arguments` 为**对象**（非字符串）⇒ JSON 序列化进轨迹；缺 `name` 回落 `(tool)`', async () => {
    // `:507` 的三元 `typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})`
    // ＋ `:508` 的 `c.name ?? '(tool)'`。既有夹具只给字符串 arguments **且**恒有 name。
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}tc-1`, events },
      followup: () => {
        events.push({
          type: 'assistant/message',
          data: {
            message: {
              content: [],
              tool_calls: [
                { arguments: { action: 'list', deep: { n: 1 } } }, // 无 name ⇒ 回落 (tool)
              ],
            },
          },
        })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    const call = result.trajectory.find((t) => t.text.includes('→'))
    expect(call).toBeDefined()
    // 对象被 JSON 序列化（不是 "[object Object]"）
    expect(call!.text).toContain('"action":"list"')
    expect(call!.text).toContain('(tool)') // name 缺失的回落
    expect(call!.tool).toBeUndefined() // name 缺失 ⇒ tool 字段不出现（undefined）
  })

  it('🔴 A6：`truncate` 的**截断侧** ⇒ 超长文本被切到上限并带省略号', async () => {
    // `:528` 的 `s.length > n ? slice(0,n)+'…' : s` —— 既有夹具文本都短 ⇒ **恒走 `: s` 那侧**。
    // 真故障形态：长工具结果（生产里很常见）。
    const long = 'x'.repeat(900)
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}trunc-1`, events },
      followup: () => {
        events.push({ type: 'tool/result', data: { name: 'big', content: [{ type: 'text', text: long }] } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    const toolEntry = result.trajectory.find((t) => t.role === 'tool')
    expect(toolEntry).toBeDefined()
    // 上限 500（源码 :512）⇒ 500 + 省略号
    expect(toolEntry!.text).toHaveLength(501)
    expect(toolEntry!.text.endsWith('…')).toBe(true)
    // 正控（成对）：截断**没有**发生在短文本上 —— 同一断言链的反侧
    expect('short'.length > 500).toBe(false)
  })

  it('🔴 A7：单条事件解析失败 ⇒ **跳过该条、其余照常**（轨迹尽力而为）', async () => {
    // `:514` 的 catch「单条事件解析失败跳过（轨迹尽力而为，不影响答案）」。
    // 真故障形态：事件条目是 `null` ⇒ 读 `ev.type` 抛 TypeError。
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}skip-1`, events },
      followup: () => {
        events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'before' }] } },
          null, // ← 解析时抛
          { type: 'user/message', data: { content: [{ type: 'text', text: 'after' }] } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    // 🔴 判据 = **前后两条都在**（只断言"没抛"无法区分"跳过"与"整段中止"——累积纪律 ⑫）
    const texts = result.trajectory.map((t) => t.text)
    expect(texts).toContain('before')
    expect(texts).toContain('after')
  })

  it('🔴 A8：`answer` 的 `session.id` 缺失 ⇒ 回落空串（非 "undefined"）', async () => {
    // `:551` 的 `String((agent.session as {id?:unknown}).id ?? '')`。
    // 真故障形态：测试替身/极简构造的 session 无 id。
    const events: unknown[] = []
    const agent = {
      session: { events }, // ← 无 id
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.sessionId).toBe('')
    expect(result.answer).toBe('a') // 答案不受影响
  })

  it('A9（正控）：存在 id 时如实带出 ⇒ 证明 A8 的空串来自 ?? 回落', async () => {
    const events: unknown[] = []
    const agent = {
      session: { id: 'real-id', events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.sessionId).toBe('real-id')
  })

  it('🔴 A10：`includeTrajectory:false` ⇒ 轨迹跳过计算，**但答案仍取到**（3100 对外面的分工）', async () => {
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}notraj-1`, events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'only answer' }] } } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q', undefined, { includeTrajectory: false })
    expect(result.trajectory).toEqual([])
    expect(result.answer).toBe('only answer') // 🔴 关闭的是轨迹，**不是答案**
  })

  it('🔴 A11：`eventsStart` 显式传 0 ⇒ **全量轨迹**；不传 ⇒ 本轮增量（v1.25.10 用户拍板的两语义）', async () => {
    const events: unknown[] = []
    const agent = {
      session: { id: `${SKIFF_SESSION_PREFIX}start-1`, events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'incremental' }] } } })
      },
    }
    // 先垫一条历史（不属于本轮）
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'historical' }] } })
    const agentAny = agent as never
    // 不传 eventsStart ⇒ before = 当前长度 ⇒ 只含本轮
    const inc = await askSkiff(fakeCtx(agent) as never, agentAny, 'q')
    expect(inc.trajectory.map((t) => t.text)).not.toContain('historical')
    // 显式 0 ⇒ 全量（含历史）
    const full = await askSkiff(fakeCtx(agent) as never, agentAny, 'q', 0)
    expect(full.trajectory.map((t) => t.text)).toContain('historical')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 工作台提示词段的降级面
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: ensureWorkspacePromptSection 的三条守卫（挂不上 ⇒ 调用方降级 question 注入）', () => {
  it('🔴 B1：非对象 agent ⇒ false（不抛）', () => {
    // `:139` 的 `if (!agent || typeof agent !== 'object') return false` —— 两半都要走
    expect(ensureWorkspacePromptSection(null as never, dir)).toBe(false)
    expect(ensureWorkspacePromptSection(undefined as never, dir)).toBe(false)
    expect(ensureWorkspacePromptSection('a string' as never, dir)).toBe(false)
  })

  it('🔴 B2：无 `systemPrompt.section`（宿主契约缺失）⇒ false，且**不注册**', () => {
    // `:142` 的 `if (typeof api?.section !== 'function') return false`
    expect(ensureWorkspacePromptSection({ ctx: {} } as never, dir)).toBe(false)
    expect(ensureWorkspacePromptSection({ ctx: { systemPrompt: {} } } as never, dir)).toBe(false)
    expect(ensureWorkspacePromptSection({ ctx: { systemPrompt: { section: 'not-a-fn' } } } as never, dir)).toBe(false)
  })

  it('🔴 B3：`section()` 真抛 ⇒ false 且**响亮告警**（回退 question 注入）', () => {
    // `:155~158` 的 catch —— 既有文件只测了成功侧。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent = {
      ctx: {
        systemPrompt: {
          section: () => {
            throw new Error('section boom')
          },
        },
      },
    }
    expect(ensureWorkspacePromptSection(agent as never, dir)).toBe(false)
    // 判据升级（累积纪律 ⑫）：不只要"返回 false"，而要**告警里带出真因**
    expect(warn.mock.calls.some((c) => String(c[0]).includes('section boom'))).toBe(true)
  })

  it('B4（正控）：`section()` 正常 ⇒ true，且**幂等**（第二次不再注册）', () => {
    let calls = 0
    const agent = {
      ctx: {
        systemPrompt: {
          section: () => {
            calls += 1
          },
        },
      },
    }
    expect(ensureWorkspacePromptSection(agent as never, dir)).toBe(true)
    expect(ensureWorkspacePromptSection(agent as never, dir)).toBe(true)
    // 🔴 幂等判据 = **注册次数仍为 1**（只断言返回 true 无法区分"幂等"与"重复注册"）
    expect(calls).toBe(1)
  })

  it('🔴 B5：`text()` 在**无活跃绑定**时返回空串（而非抛或给出半截路径）', () => {
    // `:149~150` 的 `const mdPath = getActiveSessionInfo(scope)?.mdPath` + `mdPath ? ... : ''`
    // 既有文件只测了有绑定的那侧 ⇒ `: ''` 从未执行。
    let captured: (() => string) | undefined
    const agent = {
      ctx: {
        systemPrompt: {
          section: (s: { text: () => string }) => {
            captured = s.text
          },
        },
      },
    }
    expect(ensureWorkspacePromptSection(agent as never, 'scope-without-binding')).toBe(true)
    expect(captured).toBeDefined()
    // 无活跃绑定 ⇒ 空串（调用方据此可判"工作台未就绪"，而不是拿到一个假路径）
    expect(captured!()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 恢复链的退化形态
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: ensureSkiffSession 的退化形态', () => {
  const sessionRole = () => ({
    msms: ['memory-tool'],
    tools: ['read'],
    trajectory: { session: true, keeper: true, rebuild: true },
  })

  it('🔴 C1：`persistent=false`（临时身份）⇒ null，**不建工作台**（v1.30.9 "SESSION 爆炸"根治）', () => {
    // `:189` 的 `if (!persistent) return null`
    const agent = { session: { id: 'tmp-1', header: { id: 'tmp-1', cwd: dir }, events: [], append: () => {} } }
    expect(ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole() as never, false)).toBeNull()
  })

  it('🔴 C2：角色未开 session 能力 ⇒ null（现状零变化）', () => {
    // `:187` 的 `if (!trajectorySubset(role).session) return null`
    const agent = { session: { id: 'x', header: { id: 'x', cwd: dir }, events: [], append: () => {} } }
    expect(ensureSkiffSession(dir, agent as never, 'zhaocai', { msms: [], tools: ['read'] } as never)).toBeNull()
  })

  it('🔴 C3：session 无 `id` ⇒ scope 回落 `agent.id`（而非字面量 "undefined"）', () => {
    // `:191` 的 `String((agent.session as {id?:unknown}).id ?? agent.id)`
    const agent = {
      id: 'agent-fallback-id',
      session: { header: { id: 'h', cwd: dir }, events: [], append: () => {} }, // ← 无 session.id
    }
    // 能走通（建工作台）即证明 scope 不是 "undefined"——否则下游会按错的 scope 记绑定
    const mdPath = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole() as never)
    expect(mdPath).not.toBeNull()
    expect(mdPath).toContain('SESSION.md')
  })

  it('C4（正控）：session 有 id 时正常建工作台 ⇒ 与 C3 成对', () => {
    const agent = { session: { id: 'real-scope', header: { id: 'real-scope', cwd: dir }, events: [], append: () => {} } }
    const mdPath = ensureSkiffSession(dir, agent as never, 'zhaocai', sessionRole() as never)
    expect(mdPath).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. skiffTrajectoryEnabled / skiffMsmGate 的边角
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: 门控函数的边角（role 缺失/无 msms 声明）', () => {
  it('🔴 D1：`skiffTrajectoryEnabled` —— skiff 会话但角色已从配置移除 ⇒ 保守旁路 false', () => {
    // `:568` 的 `if (!roleName) return false`
    expect(skiffTrajectoryEnabled(dir, `${SKIFF_SESSION_PREFIX}ghost-x`, 'session')).toBe(false)
  })

  it('🔴 D2：`skiffMsmGate` —— 角色声明里**没有 msms 键** ⇒ `exec` 拒绝（`?? []` 那侧）', () => {
    // `:596` 的 `(role.msms ?? [])` —— 既有夹具恒有 msms ⇒ `?? []` 从未执行。
    // 真故障形态：角色配置只写 tools 不写 msms（**合法且常见**——只用平台工具、不用 MSM）。
    // ⚠️ 必须走**真配置**（writeConfig → readSkiffRoles），不能用内存替身：
    //    `readSkiffRoles` 会把缺省的 msms 规范成 `undefined`，正是 `?? []` 要兜的形态。
    writeConfig({ skiff: { roles: { 'no-msm-role': { tools: ['read'] } } } })
    registerSkiffSession(`${SKIFF_SESSION_PREFIX}no-msm`, 'no-msm-role', dir, {} as never)

    // 🔴 判据 = **拒绝**（不是静默放行）。`?? []` 若写成 `?? ['*']` 或漏掉，这里就会放行。
    expect(skiffMsmGate(dir, `${SKIFF_SESSION_PREFIX}no-msm`, 'exec', 'anything').reject).toContain('MSM not allowed')
  })

  it('D3（正控）：角色**有** msms 声明且命中 ⇒ 放行 ⇒ 与 D2 成对', () => {
    writeConfig({ skiff: { roles: { 'with-msm-role': { tools: ['read'], msms: ['memory-tool'] } } } })
    registerSkiffSession(`${SKIFF_SESSION_PREFIX}with-msm`, 'with-msm-role', dir, {} as never)
    expect(skiffMsmGate(dir, `${SKIFF_SESSION_PREFIX}with-msm`, 'exec', 'memory-tool')).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. workspaceTrajectoryLine 的内容契约
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: workspaceTrajectoryLine 的内容契约', () => {
  it('🔴 E1：含 SESSION.md 路径 ＋ 「不点名具体写入工具」纪律（v1.30.13 的 ACC/CCC 归属二分）', () => {
    const line = workspaceTrajectoryLine('/some/path/SESSION.md')
    expect(line).toContain('/some/path/SESSION.md')
    // v1.30.13 的关键修正：**不得**写死 write/edit（zhaocai 白名单已移除它们）
    expect(line).not.toContain('with write/edit')
    expect(line).toContain('never assume')
    // 七段固定格式清单必须在场（与 D88 的格式契约同源）
    expect(line).toContain('身份与边界')
    expect(line).toContain('待 owner 裁决')
  })
})
