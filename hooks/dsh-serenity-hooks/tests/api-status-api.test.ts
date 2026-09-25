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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IMAGE_UPLOAD_DIR, registerStatusApi } from '../src/api.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

interface Booted {
  port: number
  routes: string[]
  close: () => Promise<void>
}

/** 起一台真 listener：把 `registerStatusApi` 注册的处理器按**精确路径**派发出去。 */
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
    // 🔴 必须提供 `get`：真实 cordis 的 ctx **必有**服务读取器，而本端点里有一处**裸**
    //    `ctx.get('codeRuntime')`（F-06 残留，见地图 §3-1 登记项）。夹具不提供它时，
    //    异常会被 handler 的 catch 吞成 **400** ⇒ 整端点降级为"不可用"，而**不是**"codeRuntime 为 null"。
    //    ⇒ 这一处正是"走收口层（`hostService`，异常吞掉返回 undefined）vs 裸调用"的**失败模式差异**的实证。
    get: () => undefined,
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

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'hooks-api-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
  plain = mkdtempSync(join(tmpdir(), 'hooks-api-plain-')) // 无 .serenity ⇒ cccRootForCwd 解析不到
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
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
