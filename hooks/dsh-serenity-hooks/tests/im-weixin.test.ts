import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 微信通道测试（v1.31.0，S142 P1）。
 *
 * 通道实现 = `im-bridge` 的微信插槽：可见性判据（`weixin.enabled`）、别名解析（读本 CCC
 * localstore）、文本/文件发送与记录。协议层（iLink HTTP/CDN 上传）已由 weixin.test.ts
 * 覆盖，此处只验证**通道契约**——用替身隔离网络，替身形状镜像真实导出（E-01 纪律）。
 */

const sendProactiveText = vi.fn()
const weixinBridgeStatus = vi.fn()
const resolveWeixinAccount = vi.fn()
const sendFileMessage = vi.fn()
const sendTextMessage = vi.fn()
const invokeWeixinHook = vi.fn()
const buildOutgoingHookEvent = vi.fn()

vi.mock('../src/im/bridge.js', () => ({
  sendProactiveText: (...a: unknown[]) => sendProactiveText(...a),
  weixinBridgeStatus: (...a: unknown[]) => weixinBridgeStatus(...a),
  resolveWeixinAccount: (...a: unknown[]) => resolveWeixinAccount(...a),
}))
vi.mock('../src/im/ilink.js', () => ({
  sendFileMessage: (...a: unknown[]) => sendFileMessage(...a),
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
}))
vi.mock('../src/im/hook.js', () => ({
  invokeWeixinHook: (...a: unknown[]) => invokeWeixinHook(...a),
  buildOutgoingHookEvent: (...a: unknown[]) => buildOutgoingHookEvent(...a),
}))

const { weixinChannel, weixinAliasMap } = await import('../src/im/weixin-channel.js')

let dir = ''

/** 写该 CCC 的 serenity.json（微信段）与 localstore 凭据 */
function setupCcc(weixin: Record<string, unknown>, credentials: Record<string, string> = {}): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ weixin }))
  if (Object.keys(credentials).length > 0) {
    writeFileSync(join(dir, 'localstore.json'), JSON.stringify({ credentials }, null, 2))
  }
}

