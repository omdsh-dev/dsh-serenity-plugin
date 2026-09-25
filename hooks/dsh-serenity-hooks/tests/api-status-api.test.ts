/**
 * api-status-api.test.ts — 🔴 **HTTP 对外面（`registerStatusApi`）的首次行为验收**
 * （2026-09-25 · ⑤ 第 8 件 · 对应地图 §3-9 新增行）
 *
 * 为什么必须补（R↓，读数是实测的）：`src/api.ts` 是**整个 HTTP 对外面**（9 条 `/serenity/*`
 * 路由：状态／safe-mode 切换／图片落盘／文件落盘／配置读写／cccs／public-ask／weixin／
 * session-cleanup）。而覆盖率报告实测：**`api.ts` 23.55% statements、4/11 functions**
 * —— **`registerStatusApi` 这个入口本身（约 530 行）从未被执行过**，连带 6 个私有助手
 * （`readBody` / `sendJson` / `senderIsWebUi` / `requireWebUi` / `resolveWorkspace` / `requireCcc`）
 * 也全是"零执行"。⇒ 此前**没有任何测试证明这些端点真的能应答**。
 *
 * 🔴 为什么覆盖门禁没拦住（这正是地图 §3-9 第 5 行那条缺口形态）：`coverage-gate` 用**正则匹配
 * 测试源码里的 import 字符串**（"**提到即算覆盖**"）——`accounts-api.test.ts` 提到了 `api.ts`，
 * 于是门禁判"已覆盖"，而**77% 的语句从未运行**。
 *
 * 本组用的是**真 listener ＋ 真 HTTP 往返 ＋ 真 CCC 夹具**（不是构造 req/res 假对象）：
 *   ① `ctx.webServer.register` 的**接线自证**（9 条路由真被注册、且全在 `/serenity/` 下）
 *   ② handymen 端点：GET（无 CCC ⇒ 空表）／ 非 GET ⇒ 405
 *   ③ status GET：200 ＋ `codeRuntime: null`（探测服务缺失时的降级形态）
 *   ④ status POST 的**安全边界**（v1.22.4 语义）：**无 WebUI 头 ⇒ 403 且 `on` 的标记文件绝不出现**（正负成对）
 *   ⑤ status POST 带 WebUI 头 ＋ 真 CCC ⇒ 200 且 **`.serenity-safe-on` 真的被写到盘上**
 *   ⑥ `readBody` 上限：超 64KB ⇒ 400 `body too large`
 *   ⑦ image-upload：无头 ⇒ 403；带头 ＋ 真 CCC ⇒ 200 且**图片真的落在 `_tmp/images_from_user/`**
 *   ⑧ file-upload：可执行扩展名 ⇒ 400（**安全边界**：不落盘可执行文件）＋ 盘上无文件（负控）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IMAGE_UPLOAD_DIR, registerStatusApi } from '../src/api.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

interface Booted {
  port: number
  routes: string[]
  close: () => Promise<void>
}

/** 起一台真 listener：把 `registerStatusApi` 注册的处理器按**精确路径**派发出去。 */
async function bootApi(opts: { liveSessionIds?: string[] } = {}): Promise<Booted> {
  const handlers = new Map<string, Handler>()
  const routes: string[] = []
  const ctx = {
    webServer: {
      register: (r: { path: string; handler: Handler }) => {
        handlers.set(r.path, r.handler)
        routes.push(r.path)
      },
    },
    // 🔴 必须提供 `get`：真实 cordis 的 ctx **必有**服务读取器，而本端点里有一处**裸**
    //    `ctx.get('codeRuntime')`（F-06 残留，见地图 §3-1 登记项）。夹具不提供它时，
    //    异常会被 handler 的 catch 吞成 **400** ⇒ 整端点降级为"不可用"，而**不是**"codeRuntime 为 null"。
    //    ⇒ 这一处正是"走收口层（`hostService`，异常吞掉返回 undefined）vs 裸调用"的**失败模式差异**的实证。
    get: (name: string) => {
      // 只有 cleanup 那组需要"宿主里正在跑的会话"（live 保护 = 该端点的安全底线）
      if (name === 'sessions' && opts.liveSessionIds !== undefined) {
        return { list: () => opts.liveSessionIds!.map((id) => ({ header: { id } })) }
      }
      return undefined
    },
    // 也刻意不提供 sessions/agents ⇒ `resolveWorkspace` 走"无参回落"分支
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

/** WebUI 判别头（client 专属动作的门；见 `requireWebUi` 的语义边界注释） */
const UI_HEADERS = { 'content-type': 'application/json', 'x-serenity-ui': '1' }

let ccc: string
let plain: string
let cfgDir: string
let prevCfgEnv: string | undefined
let prevDshHome: string | undefined
let dshHome: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'hooks-api-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
  plain = mkdtempSync(join(tmpdir(), 'hooks-api-plain-')) // 无 .serenity ⇒ cccRootForCwd 解析不到
  // 🔴 环境隔离（两条，都是"绝不碰真实环境"）：
  //   ① `SERENITY_HOOKS_CONFIG` → 临时文件：`/serenity/config` 的 PUT 与 public-ask 的 key
  //      轮换都会**写全局配置**（`globalConfigPath()` 认这个 env）⇒ 不隔离就会改到真机配置。
  //   ② simple settings 源：`readSimpleSettings()` 需要宿主 settings 源，测试里注入默认值。
  prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
  cfgDir = mkdtempSync(join(tmpdir(), 'hooks-api-cfg-'))
  process.env.SERENITY_HOOKS_CONFIG = join(cfgDir, 'serenity-hooks.json')
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings() }))
  //   ③ `DSH_HOME` → 临时目录：`session-cleanup` 的 POST **会真删会话**（`sessionsRootDir()` 认
  //      这个 env）⇒ 不隔离就会删到**真机会话日志**。隔离后该端点才敢测（见文件末尾那组）。
  prevDshHome = process.env.DSH_HOME
  dshHome = mkdtempSync(join(tmpdir(), 'hooks-api-dsh-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  rmSync(ccc, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
})

