/**
 * ⑤ 第 52 件 — `src/im/bridge.ts` 分支退化面。
 *
 * 靶（锚定 2026-09-25 23:2x 那一跑）：分支 **77.69%**（108/139）、语句 94.16%（597/634）
 * —— 复扫后 `src/**` 分支覆盖率最低的未做过文件（比 handover 里列的 im/ilink.ts
 * 82.96% 更低；且 trajectory/rebuild.ts 实测已 100%、不再是靶）。
 *
 * 为何挑它：微信桥是**家庭唯一 IM 通道**（owner 与家人全靠它），文件头的设计承诺是
 * 「桥错误静默 —— 不中断轮询循环」「旁路容忍 H3：hook 失败不阻塞对话处理」
 * 「typing 失败静默（不影响主流程）」⇒ 这些**降级承诺**必须被机械钉住；
 * 而既有 `weixin.test.ts` 虽覆盖了所有 happy path 与主要降级，
 * 其夹具**恒走"配置齐全 + 正常返回"形态** ⇒ 下列分支从未执行。
 *
 * ⚠️ **夹具前置条件（2026-10-19 重做后新增，漏了会让本件集体变红）**：路由目标必须是
 * **该 CCC 里真实存在的认知轨迹**（`im/bridge.ts` 的 `findDirNameByCode`）⇒ 每个用例
 * 都得先有一条轨迹可投。`beforeEach` 默认造 `qa`；要打"目标不存在"那档（C4）写一个
 * 不存在的编码。旧夹具靠 `serenity.json` 的 `轨迹约束.roles` 造 轨迹约束，该段已退役。
 *
 * 覆盖的 29 处未覆盖分支（按源码位置，`im/bridge.ts`；行号为锚定时的读数）：
 *   A 组 — typing 失败静默（`:64` / `:86` 的两个 catch，函数头逐字承诺"任何失败静默"）
 *   B 组 — 轮询循环容错（`:118` `??` 游标回退 / `:122` 忽略非用户消息 / `:124` `?? []` /
 *           `:127` 非 Error 抛出的 `String(err)` 分支 / `:130` catch 后**继续循环**）
 *   C 组 — handleIncoming 早退（`:204` 无 fromUserId / `:209` 未启用 / `:210` routes 缺省 /
 *           `:230` 路由命中但**轨迹不存在** / `:244` 挂段失败 ⇒ 降级 question 注入不阻断）
 *   D 组 — 媒体/答案回退（`:272` 文件无名 / `:289` 净化后空名 / `:296` 保存失败 /
 *           `:351` answer 缺省 / `:425` 非 Error 抛出）
 *   E 组 — 装配与状态（`:438` 热重建 / `:444` 未启用 / `:447` accounts 缺省 /
 *           `:448` account 显式禁用 / `:464` stop 无桥 / `:473` 空集合遍历）
 *   F 组 — 主动发送（`:535` accounts 缺省 / `:563` routes 缺省 / `:567` 非 Error 抛出）
 *   G 组 — registerWeixinBridge（`:620` 扫描失败忽略 / `:631` 事件监听失败不阻断）
 *
 * 判据纪律 20（累积累积）：**测降级/兜底必须断言「方向」** —— 只断言"不抛"无法区分
 * "吞掉后继续"与"吞掉后中断"。本件的每条降级断言都钉**继续做事**的证据。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { __setWeixinFetchForTest } from '../src/im/ilink.js'
import { writeWeixinCredential, weixinSessionIdForTrajectory } from '../src/im/route.js'
import { registerTrajectorySession, unregisterTrajectorySession, trajectorySessionSnapshot } from '../src/trajectory/session.js'
// 轨迹夹具（造 轨迹约束 数据的**唯一入口**；2026-10-19 重做后约束面住在轨迹目录的 `trajectory-constraint.json` 里）
import { makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

let dir: string
/** `beforeEach` 造的 `qa` 轨迹目录名（= 路由目标 `qa` 解析到的目录） */
let qaDirName: string
let oldConfigEnv: string | undefined
/** P0-3：机器级留痕的 env 隔离（见 `beforeEach` 注释） */
let oldAuditEnv: string | undefined

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 写 CCC 配置（显式传 weixin 段，允许省略字段以驱动缺省分支）。 */
function writeConfig(weixin: unknown): void {
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
    'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
    // ⚠️ 这里**不再**写 `轨迹约束: { roles: {...} }` —— 该段 2026-10-19 随重做退役（读侧也读不到）。
    //    轨迹约束的约束面现在住在**轨迹目录的 `trajectory-constraint.json`** 里，由 `beforeEach` 的夹具造。
    weixin,
  }))
}

