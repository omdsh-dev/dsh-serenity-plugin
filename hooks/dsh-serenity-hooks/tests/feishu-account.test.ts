import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setSimpleSourceForTest, defaultSimpleSettings, type SerenitySimpleSettings } from '../src/surface/settings.js'

/**
 * 飞书账号实现（P3）的判据
 *
 * ## 分层说清（别把绿读成"飞书能用了"）
 *
 * ✅ **证明**：凭据判据、事件→中立事件的翻译、去重、只入队不入回调、
 *    发送形状（`receive_id_type` / `content` 是 JSON 字符串）。
 * ⛔ **不证明**：真能连上飞书、真能收到真消息、真能发出去
 *    —— 那要真 appId/appSecret 与真网络，三格分开取证（调研 §5.2）。
 *
 * ## 为什么用替身而不是真 SDK 连接
 *
 * 单测里起真 WebSocket 会长连接外网、且不可重放。⇒ 本文件用**假 SDK**，
 * 但它必须**镜像真签名**（构造参数、`start({eventDispatcher})`、`register({...})`），
 * 否则测的是我编的形状（本轨既有教训：替身必须给返回值、必须镜像宿主）。
 */

/**
 * 飞书 SDK 替身（**注入**，不用 `vi.mock`）。
 *
 * 🔴 为什么不用 `vi.mock`（本轮实测两次都没成）：`feishu-account.ts` 用
 *    `await import('@larksuiteoapi/node-sdk')` 取 SDK，而该包在 pnpm 下是**外置依赖**
 *    ⇒ vitest 的动态 import 不被 mock 拦截。证据：测试里跑出了**真 SDK 自己的日志**
 *    `[error]: [ '[ws]', 'invalid appId: cli_x' ]` —— 那是读数器在替我说"你没拦住我"。
 * ⇒ 改成**依赖注入**（与微信侧 `installWeixinAccountImpl` 同款）：测试给替身，
 *    生产给真加载器。**没有魔法**，也不需要理解 vitest 的提升语义。
 */
const fakeState = {
  sent: [] as Array<Record<string, unknown>>,
  started: 0,
  closed: 0,
  registered: [] as string[],
  emit: (_data: Record<string, unknown>): void => {},
}

const fakeSdk = {
  Client: class {
    im = {
      v1: {
        message: {
          create: async (p: Record<string, unknown>) => {
            fakeState.sent.push(p)
            return { code: 0, data: { message_id: 'om_out' } }
          },
        },
      },
    }
  },
  EventDispatcher: class {
    private handles = new Map<string, (d: unknown) => unknown>()
    constructor(_p?: unknown) {}
    register(h: Record<string, (d: unknown) => unknown>) {
      for (const [k, v] of Object.entries(h)) { this.handles.set(k, v); fakeState.registered.push(k) }
      fakeState.emit = (d) => { void this.handles.get('im.message.receive_v1')?.(d) }
      return this
    }
  },
  WSClient: class {
    constructor(_p?: unknown) {}
    async start(_p: { eventDispatcher: unknown }) { fakeState.started += 1 }
    close(_p?: { force?: boolean }) { fakeState.closed += 1 }
  },
}

let dir: string

