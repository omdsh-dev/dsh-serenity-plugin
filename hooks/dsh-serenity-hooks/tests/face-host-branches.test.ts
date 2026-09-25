import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, request, type Server } from 'node:http'
import {
  startFace,
  stopFace,
  stopAllFaces,
  faceActive,
  activeFaceNames,
  type FaceSpec,
} from '../src/face-host.js'

/**
 * face-host-branches.test.ts — 面宿主：**«绑上之后» 与半途中止面**（⑤ 第 55 件，S142 2026-09-26）
 *
 * ## 与既有 `face-host.test.ts` 的分工（互补不重叠）
 *
 * 既有文件走**绑的过程**那一侧：真 listener ＋ 真 HTTP 往返 ＋ EADDRINUSE 重试成功/reject/取消
 * ＋ unref ＋ `faceEnabled` 三态 ＋ 机械入口不读 enabled。本文件补它**全部没碰**的两类：
 *
 *   ① 🔴 **«绑上之后» 的常驻面** —— `permanentOnError` ／ `stopFace` 的 catch ／
 *      `clientError` 兜底。既有用例只覆盖"**绑的过程中**"的错误（EADDRINUSE 预算），
 *      而**绑成功之后**挂在同一个 server 上的这几条 handler，**一次都没被执行过**。
 *   ② 🔴 **请求分派的半途中止面** —— `dispatch` 的 `headersSent` 分支与"非 Error 抛出物"。
 *      既有 T2 只测"handler 抛错且响应未发出 ⇒ 500"，即只走了一个方向。
 *
 * ## 为什么这两类重要（贴 objective：**面宿主 = 对外面／宿主接触面**）
 *
 * `face-host.ts` 是插件**唯一**自起 HTTP listener 的生命周期处（B/C/D/E 四个面）。
 * 上面两类正是文件头两条设计承诺的**唯一执行点**：
 *   · `:232` 「server 级 clientError 兜底 —— 否则**整个 dsh web 进程崩溃**」（v1.22.3 事故的修复）
 *   · `:328` 「单请求异常不得杀进程（…这是**第二道**）」
 * 把其中任何一处写坏（`catch` 改 `throw`、删掉 `destroy()`、把 `headersSent` 判反），
 * **既有测试全绿** ⇒ 属 §1-I7「声明—现实一致」意义上的**静默缺口**。
 *
 * ## 🔴 本件的硬前置（纪律 22/23 同族）
 *
 * 1. **绝不占活服务端口**：全部 spec 用 `port: 0`（内核分配）—— 绝不触碰 3080/3081/3082/3099/3100。
 * 2. **模块级 Map 必须重置**：`faces`/`starting`/`cancellers` 跨用例存活 ⇒ 显式
 *    `beforeEach(stopAllFaces)`，并**断言重置真的生效**（否则"面已摘除"这类断言会在脏初始态上跑）。
 * 3. **降级面断言须先有 happy-path 正控**（纪律 10）：每条"守卫生效"断言之前，先证明
 *    同一夹具在正常输入下**确实走到了目标分支**。
 */

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

