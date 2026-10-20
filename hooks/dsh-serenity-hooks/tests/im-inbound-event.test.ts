import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { __setSimpleSourceForTest, defaultSimpleSettings, type SerenitySimpleSettings } from '../src/surface/settings.js'

/**
 * im/inbound-event.ts —— **中立入站事件层**的判据（B1，2026-10-19）
 *
 * ## 这个文件要证明什么（判据分层，别把绿读成"飞书能用了"）
 *
 * ✅ **证明**：`handleInboundEvent` 能**完全不知道 iLink 存在**地跑完一条消息——
 *    路由 → 会话 → 提问 → 回复 → 记账 → 媒体落盘。
 * ✅ **证明**：它吃的是**中立事件**（`userId` / `text` / `media[].fetch()` / `replyRef`），
 *    与 iLink 的 `from_user_id` / `context_token` / `item_list` **没有一处同名**。
 * ⛔ **不证明**：飞书能连上、能收、能发 —— 那要真 appId/appSecret 与真网络（P3 三格分开验）。
 *
 * ## 为什么"非 iLink 形状"是核心判据
 *
 * 抽没抽干净，**不是**看代码里有没有 `context_token` 字样 —— 那种判据随手就能糊弄。
 * 真判据是：**喂进一个主流程从没见过的形状，它照样跑通**。
 * ⇒ 这就是"未来第三家 IM 接进来要不要改主流程"的答案。
 */

let dir: string
let oldAuditEnv: string | undefined
let oldConfigEnv: string | undefined
/** 机器级订阅表的可变量（每例改它） */
let machineSubscriptions: Array<Record<string, unknown>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'im-inbound-event-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  // CCC 标记（`cccRootForCwd` 上溯要它）
  writeFileSync(join(dir, '.serenity'), 'test')
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  // 机器级留痕隔离（未命中档会写它，不隔离会污染别的用例）
  oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'audit.jsonl')
  machineSubscriptions = []
  __setSimpleSourceForTest((): SerenitySimpleSettings => ({
    ...defaultSimpleSettings(),
    humanChannel: { ...defaultSimpleSettings().humanChannel, subscriptions: machineSubscriptions },
  }))
})

