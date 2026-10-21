import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv } from 'node:crypto'

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

// trajectory-session 依赖 @deepseek-ai/dsh-session 类型（运行时擦除）——无需 mock；
// createTrajectoryAgent 链在 handleIncoming 集成测试中用 fake ctx 走轻路径
// （原注释写「acp-core → trajectory-session 链」，2026-10-15 更正：**本链从不经过 acp-core**——
//  桥 import 的是 trajectory-session；acp-core 已随面 E 退役删除）

import {
  fetchQRCode,
  pollQRStatus,
  getUpdates,
  sendTextMessage,
  getConfig,
  sendTyping,
  TypingStatus,
  buildMediaDownloadUrl,
  parseMediaAesKey,
  aes128EcbDecrypt,
  sniffImageExt,
  downloadMedia,
  markdownToPlainText,
  buildClientVersion,
  __setWeixinFetchForTest,
} from '../src/im/ilink.js'
import {
  weixinSessionIdForTrajectory,
  isWeixinSessionId,
  readWeixinSettings,
  readWeixinCredential,
  writeWeixinCredential,
  clearWeixinCredential,
  matchWeixinRoute,
  extractWeixinText,
  hasVoiceItem,
  extractWeixinMedia,
  sanitizeFileName,
  weixinInboundDir,
  upsertWeixinAccount,
  removeWeixinAccount,
  saveWeixinRoutes,
  setWeixinEnabled,
  nextWeixinAccountId,
} from '../src/im/route.js'
import { registerTrajectorySession, unregisterTrajectorySession, trajectorySessionSnapshot } from '../src/trajectory/session.js'
import { manualOutputFallbackNeeded } from '../src/im/bridge.js'
import { registerWeixinOutputGuard } from '../src/im/guard.js'
// 轨迹夹具（造 轨迹约束 数据的**唯一入口**；2026-10-19 重做后约束面住在轨迹目录的 `trajectory-constraint.json` 里）
import { makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

let dir: string
let oldConfigEnv: string | undefined
/** P0-3：机器级留痕的 env 隔离（`handleIncoming` 的未命中／目标不存在档会写它） */
let oldAuditEnv: string | undefined

/** fake Response（fetch mock 返回值） */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-'))
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  // 🔴 同 `weixin-bridge-branches.test.ts`：不隔离 ⇒ 用例会把行写进**真机** `~/.dsh/`
  oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'human-channel-audit.jsonl')
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  // 🔴 2026-10-19 重做后**路由目标必须是该 CCC 里真实存在的认知轨迹**（`findDirNameByCode`），
  //    不再是"这个 CCC 配没配这个 轨迹约束角色" ⇒ 夹具默认造一条 `qa` 轨迹（有 `trajectory-constraint.json`
  //    ⇒ 它同时是一条 轨迹约束轨迹）。需要别的编码的用例各自另造（如 `zc`）；需要"目标不存在"
  //    的用例（C4）写一个根本不存在的编码。
  makeTrajectory(dir, 'qa', 轨迹约束Json({ tools: [], msms: [], systemPrompt: 'qa' }))
})

