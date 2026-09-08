/**
 * weixin-send-api.test.ts — 主动发送入口（v1.30.9，S142 用户需求"微信桥支持被调用发消息"）
 *
 * 契约：
 *  - **只接受 loopback**（公网网关 3081 不可达，故不做密钥；来源仍校验）
 *  - `ccc` 必填、无隐式默认（用户拍板）；`user` 必须是 iLink id 形式（别名解析归调用方）
 *  - 未知 CCC / 歧义名 → 404/400 + 候选提示；桥侧失败 → 稳定 code 映射到语义化 HTTP 状态
 *  - 监听器只绑 127.0.0.1；装配按 plugin 全局配置启停；卸载时拆卸（F-08）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'

// 桥与 CCC 发现都替身化：本模块的契约是"入口层"，不需要真实 iLink / 真实 skiff 链
vi.mock('../src/weixin-bridge.js', () => ({
  sendProactiveText: vi.fn(),
}))
vi.mock('../src/skiff-debug.js', () => ({
  discoverCccs: vi.fn(),
}))

import {
  WEIXIN_SEND_MAX_TEXT,
  handleWeixinSendRequest,
  isLoopbackAddress,
  matchCcc,
  parseSendRequest,
  registerWeixinSendApi,
  startWeixinSendApi,
  stopWeixinSendApi,
  weixinSendEndpoint,
  type CccCandidate,
} from '../src/weixin-send-api.js'
import { sendProactiveText } from '../src/weixin-bridge.js'
import { discoverCccs } from '../src/skiff-debug.js'

const sendMock = vi.mocked(sendProactiveText)
const discoverMock = vi.mocked(discoverCccs)

let dir: string
let oldConfigEnv: string | undefined

/** 极简响应替身：记录 status + body */
function fakeRes() {
  const out: { status: number; body: unknown } = { status: 0, body: undefined }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (body: string) => { out.body = JSON.parse(body) },
  }
  return { res: res as unknown as ServerResponse, out }
}

/** 极简请求替身：method/url/来源地址/body 分块 */
function fakeReq(opts: { method?: string; url?: string; remoteAddress?: string; body?: string }) {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body)]
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/send',
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-send-api-'))
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  writeFileSync(join(dir, '.serenity'), 'test')
  sendMock.mockReset()
  discoverMock.mockReset()
})