/** 该 CCC 的别名表（形如 { user-a: 'WEIXIN_USER_A' }）——测试夹具统一用中性名 */
const ALIASES = { 'user-a': 'WEIXIN_USER_A', 'user-b': 'WEIXIN_USER_B' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'im-weixin-'))
  sendProactiveText.mockReset()
  weixinBridgeStatus.mockReset().mockReturnValue([])
  resolveWeixinAccount.mockReset()
  sendFileMessage.mockReset()
  sendTextMessage.mockReset()
  invokeWeixinHook.mockReset()
  buildOutgoingHookEvent.mockReset().mockReturnValue({ event: 'outgoing' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('im-weixin: 通道身份与可见性判据', () => {
  it('通道 id = weixin（工具 channel 参数取值）', () => {
    expect(weixinChannel.id).toBe('weixin')
  })

  it('未配置 / enabled=false → isEnabled false（工具对本 CCC 不可见）', () => {
    expect(weixinChannel.isEnabled(dir)).toBe(false)
    setupCcc({ enabled: false })
    expect(weixinChannel.isEnabled(dir)).toBe(false)
  })

  it('enabled=true → isEnabled true', () => {
    setupCcc({ enabled: true })
    expect(weixinChannel.isEnabled(dir)).toBe(true)
  })
})

describe('im-weixin: 别名解析（别名归 CCC 配置，D23 / v1.56.10）', () => {
  it('🔴 ACC 源码不含任何具体别名（隐私核查：别名随包发布过）', () => {
    // 未配置 ⇒ 别名表为空（ACC 不认识任何名字）
    setupCcc({ enabled: true })
    expect(weixinAliasMap(dir)).toEqual({})
    expect(weixinChannel.listUsers(dir)).toEqual([])
    // 源码面：别名只在 CCC 配置里出现
    const src = readFileSync(new URL('../src/im/weixin-channel.ts', import.meta.url), 'utf-8')
    for (const person of ['user-b', 'user-a', 'user-c']) {
      expect(src.toLowerCase()).not.toContain(`'${person}'`)
    }
  })

  it('CCC 配了别名 → 解析为该 CCC 的 iLink id；大小写不敏感', () => {
    setupCcc({ enabled: true, aliases: ALIASES }, { WEIXIN_USER_A: 'a@im.wechat' })
    expect(weixinChannel.resolveUser(dir, 'user-a')).toEqual({ alias: 'user-a', id: 'a@im.wechat' })
    expect(weixinChannel.resolveUser(dir, 'USER-A')).toEqual({ alias: 'user-a', id: 'a@im.wechat' })
  })

  it('别名存在但凭据缺失 → null（不猜测、不回落）', () => {
    setupCcc({ enabled: true, aliases: ALIASES })
    expect(weixinChannel.resolveUser(dir, 'user-a')).toBeNull()
  })

  it('非法别名表项被清洗（空键 / 非字符串值 / 数组）', () => {
    setupCcc({ enabled: true, aliases: { '': 'X', ' user-c ': ' WEIXIN_USER_C ', bad: 42 } })
    expect(weixinAliasMap(dir)).toEqual({ 'user-c': 'WEIXIN_USER_C' })
    setupCcc({ enabled: true, aliases: ['nope'] })
    expect(weixinAliasMap(dir)).toEqual({})
  })

  it('裸 iLink id（含 @）直接透传；空串/未知别名 → null', () => {
    setupCcc({ enabled: true, aliases: ALIASES })
    expect(weixinChannel.resolveUser(dir, 'u@im.wechat')).toEqual({ alias: 'u@im.wechat', id: 'u@im.wechat' })
    expect(weixinChannel.resolveUser(dir, '')).toBeNull()
    expect(weixinChannel.resolveUser(dir, '   ')).toBeNull()
    expect(weixinChannel.resolveUser(dir, 'nobody')).toBeNull()
  })

  it('listUsers 只列有凭据的别名', () => {
    setupCcc({ enabled: true, aliases: ALIASES }, { WEIXIN_USER_A: 'a@im.wechat', WEIXIN_USER_B: 'b@im.wechat' })
    const users = weixinChannel.listUsers(dir)
    expect(users).toEqual([
      { alias: 'user-a', id: 'a@im.wechat' },
      { alias: 'user-b', id: 'b@im.wechat' },
    ])
  })
})

describe('im-weixin: status（工具返回值必须可 JSON 化）', () => {
  it('三态配置 + 路由 + 本 CCC 账号轮询快照', () => {
    setupCcc({
      enabled: true,
      autoReplyWithLastMessage: false,
      fallbackOnNoSend: true,
      routes: [{ user: '*', role: 'my-role' }],
    })
    weixinBridgeStatus.mockReturnValue([
      { ccc: dir, accounts: [{ accountId: 'wechat-1', lastPollAt: 123, lastError: 'boom' }] },
      { ccc: '/other/ccc', accounts: [{ accountId: 'wechat-9', lastPollAt: 1 }] },
    ])
    const status = weixinChannel.status(dir)
    expect(status).toEqual({
      enabled: true,
      autoReplyWithLastMessage: false,
      fallbackOnNoSend: true,
      routes: [{ user: '*', role: 'my-role' }],
      accounts: [{ accountId: 'wechat-1', lastPollAt: 123, lastError: 'boom' }],
    })
    expect(JSON.parse(JSON.stringify(status))).toEqual(status)
  })

  it('未配置 → 缺省三态（自动回发开 / 不兜底）+ 空路由账号', () => {
    const status = weixinChannel.status(dir)
    expect(status).toEqual({
      enabled: false,
      autoReplyWithLastMessage: true,
      fallbackOnNoSend: false,
      routes: [],
      accounts: [],
    })
  })

  it('账号无 lastError → 字段不出现（undefined 不进入载荷）', () => {
    setupCcc({ enabled: true })
    weixinBridgeStatus.mockReturnValue([{ ccc: dir, accounts: [{ accountId: 'wechat-2', lastPollAt: 9 }] }])
    const status = weixinChannel.status(dir) as { accounts: Array<Record<string, unknown>> }
    expect(status.accounts[0]).toEqual({ accountId: 'wechat-2', lastPollAt: 9 })
    expect('lastError' in status.accounts[0]!).toBe(false)
  })
})

describe('im-weixin: send（复用 sendProactiveText 唯一发送实现）', () => {
  it('成功 → 透传账号/会话/角色；参数只传 root/userId/text/account', async () => {
    setupCcc({ enabled: true })
    sendProactiveText.mockResolvedValue({ ok: true, accountId: 'wechat-1', userId: 'u@im', sessionId: 'skiff-1', role: 'my-role' })
    const r = await weixinChannel.send({ root: dir, userId: 'u@im', text: 'hi', accountId: 'wechat-1' })
    expect(r).toEqual({ accountId: 'wechat-1', userId: 'u@im', sessionId: 'skiff-1', role: 'my-role' })
    expect(sendProactiveText).toHaveBeenCalledWith({ root: dir, toUserId: 'u@im', text: 'hi', accountId: 'wechat-1' })
  })

  it('未指定 account → 不传 accountId（由桥按"首个启用账号"选择）', async () => {
    setupCcc({ enabled: true })
    sendProactiveText.mockResolvedValue({ ok: true, accountId: 'wechat-1', userId: 'u@im', sessionId: 'skiff-1', role: '' })
    await weixinChannel.send({ root: dir, userId: 'u@im', text: 'hi' })
    expect(sendProactiveText).toHaveBeenCalledWith({ root: dir, toUserId: 'u@im', text: 'hi' })
  })

  it('桥侧失败 → 抛错（错误码 + 可行动提示），由 runImBridge 归一为 SEND_FAILED', async () => {
    setupCcc({ enabled: true })
    sendProactiveText.mockResolvedValue({ ok: false, code: 'ACCOUNT_NOT_BOUND', error: 'account wechat-1 not bound', remediation: 'scan the QR code' })
    await expect(weixinChannel.send({ root: dir, userId: 'u@im', text: 'hi' }))
      .rejects.toThrow(/ACCOUNT_NOT_BOUND.*scan the QR code/)
  })
})

describe('im-weixin: sendFile（协议层归 ACC，记录走同一 hook）', () => {
  beforeEach(() => {
    resolveWeixinAccount.mockReturnValue({ ok: true, accountId: 'wechat-1', cred: { token: 'tok', baseUrl: 'https://ilink' } })
    sendFileMessage.mockResolvedValue({ fileName: 'note.txt', size: 5 })
    sendTextMessage.mockResolvedValue({ ok: true })
    invokeWeixinHook.mockResolvedValue(undefined)
  })

  it('未启用桥 → 拒绝（BRIDGE_DISABLED，不发起任何网络调用）', async () => {
    setupCcc({ enabled: false })
    await expect(weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' }))
      .rejects.toThrow(/BRIDGE_DISABLED/)
    expect(sendFileMessage).not.toHaveBeenCalled()
  })

  it('账号选择失败 → 透传稳定码（不静默用别的账号）', async () => {
    setupCcc({ enabled: true })
    resolveWeixinAccount.mockReturnValue({ ok: false, code: 'NO_ACCOUNT', error: 'no enabled account' })
    await expect(weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' }))
      .rejects.toThrow(/NO_ACCOUNT/)
    expect(sendFileMessage).not.toHaveBeenCalled()
  })

  it('成功无 caption → 只发文件；有 caption → 追加一条文本', async () => {
    setupCcc({ enabled: true })
    const r = await weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' })
    expect(r).toEqual({ fileName: 'note.txt', size: 5 })
    expect(sendFileMessage).toHaveBeenCalledWith({ baseUrl: 'https://ilink', token: 'tok', toUserId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' })
    expect(sendTextMessage).not.toHaveBeenCalled()

    sendTextMessage.mockClear()
    await weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt', caption: '看这个' })
    expect(sendTextMessage).toHaveBeenCalledWith({ baseUrl: 'https://ilink', token: 'tok', toUserId: 'u@im', text: '看这个' })
  })

  it('配置了 hook → 触发 outgoing 记录（source=proactive + file 元数据 + 该用户固定会话）', async () => {
    setupCcc({ enabled: true, hook: 'scripts/hook.ts', routes: [{ user: 'u@im', role: 'my-role' }] })
    await weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt', caption: '看这个' })
    expect(buildOutgoingHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u@im',
      role: 'my-role',
      source: 'proactive',
      reply: '[文件] note.txt — 看这个',
      file: { name: 'note.txt', size: 5, caption: '看这个' },
    }))
    expect(invokeWeixinHook).toHaveBeenCalledWith(dir, 'scripts/hook.ts', { event: 'outgoing' })
  })

  it('未配置 hook → 不发记录调用（零成本）', async () => {
    setupCcc({ enabled: true })
    await weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' })
    expect(invokeWeixinHook).not.toHaveBeenCalled()
  })

  it('记录写入失败不阻断发送（hook 旁路容忍）', async () => {
    setupCcc({ enabled: true, hook: 'scripts/hook.ts' })
    invokeWeixinHook.mockRejectedValue(new Error('hook exploded'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(weixinChannel.sendFile!({ root: dir, userId: 'u@im', data: Buffer.from('hi'), fileName: 'note.txt' }))
      .resolves.toEqual({ fileName: 'note.txt', size: 5 })
    // 异步 catch 需要让微任务队列结算
    await new Promise((r) => setTimeout(r, 0))
    expect(log.mock.calls.some((c) => String(c[0]).includes('outgoing(file) error'))).toBe(true)
    log.mockRestore()
  })
})
