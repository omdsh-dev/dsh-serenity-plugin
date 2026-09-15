import { describe, it, expect, afterEach, vi } from 'vitest'
import { Agent, createServer, request, type Server } from 'node:http'
import {
  startFace,
  stopFace,
  stopAllFaces,
  faceActive,
  facePort,
  faceEnabled,
  activeFaceNames,
  FaceStartCancelled,
  type FaceSpec,
} from '../src/face-host.js'

/**
 * face-host.test.ts — 面宿主（C4 块 A，S142 2026-09-15）
 *
 * 被验证的归一（每个用例对应一条"此前分散在四个面里各写一遍"的样板）：
 *   ① active 表（`faceActive`/`facePort`/`activeFaceNames`）= 唯一真相源
 *   ② 统一 listen（含 `port:0` 的内核分配）
 *   ③ **统一端口占用处理**（EADDRINUSE 重试——此前只有 gateway 独享这条稳定性逻辑）
 *   ④ 统一请求分派（handler 抛错不得杀进程）
 *   ⑤ 统一 close（`stopFace`/`stopAllFaces` 幂等）
 *   ⑥ 并发启动合并（在飞 Promise 复用——替代各面手搓的 `starting`/`active` 标志）
 *   ⑦ 拆卸窗口内取消在飞启动（不得"卸载后仍绑上端口"）
 *
 * 全部用例都走**真实 listener + 真实 HTTP 往返**（不只单测 handler 函数）。
 */

/**
 * 已绑 server 的实际端口（`listen(0)` 后读回）。
 *
 * v1.34.1 修 flake（块 3）：本文件此前用 `freePort() = 7300 + random(400)` 取"随机固定端口段"——
 * 撞上别的进程/别的用例即 EADDRINUSE。**需要"已知端口"的用例**（占用方与面必须绑同一端口）
 * 改为"先让内核分配（`listen(0, …)`）再读回"：既确定空闲、又不与任何人抢预定义端口段。
 */
function boundPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr !== null ? addr.port : 0
}

/** 让 server 绑上内核分配的端口并读回（供"占用方/替身"使用） */
function listenEphemeral(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(boundPort(server)))
  })
}

/** 关闭 server（等待 close 完成——占用方必须真的让出端口） */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

function httpGet(port: number, path = '/', agent?: Agent | false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 读取 net.Server 底层 handle 的 ref 状态（Node 无公开 hasRef——unref 的**唯一**同步可观测面） */
function serverHasRef(server: Server): boolean | undefined {
  const handle = (server as unknown as { _handle?: { hasRef?: () => boolean } })._handle
  return handle?.hasRef?.()
}

function spec(over: Partial<FaceSpec> & { name: string }): FaceSpec {
  return {
    port: 0,
    host: '127.0.0.1',
    enabled: () => true,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    },
    ...over,
  }
}

afterEach(() => {
  stopAllFaces()
})