afterEach(() => {
  stopWeixinSendApi()
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('weixin-send-api: 纯校验', () => {
  it('parseSendRequest：合法请求（含/不含 accountId）', () => {
    expect(parseSendRequest({ ccc: 'home-serenity', user: 'u1@im.wechat', text: '  hi  ' })).toEqual({
      ok: true, ccc: 'home-serenity', user: 'u1@im.wechat', text: 'hi',
    })
    expect(parseSendRequest({ ccc: '/x', user: 'u@im.wechat', text: 't', accountId: 'wechat-2' })).toEqual({
      ok: true, ccc: '/x', user: 'u@im.wechat', text: 't', accountId: 'wechat-2',
    })
  })

  it('parseSendRequest：ccc 必填（无隐式默认）', () => {
    const r = parseSendRequest({ user: 'u@im.wechat', text: 't' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('ccc')
    expect(parseSendRequest({ ccc: '   ', user: 'u@im.wechat', text: 't' }).ok).toBe(false)
  })

  it('parseSendRequest：user 必须是 iLink id（别名不在此层解析）', () => {
    const r = parseSendRequest({ ccc: 'x', user: 'yh', text: 't' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.remediation).toContain('别名')
  })

  it('parseSendRequest：text 非空 + 超限拒绝', () => {
    expect(parseSendRequest({ ccc: 'x', user: 'u@im.wechat', text: '  ' }).ok).toBe(false)
    expect(parseSendRequest({ ccc: 'x', user: 'u@im.wechat', text: 'a'.repeat(WEIXIN_SEND_MAX_TEXT + 1) }).ok).toBe(false)
    expect(parseSendRequest({ ccc: 'x', user: 'u@im.wechat', text: 'a'.repeat(WEIXIN_SEND_MAX_TEXT) }).ok).toBe(true)
  })

  it('parseSendRequest：非对象 body', () => {
    expect(parseSendRequest(null).ok).toBe(false)
    expect(parseSendRequest('x').ok).toBe(false)
  })

  it('isLoopbackAddress：127.0.0.1 / ::1 / IPv4-mapped 放行，其余拒绝', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })

  it('matchCcc：绝对路径 / 目录名 / .serenity 名 / 大小写不敏感', () => {
    const cands: CccCandidate[] = [
      { root: '/home/yh/home/home-serenity', dirName: 'home-serenity', cccName: 'home-serenity' },
      { root: '/home/yh/lab/pangu', dirName: 'pangu', cccName: 'pangu-serenity' },
    ]
    expect(matchCcc('/home/yh/home/home-serenity', cands)).toEqual({ ok: true, root: '/home/yh/home/home-serenity' })
    expect(matchCcc('home-serenity', cands)).toEqual({ ok: true, root: '/home/yh/home/home-serenity' })
    expect(matchCcc('PANGU-SERENITY', cands)).toEqual({ ok: true, root: '/home/yh/lab/pangu' })
    expect(matchCcc('pangu', cands)).toEqual({ ok: true, root: '/home/yh/lab/pangu' })
  })

  it('matchCcc：未知 / 歧义 / 路径无 CCC → 报错带候选', () => {
    const cands: CccCandidate[] = [
      { root: '/a/x', dirName: 'x', cccName: null },
      { root: '/b/x', dirName: 'x', cccName: null },
    ]
    const unknown = matchCcc('nope', cands)
    expect(unknown.ok).toBe(false)
    expect(unknown.ok === false && unknown.remediation).toContain('x')

    const ambiguous = matchCcc('x', cands)
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ok === false && ambiguous.error).toContain('ambiguous')

    const noCcc = matchCcc('/definitely/not/a/ccc', [])
    expect(noCcc.ok).toBe(false)
  })
})

describe('weixin-send-api: 请求处理', () => {
  it('非 loopback 来源 → 403', async () => {
    const { res, out } = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ remoteAddress: '192.168.1.5' }) as never, res)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('GET /health → 200；未知路径 → 404；非 POST /send → 405', async () => {
    const a = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ method: 'GET', url: '/health' }) as never, a.res)
    expect(a.out.status).toBe(200)
    expect(a.out.body).toMatchObject({ ok: true })

    const b = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ method: 'GET', url: '/nope' }) as never, b.res)
    expect(b.out.status).toBe(404)

    const c = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ method: 'GET', url: '/send' }) as never, c.res)
    expect(c.out.status).toBe(405)
  })

  it('非法 JSON / 校验失败 → 400（带 remediation）', async () => {
    const a = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: '{oops' }) as never, a.res)
    expect(a.out.status).toBe(400)
    expect(a.out.body).toMatchObject({ code: 'BAD_JSON' })

    const b = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: JSON.stringify({ user: 'u@im.wechat', text: 't' }) }) as never, b.res)
    expect(b.out.status).toBe(400)
    expect(b.out.body).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('未知 CCC → 404（候选提示来自 discoverCccs）', async () => {
    discoverMock.mockResolvedValue([{ root: '/ccc/a', name: 'a', roles: [] }])
    const { res, out } = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: JSON.stringify({ ccc: 'b', user: 'u@im.wechat', text: 't' }) }) as never, res)
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ code: 'UNKNOWN_CCC' })
    expect(JSON.stringify(out.body)).toContain('已知 CCC: a')
  })

  it('成功 → 200 + accountId/userId/sessionId/role（透传桥结果）', async () => {
    discoverMock.mockResolvedValue([{ root: '/ccc/a', name: 'a', roles: [] }])
    sendMock.mockResolvedValue({ ok: true, accountId: 'wechat-1', userId: 'u@im.wechat', sessionId: 'skiff-weixin-x', role: 'zhaocai' })
    const { res, out } = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: JSON.stringify({ ccc: 'a', user: 'u@im.wechat', text: 't' }) }) as never, res)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, accountId: 'wechat-1', userId: 'u@im.wechat', sessionId: 'skiff-weixin-x', role: 'zhaocai' })
    expect(sendMock).toHaveBeenCalledWith({ root: '/ccc/a', toUserId: 'u@im.wechat', text: 't' })
  })

  it('桥失败 → 稳定 code 映射语义化状态（409 未绑定 / 502 发送失败）', async () => {
    discoverMock.mockResolvedValue([{ root: '/ccc/a', name: 'a', roles: [] }])
    sendMock.mockResolvedValue({ ok: false, code: 'ACCOUNT_NOT_BOUND', error: 'no cred' })
    const a = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: JSON.stringify({ ccc: 'a', user: 'u@im.wechat', text: 't' }) }) as never, a.res)
    expect(a.out.status).toBe(409)

    sendMock.mockResolvedValue({ ok: false, code: 'SEND_FAILED', error: 'boom' })
    const b = fakeRes()
    await handleWeixinSendRequest({} as never, fakeReq({ body: JSON.stringify({ ccc: 'a', user: 'u@im.wechat', text: 't' }) }) as never, b.res)
    expect(b.out.status).toBe(502)
  })
})