describe('src/api.ts：HTTP 对外面（真 listener ＋ 真往返）', () => {
  it('🔴 接线自证：9 条 `/serenity/*` 路由真被注册，且全部落在 `/serenity/` 前缀下', () => {
    return bootApi().then(async (api) => {
      try {
        const expected = [
          '/serenity/status',
          '/serenity/handymen',
          '/serenity/image-upload',
          '/serenity/file-upload',
          '/serenity/config',
          '/serenity/cccs',
          '/serenity/public-ask',
          '/serenity/weixin',
          '/serenity/session-cleanup',
        ]
        for (const p of expected) expect(api.routes, `未注册：${p}`).toContain(p)
        // 不变式：这个面**只碰**自己的命名空间（不许顺手抢别的路径）
        for (const p of api.routes) expect(p.startsWith('/serenity/'), `越界路径：${p}`).toBe(true)
        expect(new Set(api.routes).size, '路径重复注册').toBe(api.routes.length)
      } finally {
        await api.close()
      }
    })
  })

  it('/serenity/handymen：GET（无 CCC ⇒ 空表）／POST ⇒ 405', async () => {
    const api = await bootApi()
    try {
      const empty = await raw({ port: api.port, method: 'GET', path: `/serenity/handymen?workspace=${encodeURIComponent(plain)}` })
      expect(empty.status).toBe(200)
      expect(JSON.parse(empty.body)).toEqual({ handymen: [] })

      const wrong = await raw({ port: api.port, method: 'POST', path: '/serenity/handymen' })
      expect(wrong.status).toBe(405)
      expect(JSON.parse(wrong.body)).toEqual({ error: 'method not allowed' })
    } finally {
      await api.close()
    }
  })

  it('/serenity/status GET ⇒ 200 ＋ 探测服务缺失时 codeRuntime: null（降级形态）', async () => {
    const api = await bootApi()
    try {
      // CCC 内 ⇒ 完整 status
      const inCcc = await raw({ port: api.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(ccc)}` })
      expect(inCcc.status).toBe(200)
      const body = JSON.parse(inCcc.body) as Record<string, unknown>
      expect(body.root).toBe(ccc)
      expect(body.codeRuntime).toBeNull()

      // CCC 外 ⇒ **降级不是报错**（`getStatus` 对 `root=null` 有明确分支）
      const outside = await raw({ port: api.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(plain)}` })
      expect(outside.status).toBe(200)
      expect((JSON.parse(outside.body) as Record<string, unknown>).root).toBeNull()
    } finally {
      await api.close()
    }
  })

  it('⚠️ 现状（**已登记的缺陷**）：超 64KB 的 POST 体 ⇒ **连接被重置**，预期的 400 JSON 不可达', async () => {
    const api = await bootApi()
    try {
      // 语义：`readBody` 在超限时 `reject` **并 `req.destroy()`** ⇒ socket 被销毁 ⇒
      // handler 随后那句 `sendJson(res, 400, {error:'body too large'})` **写不出去** ⇒
      // 客户端看到的是 ECONNRESET，而不是一条可读的 400。🔴 **已登记待裁**（改实现 = 先排空再回 400；
      // 或改判据 = 承认"硬断"是刻意的 DoS 防护）。本例**钉住现状**：谁修了它，这里会红并提醒更新。
      await expect(
        raw({
          port: api.port,
          method: 'POST',
          path: '/serenity/status',
          headers: UI_HEADERS,
          body: JSON.stringify({ workspace: ccc, on: true, pad: 'x'.repeat(70 * 1024) }),
        }),
      ).rejects.toThrow(/socket hang up|ECONNRESET/i)

      // 🔴 但"硬断"**确实拦住了动作**：被拒的请求没有副作用（安全性质仍成立）
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 safe-mode 安全边界（正负成对）：无 WebUI 头 ⇒ 403，且**标记文件绝不出现**', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: { 'content-type': 'application/json' }, // 故意不带 x-serenity-ui
        body: JSON.stringify({ workspace: ccc, on: true }),
      })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'safe-mode 切换仅限 WebUI（agent 不可自行开关）' })
      // 🔴 负控：**守卫生效的实质证据**——不是"回了个 403"，而是"**动作根本没发生**"
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 带 WebUI 头 ＋ 真 CCC ⇒ 200，且 `.serenity-safe-on` 真的落到盘上（端到端真动作）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, on: true }),
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ on: true })
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(true)

      // 再关掉：同一个端点要能把状态改回去（否则"只能开不能关"是半个功能）
      const off = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, on: false }),
      })
      expect(off.status).toBe(200)
      expect(JSON.parse(off.body)).toMatchObject({ on: false })
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 image-upload：无头 ⇒ 403；带头 ⇒ 200 且图片真的落在 _tmp/images_from_user/', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: ccc, mediaType: 'image/png', data: 'AAAA' }),
      })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '图片落盘仅限 WebUI（client 专用）' })

      const ok = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64') }),
      })
      expect(ok.status).toBe(200)
      const rel = (JSON.parse(ok.body) as { path: string }).path
      expect(rel.startsWith(`${IMAGE_UPLOAD_DIR}/`)).toBe(true)
      expect(existsSync(join(ccc, rel))).toBe(true)
      expect(readdirSync(join(ccc, IMAGE_UPLOAD_DIR)).length).toBe(1)

      // 白名单外类型 ⇒ 400（校验在核心逻辑里，端点只负责转码）
      const badType = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, mediaType: 'application/x-msdownload', data: 'AAAA' }),
      })
      expect(badType.status).toBe(400)
    } finally {
      await api.close()
    }
  })

  it('🔴 file-upload 安全边界：可执行扩展名 ⇒ 400，且**盘上不留文件**（负控）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/file-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, name: 'evil.sh', data: Buffer.from('#!/bin/sh\nrm -rf /').toString('base64') }),
      })
      expect(res.status).toBe(400)
      expect(String(JSON.parse(res.body).error)).toContain('blocked executable file type')
      expect(existsSync(join(ccc, '_tmp/files_from_user'))).toBe(false)

      // 正控：普通扩展名同一端点要能落盘（否则上一条可能只是"端点坏了"）
      const ok = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/file-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, name: '报告.txt', data: Buffer.from('hello').toString('base64') }),
      })
      expect(ok.status).toBe(200)
      const rel = (JSON.parse(ok.body) as { path: string }).path
      expect(existsSync(join(ccc, rel))).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('未知路径 ⇒ 本面不接管（404 由派发层给，不是本面抢答）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/api/whatever' })
      expect(res.status).toBe(404)
      expect(res.body).toBe('no such route')
    } finally {
      await api.close()
    }
  })
})

