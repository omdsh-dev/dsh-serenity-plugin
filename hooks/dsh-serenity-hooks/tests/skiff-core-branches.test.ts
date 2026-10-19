import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  askSkiff,
  ensureWorkspacePromptSection,
  skiffWorkspaceMdPath,
  workspaceCognitiveTrajectoryLine,
  skiffCognitiveTrajectoryEnabled,
  skiffMsmGate,
} from '../src/trajectory/session.js'
import { resetSkiffSessions, registerSkiffSession } from '../src/trajectory/policy/window.js'
import { makeSkiffSession, makeTrajectory, skiffJson } from './helpers/skiff-fixture.js'
import { resetActiveSessionStore } from '../src/trajectory/core.js'

/**
 * skiff-core-branches.test.ts — Skiff 会话核心：**降级面与事件解析容错**（⑤ 第 56 件，S142 2026-09-26）
 *
 * ## 🔴 2026-10-19：随 skiff 重做同步更新的两处范围变更（R↓，为什么本文件被重写而不是只改断言）
 *
 * ① **`askSkiff` 不再返回 `cognitiveTrajectory`**（返回值现只剩 `{answer, sessionId}`）：
 *    旧的"事件 → 认知轨迹"派生（`eventsToCognitiveTrajectory` / `includeCognitiveTrajectory` /
 *    `eventsStart` 全量-增量两语义 / tool_calls 序列化 / 工具结果 500 字截断）**整件退役**。
 *    ⇒ 对应用例**删除**（生产实现已不在 `core.ts`；留着就是对不存在行为的空断言），
 *      保留的是同一段里**仍然活着**的"答案读取"两条形态兼容 —— 它们决定用户能不能收到回复。
 * ② **`ensureSkiffSession` 整件删除**（它会为 skiff 另建一个 SESSION，即"SESSION 爆炸"来源）：
 *    工作台**就是该轨迹自己的 SESSION.md** ⇒ 同一位置的动作从「建」变成「查」
 *    （`skiffWorkspaceMdPath`，纯查询无副作用），C 段改钉这条新语义。
 *
 * 身份判据同时换代：**不再看 `serenity.json` 的 `skiff.roles`，而看「会话绑定的轨迹目录里
 * 有没有 `skiff.json`」** ⇒ 本文件的夹具一律走 `helpers/skiff-fixture.ts`。
 *
 * ## 与既有 `skiff-core.test.ts` 的分工（互补不重叠）
 *
 * 既有文件走**正路**：`createSkiffAgent` 的 resume-or-create、`askSkiff` 的成功往返、
 * `skiffCognitiveTrajectoryEnabled` 与 `skiffMsmGate` 的三态主路。
 * 本文件补它**全部没碰**的降级面与事件形态兼容。
 *
 * ## 🔴 本件的硬前置（纪律 22/23/⑬ 同族）
 *
 * 1. **绝不占活服务端口**：本文件不建 listener（纯函数 ＋ 内存替身），端口纪律自动满足。
 * 2. **模块级状态必须重置**：活跃会话表 `resetActiveSessionStore()` ＋ skiff 会话注册表
 *    `resetSkiffSessions()`（两者都是进程级 Map/Set，用例间必须复位）。
 * 3. **降级面断言须先有 happy-path 正控**（纪律 10 ／ 累积纪律 ⑬ "成对测"）：每条守卫断言
 *    都配一条"同一夹具在正常输入下确实走通"的对照，否则无法区分"守卫生效"与"夹具坏了"。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-core-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
  resetSkiffSessions() // 会话 → 轨迹 的内存注册表（模块级状态，用例间必须复位）
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetSkiffSessions()
  vi.restoreAllMocks()
})

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
// A. 事件形态兼容（sessionEvents 双形态 ＋ assistant 取文两条路径）
//
// 🔴 2026-10-19 的范围变更（本段整体重写的理由，R↓）：
//   `askSkiff` 的返回值**不再有 `cognitiveTrajectory`**（`SkiffAskResult` 现只剩
//   `{answer, sessionId}`）⇒ 旧版的"事件 → 认知轨迹"派生（`eventsToCognitiveTrajectory`、
//   `includeCognitiveTrajectory`、`eventsStart` 全量/增量两语义、tool_calls 序列化、
//   工具结果 500 字截断）**整件退役**，它们的生产实现已不在 `core.ts` 里。
//   ⇒ 对应用例**删除**（不是"断言放宽"）：保留它们只会变成对不存在行为的空断言。
//   ⇒ 下面保留下来的，是**答案读取**这条链上仍然活着的两条形态兼容（它们决定
//      "用户能不能收到回复"，是本段最初的贴 objective）。
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: 事件形态兼容（sessionEvents 双形态 ＋ assistant 取文两条路径）', () => {
  it('🔴 A1：`snapshotEvents()` 形态（**真宿主 rc.1 走的那条**）⇒ 能取到答案', async () => {
    // 真故障形态的反面：rc.1 宿主把 `Session.events` 换成了 `snapshotEvents()` 方法。
    // 既有夹具只给 `.events` ⇒ `sessionEvents` 的兼容分支从未为真。
    const events: unknown[] = []
    const agent = {
      session: { id: 'sess-snap-1', snapshotEvents: () => events },
      followup: () => {
        events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'via snapshotEvents' }] } } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('via snapshotEvents')
  })

  it('🔴 A2：`assistant/message` 的 `data.content` 直挂形态（无 `message` 包裹）⇒ 仍能取到', async () => {
    // `e.data?.message?.content ?? e.data?.content ?? []` —— 既有夹具恒给 `message`
    // 包裹 ⇒ `?? e.data?.content` 这一侧**从未执行**。
    const events: unknown[] = []
    const agent = {
      session: { id: 'sess-flat-1', events },
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
      session: { id: 'sess-wrap-1', events },
      followup: () => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'wrapped' }] } } })
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('wrapped')
  })

  it('🔴 A4：content **非数组**（字符串/null/对象）⇒ 答案取不到就是空串，⛔ 不抛', async () => {
    // 真故障形态：宿主事件里 content 是字符串/null/对象（版本差异或畸形事件）。
    const events: unknown[] = []
    const agent = {
      session: { id: 'sess-bad-1', events },
      followup: () => {
        events.push(
          { type: 'user/message', data: { content: 'not-an-array' } },
          { type: 'assistant/message', data: { message: { content: null } } },
          { type: 'tool/result', data: { name: 'x', content: { not: 'array' } } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    // 判据不只"没崩"，而要**答案真为空**（畸形事件一条都没产出文本）
    expect(result.answer).toBe('')
  })

  it('🔴 A5：事件序列里有 `null` / 缺 `type` 的坏条目 ⇒ **跳过该条、其余照常**', async () => {
    // 真故障形态：事件数组里混入 `null`（宿主侧落盘残缺）。旧实现里这条断言是
    // "轨迹尽力而为"，现在轨迹已退役 ⇒ **同一容错判据改挂在答案读取上**：
    // 坏条目不得让整段读取中止（否则用户收到空回复却查不到原因）。
    const events: unknown[] = []
    const agent = {
      session: { id: 'sess-skip-1', events },
      followup: () => {
        events.push(
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'before' }] } } },
          null, // ← 读取时必须跳过
          { type: 'no-type-here' },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'after' }] } } },
        )
      },
    }
    const result = await askSkiff(fakeCtx(agent) as never, agent as never, 'q')
    // 🔴 判据 = **最后一条**被读到（只断言"没抛"无法区分"跳过"与"整段中止"）
    expect(result.answer).toBe('after')
  })

  it('🔴 A6：`answer` 的 `session.id` 缺失 ⇒ 回落空串（非 "undefined"）', async () => {
    // `String((agent.session as {id?:unknown}).id ?? '')`。
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

  it('A7（正控）：存在 id 时如实带出 ⇒ 证明 A6 的空串来自 ?? 回落', async () => {
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
// C. 工作台路径的退化形态（`skiffWorkspaceMdPath`）
//
// 🔴 2026-10-19：`ensureSkiffSession` **整件删除**（它会为 skiff 另建一个 SESSION ——
//    那正是"SESSION 爆炸"的来源）。新模型里**工作台就是这条轨迹自己的 SESSION.md**，
//    于是同一位置的动作从「**建**」变成「**查**」（纯查询，无副作用）。
// ⇒ 下面四条替代原 C1~C4，钉的是新语义：**不给就不造**、身份跟着**轨迹**走。
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: skiffWorkspaceMdPath 的退化形态', () => {
  it('🔴 C1：会话未登记（无绑定轨迹）⇒ null（**不猜、不新建**）', () => {
    expect(skiffWorkspaceMdPath(dir, 'never-registered-1')).toBeNull()
    expect(skiffWorkspaceMdPath(dir, undefined)).toBeNull()
  })

  it('🔴 C2：登记了轨迹，但该轨迹目录里**没有 SESSION.md** ⇒ null（不代建）', () => {
    // 旧 `ensureSkiffSession` 在这里会**新建**一个 SESSION —— 那正是要钉死的旧行为。
    const dirName = makeSkiffSession(dir, 'sess-empty-body', 'empty-body', skiffJson({ tools: [] }))
    rmSync(join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'))
    expect(skiffWorkspaceMdPath(dir, 'sess-empty-body')).toBeNull()
  })

  it('🔴 C3：登记的轨迹有 SESSION.md ⇒ 返回**那条轨迹自己的** SESSION.md 路径', () => {
    const dirName = makeSkiffSession(dir, 'sess-own-body', 'qa', skiffJson({ tools: [] }))
    const md = skiffWorkspaceMdPath(dir, 'sess-own-body')
    expect(md).not.toBeNull()
    expect(md).toBe(join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'))
    // 🔴 语义钉：**不新建目录**——路径必须落在已存在的轨迹目录里（旧的"另建工作台"会指向别处）
    expect(md).toContain(dirName)
  })

  it('C4（正控）：换一个会话 id 指向**另一条轨迹** ⇒ 返回的是那条轨迹的 SESSION.md', () => {
    const dirA = makeSkiffSession(dir, 'sess-a', 'traj-a', skiffJson({ tools: [] }), 'trajA')
    const dirB = makeSkiffSession(dir, 'sess-b', 'traj-b', skiffJson({ tools: [] }), 'trajB')
    // 身份跟着**轨迹**走（旧模型的身份是 sessionId 前缀 `skiff-`，且与轨迹无关）
    expect(skiffWorkspaceMdPath(dir, 'sess-a')).toContain(dirA)
    expect(skiffWorkspaceMdPath(dir, 'sess-b')).toContain(dirB)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. skiffCognitiveTrajectoryEnabled / skiffMsmGate 的边角
//
// 🔴 2026-10-19：身份判据换了 —— 不再是「`serenity.json` 里配没配这个角色」，
//    而是「**会话绑定的轨迹目录里有没有 `skiff.json`**」（`trajectory/policy/profile.ts`）。
//    ⇒ 夹具从 writeConfig(`skiff.roles`) 改为 makeSkiffSession（真造一条带 `skiff.json` 的轨迹）。
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: 门控函数的边角（轨迹没有 skiff.json / 无 msms 声明）', () => {
  it('🔴 D1：会话绑定到**没有 skiff.json 的普通轨迹** ⇒ 判「不是 skiff」⇒ 纪律**恒参与**（fail-open）', () => {
    // 新语义（R↓ 见 core.ts 的 `skiffCognitiveTrajectoryEnabled` 注释）：拿不到约束面 ⇒
    // 按"不是 skiff"处理 ⇒ **正常参与**。旧模型这里判的是 `false`（保守旁路）——
    // 那是旧"角色可能被删"场景的产物；新模型里"约束面不存在"只意味着"这条轨迹是普通轨迹"。
    // ⚠️ 夹具要点：`makeSkiffSession(root, sid, code, null)` 内部是 `profile ?? {}`
    //    ⇒ 仍会落一个空 `skiff.json`，那样测的是"约束面全默认 true"而不是 fail-open。
    //    要造真正的普通轨迹必须用 `makeTrajectory(root, code, null)`（不写文件）＋ 手工登记。
    const { dirName } = makeTrajectory(dir, 'plain-trajectory', null)
    registerSkiffSession('sess-plain', dirName, dir)
    expect(skiffCognitiveTrajectoryEnabled(dir, 'sess-plain', 'session')).toBe(true)
    expect(skiffCognitiveTrajectoryEnabled(dir, 'sess-plain', 'keeper')).toBe(true)
    expect(skiffCognitiveTrajectoryEnabled(dir, 'sess-plain', 'rebuild')).toBe(true)
  })

  it('🔴 D1b：`skiff.json` 显式写 `session:false` ⇒ 那一条**不参与**（真 skiff 的开关仍有效）', () => {
    // 与 D1 成对：D1 证明"不是 skiff ⇒ 恒参与"，这条证明"是 skiff 时开关读得到"
    // （否则 D1 会退化成"这函数恒 true"的空断言）。
    makeSkiffSession(dir, 'sess-explicit', 'qa', skiffJson({
      tools: ['read'],
      cognitiveTrajectory: { session: false, keeper: true, rebuild: true },
    }))
    expect(skiffCognitiveTrajectoryEnabled(dir, 'sess-explicit', 'session')).toBe(false)
    expect(skiffCognitiveTrajectoryEnabled(dir, 'sess-explicit', 'keeper')).toBe(true)
  })

  it('🔴 D2：`skiff.json` 里**没有 msms 键** ⇒ `exec` 拒绝（缺省空表，不是放行）', () => {
    // 真故障形态：约束面只写 tools 不写 msms（**合法且常见**——只用平台工具、不用 MSM）。
    // ⚠️ 必须走**真 `skiff.json`**（`makeSkiffSession` 会写盘），不能用内存替身：
    //    读侧 `strList` 把缺项归一成 `[]`，正是要兜的形态。
    makeSkiffSession(dir, 'sess-no-msm', 'no-msm-role', skiffJson({ tools: ['read'] }))

    // 🔴 判据 = **拒绝**（不是静默放行）。缺项若被写成 `?? ['*']` 或漏掉，这里就会放行。
    expect(skiffMsmGate(dir, 'sess-no-msm', 'exec', 'anything').reject).toContain('MSM not allowed')
  })

  it('D3（正控）：`skiff.json` **有** msms 声明且命中 ⇒ 放行 ⇒ 与 D2 成对', () => {
    makeSkiffSession(dir, 'sess-with-msm', 'with-msm-role', skiffJson({ tools: ['read'], msms: ['memory-tool'] }))
    expect(skiffMsmGate(dir, 'sess-with-msm', 'exec', 'memory-tool')).toEqual({})
    // 未声明的 MSM 仍拒绝（白名单是**逐条**判，不是"配过就全放"）
    expect(skiffMsmGate(dir, 'sess-with-msm', 'exec', 'other-msm').reject).toContain('MSM not allowed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. workspaceCognitiveTrajectoryLine 的内容契约
// ─────────────────────────────────────────────────────────────────────────────

describe('skiff-core: workspaceCognitiveTrajectoryLine 的内容契约', () => {
  it('🔴 E1：含 SESSION.md 路径 ＋ 「不点名具体写入工具」纪律（v1.30.13 的 ACC/CCC 归属二分）', () => {
    const line = workspaceCognitiveTrajectoryLine('/some/path/SESSION.md')
    expect(line).toContain('/some/path/SESSION.md')
    // v1.30.13 的关键修正：**不得**写死 write/edit（my-role 白名单已移除它们）
    expect(line).not.toContain('with write/edit')
    expect(line).toContain('never assume')
    // 七段固定格式清单必须在场（与 D88 的格式契约同源）
    expect(line).toContain('身份与边界')
    expect(line).toContain('待 owner 裁决')
  })
})