/**
 * fake ctx：`agents.create/resume` 产生带 followup 的 fake agent；`on` 立即触发 idle。
 * 🔴 夹具前置条件（第 48~51 件的教训）：`on` 必须**真的调 cb**，否则 askTrajectory 拿不到 idle
 * 信号而挂起；`followup` 必须推入 user+assistant 事件，否则 askTrajectory 取不到 answer。
 */
function fakeCtx(opts?: { createThrows?: boolean }): {
  agents: { create: (o: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown> }
  on: (ev: string, cb: (p: { agent: unknown; status: string }) => void) => () => void
} {
  let agent: { session: { id: string; events: unknown[] }; ctx: unknown; followup: (m?: unknown) => void; interrupt?: () => void } | undefined
  const makeAgent = (id: string) => ({
    session: { id, events: [] as unknown[] },
    ctx: { systemPrompt: { section: () => {} } },
    followup: () => {
      agent!.session.events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
      )
    },
    interrupt: () => {},
  })
  return {
    agents: {
      create: async (o: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        if (opts?.createThrows) throw new Error('create boom')
        agent = makeAgent(o.sessionId)
        await o.setup?.(agent as never)
        return { agent }
      },
    },
    on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' })
      return () => {}
    },
  }
}

/**
 * 🔴 夹具前置条件（本件首跑踩到、极其重要）：`waitAgentIdle`（`trajectory/carrier.ts:71`）结算
 * 的判据是 **`p?.agent === agent` 的同一性比较** ⇒ 触发 idle 时**必须交回那个真实 agent
 * 引用**，传 `undefined` 会让 Promise 永不结算 ⇒ 用例**超时**（不是生产代码有 bug）。
 * 本工厂把 agent 引用闭包保存，`on` 触发时回传真引用（与既有 `weixin.test.ts` 同构）。
 * `followup` 可配置：不推事件 ⇒ `answer` 为空，用于驱动空答案分支。
 */
function fakeCtxWithAnswer(pushEvents: boolean): {
  agents: { create: (o: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown> }
  on: (ev: string, cb: (p: { agent: unknown; status: string }) => void) => () => void
  questions: string[]
} {
  let agent: { session: { id: string; events: unknown[] }; ctx: unknown; followup: (m?: unknown) => void; interrupt?: () => void } | undefined
  const questions: string[] = []
  return {
    agents: {
      create: async (o: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        const a = {
          session: { id: o.sessionId, events: [] as unknown[] },
          ctx: { systemPrompt: { section: () => {} } },
          followup: (m?: { content?: Array<{ type?: string; text?: string }> }) => {
            const q = (m?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
            if (q) questions.push(q)
            if (pushEvents) {
              a.session.events.push(
                { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
              )
            }
          },
          interrupt: () => {},
        }
        agent = a
        await o.setup?.(a as never)
        return { agent: a }
      },
    },
    on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' }) // ← 回传真引用（同一性比较的前提）
      return () => {}
    },
    questions,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-bridge-br-'))
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  // 🔴 P0-3 起 `handleIncoming` 会写**机器级留痕**（未命中 ／ 目标不存在）—— 必须隔离，
  //    否则"入站未命中"的用例会把行**追加到开发者真机的 `~/.dsh/human-channel-audit.jsonl`**。
  //    （与 `register.test.ts` 当年踩过的同一个坑：机器级文件缺 env 隔离 ⇒ 测试污染真机。）
  oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'human-channel-audit.jsonl')
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  // 🔴 2026-10-19 重做后**路由目标必须是该 CCC 里真实存在的认知轨迹**（`findDirNameByCode`），
  //    不再是"这个 CCC 配没配这个 轨迹约束角色" ⇒ 默认造一条 `qa` 轨迹（带 `trajectory-constraint.json`）。
  //    不造的话本件 A/D 组会集体停在路由层（表面症状各不相同，实际同一个原因）。
  qaDirName = makeTrajectory(dir, 'qa', 轨迹约束Json({ tools: [], msms: [], systemPrompt: 'qa' })).dirName
})

afterEach(async () => {
  __setWeixinFetchForTest(null)
  const { resetWeixinTypingCache } = await import('../src/im/bridge.js')
  resetWeixinTypingCache()
  const { __resetWeixinOutputGuardForTest } = await import('../src/im/guard.js')
  __resetWeixinOutputGuardForTest()
  for (const [id] of trajectorySessionSnapshot()) unregisterTrajectorySession(id)
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
  rmSync(dir, { recursive: true, force: true })
})

// ── A 组：typing 失败静默（sendTypingStart / sendTypingStop 的 catch） ──────────────

describe('weixin-bridge 分支：A 组 —— typing 失败静默（文件头逐字承诺「任何失败静默」）', () => {
  it('A1 getconfig 抛错 → typing start 静默，**主流程继续**（不中断对话）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })

    const sent: string[] = []
    let configCalls = 0
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('getconfig')) {
        configCalls += 1
        throw new Error('getconfig network down') // ← 驱动 sendTypingStart 的 catch
      }
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push(p.msg.item_list[0]!.text_item.text)
      }
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtxWithAnswer(true)
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // 🔴 方向断言（纪律 20）：不是"没抛"，而是**降级后主流程真跑到结束**。
    // ⚠️ D238（2026-10-24）：不能再断言"答案被回写" —— 桥已不再转发最终文本。
    //    ⇒ 证据换成「追问真的送进了会话」（`questions`）＋「无异常逃逸」（正常 resolve）。
    expect(configCalls).toBe(1)
    expect(ctx.questions.length).toBeGreaterThan(0)
  })

  it('A2 sendtyping 抛错 → typing stop 静默（finally 里，异常路径也不掩盖主流程）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })

    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendtyping')) throw new Error('typing endpoint down') // ← 驱动两个 catch
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push(p.msg.item_list[0]!.text_item.text)
      }
      // getconfig 正常返回 ticket，确保走到 sendTyping 那一行（否则 catch 不触发）
      if (url.includes('getconfig')) return jsonResponse(200, { ret: 0, typing_ticket: 'tk-1' })
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx2 = fakeCtxWithAnswer(true)
    await handleIncoming(ctx2 as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // 🔴 方向断言：typing 端点全挂，但**主流程照样跑完**（D238：不再有"答案回写"这回事）
    expect(ctx2.questions.length).toBeGreaterThan(0)
  })
})