afterEach(async () => {
  __setWeixinFetchForTest(null)
  // typing_ticket 缓存清空（模块级状态，防测试间污染）
  const { resetWeixinTypingCache, resetWeixinContextCache } = await import('../src/im/bridge.js')
  resetWeixinTypingCache()
  // 🔴 2026-10-21：`context_token` 缓存同样是**模块级**状态 —— 不清就会跨用例污染。
  //    实测形态（本文件首跑就踩到）：前一条用例入站带了 `ct1`，后一条用例的
  //    「无票 ⇒ 裸发」断言于是收到 `expected 'ct1' to be undefined`。
  //    ⚠️ 这类污染**只在同文件内串行执行时才暴露**，跑单条用例永远是绿的。
  resetWeixinContextCache()
  // v1.30.16：手动输出闸门模块级状态（桥每轮登记）——跨用例清空
  const { __resetWeixinOutputGuardForTest } = await import('../src/im/guard.js')
  __resetWeixinOutputGuardForTest()
  for (const [id] of trajectorySessionSnapshot()) unregisterTrajectorySession(id)
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
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

  it('buildMediaDownloadUrl：full_url 优先 + encrypted_query_param 构造 + 无 → null', () => {
    expect(buildMediaDownloadUrl({ full_url: 'https://cdn.example.com/f' })).toBe('https://cdn.example.com/f')
    expect(buildMediaDownloadUrl({ encrypt_query_param: 'eq 1' })).toContain('/download?encrypted_query_param=eq%201')
    expect(buildMediaDownloadUrl({})).toBeNull()
  })

  it('parseMediaAesKey：hex / base64-16 / base64-32-ascii-hex 三型 + 无效 → null', () => {
    const hexKey = '0123456789abcdef0123456789abcdef'
    // ① 32 hex 字符 → hex Buffer(16)
    expect(parseMediaAesKey(hexKey)?.toString('hex')).toBe(hexKey)
    // ② base64 解码 16 字节
    const b64 = Buffer.from(hexKey, 'hex').toString('base64')
    expect(parseMediaAesKey(b64)?.toString('hex')).toBe(hexKey)
    // ③ base64 解码 32 字节 → ascii 是 hex 串 → 再 hex
    const b64ascii = Buffer.from(hexKey, 'ascii').toString('base64')
    expect(parseMediaAesKey(b64ascii)?.toString('hex')).toBe(hexKey)
    // 无效
    expect(parseMediaAesKey(undefined)).toBeNull()
    expect(parseMediaAesKey('')).toBeNull()
    expect(parseMediaAesKey('abc')).toBeNull()
  })

  it('aes128EcbDecrypt 已知向量（AES-128-ECB 解密，无 IV）', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const plain = Buffer.from('hello weixin media!')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    expect(aes128EcbDecrypt(encrypted, key).toString()).toBe('hello weixin media!')
  })

  it('sniffImageExt 魔数嗅探（jpg/png/gif/webp/bmp/bin）', () => {
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpg')
    expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffImageExt(Buffer.from('GIF89a'))).toBe('gif')
    expect(sniffImageExt(Buffer.from('RIFFxxxxWEBP'))).toBe('webp')
    expect(sniffImageExt(Buffer.from('BMxxxx'))).toBe('bmp')
    expect(sniffImageExt(Buffer.from('not an image'))).toBe('bin')
  })

  it('downloadMedia：CDN GET + AES 解密（image）；非 200 / 无 URL → null', async () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const plain = Buffer.from('fake jpeg bytes')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    let calledUrl = ''
    __setWeixinFetchForTest(async (input) => {
      calledUrl = typeof input === 'string' ? input : String(input)
      return new Response(encrypted, { status: 200 })
    })
    const r = await downloadMedia({
      item: { image_item: { media: { encrypt_query_param: 'eq-1' }, aeskey: key.toString('hex') } },
      mediaType: 'image_item',
    })
    expect(r?.data.equals(plain)).toBe(true)
    expect(calledUrl).toContain('/download?encrypted_query_param=eq-1')
    // 非 200 → null
    __setWeixinFetchForTest(async () => new Response('err', { status: 500 }))
    expect(await downloadMedia({ item: { image_item: { media: { encrypt_query_param: 'eq-1' }, aeskey: 'x' } }, mediaType: 'image_item' })).toBeNull()
    // 无 URL（无 encrypt_query_param / full_url）→ null（不调 fetch）
    expect(await downloadMedia({ item: { image_item: { media: {} } }, mediaType: 'image_item' })).toBeNull()
    // 无 media 项 → null
    expect(await downloadMedia({ item: {}, mediaType: 'image_item' })).toBeNull()
  })

  it('markdownToPlainText 7 类转换', () => {
    expect(markdownToPlainText('# 标题\n**粗** *斜* `code` ~~删~~ [文](http://x) ![图](http://i)')).toBe('标题\n粗 斜 code 删 文')
    expect(markdownToPlainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(markdownToPlainText('| a | b |\n|---|---|')).toBe('')
  })

  it('stripThink 剥离 <think> 块（微信桥用户反馈：用户不应看到思考过程）', async () => {
    const { stripThink } = await import('../src/surface/text.js')
    expect(stripThink('答案<think>内部推理</think>正文')).toBe('答案正文')
    expect(stripThink('<think>只有思考</think>')).toBe('')
    expect(stripThink('无 think 的正常回复')).toBe('无 think 的正常回复')
    // 未闭合：think 内容截断，开标签前正文保留
    expect(stripThink('前置<think>剩余全部作为思考')).toBe('前置')
  })
})

