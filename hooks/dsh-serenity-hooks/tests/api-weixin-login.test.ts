/**
 * api-weixin-login.test.ts — 🔴 **微信扫码登录全链**（2026-09-25 · ⑤ 第 15 件）
 *
 * 为什么必须补（R↓ 起点 = 前一个文件**明文登记的边界**）：`api-status-api.test.ts` 末尾写着 ——
 * "**刻意不测 `login-start` 与"带账号的 enable"**：前者 `fetchQRCode()` 要**真连微信后端**、
 * 后者 `syncCccBridge()` 会**真起轮询循环** ⇒ **当前没有假微信后端**，贸然测就是把测试接到真网络上。"
 * 本文件就是把那个"**假 iLink 后端**"建出来 —— 于是这条边界可以诚实收掉。
 *
 * ## 做法：真 listener 实现 iLink 契约 ＋ **官方注入点**（不改一处生产语义）
 * ① 假后端 = 本进程内一台**真 HTTP server**，实现两个端点：
 *    `GET /ilink/bot/get_bot_qrcode?bot_type=` ／ `GET /ilink/bot/get_qrcode_status?qrcode=`；
 * ② 经 `weixin-api.ts` **自带的测试注入点** `__setWeixinFetchForTest()`（生产零调用）把注入的 fetch
 *    把 URL **改指本机假后端**；
 * ⇒ `apiGet` 整条链（URL 组装 → 真 socket → abort 计时器 → `res.ok`/`res.text()` → JSON 解析）**全被走到**，
 *    而**一个字节都不出本机**。这严格强于"把 fetch 换成返回假 Response 的函数"（那会跳过真实 HTTP 层）。
 *
 * ## 判据：每条都看**盘上读数**，不看响应自述
 * 登录链的产物只有两个：CCC `localstore.json` 的凭据（`WEIXIN_WECHAT_N_TOKEN`）
 * 与 CCC `.opencode/serenity.json` 的账号结构。**响应说成没成，一律另说。**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerStatusApi } from '../src/api.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'
import { __setWeixinFetchForTest } from '../src/weixin-api.js'
import { readWeixinCredential, writeWeixinCredential } from '../src/weixin-route.js'
import { stopCccBridge, weixinBridgeStatus } from '../src/weixin-bridge.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

// ── 被测面：真 listener ＋ 按精确路径派发（与 api-status-api.test.ts 同款夹具）──

interface Booted { port: number; routes: string[]; close: () => Promise<void> }

async function bootApi(): Promise<Booted> {
  const handlers = new Map<string, Handler>()
  const routes: string[] = []
  const ctx = {
    webServer: {
      register: (r: { path: string; handler: Handler }) => {
        handlers.set(r.path, r.handler)
        routes.push(r.path)
      },
    },
    get: () => undefined,
  }
  registerStatusApi(ctx as never)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such route')
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500); res.end() } catch { /* 已结束 */ }
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return {
    port,
    routes,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()); setTimeout(resolve, 1000) })
    },
  }
}

interface RawRes { status: number; body: string }

function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const UI_HEADERS = { 'content-type': 'application/json', 'x-serenity-ui': '1' }

// ── 假 iLink 后端：真 HTTP server，按端点脚本化应答 ──

interface FakeCall { path: string; query: Record<string, string>; method: string }
interface FakeReply { status: number; body: unknown }
type FakeRule = FakeReply | ((call: FakeCall, nth: number) => FakeReply)

interface FakeIlink {
  /** 真 URL（注入的 fetch 会把 ilinkai.weixin.qq.com 的请求改指到这里） */
  base: string
  /** 收到的**全部**请求（判据用：证明"真被请求了"与参数透传） */
  calls: FakeCall[]
  set: (pathname: string, rule: FakeRule) => void
  close: () => Promise<void>
}