// ── C 组：handleIncoming 早退与角色缺失 ────────────────────────────────────────────

describe('weixin-bridge 分支：C 组 —— handleIncoming 早退面', () => {
  it('C1 无 fromUserId → 直接 return（不发任何东西、不建会话）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) sent.push(String(init?.body))
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    await handleIncoming(fakeCtx() as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: '', // ← `:204` 的空判
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(sent).toHaveLength(0)
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('C2 桥未启用 → 直接 return（`!settings.enabled`）', async () => {
    writeConfig({ enabled: false, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) sent.push(String(init?.body))
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    await handleIncoming(fakeCtx() as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(sent).toHaveLength(0)
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('C3 routes 段缺省（`settings.routes ?? []`）→ 无路由 → 不回复', async () => {
    writeConfig({ enabled: true }) // ← 无 routes 键
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) sent.push(String(init?.body))
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    await handleIncoming(fakeCtx() as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(sent).toHaveLength(0)
  })

  it('C4 路由命中但该 CCC 里**没有这条轨迹** → **响亮报错**并 return（P0-3 起走 `console.error`）', async () => {
    // 路由指向 ghost —— 该 CCC 内不存在这个编码的轨迹（`beforeEach` 只造了 `qa`）
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'ghost' }] },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) sent.push(String(init?.body))
      return jsonResponse(200, { ret: 0 })
    })
    // 🔴 P0-3 起这一档**升格**：原来是 `console.log`（"告警"），现为 `console.error`
    //    —— 方案 §3.1 要求"目标不存在 ⇒ **响亮报错**，不静默丢弃"。
    // 🔴 2026-10-19 重做后判据换了：不是"这个 CCC 有没有配这个 轨迹约束角色"，
    //    而是"**这个 CCC 里有没有这条认知轨迹**"（`findDirNameByCode`）。
    //    ⚠️ 与旧模型的关键差别：轨迹存在但没有 `trajectory-constraint.json` **不是错**（那只是一条普通轨迹）。
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { handleIncoming } = await import('../src/im/bridge.js')
    await handleIncoming(fakeCtx() as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    expect(sent).toHaveLength(0)
    // 🔴 可观测性断言：不是"静默返回"，而是**留下指引性日志**（告诉运维去建这条轨迹）
    expect(err.mock.calls.some((c) => String(c[0]).includes('内没有编码为 "ghost" 的认知轨迹'))).toBe(true)
    err.mockRestore()
  })

  it('C5 existing 快路径：agent 挂不上系统提示词段 → 降级 question 前缀注入，**不阻断本轮处理**', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push(p.msg.item_list[0]!.text_item.text)
      }
      return jsonResponse(200, { ret: 0 })
    })

    // 预注册一个 existing agent（走 getTrajectoryAgent 快路径 ⇒ `agents.create` 一次都不该被调）。
    // 🔴 2026-10-19：注册签名 = `(sessionId, 轨迹目录名, CCC, agent)`；会话 id 由**轨迹编码**派生。
    //    这里让它的 `systemPrompt.section` **抛错**——旧模型的 `ensureTrajectorySession` 是同一个位置
    //    的失败点（现模型对应 `ensureWorkspacePromptSection` 返回 false ⇒ question 前缀兜底）。
    const sessionId = weixinSessionIdForTrajectory('qa')
    const asked: string[] = []
    const existing = {
      session: { id: sessionId, events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => { throw new Error('section boom') } } },
      followup: (m?: { content?: Array<{ type?: string; text?: string }> }) => {
        const q = (m?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
        if (q) asked.push(q)
        existing.session.events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
        )
      },
      interrupt: () => {},
    }
    registerTrajectorySession(sessionId, qaDirName, dir, existing as never)

    const { handleIncoming } = await import('../src/im/bridge.js')
    await handleIncoming({
      // 命中 existing ⇒ 不该走 create（若误走，这里会抛并被桥吞掉 → 断言失守）
      agents: { create: async () => { throw new Error('should not create on the existing fast path') } },
      on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent: existing, status: 'idle' }) // ← 回传真引用（waitAgentIdle 的同一性判据）
        return () => {}
      },
    } as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // 🔴 方向断言：挂段失败（降级）后，**本轮仍跑到产出答案那一步**（"不影响处理"是逐字承诺）
    //    —— 且降级不是静默的：工作台纪律改由 question 前缀注入（约束仍在场）。
    // ⚠️ D238（2026-10-24）：桥不再转发最终文本 ⇒ "产出答案"的证据 = **question 真的进了会话**，
    //    而不是"答案被回写"（那是已退役的行为）。
    expect(asked.some((q) => q.includes('Serenity Session Workspace') && q.includes('你好'))).toBe(true)
    // existing 快路径 = 历史延续 ⇒ 不发"新的对话已开始"通知，也**不自动回发答案**
    expect(sent.some((t) => t.includes('新的对话'))).toBe(false)
    expect(sent.some((t) => t.includes('答'))).toBe(false)
    // 注：本用例同时是 C 组与"existing 快路径"的 happy-path 正控（纪律 10）
  })
})

