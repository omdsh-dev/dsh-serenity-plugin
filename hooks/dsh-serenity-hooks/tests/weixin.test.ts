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

// skiff-core 依赖 @deepseek-ai/dsh-session 类型（运行时擦除）——无需 mock；
// acp-core → skiff-core 链在 handleIncoming 集成测试中用 fake ctx 走 createSkiffAgent 的轻路径

import {
  fetchQRCode,
  pollQRStatus,
  getUpdates,
  sendTextMessage,
  getConfig,
  sendTyping,
  TypingStatus,
  markdownToPlainText,
  buildClientVersion,
  __setWeixinFetchForTest,
} from '../src/weixin-api.js'
import {
  weixinSessionIdFor,
  isWeixinSessionId,
  readWeixinSettings,
  readWeixinCredential,
  writeWeixinCredential,
  clearWeixinCredential,
  matchWeixinRoute,
  extractWeixinText,
  hasVoiceItem,
  upsertWeixinAccount,
  removeWeixinAccount,
  saveWeixinRoutes,
  setWeixinEnabled,
  nextWeixinAccountId,
} from '../src/weixin-route.js'
import { registerSkiffSession, unregisterSkiffSession, skiffSessionSnapshot } from '../src/skiff-core.js'

let dir: string
let oldConfigEnv: string | undefined

/** fake Response（fetch mock 返回值） */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-'))
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
})