async function bootFakeIlink(initial: Record<string, FakeRule> = {}): Promise<FakeIlink> {
  const rules = new Map<string, FakeRule>(Object.entries(initial))
  const counters = new Map<string, number>()
  const calls: FakeCall[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const call: FakeCall = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method ?? '' }
    calls.push(call)
    const nth = (counters.get(url.pathname) ?? 0) + 1
    counters.set(url.pathname, nth)
    const rule = rules.get(url.pathname)
    const reply: FakeReply = rule === undefined
      ? { status: 404, body: { error: `fake iLink: no rule for ${url.pathname}` } }
      : typeof rule === 'function' ? rule(call, nth) : rule
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    set: (pathname, rule) => { rules.set(pathname, rule) },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()); setTimeout(resolve, 500) })
    },
  }
}

const QR_PATH = '/ilink/bot/get_bot_qrcode'
const STATUS_PATH = '/ilink/bot/get_qrcode_status'

const realFetch = globalThis.fetch
let fake: FakeIlink
let ccc: string
let prevCfgEnv: string | undefined

const json = (res: RawRes): any => JSON.parse(res.body)
const postWeixin = (port: number, body: Record<string, unknown>): Promise<RawRes> =>
  raw({ port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS, body: JSON.stringify({ ccc, ...body }) })
const pollLogin = (port: number, key: string): Promise<RawRes> =>
  raw({ port, method: 'GET', path: `/serenity/weixin/login?key=${encodeURIComponent(key)}`, headers: UI_HEADERS })

function writeCccConfig(cfg: unknown): void {
  mkdirSync(join(ccc, '.opencode'), { recursive: true })
  writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify(cfg, null, 2))
}
/** 盘上读 CCC `localstore.json` 的凭据节（**不经 src 读取器**——判据要独立于被测代码） */
function diskCredentials(): Record<string, string> {
  const p = join(ccc, 'localstore.json')
  if (!existsSync(p)) return {}
  return ((JSON.parse(readFileSync(p, 'utf-8')) as { credentials?: Record<string, string> }).credentials) ?? {}
}
function diskAccounts(): Array<{ accountId: string; enabled?: boolean }> {
  const p = join(ccc, '.opencode', 'serenity.json')
  if (!existsSync(p)) return []
  return ((JSON.parse(readFileSync(p, 'utf-8')) as { weixin?: { accounts?: Array<{ accountId: string }> } }).weixin?.accounts) ?? []
}

beforeEach(async () => {
  ccc = mkdtempSync(join(tmpdir(), 'hooks-wx-login-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
  prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(mkdtempSync(join(tmpdir(), 'hooks-wx-cfg-')), 'serenity-hooks.json')
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings() }))

  fake = await bootFakeIlink({
    [QR_PATH]: { status: 200, body: { qrcode: 'qr-abc', qrcode_img_content: 'data:image/png;base64,AAAA' } },
    [STATUS_PATH]: { status: 200, body: { status: 'wait' } },
  })
  // 🔴 注入点：只把 iLink 域名的请求改指假后端，其余（本机 serenity API 等）原样走真 fetch
  __setWeixinFetchForTest(((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(rawUrl)
    if (u.hostname !== 'ilinkai.weixin.qq.com') return realFetch(input as never, init)
    return realFetch(new URL(u.pathname + u.search, fake.base).toString(), init)
  }) as typeof fetch)
})

afterEach(async () => {
  __setWeixinFetchForTest(null)
  stopCccBridge(ccc)
  await fake.close()
  __setSimpleSourceForTest(null)
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  rmSync(ccc, { recursive: true, force: true })
})