describe('face-host: 生命周期 + 真实 HTTP 往返', () => {
  it('startFace 绑真实端口（port:0 → 内核分配）+ 真实 GET 往返；stopFace 幂等', async () => {
    const handle = await startFace(spec({ name: 't-basic', handler: (_req, res) => { res.writeHead(200); res.end('hello-face') } }))
    try {
      expect(handle.port).toBeGreaterThan(0)
      expect(faceActive('t-basic')).toBe(true)
      expect(facePort('t-basic')).toBe(handle.port)
      expect(activeFaceNames()).toContain('t-basic')
      const res = await httpGet(handle.port)
      expect(res.status).toBe(200)
      expect(res.body).toBe('hello-face')
    } finally {
      expect(stopFace('t-basic')).toBe(true)
    }
    expect(faceActive('t-basic')).toBe(false)
    expect(stopFace('t-basic')).toBe(false) // 幂等（第二次无在监听的面）
  })

  it('handler 抛错 → 500 JSON 且**进程存活**（统一请求分派；此前每面各写一份 catch）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await startFace(spec({ name: 't-throw', handler: () => { throw new Error('boom') } }))
    try {
      const res = await httpGet(handle.port)
      expect(res.status).toBe(500)
      expect(JSON.parse(res.body)).toEqual({ error: 'internal error' })
      expect(warn.mock.calls.some((c) => String(c[0]).includes('t-throw 处理请求失败'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('并发启动同一面 → 在飞合并（同一个 server 实例，不重复 bind）', async () => {
    const s = spec({ name: 't-merge' })
    const [a, b] = await Promise.all([startFace(s), startFace(s)])
    expect(a.server).toBe(b.server) // 合并：第二次复用在飞的 Promise，而非再绑一次
    expect(facePort('t-merge')).toBe(a.port)
    const res = await httpGet(a.port)
    expect(res.status).toBe(200)
  })

  it('同名面再次 startFace → 先停后起（替换语义；旧 server 已关）', async () => {
    const first = await startFace(spec({ name: 't-replace' }))
    const second = await startFace(spec({ name: 't-replace' }))
    expect(second.server).not.toBe(first.server)
    expect(second.port).not.toBe(first.port) // port:0 两次内核分配（碰撞概率 ~1/2.8万，非"固定端口段"级别的 1/400）
    expect(facePort('t-replace')).toBe(second.port)
    // 旧句柄的 dispose 不得误停新实例（句柄与 server 绑定）
    first.dispose()
    expect(faceActive('t-replace')).toBe(true)
    expect(facePort('t-replace')).toBe(second.port)
  })

  it('stopAllFaces 停掉全部在监听的面（插件卸载的唯一拆卸入口）', async () => {
    await startFace(spec({ name: 't-all-1' }))
    await startFace(spec({ name: 't-all-2' }))
    expect(activeFaceNames().sort()).toEqual(['t-all-1', 't-all-2'])
    const stopped = stopAllFaces().sort()
    expect(stopped).toEqual(['t-all-1', 't-all-2'])
    expect(activeFaceNames()).toEqual([])
    expect(facePort('t-all-1')).toBeNull()
  })
})

describe('face-host: 统一端口占用处理（EADDRINUSE 重试——此前只有 gateway 独享）', () => {
  it('端口被占用 → 不崩、1s 后重试成功（占用方释放后自动绑上）', async () => {
    const blocker: Server = createServer((_req, res) => { res.end('blocker') })
    const port = await listenEphemeral(blocker) // 内核分配 + 当场占用（不猜端口段 ⇒ 不撞别的用例）

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = startFace(spec({ name: 't-busy', port, handler: (_req, res) => { res.writeHead(200); res.end('after-retry') } }))

    // 等第一次 listen 失败（EADDRINUSE）被观察并排入重试
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('EADDRINUSE'))).toBe(true)
    }, { timeout: 3000 })

    // 占用方释放 → 1s 后的重试应绑上（而不是像改成"快速失败"那样永久放弃）
    await closeServer(blocker)
    const handle = await pending
    warn.mockRestore()
    try {
      expect(handle.port).toBe(port)
      const res = await httpGet(port)
      expect(res.status).toBe(200)
      expect(res.body).toBe('after-retry')
    } finally {
      stopFace('t-busy')
    }
  }, 10_000)

  it('拆卸发生在重试窗口内 → 在飞启动被取消（FaceStartCancelled，不产生"卸载后仍绑端口"）', async () => {
    const blocker = createServer((_req, res) => { res.end('blocker') })
    const port = await listenEphemeral(blocker) // 同上：内核分配 + 当场占用

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = startFace(spec({ name: 't-cancel', port }))
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('EADDRINUSE'))).toBe(true)
    }, { timeout: 3000 })

    // 卸载：取消在飞启动（此前 gateway 的重试定时器是 fire-and-forget——卸载后仍可能绑上）
    stopAllFaces()
    await expect(pending).rejects.toBeInstanceOf(FaceStartCancelled)
    expect(faceActive('t-cancel')).toBe(false)

    await closeServer(blocker)
    warn.mockRestore()
    // 给重试窗口留时间：不得偷偷绑上（取消生效）
    await new Promise((r) => setTimeout(r, 1200))
    expect(faceActive('t-cancel')).toBe(false)
  }, 10_000)
})

/**
 * v1.34.1 flake 修复回归钉（块 1 / 块 2 / 块 5）。
 *
 * 背景：`acp-core.test.ts` 的 F4d 用例偶发 "Test timed out in 5000ms"，伴生日志是
 * "端口 … 被占用（EADDRINUSE），1s 后重试（n/10）" —— 真相 = **撞端口** + 重试预算（10s）
 * 远大于调用方耐心（vitest 5s）："快失败"被拉长成"挂死"。
 *
 * 📐 **实测更正（2026-09-15，Node v22.22.1）**：本组第一个用例曾预期"去掉块 1 就会失败"，
 * 对照实验（把 `closeIdleConnections()` 注释掉单跑）**它仍然通过** ⇒ 原诊断"close() 不释放
 * 空闲 keep-alive 连接"在**本运行时上不成立**：`http.Server.close()` 本身就会收掉空闲连接
 * （探针：请求后 server 持 1 连接 → close() 同步后 0）。探针同时确认：唯一会触发 EADDRINUSE
 * 的情形是**同一 (host,port) 上另有 LISTEN 的 socket** ⇒ flake 的真实类别是**端口碰撞**
 * （并发测试 worker / 残留监听者），该类由测试侧 `port:0` 结构性消除（块 3）。
 * 故下面的用例定位 = **不变量钉子**（钉行为），**不是**"钉住某一行实现"。
 */