describe('weixin-route: CCC 配置 + 凭据 + 映射', () => {
  it('会话 id 由**轨迹编码**派生 + 前缀判定（身份挂在轨迹上，不挂在微信用户上）', () => {
    // 🔴 2026-10-19：旧派生是 `skiff-weixin-<sha256(微信用户 id)>`（"用户是一等公民"），
    //    现派生是 `skiff-weixin-<轨迹编码>`。完整语义见 `weixin-session-identity.test.ts`。
    const a = weixinSessionIdForTrajectory('qa')
    const b = weixinSessionIdForTrajectory('qa')
    const c = weixinSessionIdForTrajectory('zc')
    expect(a).toBe(b)          // 同一条轨迹 ⇒ 恒同一条会话（跨调用稳定）
    expect(a).not.toBe(c)      // 换轨迹 ⇒ 换会话
    expect(a).toMatch(/^skiff-weixin-/)
    expect(isWeixinSessionId(a)).toBe(true)
    expect(isWeixinSessionId('轨迹约束-qa-xxx')).toBe(false)
  })

  it('readWeixinSettings 归一（未配置 → 默认关）', () => {
    expect(readWeixinSettings(dir)).toEqual({ enabled: false, accounts: [], routes: [] })
  })

  it('readWeixinSettings 读取配置 + 清洗非法项（`role` 过渡别名仍读，统一映射为 `trajectory`）', () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1', name: '家庭', enabled: true }, { accountId: '' }],
        routes: [
          { user: 'u1@im.wechat', trajectory: 'qa' },        // 新写法（canonical）
          { user: 'u2@im.wechat', role: 'zc' },              // 旧写法（存量 CCC 不必同批迁移）
          { user: '', role: 'x' },                           // 残缺行（无 user）→ 丢弃
        ],
      },
    }))
    const s = readWeixinSettings(dir)
    expect(s.enabled).toBe(true)
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts![0]!.accountId).toBe('wechat-1')
    expect(s.routes).toHaveLength(2)
    // 🔴 返回行一律带 `trajectory`：`role` 只在**读侧**作别名（存量配置不必同批改）
    expect(s.routes![0]!.trajectory).toBe('qa')
    expect(s.routes![1]!.trajectory).toBe('zc')
  })

  it('v1.30.10 autoReplyWithLastMessage 归一（缺省 = 自动回发；显式 false 才关）', () => {
    // 缺省（未写该键）→ 非 false（= 现状：桥回发最终文本）
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true } }))
    expect(readWeixinSettings(dir).autoReplyWithLastMessage).not.toBe(false)
    // 显式 false → 关闭
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true, autoReplyWithLastMessage: false } }))
    expect(readWeixinSettings(dir).autoReplyWithLastMessage).toBe(false)
    // 显式 true → 开启
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true, autoReplyWithLastMessage: true } }))
    expect(readWeixinSettings(dir).autoReplyWithLastMessage).toBe(true)
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

  it('路由匹配：exact 优先，通配兜底，无命中 null（返回值 = 目标**轨迹编码**）', () => {
    const routes = [{ user: 'a@im.wechat', trajectory: 'r1' }, { user: '*', trajectory: 'r2' }]
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

  it('extractWeixinMedia：type 2 图 / type 4 文件（需 media 元数据）；无 media/非媒体 → 过滤', () => {
    const refs = extractWeixinMedia({
      item_list: [
        { type: 2, image_item: { media: { encrypt_query_param: 'e1' }, aeskey: 'k1' } },
        { type: 4, file_item: { media: { full_url: 'https://f' }, file_name: '../evil.pdf' } },
        { type: 1, text_item: { text: 'hi' } },
        { type: 2, image_item: {} }, // 无 media → 过滤
      ],
    })
    expect(refs).toHaveLength(2)
    expect(refs[0]!.kind).toBe('image')
    expect(refs[1]!.kind).toBe('file')
    expect(refs[1]!.fileName).toBe('../evil.pdf')
    expect(extractWeixinMedia({})).toEqual([])
  })

  it('sanitizeFileName：basename + 去控制字符 + 截断 128（防路径穿越）', () => {
    expect(sanitizeFileName('../evil/name.pdf')).toBe('name.pdf')
    expect(sanitizeFileName('a\u0000b.txt')).toBe('ab.txt')
    expect(sanitizeFileName('x'.repeat(200) + '.txt').length).toBeLessThanOrEqual(128)
  })

  it('weixinInboundDir：确定性 + 按用户分目录 + _tmp/weixin-inbound 格式', () => {
    const a = weixinInboundDir(dir, 'u1@im.wechat')
    const b = weixinInboundDir(dir, 'u1@im.wechat')
    const c = weixinInboundDir(dir, 'u2@im.wechat')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith(dir)).toBe(true)
    expect(a).toContain('_tmp/weixin-inbound/')
  })

  it('upsert/remove/save/setEnabled 写回 serenity.json', () => {
    upsertWeixinAccount(dir, { accountId: 'wechat-1', name: 'n1', enabled: true })
    let s = readWeixinSettings(dir)
    expect(s.accounts).toHaveLength(1)
    upsertWeixinAccount(dir, { accountId: 'wechat-1', name: 'n2' })
    s = readWeixinSettings(dir)
    expect(s.accounts![0]!.name).toBe('n2')
    expect(s.accounts).toHaveLength(1)
    saveWeixinRoutes(dir, [{ user: '*', trajectory: 'qa' }])
    s = readWeixinSettings(dir)
    expect(s.routes![0]!.trajectory).toBe('qa')
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
  /** fake ctx（原地演化自 trajectory-session 侧的 fakeCtx；原注「对齐 acp-core.test fakeCtx」已失效——
   *  该文件 2026-10-15 随面 E 退役删除）：agents.create/resume 产生带 followup 的 fake agent；
   *  on 立即触发 idle（waitIdle 立即返回）；followup 推入 user + assistant 答案事件。
   *  resumeMode: 'create'（resume 缺失→恒 create 路径）/ 'resume'（resume 命中历史恢复）/ 'not-found'（首次）
   *  / 'live'（v1.27.3：重启后 DSH 恢复 live——resume/create 均抛错，get 返回 live agent） */
  function fakeCtx(
    resumeMode: 'create' | 'resume' | 'not-found' | 'live' = 'create',
    liveId?: string,
    testOpts?: { noSystemPrompt?: boolean },
  ): {
    agents: {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
      resume?: (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void> }) => Promise<unknown>
      get?: (id: string) => unknown
    }
    on: () => () => void
    /** askTrajectory 注入的 question 文本（媒体存在性/降级断言用） */
    questions: string[]
    /** agent 系统提示词段（v1.30.13：工作台纪律单一注入点断言用） */
    sections: Array<{ name: string; text: () => string }>
  } {
    let agent: { session: { id: string; events: unknown[] }; followup: (msg?: unknown) => void; interrupt?: () => void } | undefined
    const questions: string[] = []
    const sections: Array<{ name: string; text: () => string }> = []
    const makeAgent = (id: string, opts: { setup?: (c: unknown) => Promise<void> }) => {
      const built = {
        session: { id, events: [] as unknown[] },
        // 保真：宿主 agent 上下文有 systemPrompt.section（E-01 纪律——替身镜像宿主）
        ctx: testOpts?.noSystemPrompt ? {} : { systemPrompt: { section: (s: { name: string; text: () => string }) => sections.push(s) } },
        followup: (msg?: { content?: Array<{ type?: string; text?: string }> }) => {
          // 捕获 askTrajectory 注入的 question（含媒体存在性/降级说明）
          const q = (msg?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
          if (q) questions.push(q)
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
      get?: (id: string) => unknown
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
    } else if (resumeMode === 'live') {
      // 重启后 DSH 恢复的 live 会话（v1.27.3 根因场景）：resume 报 "while it is live"、
      // create 报 "already exists"、get 返回 live agent——唯一可行路径 = get 复用
      const live = makeAgent(liveId ?? 'skiff-weixin-live', {})
      agent = live
      agents.get = (id: string) => (id === live.session.id ? live : undefined)
      agents.resume = async () => {
        throw new Error('cannot prepare session while it is live')
      }
      agents.create = async () => {
        throw new Error('session already exists')
      }
    }
    return {
      agents,
      on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent, status: 'idle' })
        return () => {}
      },
      questions,
      sections,
    }
  }

  it('路由命中 → session/new + prompt → 回复回写（md→plain）', async () => {
    // 配置：enabled + 路由 * → qa
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
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

    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found') // 首次：resume not-found → 降级 create → 新会话
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com' }, {
      from_user_id: 'u1@im.wechat',
      context_token: 'ct1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // session/new 已创建（注册表含 skiff-weixin- 会话）+ 回复已回写
    // 首条消息 = 新会话 → 通知（新的对话已开始）+ 答案，共 2 条
    expect([...trajectorySessionSnapshot().keys()].some((id) => id.startsWith('skiff-weixin-'))).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.text.includes('新的对话')).toBe(true)
    expect(sent[1]!.to).toBe('u1@im.wechat')
    expect(sent[1]!.text).toBe('答案') // markdown **答**案 → 答案
    expect(sent[1]!.contextToken).toBe('ct1') // context_token 回带
  })

  it('v1.30.16 autoReplyWithLastMessage=false → 桥不回发最终文本 + 每轮末尾注入机制标记（措辞归 CCC）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, autoReplyWithLastMessage: false, hook: 'hooks/weixin-log.js', routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const hookEvents: unknown[] = []
    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    setWeixinHookRunnerForTest(async (_root, _rel, ev) => {
      hookEvents.push(ev)
      return { ok: true }
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'manual@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // ① 桥不回发 agent 最终文本（只剩系统类「新对话」通知——用户拍板保留）
    expect(sent.map((s) => s.text).join('|')).not.toContain('答案')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('新的对话')

    // ② 每轮注入**机制标记**（v1.30.16 重构：ACC 只给事实 + 已填参数，措辞归 CCC 角色提示词）
    const q = ctx.questions[0] ?? ''
    expect(q).toContain('[serenity:weixin-manual-output]')
    expect(q).toContain('im-bridge({channel:"weixin", action:"send"')
    expect(q).toContain('account:"wechat-1"')
    expect(q).toContain('user:"manual@im.wechat"')
    expect(q).not.toContain('--ccc') // v1.31.0：工具只能操作本会话 CCC → 命令无目标 CCC 参数
    // ACC 不再内嵌任何纪律措辞（用户拍板"这个词不能让 ACC 定义，要让 CCC 定义"）
    expect(q).not.toContain('Reply Output')
    expect(q).not.toContain('no fallback')
    expect(q).not.toContain('will NOT')
    // 标记位于**消息末尾**（recency——旧实现放在用户正文之前，实测被压过）
    expect(q.indexOf('[serenity:weixin-manual-output]')).toBeGreaterThan(q.indexOf('你好'))
    expect(q.trimEnd().endsWith('})')).toBe(true)
    // 用户原文仍在（标记是追加注入，不吞消息）
    expect(q).toContain('你好')

    // ③ 记录只有 incoming——桥没发消息，故无 outgoing(reply)；agent 自己发的走 source=proactive
    expect(hookEvents.map((e) => (e as { event: string }).event)).toEqual(['incoming'])
  })

  it('v1.30.17 兜底判定矩阵（manualOutputFallbackNeeded：四条件全成立才兜底）', () => {
    const base = { guardActive: true, sentThisTurn: false, answer: '答案' }
    expect(manualOutputFallbackNeeded({ ...base, fallbackOnNoSend: true })).toBe(true)
    // agent 自己发过 → 不重复（输出权归 agent）
    expect(manualOutputFallbackNeeded({ ...base, fallbackOnNoSend: true, sentThisTurn: true })).toBe(false)
    // 缺省（未配置 / 显式 false）→ 严格静默（v1.30.10 语义，向后兼容）
    expect(manualOutputFallbackNeeded({ ...base })).toBe(false)
    expect(manualOutputFallbackNeeded({ ...base, fallbackOnNoSend: false })).toBe(false)
    // 闸门未装配 → 无法判定"是否发送过" → 不兜底（防重复发送）
    expect(manualOutputFallbackNeeded({ ...base, fallbackOnNoSend: true, guardActive: false })).toBe(false)
    // 无最终文本 → 不兜底
    expect(manualOutputFallbackNeeded({ ...base, fallbackOnNoSend: true, answer: '' })).toBe(false)
  })

  it('v1.30.17 fallbackOnNoSend=true + 闸门已装配 + 本轮未发送 → 桥兜底转发最终文本（source=reply-fallback）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, autoReplyWithLastMessage: false, fallbackOnNoSend: true, hook: 'hooks/weixin-log.js', routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: Array<{ text: string; contextToken?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }>; context_token?: string } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text, contextToken: p.msg.context_token })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const hookEvents: unknown[] = []
    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    setWeixinHookRunnerForTest(async (_root, _rel, ev) => {
      hookEvents.push(ev)
      return { ok: true }
    })
    // 闸门装配（handler 不会被触发 → 本轮"未发送"成立）；同时验证 guardActive=true
    registerWeixinOutputGuard({ on: () => () => {} } as never)
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'fallback@im.wechat',
      context_token: 'ct-fb',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })

    // 系统类「新对话」通知 + 兜底转发的最终文本（markdown **答**案 → 答案，context_token 回带）
    expect(sent.map((s) => s.text)).toEqual(['（新的对话已开始）', '答案'])
    expect(sent[1]!.contextToken).toBe('ct-fb')
    // 记录：incoming + outgoing(source=reply-fallback) —— 与 agent 自己发的 proactive 可区分
    const outgoing = hookEvents.filter((e) => (e as { event: string }).event === 'outgoing') as Array<{ source?: string; reply?: string }>
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.source).toBe('reply-fallback')
    expect(outgoing[0]!.reply).toBe('答案')
  })

  it('v1.30.17 fallbackOnNoSend 缺省（false）→ 不兜底（严格静默，向后兼容）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, autoReplyWithLastMessage: false, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    registerWeixinOutputGuard({ on: () => () => {} } as never)
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'strict@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
    expect(sent.map((s) => s.text)).toEqual(['（新的对话已开始）'])
    expect(sent.some((s) => s.text === '答案')).toBe(false)
  })

  it('v1.30.10 autoReplyWithLastMessage=true（显式）→ 仍自动回发（开关对照）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, autoReplyWithLastMessage: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'auto@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    expect(sent.some((s) => s.text === '答案')).toBe(true)
    expect(ctx.questions[0] ?? '').not.toContain('[serenity:weixin-manual-output]')
  })

  it('进程重启后会话持久化历史存在 → resume 恢复（不发"新对话"通知，直接答案）', async () => {    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
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
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('resume') // 重启后：resume 命中历史 → 恢复，非新对话
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'u2@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    // 历史延续：无"新的对话"通知，只有答案
    expect(sent.some((s) => s.text.includes('新的对话'))).toBe(false)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('重启后会话已 live（DSH 恢复）→ live 复用直接回答，无"新对话"通知（v1.27.3 修复）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
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
    const { handleIncoming } = await import('../src/im/bridge.js')
    // 重启后：resume 报 "while it is live"、create 报 "already exists"、get 命中 live agent
    // 🔴 会话 id 由**轨迹编码**派生 ⇒ live 的那条会话 id 就是 `skiff-weixin-qa`（与用户无关）
    const fromId = 'live@im.wechat'
    const ctx = fakeCtx('live', weixinSessionIdForTrajectory('qa'))
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: fromId,
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    // 历史延续（live 复用 resumed=true）：只有答案，无"新的对话已开始"通知
    expect(sent.some((s) => s.text.includes('新的对话'))).toBe(false)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
    // 内存注册表已登记（后续消息走进程内延续）
    expect([...trajectorySessionSnapshot().keys()].some((id) => id === weixinSessionIdForTrajectory('qa'))).toBe(true)
  })

  it('图片消息 → CDN 下载解密 → 落盘 _tmp/weixin-inbound → question 注入路径 → 回复（媒体接收）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(jpg), cipher.final()])
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      if (url.includes('download')) return new Response(encrypted, { status: 200 })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'img@im.wechat',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'eq-img' }, aeskey: key.toString('hex') } }],
    })
    // question 注入：存在性 + 路径（不做内容转述/工具引导——M3）
    expect(ctx.questions.some((q) => q.includes('一张图片') && q.includes('已保存到'))).toBe(true)
    expect(ctx.questions.some((q) => q.includes('_tmp/weixin-inbound/'))).toBe(true)
    expect(ctx.questions.some((q) => q.includes('vlm-describe'))).toBe(false) // 不教工具用法
    // 落盘：文件存在 + 内容 = 解密后明文 + magic-byte 嗅探 .jpg
    const inboundDir = weixinInboundDir(dir, 'img@im.wechat')
    const files = readdirSync(inboundDir)
    expect(files).toHaveLength(1)
    expect(files[0]!.endsWith('.jpg')).toBe(true)
    expect(readFileSync(join(inboundDir, files[0]!)).equals(jpg)).toBe(true)
    // 回复回写（通知 + 答案）
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('文件消息 → 落盘（净化文件名）+ 注入存在性（无加密原样保存）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const plain = Buffer.from('hello file content')
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      if (url.includes('download') || url.includes('cdn/f')) return new Response(plain, { status: 200 })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'file@im.wechat',
      item_list: [{ type: 4, file_item: { media: { full_url: 'https://cdn/f' }, file_name: '../报告.txt' } }],
    })
    // 落盘：净化文件名（去路径穿越）+ 内容原样
    const inboundDir = weixinInboundDir(dir, 'file@im.wechat')
    expect(readdirSync(inboundDir)).toEqual(['报告.txt'])
    expect(readFileSync(join(inboundDir, '报告.txt')).toString()).toBe('hello file content')
    // 注入存在性 + 文件名
    expect(ctx.questions.some((q) => q.includes('文件 报告.txt') && q.includes('已保存到'))).toBe(true)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('媒体下载失败 → 降级注入"下载失败"进对话（不静默）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      if (url.includes('download')) return new Response('err', { status: 500 })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'fail@im.wechat',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'eq' }, aeskey: 'k' } }],
    })
    expect(ctx.questions.some((q) => q.includes('下载失败'))).toBe(true)
    // 未落盘
    expect(existsSync(weixinInboundDir(dir, 'fail@im.wechat'))).toBe(false)
    // agent 处理后回复（降级说明进对话 → 回复告知用户）
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('媒体超 20MB → 降级注入"大小限制"进对话（不落盘）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 1)
    const sent: Array<{ text: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { item_list: Array<{ text_item: { text: string } }> } }
        sent.push({ text: p.msg.item_list[0]!.text_item.text })
      }
      if (url.includes('download')) return new Response(big, { status: 200 })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'big@im.wechat',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'eq' } } }],
    })
    expect(ctx.questions.some((q) => q.includes('20MB'))).toBe(true)
    expect(existsSync(weixinInboundDir(dir, 'big@im.wechat'))).toBe(false)
    expect(sent.some((s) => s.text === '答案')).toBe(true)
  })

  it('无路由 → 不创建会话不回复', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true } }))
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('非文本消息 → 忽略', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 2 }], // 图片
    })
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('语音消息（带服务端转写 voice_item.text）→ 按文本处理并回复', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
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
    const { handleIncoming } = await import('../src/im/bridge.js')
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
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
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
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = { agents: { create: async () => { throw new Error('should not create') } }, on: () => () => {} }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 't', baseUrl: 'https://x' }, {
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 3, voice_item: {} }], // 语音但无转写
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text.includes('无法解析')).toBe(true)
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('正在输入：处理前 sendtyping 1，处理后 0（getconfig ticket 缓存一次）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'qa' }] },
    }))
    const calls: Array<{ url: string; body?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push({ url, body: init?.body as string | undefined })
      if (url.includes('getconfig')) return jsonResponse(200, { ret: 0, typing_ticket: 'tk-1' })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
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

  it('v1.27.13 消息 hook：incoming + outgoing 双向触发（runner 捕获事件，不含凭据）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, hook: 'hooks/weixin-log.js', routes: [{ user: '*', trajectory: 'qa' }] },
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
    // hook runner 注入捕获（真实 spawn 由 weixin-hook.test 覆盖——此处断言 bridge 触发时机与载荷）
    const hookEvents: unknown[] = []
    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    setWeixinHookRunnerForTest(async (_root, _hookRel, ev) => {
      hookEvents.push(ev)
      return { ok: true }
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'hook@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: '记录我' } }],
    })

    // 双向：incoming（用户消息）+ outgoing（bot 回复）各一次，顺序入→出
    expect(hookEvents).toHaveLength(2)
    const incoming = hookEvents[0] as { event: string; userId: string; role: string; message: { text: string | null; media: unknown[] } }
    const outgoing = hookEvents[1] as { event: string; reply: string }
    expect(incoming.event).toBe('incoming')
    expect(incoming.userId).toBe('hook@im.wechat')
    expect(incoming.role).toBe('qa')
    expect(incoming.message.text).toBe('记录我')
    expect(incoming.message.media).toEqual([])
    expect(outgoing.event).toBe('outgoing')
    expect(outgoing.reply).toBe('答案') // stripThink 后的回复文本
    // 载荷无凭据（context_token 不随事件）
    const json = JSON.stringify(hookEvents)
    expect(json).not.toContain('context_token')
    expect(json).not.toContain('"token"')
    expect(sent.some((s) => s.text === '答案')).toBe(true) // 回复仍正常送达（hook 旁路）
  })

  it('v1.27.13 消息 hook：hook 失败不阻断微信桥（旁路容忍 H3）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, hook: 'hooks/weixin-log.js', routes: [{ user: '*', trajectory: 'qa' }] },
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
    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    setWeixinHookRunnerForTest(async () => {
      throw new Error('hook boom') // 注入 runner 抛错（真实执行已吞错——此处验证 fire-and-forget 不阻断）
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found')
    await expect(handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, {
      from_user_id: 'fail@im.wechat',
      context_token: 'ct',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })).resolves.toBeUndefined()
    expect(sent.some((s) => s.text === '答案')).toBe(true) // 回复送达（hook 失败被吞）
  })

  it('v1.30.13：工作台纪律单一注入点——挂 轨迹约束 系统提示词段，桥不再每轮拼 question（用户：不重复配置）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'zc' }] },
    }))
    // 约束面不再写在 `serenity.json` 的 轨迹约束段里（该段已退役）——它住在 `zc` 轨迹目录的 `trajectory-constraint.json`
    const { dirName: zcDir } = makeTrajectory(dir, 'zc', 轨迹约束Json({
      msms: ['memory-tool'],
      tools: ['read', 'write', 'cognitive_trajectory', 'msm'],
      cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
      systemPrompt: '某角色',
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
    const { handleIncoming } = await import('../src/im/bridge.js')
    const fromId = 'user@im.wechat'
    const sid = weixinSessionIdForTrajectory('zc')
    // 两段式真实场景：第一次 incoming（agent 首次创建 → createTrajectoryAgent 内挂段 + 注册进注册表）；
    // 第二次 incoming（同一条轨迹 ⇒ getTrajectoryAgent 命中 existing 快路径）
    const ctx = fakeCtx('not-found')
    const msg: Parameters<typeof handleIncoming>[4] = {
      from_user_id: fromId,
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    }
    // 第一次：create 路径
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, msg)
    // 🔴 工作台 = **这条轨迹自己的 SESSION.md**（旧模型里 `createTrajectoryAgent` 另建一个
    //    `zc 轨迹约束` 目录——那个"自动新建"的动作已随重做整件删除）⇒ 桥**不得**再落第三个目录。
    const sessionDirs = readdirSync(join(dir, 'AGENT_SESSIONS'))
    expect(sessionDirs).toContain(zcDir)
    expect(sessionDirs).toHaveLength(2) // qa（beforeEach 造的）+ zc；桥没有另建
    expect([...trajectorySessionSnapshot().keys()].some((id) => id === sid)).toBe(true)
    // 工作台纪律挂在 agent 系统提示词段（单一注入点）——question 不含（不再每轮重复）
    const wsSections = ctx.sections.filter((s) => s.name === 'serenity-轨迹约束-workspace')
    expect(wsSections).toHaveLength(1)
    // 段正文指向**该轨迹自己的** SESSION.md（旧文案里的 AUTO-BOUND 标记随旧模型退役）
    expect(wsSections[0]!.text()).toContain(join(zcDir, 'SESSION.md'))
    // 动态 text()：每轮按 scope 读活跃 mdPath（绑定变化自动跟随，无需重挂）
    expect(wsSections[0]!.text()).toContain('AGENT_SESSIONS')
    expect(wsSections[0]!.text()).toContain('SESSION.md')
    expect(ctx.questions.every((q) => !q.includes('Serenity Session Workspace'))).toBe(true)
    expect(ctx.questions.some((q) => q.includes('你好'))).toBe(true)
    const questionsAfterFirst = ctx.questions.length
    // 第二次：existing 快路径（getTrajectoryAgent 命中——agent 已在注册表）——段幂等，question 仍不含
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, msg)
    expect(ctx.sections.filter((s) => s.name === 'serenity-轨迹约束-workspace')).toHaveLength(1)
    const newQuestions = ctx.questions.slice(questionsAfterFirst)
    expect(newQuestions.some((q) => q.includes('你好'))).toBe(true)
    expect(newQuestions.every((q) => !q.includes('Serenity Session Workspace'))).toBe(true)
  })

  it('v1.30.13：agent 无 systemPrompt 段 → 降级 question 前缀注入（约束必须在场）', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      'cheap-worker': { models: ['p/m'], defaultModel: 'p/m' },
      weixin: { enabled: true, routes: [{ user: '*', trajectory: 'zc' }] },
    }))
    const { dirName: zcDir } = makeTrajectory(dir, 'zc', 轨迹约束Json({
      msms: [],
      tools: ['read', 'cognitive_trajectory', 'msm'],
      cognitiveTrajectory: { session: true },
      systemPrompt: '某角色',
    }))
    __setWeixinFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) return jsonResponse(200, { ret: 0 })
      return jsonResponse(200, { ret: 0 })
    })
    const { handleIncoming } = await import('../src/im/bridge.js')
    const ctx = fakeCtx('not-found', undefined, { noSystemPrompt: true })
    const msg: Parameters<typeof handleIncoming>[4] = {
      from_user_id: 'user2@im.wechat',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    }
    await handleIncoming(ctx as never, dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' }, msg)
    expect(ctx.sections).toHaveLength(0)
    // 降级注入的纪律块指向该轨迹自己的工作台（AUTO-BOUND 标记随旧模型退役）
    expect(ctx.questions.some((q) => q.includes('Serenity Session Workspace') && q.includes(join(zcDir, 'SESSION.md')) && q.includes('你好'))).toBe(true)
  })
})