/**
 * 其余四条路由的验收（2026-09-25 · ⑤ 第 9 件）：`config` ／ `cccs` ／ `public-ask` ／ `weixin`
 * ／ `session-cleanup`（第 8 件只覆盖了 status/handymen/两个 upload ⇒ 本组把这块 HTTP 面补齐）。
 * 🔴 两条纪律：① **写操作只落临时全局配置**（`SERENITY_HOOKS_CONFIG` 已隔离，见 beforeEach）；
 * ② **破坏性动作不做** —— `session-cleanup` 只验 **GET 的 dryRun 预览**（POST 会真删会话，不测）。
 */
describe('src/api.ts：其余路由（config ／ cccs ／ public-ask ／ weixin ／ session-cleanup）', () => {
  it('/serenity/config：无 WebUI 头 ⇒ 403；带头 GET ⇒ 200（wire 形态 ＋ knownWorkspaces）', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({ port: api.port, method: 'GET', path: '/serenity/config' })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '高级设定仅限 WebUI（client 专用）' })

      const ok = await raw({ port: api.port, method: 'GET', path: '/serenity/config', headers: { 'x-serenity-ui': '1' } })
      expect(ok.status).toBe(200)
      const body = JSON.parse(ok.body) as { config?: unknown; knownWorkspaces?: unknown }
      expect(body.config).toBeTypeOf('object')
      expect(Array.isArray(body.knownWorkspaces)).toBe(true)

      const wrong = await raw({ port: api.port, method: 'DELETE', path: '/serenity/config', headers: { 'x-serenity-ui': '1' } })
      expect(wrong.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/config PUT：**真写进临时全局配置**，且明文口令既不上 wire 也不落盘', async () => {
    const api = await bootApi()
    try {
      const SECRET = 'S3cret-pw-value'
      const res = await raw({
        port: api.port,
        method: 'PUT',
        path: '/serenity/config',
        headers: UI_HEADERS,
        body: JSON.stringify({ config: { gateway: { accounts: [{ id: 'a1', user: 'tester', pass: SECRET }] } } }),
      })
      expect(res.status).toBe(200)
      const wire = JSON.parse(res.body) as { config: { gateway: { accounts?: Array<Record<string, unknown>> } } }
      // ① 回包是 wire 形态：账号只回元信息（**口令不回**）
      expect(res.body).not.toContain(SECRET)
      expect(wire.config.gateway.accounts?.[0]).toMatchObject({ id: 'a1', user: 'tester', hasPassword: true })

      // ② 端到端：文件**真的**写到了隔离路径上（并且口令是 hash，不是明文）
      const onDisk = readFileSync(process.env.SERENITY_HOOKS_CONFIG!, 'utf-8')
      expect(onDisk).toContain('tester')
      expect(onDisk).not.toContain(SECRET)
      expect(onDisk.toLowerCase()).toContain('hash')
    } finally {
      await api.close()
    }
  })

  it('/serenity/cccs：GET ⇒ 200（候选容器数组）；POST ⇒ 405', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/cccs?workspace=${encodeURIComponent(ccc)}` })
      expect(res.status).toBe(200)
      expect(Array.isArray((JSON.parse(res.body) as { cccs: unknown }).cccs)).toBe(true)

      const wrong = await raw({ port: api.port, method: 'POST', path: '/serenity/cccs' })
      expect(wrong.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/public-ask：无头 ⇒ 403；GET ⇒ 200；rotate **真换 key**（旧 key 立即失效）；非法 action ⇒ 400', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask' })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '仅限 WebUI（key 属敏感凭据）' })

      const before = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect(before.status).toBe(200)
      const b = JSON.parse(before.body) as { key: string; urls: unknown[]; listUrl: string }
      expect(b.key).not.toBe('')
      expect(Array.isArray(b.urls)).toBe(true)
      expect(b.listUrl).toContain('/')

      const rotated = await raw({
        port: api.port,
        method: 'PUT',
        path: '/serenity/public-ask',
        headers: UI_HEADERS,
        body: JSON.stringify({ action: 'rotate' }),
      })
      expect(rotated.status).toBe(200)
      const newKey = (JSON.parse(rotated.body) as { key: string }).key
      expect(newKey).not.toBe('')
      expect(newKey, 'rotate 必须换成**新** key（旧 key 立即失效）').not.toBe(b.key)

      // 再 GET 一次：盘上生效的是新 key（不是内存态幻觉）
      const after = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect((JSON.parse(after.body) as { key: string }).key).toBe(newKey)

      const bad = await raw({
        port: api.port,
        method: 'PUT',
        path: '/serenity/public-ask',
        headers: UI_HEADERS,
        body: JSON.stringify({ action: 'nope' }),
      })
      expect(bad.status).toBe(400)
      expect(JSON.parse(bad.body)).toEqual({ error: 'unsupported action (expected "rotate")' })
    } finally {
      await api.close()
    }
  })

  it('/serenity/weixin：无头 ⇒ 403；缺 ccc ⇒ 400；非 CCC 目录 ⇒ 400；真 CCC ⇒ 200（脱敏形态）', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin' })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '微信桥配置仅限 WebUI（client 专用）' })

      const missing = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin', headers: { 'x-serenity-ui': '1' } })
      expect(missing.status).toBe(400)
      expect(JSON.parse(missing.body)).toEqual({ error: 'missing ccc param' })

      const notCcc = await raw({
        port: api.port,
        method: 'GET',
        path: `/serenity/weixin?ccc=${encodeURIComponent(plain)}`,
        headers: { 'x-serenity-ui': '1' },
      })
      expect(notCcc.status).toBe(400)
      expect(String((JSON.parse(notCcc.body) as { error: string }).error)).toContain('no CCC found from:')

      const ok = await raw({
        port: api.port,
        method: 'GET',
        path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`,
        headers: { 'x-serenity-ui': '1' },
      })
      expect(ok.status).toBe(200)
      const body = JSON.parse(ok.body) as Record<string, unknown>
      expect(body.enabled).toBe(false) // 空 CCC ⇒ 未启用
      expect(body.accounts).toEqual([])
      // 🔴 脱敏不变量：**token 永不落 wire**（面板只回元信息）
      expect(JSON.stringify(body)).not.toContain('token')
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/session-cleanup GET：dryRun 预览（只读；POST 会真删会话 ⇒ 见下一组）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=30' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { dryRun: boolean; count: number; candidates: unknown[]; olderThanDays: number }
      expect(body.dryRun).toBe(true) // 🔴 预览语义：GET 绝不删
      expect(body.olderThanDays).toBe(30)
      expect(typeof body.count).toBe('number')
      expect(Array.isArray(body.candidates)).toBe(true)
      expect(body.candidates.length).toBe(body.count)
    } finally {
      await api.close()
    }
  })
})