describe('weixin-send-api: 监听器生命周期', () => {
  it('start 只绑 loopback + 暴露 endpoint；stop 幂等', async () => {
    const port = await startWeixinSendApi({} as never, 0)
    expect(port).toBeGreaterThan(0)
    expect(weixinSendEndpoint()).toBe(`http://127.0.0.1:${port}`)

    // 真实 HTTP 往返（仅 loopback 可达）
    discoverMock.mockResolvedValue([{ root: '/ccc/a', name: 'a', roles: [] }])
    sendMock.mockResolvedValue({ ok: true, accountId: 'wechat-1', userId: 'u@im.wechat', sessionId: 's', role: '' })
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    const sent = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      body: JSON.stringify({ ccc: 'a', user: 'u@im.wechat', text: 'hello' }),
    })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toMatchObject({ ok: true, accountId: 'wechat-1' })

    stopWeixinSendApi()
    expect(weixinSendEndpoint()).toBeNull()
    stopWeixinSendApi() // 幂等
  })

  it('registerWeixinSendApi：配置启用 → 启动；关闭 → 停止；config-updated 热同步', async () => {
    const handlers = new Map<string, () => void>()
    const ctx = {
      on: (name: string, cb: () => void) => { handlers.set(name, cb); return () => handlers.delete(name) },
      effect: () => () => {},
    }
    // 默认配置（enabled:true, port:3082）——为避免占用真实端口，写入临时配置指定 0 不行
    // （0 视为关闭）→ 用 enabled:false 验证不启动，再 enabled:true + 随机高位端口验证启动
    writeFileSync(join(dir, 'serenity-hooks.json'), JSON.stringify({ weixinApi: { enabled: false, port: 3082 } }))
    registerWeixinSendApi(ctx as never)
    expect(weixinSendEndpoint()).toBeNull()

    writeFileSync(join(dir, 'serenity-hooks.json'), JSON.stringify({ weixinApi: { enabled: true, port: 3182 } }))
    handlers.get('serenity/config-updated')?.()
    await vi.waitFor(() => expect(weixinSendEndpoint()).toBe('http://127.0.0.1:3182'))

    writeFileSync(join(dir, 'serenity-hooks.json'), JSON.stringify({ weixinApi: { enabled: false, port: 3182 } }))
    handlers.get('serenity/settings-changed')?.()
    expect(weixinSendEndpoint()).toBeNull()
  })
})