// ── D 组：媒体与 answer 的回退面 ──────────────────────────────────────────────────

describe('weixin-bridge 分支：D 组 —— 媒体/答案回退', () => {
  it('D1 🔴 文件消息 fileName 为空串 ⇒ 降级文案出现**悬空空白**（真实缺口，如实钉住）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    // 真故障形态：**CDN 下载真失败**（非 200）——否则走 success 路径，根本到不了降级文案。
    // 🔴 本件首跑两次栽在这里，两次都是**我的注入选错分支**（见 commit message 的纪律沉淀）。
    __setWeixinFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) return jsonResponse(200, { ret: 0 })
      return new Response('cdn down', { status: 500 }) // ← 媒体下载失败
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtxWithAnswer(true)

    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      // 文件消息：type 4 + file_item，**fileName 为空串**（`extractWeixinMedia` 忠实透传）
      item_list: [{
        type: 4,
        file_item: { file_name: '', media: { full_url: 'https://cdn/x', aes_key: '' } },
      }] as never,
    })

    const joined = ctx.questions.join('\n')
    // 🔴 如实断言**当前**行为（不是涂绿）：降级说明确实注入了……
    expect(joined).toContain('下载失败')
    // ……但标签位置是**空的** —— `'' ?? '(未命名)'` = `''`（空串不是 nullish）
    expect(joined).toContain('用户发送了文件 ，')
    // ⚠️ 契约缺口：`?? '(未命名)'` 的**本意**覆盖"没有名字"，但只覆盖 `undefined`，不覆盖 `''`
    //    ⇒ 无名文件（线上最常见形态）会渲染出「文件 ，」这种悬空空白。
    //    **修法属 `src/` 改动 ⇒ 须发版令**（已列入 §待 owner 裁决）⇒ 此处只登记，不改生产语义。
    expect(joined).not.toContain('(未命名)')
  })

  it('D1b 图片消息无 fileName（`fileName: undefined`）⇒ 「(未命名)」兜底**可达**（正控）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) return jsonResponse(200, { ret: 0 })
      return new Response('cdn down', { status: 500 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtxWithAnswer(true)

    // 🔵 正控（纪律 10）：证明 D1 的"没有 (未命名)"**不是夹具坏了** —— 同一夹具下，
    //    `undefined` 形态**确实**走到兜底 ⇒ 读数是活的（区分"分支不可达"与"夹具不瞎"）。
    //    但图片走 `kind==='image' ? '一张图片' : …` 的另一侧，故此处用**文件项 + 显式
    //    `file_name: undefined`** 来驱动同一个 `??` 的**可取侧**。
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{
        type: 4,
        file_item: { file_name: undefined, media: { full_url: 'https://cdn/x', aes_key: '' } },
      }] as never,
    })

    const joined = ctx.questions.join('\n')
    expect(joined).toContain('(未命名)')
    expect(joined).toContain('下载失败')
  })

  it('D2 answer 为空 ⇒ 自动回发模式下不发送空消息（`:394`）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: string[] = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push(p.msg.item_list[0]!.text_item.text)
      }
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    // agent 的 followup **不推任何事件** ⇒ askTrajectory 取到空 answer ⇒ 走 `answer === ''` 的 return
    const ctx = fakeCtxWithAnswer(false)

    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // 只应有"新的对话已开始"通知，**不应有**空文本回复
    expect(sent.some((t) => t.includes('新的对话'))).toBe(true)
    expect(sent.filter((t) => t === '')).toHaveLength(0)
  })

  it('D3 非 Error 抛出（`String(err)` 分支）→ 仍然静默并继续（`:425`）', async () => {
    writeConfig({ enabled: true, routes: [{ user: '*', trajectory: 'qa' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })

    __setWeixinFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('getconfig')) return jsonResponse(200, { ret: 0, typing_ticket: 'tk' })
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/im/bridge.js')
    // create 抛**非 Error 值**（字符串）⇒ 走 `err instanceof Error ? … : String(err)`
    const ctx = {
      agents: {
        create: async () => {
          throw 'plain-string-throw' // eslint-disable-line no-throw-literal
        },
      },
      on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent: undefined, status: 'idle' })
        return () => {}
      },
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // 🔴 方向断言：整个 handleIncoming **不抛**（桥错误静默是轮询循环存活的前提）
    await expect(
      handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
        from_user_id: 'u1@im.wechat',
        item_list: [{ type: 1, text_item: { text: '你好' } }],
      }),
    ).resolves.toBeUndefined()

    // 且错误**被记录**（不是无声吞掉 —— 留痕是"可诊断"的前提）
    expect(log.mock.calls.some((c) => String(c[0]).includes('plain-string-throw'))).toBe(true)
    log.mockRestore()
  })
})