afterEach(async () => {
  __setSimpleSourceForTest(null)
  const { __resetWeixinOutputGuardForTest } = await import('../src/im/guard.js')
  __resetWeixinOutputGuardForTest()
  // 会话注册表是模块级 → 不清理会串到别的用例（与 human-channel-routing 同款收尾）
  const { unregisterTrajectorySession, trajectorySessionSnapshot } = await import('../src/trajectory/session.js')
  for (const [id] of trajectorySessionSnapshot()) unregisterTrajectorySession(id)
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * 造一条**认知轨迹**（普通轨迹：有 SESSION.md，**无 trajectory-constraint.json**）
 * ⇒ 中立层不施加 轨迹约束 约束，但仍能往里投（这是"轨迹存在性"判据的正控）。
 */
function makeTrajectory(code: string): void {
  const d = join(dir, 'AGENT_SESSIONS', `2026-10-19--${code}--probe`)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SESSION.md'), `# SESSION: probe\n- ID: ${code}\n`)
}

/** 一条机器级订阅：账号 + 用户 → (CCC 别名, 轨迹编码) */
function subscribe(account: string, user: string, code: string): void {
  // ⚠️ 字段名是 `role`（计划层的历史名），值 = **轨迹编码** —— 这不是笔误：
  //    `planInboundRoute` 至今按 `role` 取该列（"角色名"这个语义已退役，键名保留）。
  machineSubscriptions = [{ account, user, ccc: basename(dir), role: code }]
}

/** fake ctx：agents.create 造一个带 followup 的 agent；on 立即触发 idle */
function fakeCtx(): { ctx: unknown; questions: string[] } {
  const questions: string[] = []
  const agent = {
    session: { id: 'probe', events: [] as unknown[] },
    ctx: { systemPrompt: { section: () => {} } },
    followup: (msg?: { content?: Array<{ type?: string; text?: string }> }) => {
      const q = (msg?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
      if (q) questions.push(q)
      agent.session.events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**答**案' }] } } },
      )
    },
    interrupt: () => {},
  }
  const ctx = {
    // `listCccs` 靠工作区注册表枚举出本 CCC（订阅表按**别名**寻址时必须能解析）
    get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
    agents: {
      create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        agent.session.id = opts.sessionId
        await opts.setup?.(agent as never)
        return { agent }
      },
      resume: async () => { throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' }) },
    },
    on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => { cb({ agent, status: 'idle' }); return () => {} },
  }
  return { ctx, questions }
}

describe('中立入站事件层：一条消息的主流程（与通道无关）', () => {
  it('🔴 主流程吃一个**非 iLink 形状**的事件也能跑通（抽缝是否干净的判据）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'someone-else', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()

    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'someone-else', cccFallback: null })
    expect(target).not.toBeNull()

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      // ⚠️ 这些字段名与 iLink **毫无关系**：这就是"第三家 IM"会拿来的形状
      userId: 'someone-else',
      text: '你好呀',
      media: [],
      hasVoice: false,
    }, { target: target! })

    expect(questions.join('\n')).toContain('你好呀') // 问题真进了会话
    // 🔴 断言必须钉**回复本身**，不能只断言"发过东西"——
    //    「（新的对话已开始）」那条系统通知也会让 `sent.length > 0` 成立。
    //    实测：把 io.sendText 那行改成不调用 ⇒ 旧断言**照样绿**（假绿，已修）。
    //    ⇒ 这里要求：**最后一条**是模型答复（fake agent 的答案是 `**答**案`），
    //       且先有系统通知、后有答复（顺序也要对，否则用户看到的是倒的）。
    expect(sent.some((s) => s.includes('新的对话已开始'))).toBe(true)
    expect(sent[sent.length - 1]).toContain('答案')
    expect(sent.length).toBeGreaterThan(1)
  })

  it('无文本无媒体 + 有语音 ⇒ 发降级提示（不静默、不建会话）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-voice', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-voice', cccFallback: null })

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      userId: 'u-voice', text: null, media: [], hasVoice: true,
    }, { target: target! })

    expect(sent.join('\n')).toContain('无法解析这条语音')
    expect(questions).toEqual([]) // 没进对话 = 没建会话
  })

  it('无文本无媒体且**不是**语音 ⇒ 完全静默（不打扰用户）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-empty', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-empty', cccFallback: null })

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      userId: 'u-empty', text: null, media: [], hasVoice: false,
    }, { target: target! })

    expect(sent).toEqual([])
  })

  it('媒体：`fetch()` 由事件自带 ⇒ 主流程落盘并注入路径（不认 iLink 的下载函数）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-media', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-media', cccFallback: null })

    let fetched = 0
    await handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-media',
      text: '看这个',
      media: [{
        kind: 'file',
        fileName: '报表.csv',
        fetch: async () => { fetched += 1; return { data: Buffer.from('a,b\n1,2\n'), fileName: '报表.csv' } },
      }],
      hasVoice: false,
    }, { target: target! })

    expect(fetched).toBe(1)
    expect(questions.join('\n')).toContain('已保存到')
    // 文件真落盘（按用户分目录）
    const inboundRoot = join(dir, '_tmp', 'weixin-inbound')
    expect(existsSync(inboundRoot)).toBe(true)
    const perUser = readdirSync(inboundRoot)
    expect(perUser.length).toBe(1)
    expect(readdirSync(join(inboundRoot, perUser[0]!)).join(',')).toContain('报表.csv')
  })

  it('媒体 `fetch()` 返回 null ⇒ 降级告知进对话（不静默丢消息）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-fail', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-fail', cccFallback: null })

    await handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-fail',
      text: '',
      media: [{ kind: 'image', fetch: async () => null }],
      hasVoice: false,
    }, { target: target! })

    expect(questions.join('\n')).toContain('下载失败')
  })

  it('🔴 `io.typingStart/typingStop` **可选** ⇒ 没有打字态的通道（如飞书）不会因此失败', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-notyping', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-notyping', cccFallback: null })

    await expect(handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-notyping', text: 'hi', media: [], hasVoice: false,
    }, { target: target! })).resolves.toBeUndefined()
    expect(questions.length).toBeGreaterThan(0)
  })

  it('异常路径也调 typingStop（try/finally 真存在）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-throw', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')

    const agent = {
      session: { id: 'probe', events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => {} } },
      followup: () => { throw new Error('boom') }, // 提问阶段就炸
      interrupt: () => {},
    }
    const ctx = {
      get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
      agents: {
        create: async () => ({ agent }),
        resume: async () => { throw Object.assign(new Error('nf'), { name: 'SessionPersistenceNotFoundError' }) },
      },
      on: (_e: string, cb: (p: unknown) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    }
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-throw', cccFallback: null })

    let stopped = 0
    // 主流程自己吞错误（桥错误静默是轮询循环存活的前提）⇒ 断言"不抛"且 stop 被调
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async () => {},
      typingStart: async () => {},
      typingStop: async () => { stopped += 1 },
    }, {
      userId: 'u-throw', text: 'hi', media: [], hasVoice: false,
    }, { target: target! })

    expect(stopped).toBe(1)
  })
})