afterEach(async () => {
  __setWeixinFetchForTest(null)
  // typing_ticket 缓存清空（模块级状态，防测试间污染）
  const { resetWeixinTypingCache } = await import('../src/weixin-bridge.js')
  resetWeixinTypingCache()
  for (const [id] of skiffSessionSnapshot()) unregisterSkiffSession(id)
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('weixin-api: 协议客户端（mock fetch）', () => {
  it('buildClientVersion 编码 2.1.1 → 131329', () => {
    expect(buildClientVersion('2.1.1')).toBe(131329)
    expect(buildClientVersion('1.0.0')).toBe(65536)
  })

  it('fetchQRCode 裸调（无凭据）返回 qrcode + img', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    __setWeixinFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, headers: {} })
      return jsonResponse(200, { qrcode: 'abc123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x' })
    })
    const r = await fetchQRCode({})
    expect(r.qrcode).toBe('abc123')
    expect(r.qrcode_img_content).toContain('liteapp')
    expect(calls[0]!.url).toContain('/ilink/bot/get_bot_qrcode?bot_type=3')
  })

  it('pollQRStatus wait → confirmed 带 bot_token', async () => {
    let n = 0
    __setWeixinFetchForTest(async () => {
      n++
      return jsonResponse(200, n === 1
        ? { status: 'wait' }
        : { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1', baseurl: 'https://x', ilink_user_id: 'u1' })
    })
    const first = await pollQRStatus({ qrcode: 'q' })
    expect(first.status).toBe('wait')
    const second = await pollQRStatus({ qrcode: 'q' })
    expect(second.status).toBe('confirmed')
    expect(second.bot_token).toBe('tok')
    expect(second.ilink_user_id).toBe('u1')
  })

  it('pollQRStatus 网络错误 → wait（不抛）', async () => {
    __setWeixinFetchForTest(async () => {
      throw new Error('network down')
    })
    const r = await pollQRStatus({ qrcode: 'q' })
    expect(r.status).toBe('wait')
  })

  it('getUpdates 长轮询 body 带游标 + 返回 msgs/游标', async () => {
    let body: string | undefined
    __setWeixinFetchForTest(async (input, init) => {
      body = init?.body as string | undefined
      return jsonResponse(200, {
        ret: 0,
        msgs: [{ from_user_id: 'u@im.wechat', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }], context_token: 'ct' }],
        get_updates_buf: 'cursor-2',
      })
    })
    const r = await getUpdates({ baseUrl: 'https://ilinkai.weixin.qq.com', token: 't', getUpdatesBuf: 'cursor-1' })
    expect(body).toContain('cursor-1')
    expect(r.msgs?.[0]?.from_user_id).toBe('u@im.wechat')
    expect(r.get_updates_buf).toBe('cursor-2')
  })

  it('sendTextMessage body 结构：BOT/FINISH + context_token + md→plain', async () => {
    let bodyText = ''
    __setWeixinFetchForTest(async (_input, init) => {
      bodyText = init?.body as string
      return jsonResponse(200, { ret: 0 })
    })
    await sendTextMessage({ baseUrl: 'https://ilinkai.weixin.qq.com', token: 't', toUserId: 'u@im.wechat', text: '**hi** [link](http://x)', contextToken: 'ct' })
    const parsed = JSON.parse(bodyText) as { msg: { message_type: number; message_state: number; to_user_id: string; context_token: string; item_list: Array<{ text_item: { text: string } }> } }
    expect(parsed.msg.message_type).toBe(2)
    expect(parsed.msg.message_state).toBe(2)
    expect(parsed.msg.to_user_id).toBe('u@im.wechat')
    expect(parsed.msg.context_token).toBe('ct')
    expect(parsed.msg.item_list[0]!.text_item.text).toBe('hi link')
  })

  it('getConfig 取 typing_ticket + sendTyping 状态 1/0（正在输入）', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, body: init?.body as string | undefined })
      if (url.includes('getconfig')) return jsonResponse(200, { ret: 0, typing_ticket: 'tk-1' })
      return jsonResponse(200, { ret: 0 })
    })
    const cfg = await getConfig({ baseUrl: 'https://x', token: 't', ilinkUserId: 'u@im.wechat', contextToken: 'ct' })
    expect(cfg.typing_ticket).toBe('tk-1')
    await sendTyping({ baseUrl: 'https://x', token: 't', ilinkUserId: 'u@im.wechat', typingTicket: 'tk-1', status: TypingStatus.TYPING })
    await sendTyping({ baseUrl: 'https://x', token: 't', ilinkUserId: 'u@im.wechat', typingTicket: 'tk-1', status: TypingStatus.CANCEL })
    // getconfig body 带 ilink_user_id + context_token
    expect(calls[0]!.url).toContain('/ilink/bot/getconfig')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ilink_user_id: 'u@im.wechat', context_token: 'ct' })
    // sendtyping body 带 ticket + 状态 1 → 0
    expect(calls[1]!.url).toContain('/ilink/bot/sendtyping')
    expect(JSON.parse(calls[1]!.body!)).toEqual({ ilink_user_id: 'u@im.wechat', typing_ticket: 'tk-1', status: 1 })
    expect(JSON.parse(calls[2]!.body!).status).toBe(0)
  })

  it('markdownToPlainText 7 类转换', () => {
    expect(markdownToPlainText('# 标题\n**粗** *斜* `code` ~~删~~ [文](http://x) ![图](http://i)')).toBe('标题\n粗 斜 code 删 文')
    expect(markdownToPlainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(markdownToPlainText('| a | b |\n|---|---|')).toBe('')
  })

  it('stripThink 剥离 <think> 块（微信桥用户反馈：用户不应看到思考过程）', async () => {
    const { stripThink } = await import('../src/skiff-debug.js')
    expect(stripThink('答案<think>内部推理</think>正文')).toBe('答案正文')
    expect(stripThink('<think>只有思考</think>')).toBe('')
    expect(stripThink('无 think 的正常回复')).toBe('无 think 的正常回复')
    // 未闭合：think 内容截断，开标签前正文保留
    expect(stripThink('前置<think>剩余全部作为思考')).toBe('前置')
  })
})