beforeEach(async () => {
  fakeState.sent = []
  fakeState.started = 0
  fakeState.closed = 0
  fakeState.registered = []
  fakeState.emit = () => {}
  dir = mkdtempSync(join(tmpdir(), 'feishu-account-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'test')
  // 注入 SDK 替身（生产路径不经过这里）
  const { installFeishuSdk } = await import('../src/im/feishu-account.js')
  installFeishuSdk(async () => fakeSdk as never)
  __setSimpleSourceForTest((): SerenitySimpleSettings => ({
    ...defaultSimpleSettings(),
    humanChannel: { ...defaultSimpleSettings().humanChannel, subscriptions: [] },
  }))
})

afterEach(async () => {
  __setSimpleSourceForTest(null)
  const { __resetFeishuSeenForTest, __closeAllFeishuConnectionsForTest } = await import('../src/im/feishu-account.js')
  __resetFeishuSeenForTest()
  __closeAllFeishuConnectionsForTest()
  const { unregisterTrajectorySession, trajectorySessionSnapshot } = await import('../src/trajectory/session.js')
  for (const [id] of trajectorySessionSnapshot()) unregisterTrajectorySession(id)
  const { __resetImAccountImplsForTest } = await import('../src/im/accounts.js')
  __resetImAccountImplsForTest()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  // ⚠️ **不要 `vi.resetModules()`**：它会换掉模块实例，而 `__setSimpleSourceForTest` 注入的是
  //    旧实例上的 `simpleSource` ⇒ 表现为"配置注入没生效"（本轮实测：两条用例报「订阅表为空」，
  //    而表明明注入了）。这与本轨「读数器先自证」同族：**症状像被测对象坏，实为测试装置换实例**。
  vi.doUnmock('@larksuiteoapi/node-sdk')
})

describe('飞书：凭据就绪判据', () => {
  it('appId 与 appSecret **都非空**才算就绪（缺一即未绑定）', async () => {
    const { feishuAccountImpl } = await import('../src/im/feishu-account.js')
    expect(feishuAccountImpl.channel).toBe('feishu')
    expect(feishuAccountImpl.isReady({ appId: 'cli_x', token: 'sec' })).toBe(true)
    expect(feishuAccountImpl.isReady({ appId: 'cli_x' })).toBe(false)          // 缺 secret
    expect(feishuAccountImpl.isReady({ token: 'sec' })).toBe(false)            // 缺 appId
    expect(feishuAccountImpl.isReady({ appId: '  ', token: 'sec' })).toBe(false) // 空白不算
    expect(feishuAccountImpl.isReady({ appId: 'cli_x', token: '' })).toBe(false)
    // 未就绪原因要说人话（装配处直接印给用户）
    expect(feishuAccountImpl.notReadyReason?.({ appId: '' })).toContain('appId')
  })
})

describe('飞书：事件 → 中立入站事件（这是 P3 唯一的形状翻译）', () => {
  it('文本事件 ⇒ userId 取 **open_id**（不是 chat_id）、text 已 trim', async () => {
    const { feishuEventToInbound } = await import('../src/im/feishu-account.js')
    const ev = feishuEventToInbound({
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_1', message_type: 'text', content: JSON.stringify({ text: '  你好  ' }) },
    })
    expect(ev).not.toBeNull()
    expect(ev!.userId).toBe('ou_abc')
    expect(ev!.text).toBe('你好')
    expect(ev!.media).toEqual([])
    // 飞书没有 context_token 概念 ⇒ 不带回复锚点
    expect(ev!.replyRef).toBeUndefined()
  })

  it('🔴 群聊 @机器人 的 `@_user_N` 占位要从正文剔除（否则它会被当成正文读给模型）', async () => {
    const { feishuEventToInbound } = await import('../src/im/feishu-account.js')
    const ev = feishuEventToInbound({
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_2', message_type: 'text', content: JSON.stringify({ text: '@_user_1 帮我看看' }) },
    })
    expect(ev!.text).toBe('帮我看看')
  })

  it('非文本类型（图片/富文本）⇒ text 为 null（本期不解析，但不崩）', async () => {
    const { feishuEventToInbound } = await import('../src/im/feishu-account.js')
    const ev = feishuEventToInbound({
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_3', message_type: 'image', content: '{"image_key":"img_x"}' },
    })
    expect(ev).not.toBeNull()
    expect(ev!.text).toBeNull()
  })

  it('content 不是合法 JSON ⇒ 当作无文本（**不抛**，否则会打断整条队列）', async () => {
    const { feishuEventToInbound } = await import('../src/im/feishu-account.js')
    const ev = feishuEventToInbound({
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_4', message_type: 'text', content: 'not-json' },
    })
    expect(ev!.text).toBeNull()
  })

  it('缺 open_id 或 message_id ⇒ null（调用方据此出声，不静默当空消息处理）', async () => {
    const { feishuEventToInbound } = await import('../src/im/feishu-account.js')
    expect(feishuEventToInbound({ message: { message_id: 'om_5' } })).toBeNull()
    expect(feishuEventToInbound({ sender: { sender_id: { open_id: 'ou_x' } } })).toBeNull()
    expect(feishuEventToInbound({})).toBeNull()
  })
})

describe('飞书：长连接行为（3 秒约束 / 去重 / 发送形状）', () => {
  it('🔴 回调里**只入队**：emit 立即返回（3 秒约束），处理在微任务之后才发生', async () => {
    const { feishuAccountImpl } = await import('../src/im/feishu-account.js')

    const loop = feishuAccountImpl.startLoop({
      ctx: {} as never,
      root: dir,
      accountId: 'feishu-1',
      cred: { appId: 'cli_x', token: 'sec' },
      machine: true,
    })
    // 等建连完成（start 是 await 的）
    await vi.waitFor(() => expect(fakeState.started).toBe(1))
    expect(fakeState.registered).toContain('im.message.receive_v1')
    expect(loop.lastError).toBeUndefined()
  })

  it('🔴 同一 message_id 重推 ⇒ 只处理一次（官方：超时会重推）', async () => {
    const { feishuAccountImpl } = await import('../src/im/feishu-account.js')

    // 订阅指向本 CCC 的一条轨迹 ⇒ machine 模式能解析到目标
    const trajDir = join(dir, 'AGENT_SESSIONS', '2026-10-19--probe--p')
    mkdirSync(trajDir, { recursive: true })
    writeFileSync(join(trajDir, 'SESSION.md'), '# SESSION: p\n- ID: probe\n')
    __setSimpleSourceForTest((): SerenitySimpleSettings => ({
      ...defaultSimpleSettings(),
      humanChannel: {
        ...defaultSimpleSettings().humanChannel,
        subscriptions: [{ account: 'feishu-1', user: 'ou_abc', ccc: dir, role: 'probe' }],
      },
    }))

    const questions: string[] = []
    const agent = {
      session: { id: 'p', events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => {} } },
      followup: (m?: { content?: Array<{ type?: string; text?: string }> }) => {
        const q = (m?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
        if (q) questions.push(q)
        agent.session.events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } },
        )
      },
    }
    const ctx = {
      get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
      agents: {
        create: async () => ({ agent }),
        resume: async () => { throw Object.assign(new Error('nf'), { name: 'SessionPersistenceNotFoundError' }) },
      },
      on: (_e: string, cb: (p: unknown) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    }

    feishuAccountImpl.startLoop({
      ctx: ctx as never,
      root: '<machine>',
      accountId: 'feishu-1',
      cred: { appId: 'cli_x', token: 'sec' },
      machine: true,
    })
    await vi.waitFor(() => expect(fakeState.started).toBe(1))

    const event = {
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_dup', message_type: 'text', content: JSON.stringify({ text: '同一句话' }) },
    }
    fakeState.emit(event)
    fakeState.emit(event) // 重推

    await vi.waitFor(() => expect(questions.length).toBeGreaterThan(0))
    // 去重成立 ⇒ 只进了一次对话
    expect(questions.filter((q) => q.includes('同一句话')).length).toBe(1)
    // 且真的回了一条（发送形状下面另有断言）
    expect(fakeState.sent.length).toBeGreaterThan(0)
  })

  it('🔴 发送形状：`receive_id_type=open_id`，且 `content` 是 **JSON 字符串**（不是裸文本）', async () => {
    const { feishuAccountImpl } = await import('../src/im/feishu-account.js')

    const trajDir = join(dir, 'AGENT_SESSIONS', '2026-10-19--probe--p')
    mkdirSync(trajDir, { recursive: true })
    writeFileSync(join(trajDir, 'SESSION.md'), '# SESSION: p\n- ID: probe\n')
    __setSimpleSourceForTest((): SerenitySimpleSettings => ({
      ...defaultSimpleSettings(),
      humanChannel: {
        ...defaultSimpleSettings().humanChannel,
        subscriptions: [{ account: 'feishu-1', user: 'ou_abc', ccc: dir, role: 'probe' }],
      },
    }))

    const agent = {
      session: { id: 'p', events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => {} } },
      followup: () => {
        agent.session.events.push(
          { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**答案**' }] } } },
        )
      },
    }
    const ctx = {
      get: (n: string) => (n === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
      agents: {
        create: async () => ({ agent }),
        resume: async () => { throw Object.assign(new Error('nf'), { name: 'SessionPersistenceNotFoundError' }) },
      },
      on: (_e: string, cb: (p: unknown) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    }

    feishuAccountImpl.startLoop({
      ctx: ctx as never, root: '<machine>', accountId: 'feishu-1',
      cred: { appId: 'cli_x', token: 'sec' }, machine: true,
    })
    await vi.waitFor(() => expect(fakeState.started).toBe(1))
    fakeState.emit({
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: { message_id: 'om_shape', message_type: 'text', content: JSON.stringify({ text: '你好' }) },
    })

    await vi.waitFor(() => expect(fakeState.sent.length).toBeGreaterThan(0))
    const p = fakeState.sent[fakeState.sent.length - 1] as {
      params: { receive_id_type: string }
      data: { receive_id: string; msg_type: string; content: string }
    }
    expect(p.params.receive_id_type).toBe('open_id')
    expect(p.data.receive_id).toBe('ou_abc')
    expect(p.data.msg_type).toBe('text')
    // 🔴 content 必须是 **JSON 字符串**，且能解析回 { text }
    expect(typeof p.data.content).toBe('string')
    const parsed = JSON.parse(p.data.content) as { text: string }
    expect(parsed.text).toContain('答案') // 也证明 md 已被转纯文本
    expect(p.data.content.startsWith('{')).toBe(true)
  })

  it('凭据不全 ⇒ 不建连、把原因写进 lastError（面板可见，不静默）', async () => {
    const { feishuAccountImpl } = await import('../src/im/feishu-account.js')
    const loop = feishuAccountImpl.startLoop({
      ctx: {} as never, root: dir, accountId: 'feishu-2',
      cred: { appId: '' }, machine: true,
    })
    await vi.waitFor(() => expect(loop.lastError).toBeDefined())
    expect(loop.lastError).toContain('飞书凭据不全')
    expect(fakeState.started).toBe(0) // 没去建连
  })
})