describe('中立入站事件层：通道无关的纯机制面', () => {
  it('机制标记与兜底矩阵仍是已导出、可独立测的纯函数（与通道无关）', async () => {
    const { manualOutputMarker, manualOutputFallbackNeeded } = await import('../src/im/inbound-event.js')
    expect(manualOutputMarker('acct-a', 'u1')).toContain('[serenity:weixin-manual-output]')
    expect(manualOutputFallbackNeeded({ fallbackOnNoSend: true, guardActive: true, sentThisTurn: false, answer: 'x' })).toBe(true)
    // 反向：四条件任一不成立 ⇒ 不兜底（宁可静默也不冒重复发送风险）
    expect(manualOutputFallbackNeeded({ fallbackOnNoSend: true, guardActive: true, sentThisTurn: true, answer: 'x' })).toBe(false)
    expect(manualOutputFallbackNeeded({ fallbackOnNoSend: false, guardActive: true, sentThisTurn: false, answer: 'x' })).toBe(false)
    expect(manualOutputFallbackNeeded({ fallbackOnNoSend: true, guardActive: false, sentThisTurn: false, answer: 'x' })).toBe(false)
    expect(manualOutputFallbackNeeded({ fallbackOnNoSend: true, guardActive: true, sentThisTurn: false, answer: '' })).toBe(false)
  })

  it('🔴 渠道不是常量：传 `channel:"feishu"` ⇒ 注入的命令写 feishu（缺省仍是 weixin）', async () => {
    const { manualOutputMarker } = await import('../src/im/inbound-event.js')
    expect(manualOutputMarker('acct-a', 'u1')).toContain('channel:"weixin"')
    expect(manualOutputMarker('acct-a', 'u1', 'feishu')).toContain('channel:"feishu"')
    // 协议标记本身**不改名**（CCC 侧角色提示词按它做判据；A85）
    expect(manualOutputMarker('acct-a', 'u1', 'feishu')).toContain('[serenity:weixin-manual-output]')
  })
})

describe('中立入站事件层：渠道身份穿过本层（Q4）', () => {
  it('🔴 CCC 级路径传 `{channel}`（无 target）⇒ 自己按 routes 路由并投递，**不被静默丢弃**', async () => {
    // 这是本轮实测抓到的一个真缺陷的反向钉：
    // 首版把"机器级模式"的判据写成 `if (preset)`，而飞书 CCC 级路径要传 `{channel:'feishu'}`
    // （没有 target）⇒ 那条路径 `resolved = undefined` ⇒ 命中 `if (!resolved) return`
    // ⇒ **每一条飞书消息都被静默丢掉**，且零报错。
    makeTrajectory('probe-code')
    const { handleInboundEvent } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()

    // CCC 级路由（serenity.json 的 routes），不靠订阅表
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      im: {
        enabled: true,
        accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }],
        routes: [{ user: 'ou_feishu', trajectory: 'probe-code' }],
      },
    }, null, 2))

    await handleInboundEvent(ctx as never, dir, 'feishu-1', { sendText: async () => {} }, {
      userId: 'ou_feishu', text: '来自飞书的消息', media: [], hasVoice: false,
    }, { channel: 'feishu' })

    // 🔴 判据 = **问题真的进了会话**（若被静默丢弃，这里会是空数组）
    expect(questions.join('\n')).toContain('来自飞书的消息')
  })
})