describe('weixin-bridge: sendProactiveText（v1.30.9 主动发送，S142 用户需求）', () => {
  /** 捕获 sendmessage + hook 事件 */
  function setupFetchAndHook() {
    const sent: Array<{ to: string; text: string; contextToken?: string }> = []
    __setWeixinFetchForTest(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('sendmessage')) {
        const p = JSON.parse(init?.body as string) as { msg: { to_user_id: string; item_list: Array<{ text_item: { text: string } }>; context_token?: string } }
        sent.push({ to: p.msg.to_user_id, text: p.msg.item_list[0]!.text_item.text, contextToken: p.msg.context_token })
      }
      return jsonResponse(200, { ret: 0 })
    })
    const events: Array<Record<string, unknown>> = []
    return { sent, events }
  }

  it('成功：无票时主动发送照旧（不带 contextToken）+ outgoing hook 带 source=proactive + sessionId 复用该用户所路由的轨迹会话', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: {
        enabled: true,
        hook: 'scripts/hook.js',
        accounts: [{ accountId: 'wechat-1' }, { accountId: 'wechat-2' }],
        routes: [{ user: '*', trajectory: 'my-role' }],
      },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok1', baseUrl: 'https://x' })
    writeWeixinCredential(dir, 'wechat-2', { token: 'tok2', baseUrl: 'https://y' })
    const { sent, events } = setupFetchAndHook()
    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    setWeixinHookRunnerForTest(async (_root, _rel, ev) => {
      events.push(ev as unknown as Record<string, unknown>)
      return { ok: true }
    })

    const { sendProactiveText } = await import('../src/im/bridge.js')
    const r = await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: '**报告**已生成' })
    // 🔴 记录用的 sessionId = 该用户**所路由到的那条轨迹**的会话 id（记录里能按会话串联）
    expect(r).toEqual({ ok: true, accountId: 'wechat-1', userId: 'u1@im.wechat', sessionId: weixinSessionIdForTrajectory('my-role'), role: 'my-role' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'u1@im.wechat', text: '报告已生成' }) // md→plain
    // 🔵 2026-10-21 语义变化（**不是**放宽断言）：没有票时仍走裸发（修前行为）。
    //    「有票就带上」由下方新增的两条用例钉住 —— 两条合起来才是完整契约。
    expect(sent[0]!.contextToken).toBeUndefined()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      event: 'outgoing',
      source: 'proactive',
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: weixinSessionIdForTrajectory('my-role'),
      role: 'my-role',
      reply: '报告已生成',
    })
  })

  /**
   * 🔴 **2026-10-21（owner 报「久不发言就不通」的修法判据）**
   *
   * 协议规范把 `context_token` 定为「会话能力令牌」：主动发送**依赖最近一次入站**带来的票
   * （公开规范 §5.10/§6.4/§12）。修前我们**收到就丢** ⇒ 回复一发完就再没票 ⇒ 主动发送恒裸发。
   * ⇒ 本组用例钉住：**入站带来的票被留住，并在下一次主动发送时带上**。
   *
   * 🔴 判据纪律：这里断言的是**出站 body 里真的出现了那个 token 值**（副作用），
   * 而不是"我们调用了 rememberContextToken"（入参）—— D144：断言入参是弱断言。
   */
  describe('🆕 context_token 缓存（协议 §5.10：主动发送依赖最近一次入站带来的票）', () => {
    beforeEach(async () => {
      writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
        weixin: { enabled: true, accounts: [{ accountId: 'wechat-1' }], routes: [{ user: '*', trajectory: 'my-role' }] },
      }))
      writeWeixinCredential(dir, 'wechat-1', { token: 'tok1', baseUrl: 'https://x' })
      const { resetWeixinContextCache } = await import('../src/im/bridge.js')
      resetWeixinContextCache()
    })

    it('🔴 入站带来 token ⇒ 下一次主动发送**带上它**（修前恒不带）', async () => {
      const { sent } = setupFetchAndHook()
      const { handleIncoming, sendProactiveText } = await import('../src/im/bridge.js')
      const cred = { token: 'tok1', baseUrl: 'https://x', userId: 'me' }

      // ① 用户发来一条消息（带票）
      await handleIncoming({} as never, dir, 'wechat-1', cred, {
        from_user_id: 'u1@im.wechat',
        context_token: 'CT-FROM-INBOUND',
        item_list: [],
      } as never)
      // ② 之后某条轨迹主动发消息 —— 必须带上那张票
      await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: '主动通知' })
      const proactiveSend = sent.filter((s) => s.text === '主动通知')
      expect(proactiveSend).toHaveLength(1)
      expect(proactiveSend[0]!.contextToken).toBe('CT-FROM-INBOUND')
    })

    it('🔴 反向钉：**别人**的票不能用在另一个用户身上（不跨用户复用）', async () => {
      const { sent } = setupFetchAndHook()
      const { handleIncoming, sendProactiveText } = await import('../src/im/bridge.js')
      const cred = { token: 'tok1', baseUrl: 'https://x', userId: 'me' }

      await handleIncoming({} as never, dir, 'wechat-1', cred, {
        from_user_id: 'u1@im.wechat',
        context_token: 'CT-OF-U1',
        item_list: [],
      } as never)
      // 给**另一个**用户主动发 —— 他从来没有票 ⇒ 必须裸发
      await sendProactiveText({ root: dir, toUserId: 'u2@im.wechat', text: '给 u2' })
      const toU2 = sent.filter((s) => s.text === '给 u2')
      expect(toU2).toHaveLength(1)
      expect(toU2[0]!.contextToken).toBeUndefined()
    })

    it('🔴 空 token 不覆盖已有的好票（`trim===""` 时记都不记）', async () => {
      const { sent } = setupFetchAndHook()
      const { handleIncoming, sendProactiveText } = await import('../src/im/bridge.js')
      const cred = { token: 'tok1', baseUrl: 'https://x', userId: 'me' }

      await handleIncoming({} as never, dir, 'wechat-1', cred, {
        from_user_id: 'u1@im.wechat', context_token: 'CT-GOOD', item_list: [],
      } as never)
      // 再来一条**没带票**的消息（服务端没给）⇒ 不能把它当成"票变成了空"
      await handleIncoming({} as never, dir, 'wechat-1', cred, {
        from_user_id: 'u1@im.wechat', context_token: '', item_list: [],
      } as never)
      await sendProactiveText({ root: dir, toUserId: 'u1@im.wechat', text: '还是要有票' })
      const s = sent.filter((x) => x.text === '还是要有票')
      expect(s).toHaveLength(1)
      expect(s[0]!.contextToken).toBe('CT-GOOD')
    })
  })

  it('显式 accountId → 用该账号凭据；未命中路由 → role 空串', async () => {
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1' }, { accountId: 'wechat-2' }],
        routes: [{ user: 'someone-else@im.wechat', trajectory: 'my-role' }],
      },
    }))
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok1', baseUrl: 'https://x' })
    writeWeixinCredential(dir, 'wechat-2', { token: 'tok2', baseUrl: 'https://y' })
    const { sent } = setupFetchAndHook()
    const { sendProactiveText } = await import('../src/im/bridge.js')
    const r = await sendProactiveText({ root: dir, toUserId: 'u2@im.wechat', text: 'hi', accountId: 'wechat-2' })
    expect(r).toMatchObject({ ok: true, accountId: 'wechat-2', role: '' })
    expect(sent).toHaveLength(1)
  })

  it('失败路径：桥未启用 / 无账号 / 账号不存在 / 未绑定 / 发送失败 → 稳定 code', async () => {
    const { sendProactiveText } = await import('../src/im/bridge.js')

    // ① 未启用
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: false, accounts: [] } }))
    expect(await sendProactiveText({ root: dir, toUserId: 'u@im.wechat', text: 't' })).toMatchObject({ ok: false, code: 'BRIDGE_DISABLED' })

    // ② 无账号
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true, accounts: [] } }))
    expect(await sendProactiveText({ root: dir, toUserId: 'u@im.wechat', text: 't' })).toMatchObject({ ok: false, code: 'NO_ACCOUNT' })

    // ③ 账号不存在
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin: { enabled: true, accounts: [{ accountId: 'wechat-1' }] } }))
    expect(await sendProactiveText({ root: dir, toUserId: 'u@im.wechat', text: 't', accountId: 'nope' })).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' })

    // ④ 未绑定凭据
    clearWeixinCredential(dir, 'wechat-1')
    expect(await sendProactiveText({ root: dir, toUserId: 'u@im.wechat', text: 't' })).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_BOUND' })

    // ⑤ 发送失败（iLink 返回 ret 非 0）
    writeWeixinCredential(dir, 'wechat-1', { token: 'tok', baseUrl: 'https://x' })
    __setWeixinFetchForTest(async () => jsonResponse(200, { ret: 1, errmsg: 'denied' }))
    expect(await sendProactiveText({ root: dir, toUserId: 'u@im.wechat', text: 't' })).toMatchObject({ ok: false, code: 'SEND_FAILED' })
  })
})