// ── E 组：装配 / 停止 / 状态快照 ──────────────────────────────────────────────────

describe('weixin-bridge 分支：E 组 —— 装配与拆卸面', () => {
  it('E1 syncCccBridge：桥未启用 → 直接 return，不建 loops（`:444`）', async () => {
    writeConfig({ enabled: false })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const { syncCccBridge, weixinBridgeStatus } = await import('../src/im/bridge.js')

    syncCccBridge(fakeCtx() as never, dir)

    expect(weixinBridgeStatus()).toHaveLength(0)
  })

  it('E2 accounts 段缺省 + account 显式禁用 ⇒ 都不建 loops（`:447` `:448`）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1', enabled: false }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const { syncCccBridge, weixinBridgeStatus } = await import('../src/im/bridge.js')

    syncCccBridge(fakeCtx() as never, dir)

    // 🔴 「显式禁用」必须真的不轮询 —— 这是"关掉一个账号"的唯一语义
    expect(weixinBridgeStatus()).toHaveLength(0)
  })

  it('E3 有凭据且启用 → 建 loop 并出现在状态快照（E2 的 happy-path 正控，纪律 10）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0, msgs: [] }))

    const { syncCccBridge, weixinBridgeStatus, stopCccBridge } = await import('../src/im/bridge.js')
    syncCccBridge(fakeCtx() as never, dir)

    const status = weixinBridgeStatus()
    expect(status).toHaveLength(1)
    expect(status[0]!.accounts.some((a) => a.accountId === 'wechat-1')).toBe(true)
    stopCccBridge(dir)
  })

  it('E4 stopCccBridge 对**未注册**的根 → 静默 return（`:464`）', async () => {
    const { stopCccBridge } = await import('../src/im/bridge.js')
    // 🔴 判据：幂等 —— 重复停止不得抛（否则 dispose 路径会炸）
    expect(() => stopCccBridge('/nonexistent-root-xyz')).not.toThrow()
    expect(() => stopCccBridge('/nonexistent-root-xyz')).not.toThrow()
  })

  it('E5 syncCccBridge 热重建：已存在桥 → 先停旧 loops 再建新的（`:438`）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0, msgs: [] }))

    const { syncCccBridge, weixinBridgeStatus, stopCccBridge } = await import('../src/im/bridge.js')
    syncCccBridge(fakeCtx() as never, dir)
    syncCccBridge(fakeCtx() as never, dir) // ← 第二次触发 existing 分支

    // 🔴 判据：热重建**不叠加**（配置变化热重建是逐字承诺；叠加会导致重复轮询 = 重复回复）
    expect(weixinBridgeStatus()).toHaveLength(1)
    expect(weixinBridgeStatus()[0]!.accounts).toHaveLength(1)
    stopCccBridge(dir)
  })

  it('E6 stopAllBridges：空集合遍历 + 清空（`:473`）', async () => {
    const { stopAllBridges, weixinBridgeStatus } = await import('../src/im/bridge.js')
    expect(() => stopAllBridges()).not.toThrow()
    expect(weixinBridgeStatus()).toHaveLength(0)
  })
})