describe('weixin-route: CCC 配置 + 凭据 + 映射', () => {
  it('会话 id 固定可重建 + 前缀判定', () => {
    const a = weixinSessionIdFor('userA@im.wechat')
    const b = weixinSessionIdFor('userA@im.wechat')
    const c = weixinSessionIdFor('userB@im.wechat')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^skiff-weixin-/)
    expect(isWeixinSessionId(a)).toBe(true)
    expect(isWeixinSessionId('skiff-qa-xxx')).toBe(false)
  })

  it('readWeixinSettings 归一（未配置 → 默认关）', () => {
    expect(readWeixinSettings(dir)).toEqual({ enabled: false, accounts: [], routes: [] })
  })

  it('readWeixinSettings 读取配置 + 清洗非法项', () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1', name: '家庭', enabled: true }, { accountId: '' }],
        routes: [{ user: 'u1@im.wechat', role: 'qa' }, { user: '', role: 'x' }],
      },
    }))
    const s = readWeixinSettings(dir)
    expect(s.enabled).toBe(true)
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts![0]!.accountId).toBe('wechat-1')
    expect(s.routes).toHaveLength(1)
  })

  it('凭据读写分离：token 只进 localstore credentials，不落 serenity.json', () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: false } }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok-1', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'u1' })
    const cred = readWeixinCredential(dir, 'wechat-1')
    expect(cred?.token).toBe('tok-1')
    expect(cred?.baseUrl).toBe('https://ilinkai.weixin.qq.com')
    // localstore 文件含 token（credential scope）；serenity.json 不含
    const local = JSON.parse(require('node:fs').readFileSync(join(dir, 'localstore.json'), 'utf-8')) as Record<string, unknown>
    expect(JSON.stringify(local)).toContain('tok-1')
    expect(JSON.stringify(local)).toContain('WEIXIN_WECHAT_1_TOKEN')
    const serenityRaw = require('node:fs').readFileSync(join(dir, '.opencode', 'serenity.json'), 'utf-8')
    expect(serenityRaw).not.toContain('tok-1')
    expect(readWeixinCredential(dir, 'wechat-2')).toBeNull()
    clearWeixinCredential(dir, 'wechat-1')
    expect(readWeixinCredential(dir, 'wechat-1')).toBeNull()
  })

  it('路由匹配：exact 优先，通配兜底，无命中 null', () => {
    const routes = [{ user: 'a@im.wechat', role: 'r1' }, { user: '*', role: 'r2' }]
    expect(matchWeixinRoute(routes, 'a@im.wechat')).toBe('r1')
    expect(matchWeixinRoute(routes, 'b@im.wechat')).toBe('r2')
    expect(matchWeixinRoute([], 'a@im.wechat')).toBeNull()
  })

  it('extractWeixinText：文本取首条，非文本/空 → null', () => {
    expect(extractWeixinText({ item_list: [{ type: 1, text_item: { text: '  hi  ' } }] })).toBe('hi')
    expect(extractWeixinText({ item_list: [{ type: 2, text_item: { text: 'x' } }] })).toBeNull()
    expect(extractWeixinText({})).toBeNull()
  })

  it('extractWeixinText：语音服务端转写 voice_item.text（type 3）——微信语音支持', () => {
    expect(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: '  语音内容  ' } }] })).toBe('语音内容')
    // 文本 + 语音混合 → 文本优先
    expect(extractWeixinText({ item_list: [{ type: 1, text_item: { text: 'hi' } }, { type: 3, voice_item: { text: '语音' } }] })).toBe('hi')
    // 语音无转写 → null（bridge 降级提示）
    expect(extractWeixinText({ item_list: [{ type: 3, voice_item: {} }] })).toBeNull()
  })

  it('hasVoiceItem：type 3 + voice_item 判定（降级提示用）', () => {
    expect(hasVoiceItem({ item_list: [{ type: 3, voice_item: { text: 'x' } }] })).toBe(true)
    expect(hasVoiceItem({ item_list: [{ type: 3, voice_item: {} }] })).toBe(true)
    expect(hasVoiceItem({ item_list: [{ type: 1, text_item: { text: 'x' } }] })).toBe(false)
    expect(hasVoiceItem({})).toBe(false)
  })

  it('upsert/remove/save/setEnabled 写回 serenity.json', () => {
    upsertWeixinAccount(dir, { accountId: 'wechat-1', name: 'n1', enabled: true })
    let s = readWeixinSettings(dir)
    expect(s.accounts).toHaveLength(1)
    upsertWeixinAccount(dir, { accountId: 'wechat-1', name: 'n2' })
    s = readWeixinSettings(dir)
    expect(s.accounts![0]!.name).toBe('n2')
    expect(s.accounts).toHaveLength(1)
    saveWeixinRoutes(dir, [{ user: '*', role: 'qa' }])
    s = readWeixinSettings(dir)
    expect(s.routes![0]!.role).toBe('qa')
    setWeixinEnabled(dir, true)
    expect(readWeixinSettings(dir).enabled).toBe(true)
    removeWeixinAccount(dir, 'wechat-1')
    expect(readWeixinSettings(dir).accounts).toHaveLength(0)
  })

  it('nextWeixinAccountId：自增 + 移除中间账号后复用（多账号）', () => {
    upsertWeixinAccount(dir, { accountId: 'wechat-1' })
    upsertWeixinAccount(dir, { accountId: 'wechat-2' })
    upsertWeixinAccount(dir, { accountId: 'wechat-3' })
    expect(nextWeixinAccountId(readWeixinSettings(dir))).toBe('wechat-4')
    // 移除 wechat-2 → 最小未占用 = wechat-2（复用，不跳到 4）
    removeWeixinAccount(dir, 'wechat-2')
    expect(nextWeixinAccountId(readWeixinSettings(dir))).toBe('wechat-2')
    // 空账号表 → wechat-1
    expect(nextWeixinAccountId({ enabled: false, accounts: [], routes: [] })).toBe('wechat-1')
  })
})