describe('face-host: v1.34.1 flake 修复回归钉（块 1 端口释放 / 块 2 重试预算 / 块 5 unref）', () => {
  it('stopFace → **立即**重绑同一端口：在**微压预算**内成功（不变量：停面即让出端口）', async () => {
    // ⚠️ 端口来源改为「我们自己的第一次绑定」(`port: 0` → 读回 `handle.port`)。
    //    原写法是"内核先分配再释放"（scout + close）⇒ 留出一个**长空窗**，而内核在分配
    //    临时端口时**优先复用刚释放的那个** ⇒ 并行 worker 的 `listen(0)` 极易把它抢走
    //    （实测：本用例曾因此偶发 `EADDRINUSE 127.0.0.1:37913`，1 failed/1417）。
    const keepAlive = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const first = await startFace(spec({ name: 't-rebind', port: 0 }))
      const port = first.port
      expect(port).toBeGreaterThan(0)
      // keep-alive 客户端：请求结束后连接**留在服务端**（探针实测 server 持 1 连接）——
      // 这是"停面后端口是否真的可用"最容易出问题的那种前置状态
      expect((await httpGet(port, '/', keepAlive)).status).toBe(200)

      stopFace('t-rebind')
      // 这一条是**确定性的、我们完全可控**的：停面必须立即从 active 表消失
      expect(faceActive('t-rebind')).toBe(false)

      // 立即重绑。预算取**微压**（~185ms）而**不是**生产缺省的 10×1s：
      //   要钉的不变量是「停面即让出端口、**不需要** 10 秒预算」，
      //   而不是"绝不可能被第三方抢走"——并行的 `listen(0)` 抢走刚释放的端口是**环境噪声**，
      //   不是本模块的缺陷。原写法用 `retryDelays: []`（零重试）把环境噪声当成缺陷判据，
      //   因此本身就是 flaky 的（已实测）。
      const handle = await startFace(spec({ name: 't-rebind', port, retryDelays: [10, 25, 50, 100] }))
      expect(handle.port).toBe(port)
      const res = await httpGet(port, '/', false) // 不走复用池（免"客户端复用已关 socket"的竞态）
      expect(res.status).toBe(200)
      expect(res.body).toBe('ok')
    } finally {
      keepAlive.destroy()
      stopFace('t-rebind')
    }
  })

  it('重试预算耗尽 → startFace **reject**（EADDRINUSE 可见，绝不静默挂满 10s；块 2）', async () => {
    const blocker = createServer((_req, res) => { res.end('blocker') })
    const port = await listenEphemeral(blocker)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const t0 = Date.now()
      // 预算 = 2 次 × 20ms（远小于缺省 10 × 1s）⇒ 短预算被真正采纳 ⇒ 快失败可见
      await expect(
        startFace(spec({ name: 't-exhaust', port, retryDelays: [20, 20] })),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(faceActive('t-exhaust')).toBe(false)
      // 两次重试各记一条 → 恰好 2 条，然后耗尽 reject（不是"没有重试"也不是"无限重试"）
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('EADDRINUSE')).length).toBe(2)
    } finally {
      await closeServer(blocker)
      warn.mockRestore()
    }
  })

  it('unref:true → server 不持事件循环引用；缺省 → 持有（块 5：只有面 C 传 true）', async () => {
    const refd = await startFace(spec({ name: 't-refd' }))
    const unrefd = await startFace(spec({ name: 't-unrefd', unref: true }))
    expect(serverHasRef(refd.server)).toBe(true) // 缺省 = 维持事件循环（另外三面行为不变）
    expect(serverHasRef(unrefd.server)).toBe(false) // unref ⇒ 一次性命令（`dsh <cmd>`）不被拖住
    stopFace('t-refd')
    stopFace('t-unrefd')
  })
})

describe('face-host: 意图判据（faceEnabled）', () => {
  it('enabled() 真/假/抛错 → true/false/false（抛错不把调用方拖崩）', () => {
    expect(faceEnabled(spec({ name: 't-en-on', enabled: () => true }))).toBe(true)
    expect(faceEnabled(spec({ name: 't-en-off', enabled: () => false }))).toBe(false)
    expect(faceEnabled(spec({ name: 't-en-throw', enabled: () => { throw new Error('config broken') } }))).toBe(false)
  })

  it('startFace 是机械入口：**不读** enabled（意图归装配层，程序化直启照常起）', async () => {
    const handle = await startFace(spec({ name: 't-mech', enabled: () => false }))
    expect(faceActive('t-mech')).toBe(true)
    const res = await httpGet(handle.port)
    expect(res.status).toBe(200)
  })
})