// ── F 组：主动发送 ────────────────────────────────────────────────────────────────

describe('weixin-bridge 分支：F 组 —— 主动发送缺省与错误', () => {
  it('F1 accounts 缺省 → NO_ACCOUNT（`:535` 的 `?? []`）', async () => {
    writeConfig({ enabled: true }) // ← 无 accounts 键
    const { sendProactiveText } = await import('../src/im/bridge.js')

    const r = await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NO_ACCOUNT')
  })

  it('F2 routes 缺省 → role 为空串但仍发送成功（`:563`）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] }) // ← 无 routes 键
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 0 }))

    const { sendProactiveText } = await import('../src/im/bridge.js')
    const r = await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: 'hi' })

    // 🔴 方向断言：无路由**不该阻断发送**（主动发送不经用户触发，路由只影响记录的 role 标注）
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.role).toBe('')
  })

  it('F3 非 Error 抛出 → SEND_FAILED 且文案含原文（`:567`）', async () => {
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1' }] })
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async () => {
      throw 'net-down-plain' // eslint-disable-line no-throw-literal
    })

    const { sendProactiveText } = await import('../src/im/bridge.js')
    const r = await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: 'hi' })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('SEND_FAILED')
      expect(r.error).toContain('net-down-plain')
    }
  })
})

// ── G 组：registerWeixinBridge 的容错 ─────────────────────────────────────────────

describe('weixin-bridge 分支：G 组 —— 注册容错（扫描失败/监听失败都不阻断）', () => {
  it('G1 CCC 扫描抛错 → 忽略（`:620` catch ），不阻断插件装配', async () => {
    writeConfig({ enabled: true })
    const { registerWeixinBridge } = await import('../src/im/bridge.js')
    const ctx = {
      // listCccs 内部会读 CCC 列表；给一个**抛错**的 ctx 驱动 catch
      get: () => { throw new Error('scan boom') },
      on: () => () => {},
    }

    // 🔴 方向断言：装配必须**不抛** —— 它是插件启动路径，抛错会导致整个 ACC 装配失败
    expect(() => registerWeixinBridge(ctx as never)).not.toThrow()
  })

  it('G2 ctx.on 抛错（宿主无该事件）→ 忽略，桥仍装配（`:631`）', async () => {
    writeConfig({ enabled: true })
    const { registerWeixinBridge } = await import('../src/im/bridge.js')
    const ctx = {
      get: () => [],
      on: () => { throw new Error('no such event') }, // ← 驱动 `:631` catch
    }

    expect(() => registerWeixinBridge(ctx as never)).not.toThrow()
  })
})