describe('weixin-bridge: handleIncoming 集成（fake ctx + 注册表）', () => {
  /** fake ctx（对齐 acp-core.test fakeCtx）：agents.create/resume 产生带 followup 的 fake agent；
   *  on 立即触发 idle（waitIdle 立即返回）；followup 推入 user + assistant 答案事件。
   *  resumeMode: 'create'（resume 缺失→恒 create 路径）/ 'resume'（resume 命中历史恢复）/ 'not-found'（首次） */
  function fakeCtx(resumeMode: 'create' | 'resume' | 'not-found' = 'create'): {
    agents: {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
      resume?: (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
    }
    on: () => () => void
  } {
    let agent: { session: { id: string; events: unknown[] }; followup: () => void; interrupt?: () => void } | undefined
    const makeAgent = (id: string, opts: { setup?: (c: unknown) => Promise<void> }) => {
      const built = {
        session: { id, events: [] as unknown[] },
        followup: () => {
          built.session.events.push(
            { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**答**案' }] } } },
          )
        },
        interrupt: () => {},
      }
      // 历史恢复场景：resume 的 session 已含旧事件（同用户之前对话过）
      if (resumeMode === 'resume') {
        built.session.events.push({ type: 'user/message', data: { content: [{ type: 'text', text: '旧问题' }] } })
      }
      return built
    }
    const agents: {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
      resume?: (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
    } = {
      create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        agent = makeAgent(opts.sessionId, opts)
        await opts.setup?.(agent as never)
        return { agent }
      },
    }
    if (resumeMode === 'resume') {
      agents.resume = async (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        agent = makeAgent(opts.resumeSessionId, opts)
        await opts.setup?.(agent as never)
        return { agent }
      }
    } else if (resumeMode === 'not-found') {
      agents.resume = async (opts: { resumeSessionId: string }) => {
        const err = new Error(`session "${opts.resumeSessionId}" not found`)
        err.name = 'SessionPersistenceNotFoundError'
        throw err
      }
    }
    return {
      agents,
      on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent, status: 'idle' })
        return () => {}
      },
    }
  }

  it('路由命中 → session/new + prompt → 回复回写（md→plain）', async () => {
    // 配置：enabled + 路由 * → qa
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
    }))
    // 凭据
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com' })

    // 捕获 sendmessage 调用（endpoint 在 URL——mock 检查 URL 而非 body）
    const sent: Array<{ to: string; text: string; contextToken?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { to_user_id: string; item_list: Array<{ text_item: { text: string } }>; context_token?: string } }
        sent.push({ to: p.msg.to_user_id, text: p.msg.item_list[0]!.text_item.text, contextToken: p.msg.context_token })
      }
      return jsonResponse(200, { ret: 0 })
    })

    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = fakeCtx('not-found') // 首次：resume not-found → 降级 create → 新会话
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com' }, {
      from_user_id: 'u1@im.wechat',
      context_token: 'ct1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // session/new 已创建（注册表含 skiff-weixin- 会话）+ 回复已回写
    // 首条消息 = 新会话 → 通知（新的对话已开始）+ 答案，共 2 条
    expect([...skiffSessionSnapshot().keys()].some((id) => id.startsWith('skiff-weixin-'))).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.text.includes('新的对话')).toBe(true)
    expect(sent[1]!.to).toBe('u1@im.wechat')
    expect(sent[1]!.text).toBe('答案') // markdown **答**案 → 答案
    expect(sent[1]!.contextToken).toBe('ct1') // context_token 回带
  })

  it('进程重启后会话持久化历史存在 → resume 恢复（不发"新对话"通知，直接答案）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
    }))
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = fakeCtx('resume') // 重启后：resume 命中历史 → 恢复，非新对话
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u2@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    // 历史延续：无"新的对话"通知，只有答案
    expect(sent.some((s) => s.text.includes('新的对话'))).toBe(false)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('无路由 → 不创建会话不回复', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true } }))
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    expect(skiffSessionSnapshot().size).toBe(0)
  })

  it('非文本消息 → 忽略', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
      skiff: { roles: { qa: { systemPrompt: 'qa' } } },
    }))
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 2 }], // 图片
    })
    expect(skiffSessionSnapshot().size).toBe(0)
  })

  it('语音消息（带服务端转写 voice_item.text）→ 按文本处理并回复', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
    }))
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'voice@im.wechat',
      item_list: [{ type: 3, voice_item: { text: '语音问题' } }],
    })
    // 服务端转写 → 进对话 → 正常回复（新会话通知 + 答案）
    expect(sent.some((s) => s.text.includes('新的对话'))).toBe(true)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('语音无转写 → 降级提示（不静默、不创建会话）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
      skiff: { roles: { qa: { systemPrompt: 'qa' } } },
    }))
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 3, voice_item: {} }], // 语音但无转写
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text.includes('无法解析')).toBe(true)
    expect(skiffSessionSnapshot().size).toBe(0)
  })

  it('正在输入：处理前 sendtyping 1，处理后 0（getconfig ticket 缓存一次）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      handyman: { models: ['p/m'], defaultModel: 'p/m' },
      skiff: { roles: { qa: { msms: [], tools: [], systemPrompt: 'qa' } } },
      weixin: { enabled: true, routes: [{ user: '*', role: 'qa' }] },
    }))
    const calls: Array<{ url: string; body?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, body: init?.body as string | undefined })
      if (url.includes('getconfig')) return jsonResponse(200, { ret: 0, typing_ticket: 'tk-1' })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/weixin-bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'typing@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    // 状态序列：1（开始）→ …处理… → 0（结束）
    const typingCalls = calls.filter((c) => c.url.includes('sendtyping'))
    expect(typingCalls).toHaveLength(2)
    expect(JSON.parse(typingCalls[0]!.body!).status).toBe(1)
    expect(JSON.parse(typingCalls[0]!.body!).ilink_user_id).toBe('typing@im.wechat')
    expect(JSON.parse(typingCalls[1]!.body!).status).toBe(0)
    // ticket 缓存：getconfig 只调一次
    expect(calls.filter((c) => c.url.includes('getconfig'))).toHaveLength(1)
  })
})