/** 真实 HTTP 往返（本文件只用真往返取证据，不 mock res） */
function httpGet(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 让 server 绑上内核分配的端口并读回（占用方用） */
function listenEphemeral(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
}

afterEach(() => {
  stopAllFaces()
  vi.restoreAllMocks()
})

beforeEach(() => {
  stopAllFaces()
  // 正控（纪律 10）：证明模块级 active 表在本用例开始前**确实是干净的**。
  // 若上一用例留了面没停，下面那些「面已摘除」的断言就会在一个脏初始态上跑。
  expect(activeFaceNames()).toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────────
// A. stopAllFaces 的**在飞启动收尾段**（既有 T-cancel 未定位到的那个 branch）
// ─────────────────────────────────────────────────────────────────────────────

describe('face-host: stopAllFaces 对「在飞启动（尚未入表）」的收尾', () => {
  /**
   * 造一个**卡在重试窗口里**的面：真占用方占住内核分配的端口 ⇒ 面绑不上、停在
   * `setTimeout(tryBind, delay)` 上（既未入 `faces`、也未 settle）。
   * 这正是源码 `:211` 注释描述的状态：「在飞启动（尚未入表）」。
   */
  async function startStalledFace(name: string): Promise<{ port: number; blocker: Server; pending: Promise<unknown> }> {
    const blocker = createServer((_req, res) => { res.end('blocker') })
    const port = await listenEphemeral(blocker)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = startFace(spec({ name, port, retryDelays: [5000, 5000] }))
    // 等到第一次 EADDRINUSE 被观察并排入重试 ⇒ 此后该面就"卡"在重试窗口里了
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('EADDRINUSE'))).toBe(true)
    }, { timeout: 3000 })
    return { port, blocker, pending }
  }

  it('🔴 A3：「在飞且尚未入表」的面必须被 stopAllFaces 收掉，且**不得**出现在返回名册里', async () => {
    const A = await startStalledFace('t-a3')
    try {
      // 前置断言 = 本用例的**可达性取证**：卡住的面既没进 faces……
      expect(faceActive('t-a3')).toBe(false)

      const stopped = stopAllFaces()

      // 🔴 判据一：返回名册**不得声称停了这个面**（它本来就没在监听）。
      //    ⚠️ 时序：此刻 `startFace` 尚未 settle ⇒ `cancellers` 里**有**它的取消器，
      //    但 `names` 取自 `:203` 的 `faces.keys()` ⇒ **在本状态下必为空**。
      expect(stopped).toEqual([])

      // 🔴 判据二：**在飞启动必须真被取消**（这正是 `:211` 注释要防的那件事）。
      //    只断言 `stopped` 为空是弱测试 —— 它无法区分"取消了"与"根本没管它"。
      await expect(A.pending).rejects.toMatchObject({ name: 'FaceStartCancelled' })
      expect(faceActive('t-a3')).toBe(false)

      // 占用方释放后**不得偷偷绑上**（取消已生效）
      await new Promise<void>((resolve) => { A.blocker.close(() => resolve()) })
      await new Promise((r) => setTimeout(r, 200))
      expect(faceActive('t-a3')).toBe(false)
    } finally {
      A.blocker.close()
    }
  }, 15_000)

  it('A4（正控）：同一夹具在「无占用方」时正常绑上 ⇒ 证明 A3 的空名册不是夹具坏了', async () => {
    // 没有这条正控，A3 的 `expect(stopped).toEqual([])` 无法区分
    // 「真的是在飞未入表」与「夹具根本没启动成功」。
    const handle = await startFace(spec({ name: 't-a4' }))
    expect(handle.port).toBeGreaterThan(0)
    expect(faceActive('t-a4')).toBe(true)
    expect(stopAllFaces()).toEqual(['t-a4'])
    expect(faceActive('t-a4')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. «绑上之后» 的常驻 handler
// ─────────────────────────────────────────────────────────────────────────────

describe('face-host: «绑上之后» 的常驻 handler（既有用例只覆盖「绑的过程中」）', () => {
  it('🔴 B1：绑成功后 emit 的 server error → 由 permanentOnError 兜住，**面不被拆**', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await startFace(spec({ name: 't-perm' }))
    expect(faceActive('t-perm')).toBe(true)

    // 真故障形态：绑上之后让 server emit 一个真 ErrnoException。
    // ⚠️ 若没有 handler 兜住，Node 会把它当 **unhandled 'error'** 抛出 ⇒ 整个进程崩。
    const err = Object.assign(new Error('EPIPE after bind'), { code: 'EPIPE' })
    handle.server.emit('error', err)

    // 判据一：**日志真的打了**（= 走到了 `:287` 那一行，不是"恰好没人抛"）
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('t-perm') && String(c[0]).includes('EPIPE after bind')),
    ).toBe(true)

    // 🔴 判据二（纪律 12 同族）：常驻错误是"记一笔、**继续服务**"，不是"拆面"。
    //    只断言"记了日志"无法区分"记完继续"与"记完顺带把面摘了"。
    expect(faceActive('t-perm')).toBe(true)
    const res = await httpGet(handle.port)
    expect(res.status).toBe(200) // 面**仍可服务**——这才是"常驻兜底"的语义
    expect(stopFace('t-perm')).toBe(true)
  })

  it('B2：stopFace 在 server.close() 抛错时**仍返回 true** 且已从 active 表摘除', async () => {
    const handle = await startFace(spec({ name: 't-close-throw' }))
    // 真故障形态：让 close 真抛（对应"底层 handle 已异常/已被别人关掉"）
    const spy = vi.spyOn(handle.server, 'close').mockImplementation(() => {
      throw new Error('close boom')
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // 语义：catch 的承诺是「**已关闭** ⇒ 不当失败」；摘表发生在 try 之前 ⇒ 仍返回 true。
    // 把 catch 去掉 ⇒ 此处会抛 ⇒ 且**面永远留在 active 表里**（假"仍在监听"）。
    expect(stopFace('t-close-throw')).toBe(true)
    expect(faceActive('t-close-throw')).toBe(false)
    expect(log.mock.calls.some((c) => String(c[0]).includes('t-close-throw'))).toBe(true)
    spy.mockRestore()
  })

  it('🔴 B3：clientError → socket 被销毁且不抛（v1.22.3「整个 dsh web 进程崩溃」的修复线）', async () => {
    const handle = await startFace(spec({ name: 't-clienterr' }))
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void }
    const destroyed: string[] = []
    socket.destroy = () => { destroyed.push('destroyed') }

    // 真故障形态：外部客户端半开连接/畸形请求 ⇒ 宿主会往 server emit 'clientError'，
    // 而对没有 handler 的 socket，Node **直接 throw**（这就是 v1.22.3 的事故本体）。
    handle.server.emit('clientError', new Error('parse error'), socket)

    expect(destroyed).toEqual(['destroyed']) // 兜底真的执行了
    expect(faceActive('t-clienterr')).toBe(true) // 且**不因此拆面**
    stopFace('t-clienterr')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. dispatch 的半途中止面
// ─────────────────────────────────────────────────────────────────────────────

describe('face-host: 请求分派的半途中止面', () => {
  it('🔴 C1：handler 已发响应头后才抛 ⇒ 状态码仍 200（**不补 500**），并把已写的半截体收尾', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 真故障形态：handler 先 writeHead + 部分写，**之后**才抛（真实里 = 流中途上游断了）
    const handle = await startFace(
      spec({
        name: 't-sent',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.write('partial')
          throw new Error('mid-stream boom')
        },
      }),
    )
    const res = await httpGet(handle.port)

    // 🔴 判据 = **状态码仍是 200** —— 这正是 `headersSent` 分支存在的理由。
    //    把该分支判反（不管 headersSent 一律补 500）：`writeHead` 抛 ERR_HTTP_HEADERS_SENT
    //    ⇒ 落进二次 catch ⇒ 连接被掐断（客户端看到的将是 ECONNRESET，而不是一个"半截 200"）。
    expect(res.status).toBe(200)
    expect(res.body).toBe('partial')
    // 且**不是静默吞**：日志里留下痕迹
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('t-sent') && String(c[0]).includes('mid-stream boom')),
    ).toBe(true)
    stopFace('t-sent')
  })

  it('C2（正控）：同一夹具在「未发头就抛」时补 500 ⇒ 证明 C1 的 200 来自 headersSent 判据', async () => {
    // C1 与 C2 是**同一夹具的两个方向**，放在同一文件里才能就地对照
    // 「判据真的在判 headersSent」——分开在两个文件里就失去了这个对照。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await startFace(spec({ name: 't-unsent', handler: () => { throw new Error('early boom') } }))
    const res = await httpGet(handle.port)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'internal error' })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('t-unsent'))).toBe(true)
    stopFace('t-unsent')
  })

  it('🔴 C3：非 Error 抛出物（真抛一个字符串）⇒ 日志带出该字符串本体，且面仍可用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 真故障形态：`:333` 的 `String((err as Error)?.message ?? err)` 这条链**专为"抛的不是 Error"而写**，
    // 而既有用例只抛 `new Error(...)` ⇒ 永远走 `.message` 那半边，`?? err` 从未被执行。
    // 把 `?? err` 去掉即得 "undefined"（用户与排障者都看不到真因）。
    const handle = await startFace(
      spec({
        name: 't-nonerror',
        handler: () => {
          throw 'plain string boom' // eslint-disable-line no-throw-literal
        },
      }),
    )
    const res = await httpGet(handle.port)
    expect(res.status).toBe(500)
    // 判据升级（纪律 13 同族）：不只要"没崩"，而要**日志里出现了那个字符串本体**
    expect(warn.mock.calls.some((c) => String(c[0]).includes('plain string boom'))).toBe(true)

    // 且面**仍可用**：下一条请求照常被服务（"记一笔、继续服务"）
    const again = await httpGet(handle.port)
    expect(again.status).toBe(500)
    stopFace('t-nonerror')
  })
})