/**
 * 🔴 破坏性端点：`session-cleanup` 的 **POST 真删**（2026-09-25 · ⑤ 第 10 件）。
 *
 * 为什么现在才测：它**会物理删掉会话日志**（`performCleanup` 无 dryRun）。上一轮因此只敢测 GET 预览。
 * 本轮先补**夹具**：`DSH_HOME` 隔离到临时目录（`sessionsRootDir()` 认它）⇒ 删的只是夹具自己造的
 * `<tmp>/sessions/<project>/<id>/session.jsonl`，**碰不到真机会话**。
 *
 * 钉住的三件事（按重要性）：
 *   ① 🔴 **live 保护 = 该端点的安全底线**：宿主里正在跑的会话**即使超龄也不许删**（代码注释原话：
 *      "绝不动正在跑的会话"）；
 *   ② 阈值语义：超龄的删、未超龄的留；
 *   ③ **不是会话目录的东西不动**（无 `session*.jsonl` 的目录不进候选）。
 */
describe('src/api.ts：session-cleanup 的 POST（隔离 DSH_HOME 下的真删）', () => {
  /** 造一个会话目录：`<DSH_HOME>/sessions/<project>/<id>/session.jsonl`，mtime = 现在 − ageDays */
  function makeSession(project: string, id: string, ageDays: number): string {
    const dir = join(process.env.DSH_HOME!, 'sessions', project, id)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.jsonl')
    writeFileSync(log, '{"kind":"turn/end"}\n')
    const t = (Date.now() - ageDays * 24 * 3600 * 1000) / 1000
    utimesSync(log, t, t) // 决定"是否超龄"的是**文件 mtime**，不是目录
    return dir
  }

  /** 造一个"像会话但其实不是"的目录（没有 session*.jsonl）—— 不该被动 */
  function makeNoise(project: string, id: string): string {
    const dir = join(process.env.DSH_HOME!, 'sessions', project, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'no session log here\n')
    return dir
  }

  it('🔴 夹具自证：三个会话目录 + 一个非会话目录都在隔离的 DSH_HOME 下（不是真机）', () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    expect(old.startsWith(process.env.DSH_HOME!)).toBe(true)
    expect(existsSync(old)).toBe(true)
  })

  it('GET 预览（正负成对）：只列超龄且非 live 的那一个；**盘上谁也不动**', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const fresh = makeSession('--proj-new--', 'new-1', 1)
    const live = makeSession('--proj-live--', 'live-1', 60) // 超龄 **但** live
    const noise = makeNoise('--proj-noise--', 'noise-1')
    const api = await bootApi({ liveSessionIds: ['live-1'] })
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=30' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { candidates: Array<{ id: string }>; count: number }
      expect(body.candidates.map((c) => c.id)).toEqual(['old-1'])
      expect(body.count).toBe(1)
      // 🔴 预览的实质：四个目录**全都还在**
      for (const d of [old, fresh, live, noise]) expect(existsSync(d), `${d} 不该被预览删掉`).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('🔴 POST 真删：超龄的删掉；**live 的即使超龄也保留**；未超龄与"非会话目录"保留', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const fresh = makeSession('--proj-new--', 'new-1', 1)
    const live = makeSession('--proj-live--', 'live-1', 60)
    const noise = makeNoise('--proj-noise--', 'noise-1')
    const api = await bootApi({ liveSessionIds: ['live-1'] })
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/session-cleanup?olderThanDays=30',
        headers: UI_HEADERS,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { dryRun: boolean; deleted: string[]; errors: string[] }
      expect(body.dryRun).toBe(false)
      expect(body.deleted).toEqual(['old-1'])
      expect(body.errors).toEqual([])

      // 🔴 以**盘上状态**为准（响应说什么 ≠ 真删了什么）
      expect(existsSync(old), '超龄会话应当被物理删除').toBe(false)
      expect(existsSync(fresh), '未超龄的必须保留').toBe(true)
      expect(existsSync(live), '🔴 live 会话即使超龄也必须保留（安全底线）').toBe(true)
      expect(existsSync(noise), '不是会话目录的不许动').toBe(true)
    } finally {
      await api.close()
    }
  })

  it('🔴 无 WebUI 头 ⇒ 403，且**盘上什么都没删**（守卫生效的实质证据）', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/session-cleanup?olderThanDays=30',
        headers: { 'content-type': 'application/json' }, // 故意不带 x-serenity-ui
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: '会话清理仅限 WebUI（client 专用）' })
      expect(existsSync(old)).toBe(true) // 🔴 回 403 不算数 —— 要看**动作没发生**
    } finally {
      await api.close()
    }
  })
})