describe('src/api.ts：微信扫码登录（假 iLink 后端 ＋ 真 HTTP 往返）', () => {
  it('① `login-start`：200 {qrcode, qrcode_img_content, loginKey} ＋ 假后端**真收到** get_bot_qrcode（bot_type 透传）', async () => {
    writeCccConfig({ weixin: { botType: '7' } })
    const api = await bootApi()
    try {
      const res = await postWeixin(api.port, { action: 'login-start' })
      expect(res.status).toBe(200)
      const body = json(res) as { qrcode: string; qrcode_img_content: string; loginKey: string }
      expect(body.qrcode).toBe('qr-abc')
      expect(body.qrcode_img_content).toBe('data:image/png;base64,AAAA')
      expect(body.loginKey).toMatch(/^[0-9a-f-]{36}$/) // randomUUID

      // 🔴 判据 = **假后端真被请求**（不是"响应长这样"）
      const qrCalls = fake.calls.filter((c) => c.path === QR_PATH)
      expect(qrCalls).toHaveLength(1)
      expect(qrCalls[0]!.method).toBe('GET')
      expect(qrCalls[0]!.query.bot_type, 'CCC 配置的 botType 必须透传到 iLink').toBe('7')
    } finally {
      await api.close()
    }
  })

  it('② `login-start` 失败路径（**真实故障形态**：传输层 503）⇒ 400，且不落任何盘上状态', async () => {
    fake.set(QR_PATH, { status: 503, body: { error: 'upstream unavailable' } })
    const api = await bootApi()
    try {
      const res = await postWeixin(api.port, { action: 'login-start' })
      expect(res.status).toBe(400)
      expect(String(json(res).error)).toContain('503')
      // 负控：失败不得留下账号/凭据
      expect(diskAccounts()).toEqual([])
      expect(diskCredentials()).toEqual({})
    } finally {
      await api.close()
    }
  })

  it('🆕 ②b 🔴 **现状（不是缺陷声明，是登记待裁）**：iLink 用 HTTP 200 ＋ `errcode` 报失败时，`login-start` 回 **200 且 `qrcode` 为空**', async () => {
    // 本用例是"首跑红 ⇒ 分诊"的产物：我原以为这里会 400，实测是 200。
    // 根因（已回源码取证，非猜测）：`fetchQRCode` 只走 `apiGet`（HTTP 层）＋ `JSON.parse`，
    // **不校验 iLink 的业务返回码**；`assertIlinkOk`（`weixin-api.ts` 的 errcode/ret 校验）
    // 按设计**只挂在发送类调用**上（见该文件注释"发送类调用一律经此校验"）。
    // ⇒ 服务端把"上游业务失败"当成 200 透出；**兜底在客户端**：`WeixinBridgeEditor.tsx`
    // 判 `!res.ok || !body.qrcode_img_content || !body.loginKey` ⇒ 面板会显示失败（不是静默假绿）。
    // 🔵 是否把校验也挂到 QR/登录面 = **行为变更，登记待裁**（owner 拍板），本轮**不改生产代码**。
    fake.set(QR_PATH, { status: 200, body: { errcode: 40001, errmsg: 'invalid appid' } })
    const api = await bootApi()
    try {
      const res = await postWeixin(api.port, { action: 'login-start' })
      expect(res.status, '现状：服务端不校验业务码').toBe(200)
      const body = json(res) as { qrcode?: string; qrcode_img_content?: string; loginKey?: string }
      expect(body.qrcode).toBeUndefined()
      expect(body.qrcode_img_content).toBeUndefined()
      // 盘上仍然零改动（登录项只在内存里；账号/凭据都没写）
      expect(diskAccounts()).toEqual([])
      expect(diskCredentials()).toEqual({})
    } finally {
      await api.close()
    }
  })

  it('③ `/login`：未知 key ⇒ 404；非 GET ⇒ 405；无 WebUI 头 ⇒ 403（三条边界各自成对）', async () => {
    const api = await bootApi()
    try {
      const unknown = await pollLogin(api.port, 'no-such-key')
      expect(unknown.status).toBe(404)
      expect(unknown.body).toContain('login not found or expired')

      const wrongMethod = await raw({ port: api.port, method: 'POST', path: '/serenity/weixin/login?key=x', headers: UI_HEADERS, body: '{}' })
      expect(wrongMethod.status).toBe(405)

      const noUi = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin/login?key=x' })
      expect(noUi.status).toBe(403)
    } finally {
      await api.close()
    }
  })

  it('🔴 ④ 轮询 wait → confirmed：凭据**真落 localstore.json** ＋ 账号**真进 serenity.json** ＋ loginKey 被消费', async () => {
    const api = await bootApi()
    try {
      const started = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }

      const waiting = await pollLogin(api.port, started.loginKey)
      expect(waiting.status).toBe(200)
      expect(json(waiting)).toEqual({ status: 'wait' })

      // 后端翻牌：confirmed ＋ bot_token
      fake.set(STATUS_PATH, {
        status: 200,
        body: { status: 'confirmed', bot_token: 'tok-from-fake', baseurl: 'https://wx.example.invalid', ilink_user_id: 'u-77' },
      })
      const confirmed = await pollLogin(api.port, started.loginKey)
      expect(confirmed.status).toBe(200)
      expect(json(confirmed)).toEqual({ status: 'confirmed', accountId: 'wechat-1', tokenSaved: true })

      // 🔴 盘上读数（三条，全部独立于响应自述）
      expect(diskCredentials()['WEIXIN_WECHAT_1_TOKEN']).toBe('tok-from-fake')
      expect(diskCredentials()['WEIXIN_WECHAT_1_USERID']).toBe('u-77')
      expect(diskAccounts().map((a) => a.accountId)).toEqual(['wechat-1'])
      expect(readWeixinCredential(ccc, 'wechat-1')?.baseUrl).toBe('https://wx.example.invalid')

      // loginKey 一次性：确认后同 key 再查 ⇒ 404
      expect((await pollLogin(api.port, started.loginKey)).status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('⑤ confirmed 但**无 `bot_token`** ⇒ {status:"error"}，且盘上零改动（负控）', async () => {
    fake.set(STATUS_PATH, { status: 200, body: { status: 'confirmed' } })
    const api = await bootApi()
    try {
      const started = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }
      const res = await pollLogin(api.port, started.loginKey)
      expect(res.status).toBe(200)
      expect(json(res)).toEqual({ status: 'error', error: 'confirmed but no bot_token' })
      expect(diskCredentials()).toEqual({})
      expect(diskAccounts()).toEqual([])
    } finally {
      await api.close()
    }
  })

  it('⑥ 后端回 `expired` ⇒ {status:"expired"} 且 loginKey 被消费', async () => {
    fake.set(STATUS_PATH, { status: 200, body: { status: 'expired' } })
    const api = await bootApi()
    try {
      const started = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }
      expect(json(await pollLogin(api.port, started.loginKey))).toEqual({ status: 'expired' })
      expect((await pollLogin(api.port, started.loginKey)).status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('🔴 ⑦ TTL（时间旅行，只 fake `Date`）：新 `login-start` **清掉过期登录项**；过期项轮询 ⇒ `expired`', async () => {
    const api = await bootApi()
    try {
      const t0 = Date.now()
      const first = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }

      // 时间旅行 +6min（> TTL 5min）。只 fake Date ⇒ 真实 I/O/计时器不受影响。
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(t0 + 6 * 60_000)
      const second = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }
      expect(second.loginKey).not.toBe(first.loginKey)
      // 清理循环真跑了：过期项已被 delete ⇒ 404（而不是走到 TTL 分支回 expired）
      expect((await pollLogin(api.port, first.loginKey)).status).toBe(404)

      // 再前进 6min：**这次不触发清理**（没有新的 login-start）⇒ 轮到 `/login` 自己的 TTL 分支
      vi.setSystemTime(t0 + 12 * 60_000)
      const expired = await pollLogin(api.port, second.loginKey)
      expect(expired.status).toBe(200)
      expect(json(expired)).toEqual({ status: 'expired' })
      expect((await pollLogin(api.port, second.loginKey)).status, '过期项须被清掉').toBe(404)
    } finally {
      vi.useRealTimers()
      await api.close()
    }
  })

  it('⑧ 带账号 `set-enabled`：200 ＋ serenity.json `enabled:true`（无凭据 ⇒ 不启桥）；再 disable ⇒ 200', async () => {
    writeCccConfig({ weixin: { accounts: [{ accountId: 'wechat-1', name: '微信 1', enabled: true }] } })
    const api = await bootApi()
    try {
      const on = await postWeixin(api.port, { action: 'set-enabled', enabled: true })
      expect(on.status).toBe(200)
      expect(json(on)).toEqual({ enabled: true })
      const cfg = JSON.parse(readFileSync(join(ccc, '.opencode', 'serenity.json'), 'utf-8')) as { weixin?: { enabled?: boolean } }
      expect(cfg.weixin?.enabled, '开关必须真落到 CCC 配置').toBe(true)
      // 账号未绑定（localstore 无凭据）⇒ syncCccBridge 跳过 ⇒ 桥表里没有它
      expect(weixinBridgeStatus().filter((b) => b.ccc === ccc)).toEqual([])

      const off = await postWeixin(api.port, { action: 'set-enabled', enabled: false })
      expect(off.status).toBe(200)
      expect(json(off)).toEqual({ enabled: false })
      expect((JSON.parse(readFileSync(join(ccc, '.opencode', 'serenity.json'), 'utf-8')) as { weixin?: { enabled?: boolean } }).weixin?.enabled).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 ⑨ 已绑定账号 ⇒ enable **真把桥起起来**（`weixinBridgeStatus` 可见该账号）；disable ⇒ 桥停', async () => {
    writeCccConfig({ weixin: { enabled: true, accounts: [{ accountId: 'wechat-1', enabled: true }] } })
    // baseUrl 留空 ⇒ 轮询循环首轮会因 URL 不合法而失败并退避（**不触网**，天然故障形态）
    writeWeixinCredential(ccc, 'wechat-1', { token: 'tok-1', baseUrl: '' })
    expect(readWeixinCredential(ccc, 'wechat-1')?.token, '夹具自证：凭据确实写进去了').toBe('tok-1')

    const api = await bootApi()
    try {
      // 触发 enable 分支里的 syncCccBridge（桥表里出现该 CCC）
      const on = await postWeixin(api.port, { action: 'set-enabled', enabled: true })
      expect(on.status).toBe(200)
      expect(weixinBridgeStatus().find((b) => b.ccc === ccc)?.accounts.map((a) => a.accountId)).toEqual(['wechat-1'])

      const off = await postWeixin(api.port, { action: 'set-enabled', enabled: false })
      expect(off.status).toBe(200)
      expect(weixinBridgeStatus().filter((b) => b.ccc === ccc), 'disable 必须真停桥').toEqual([])
    } finally {
      await api.close()
    }
  })

  it('🔴 ⑩ `/login` 的 catch：**confirmed 时落盘失败**（`.opencode` 被占成一个普通文件）⇒ 400（真实故障形态，不是 mock）', async () => {
    const api = await bootApi()
    try {
      // 先出码（此时 CCC 布局正常）
      const started = json(await postWeixin(api.port, { action: 'login-start' })) as { loginKey: string }
      // 🔴 破坏 CCC 布局：`.opencode` 变成普通文件 ⇒ 写 `.opencode/serenity.json` 必然抛（ENOTDIR/EEXIST）
      writeFileSync(join(ccc, '.opencode'), 'not a directory')
      fake.set(STATUS_PATH, { status: 200, body: { status: 'confirmed', bot_token: 'tok-x', ilink_user_id: 'u-9' } })

      const res = await pollLogin(api.port, started.loginKey)
      expect(res.status, '落盘失败必须被端点 catch 收敛成 400，而不是崩').toBe(400)
      expect(String(json(res).error)).toBeTruthy()
    } finally {
      await api.close()
    }
  })
})
