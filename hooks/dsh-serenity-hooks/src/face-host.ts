/**
 * face-host.ts — **面宿主**：插件自起 HTTP listener 的唯一生命周期处（C4 块 A，S142 2026-09-15）
 *
 * ## 现状 → 本模块要收掉什么（取证：`…/acc-c4c5-current-state.md` §①/§③ 3.1）
 *
 * 插件自己 spawn 了**四个** node:http 监听器（B 3081 网关 / C 3082 微信发送 / D 3099 Skiff 调试
 * / E 3100 ACP+问答）。此前四处各写一份同款样板：`createServer` + `server.once('error')` +
 * `listen(port, host)` + 模块级 `active` 变量 + `close()`；拆卸也分裂成**两套**——
 * `seams/lifecycle.ts` 有一个聚合 disposer，而 `gateway.ts` 与 `weixin-send-api.ts`
 * **各自另注册**一个（D/E 干脆没有自己的 disposer）。
 *
 * 本模块把"listener 生命周期"收成一处：**active 表 + 统一 listen/close + 统一错误与端口占用
 * 处理**。四个面各自只提供 `{ name, port, host, enabled, handler }`。
 *
 * ## 🔴 共享的是「生命周期与样板」，**绝不是**「路由 / 监听器 / 鉴权」
 *
 * 每个面**保留自己的 listener、自己的路由、自己的鉴权**（`handler` 内部原样不动）：
 *   · **A ↔ C 解耦**（`weixin-send-api.ts:4-7`）：3080 会被 3081 原样反代（连请求头），
 *     把 3082 的端点挂到 3080 上 = 已登录的外部家庭账号即可冒充 bot 发消息
 *     ⇒ 本模块**不提供**"把面挂到别的面"的能力，也不共享路由表；
 *   · **E ↔ D** 共用会话核心（acp-core → skiff-core）但各自独立 listener + 独立路由/HTML；
 *   · **B 是 A 的代理宿主**（把请求打到 `127.0.0.1:<主端口>`），不是另一个路由面。
 *
 * ## 面 A（3080）不在本模块之列
 * 它是**宿主 DSH 主 WebUI**，插件只往上挂 `/serenity/*` 路由（`ctx.webServer.register`），
 * **插件不起这个 listener** ⇒ 面宿主只持有 B/C/D/E 四个自起面。
 *
 * ## 两个入口的分工（这是本模块唯一的"抽象决策"，别混）
 *   · {@link startFace} —— **机械启动**：把一个 handler 绑到 `host:port` 上。同名面若已在监听，
 *     **先停后起**（替换）；同名面正在启动中则**复用在飞的 Promise**（并发合并——这条替代了
 *     `index.ts` 里手搓的 `starting` 在飞标志与随之而来的 `EADDRINUSE` 双绑）。
 *     它**不读** `spec.enabled()`：调用方保证意图（测试/程序化直启也走这里）。
 *   · {@link faceEnabled} —— **意图读取**：装配层据此判"该面此刻应否在监听"，替代各面 sync 里
 *     手写的 `const want = <配置> && ...` 判据（判据本身只写在面的 {@link FaceSpec} 里一次）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** 面规格：**四个面各自只提供这 5 项**（路由/鉴权/响应体全部归面的 `handler`） */
export interface FaceSpec {
  /** 面名（日志/拆卸/幂等键；全进程唯一，建议用 `FACE_*` 常量） */
  name: string
  /** 期望监听端口（0 = 内核分配；实际端口见 {@link FaceHandle.port}） */
  port: number
  /** 监听地址（各面自定：`127.0.0.1` 或 `0.0.0.0`——**不因归一而改绑**） */
  host: string
  /** 该面**此刻是否应处于监听状态**（面自己的配置意图；由 {@link faceEnabled} 读取） */
  enabled: () => boolean
  /** 单请求处理（面自己的路由 / 鉴权 / 响应体，本模块不介入其语义） */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  /**
   * **EADDRINUSE 重试预算**：每次重试前等待的毫秒数序列（长度 = 最多重试次数）。
   * 缺省 = {@link DEFAULT_RETRY_DELAYS}（10 × 1000ms，**生产行为原样不变**）。
   * 传空数组 = 零重试（一次 EADDRINUSE 即 reject）；测试用短预算证明"耗尽即 reject"。
   *
   * 🔒 不变量（v1.34.1 修 flake 时显式化）：重试预算**可见、可控、有界**——
   * 绑定尝试绝不无声挂满整段预算；耗尽即 **reject**（调用方可见），不静默悬挂。
   * 此前预算是模块内硬写的 10×1s，而 vitest 单测超时 5s ⇒ "快失败"被拉长成"挂死"，
   * 调用方无从缩短 ⇒ 预算提到规格面上。
   */
  retryDelays?: readonly number[]
  /**
   * 绑上后 `server.unref()`（缺省 `false` = server 维持事件循环存活，**其余三面行为不变**）。
   *
   * 面 C（微信发送，`FACE_PORTS.weixinSend.defaultEnabled = true`）必须传 `true`：宿主若以
   * **一次性命令**方式跑（`dsh <cmd>` 用完即退），未 unref 的 listener 会拖着进程不退出。
   * 这是 C4 之前 `weixin-send-api.ts` 的原语义（C4 归一到面宿主时丢失），现逐字恢复。
   */
  unref?: boolean
}

/** 一个在监听的面 */
export interface FaceHandle {
  readonly name: string
  /** **实际**绑定端口（`spec.port=0` 时为内核分配值） */
  readonly port: number
  readonly host: string
  /** 原始 http server——面若需挂自己的 server 级事件（gateway 的 `'upgrade'`）在此挂 */
  readonly server: Server
  /** 停止本面（幂等；只停这一实例，不会误停同名后继实例） */
  dispose: () => void
}

interface FaceEntry {
  spec: FaceSpec
  server: Server
  handle: FaceHandle
}

/** EADDRINUSE 重试次数与间隔（沿用 gateway v1.22.1 的稳定性参数：旧进程未释放时不崩、稍后再绑） */
const LISTEN_RETRY_MAX = 10
const LISTEN_RETRY_DELAY_MS = 1000
/**
 * **缺省重试预算**（面未给 {@link FaceSpec.retryDelays} 时使用）= 10 次 × 1s。
 *
 * ⚠️ 为什么把预算提到规格面上（v1.34.1 修 flake）：生产值 **10s > vitest 单测 5s 超时**，
 * 一旦撞上 EADDRINUSE，"快失败"就变成"测试挂死"（超时报告里只剩一半重试日志，
 * 真相被超时噪音盖住）。测试侧需要能显式缩短/清空预算才能验收"耗尽 ⇒ reject"
 * 这条不变量——硬写常量给不了这个能力。
 */
const DEFAULT_RETRY_DELAYS: readonly number[] = Array.from({ length: LISTEN_RETRY_MAX }, () => LISTEN_RETRY_DELAY_MS)

/** active 表：面名 → 在监听的面（**全插件唯一**的"面是否在监听"真相源） */
const faces = new Map<string, FaceEntry>()
/** 在飞启动：面名 → 启动 Promise（并发触发只 bind 一次） */
const starting = new Map<string, Promise<FaceHandle>>()
/** 可取消句柄：面名 → 取消本次启动（拆卸/停服时防止"卸载后仍绑上端口"） */
const cancellers = new Map<string, () => void>()

/** 启动被取消（拆卸发生在重试窗口内）——不是失败，调用方按"未启动"处理 */
export class FaceStartCancelled extends Error {
  constructor(name: string) {
    super(`face start cancelled: ${name}`)
    this.name = 'FaceStartCancelled'
  }
}

/** 面是否在监听 */
export function faceActive(name: string): boolean {
  return faces.has(name)
}

/** 面的实际监听端口（未在监听 → null） */
export function facePort(name: string): number | null {
  return faces.get(name)?.handle.port ?? null
}

/** 当前在监听的面名（日志/诊断/测试；顺序 = 启动顺序） */
export function activeFaceNames(): string[] {
  return [...faces.keys()]
}

/**
 * **机械启动**一个面（同名面已在监听 → 先停后起；正在启动中 → 复用同一 Promise）。
 * 绑不上（非端口占用类的错误、或占用重试耗尽）→ **reject**，由调用方决定记日志/放弃。
 */
export async function startFace(spec: FaceSpec): Promise<FaceHandle> {
  const inflight = starting.get(spec.name)
  if (inflight) return inflight
  const promise = bind(spec)
  starting.set(spec.name, promise)
  try {
    return await promise
  } finally {
    starting.delete(spec.name)
    cancellers.delete(spec.name)
  }
}

/**
 * **意图读取**：该面此刻是否应处于监听状态（`spec.enabled()` 的安全求值——配置源抛错视为"不启用"）。
 *
 * 装配层用它替代此前散在各面 sync 里的 `const want = ...` 手写判据；**启动本身不读它**
 * （`startFace` 是机械入口：调用方保证意图，测试/程序化直启即用）。
 * 例：微信发送面的 sync = `faceEnabled(spec) ? startFace(spec) : stopWeixinSendApi()`。
 */
export function faceEnabled(spec: FaceSpec): boolean {
  try {
    return spec.enabled() === true
  } catch {
    return false
  }
}

/** 停止一个面（幂等）。返回"是否真的停了一个在监听的面"（取消在飞启动不计入）。 */
export function stopFace(name: string): boolean {
  const cancel = cancellers.get(name)
  if (cancel) {
    cancellers.delete(name)
    cancel()
  }
  const entry = faces.get(name)
  if (!entry) return false
  faces.delete(name)
  try {
    // 停面 = ① 停止接受新连接 ② 回收**空闲** keep-alive 连接（让端口真的可用）。
    // ⚠️ 绝不用 `closeAllConnections()`：那会**掐断正在处理的请求**——面 B/C 在"配置变更 → 重建"
    //    时可能正有真实用户请求在飞，掐断对用户是可见的 5xx/断流。
    entry.server.close()
    // 显式回收空闲连接（幂等；`.?.` 容忍运行时缺失该 API）。
    // 📐 实测（Node v22.22.1，2026-09-15 探针；对照实验见 tests/face-host.test.ts 的 t-rebind）：
    //    在本运行时上 `http.Server.close()` **本身**就已经把空闲 keep-alive 连接收掉
    //    （探针数据：请求后 server 持 1 连接 → `close()` 同步后为 0 → 同端口可立即重绑 **ok**）。
    //    ⇒ 这一行在此运行时是**冗余的语义钉子**，**不是**这次 flake 的根因——本仓 flake 的实测
    //    根因是"同一 (host, port) 上出现两个 **LISTEN** 的 socket"（探针：占用方还在 listen 时
    //    重绑必得 EADDRINUSE）；该类已由测试侧 `port:0` 结构性消除（见各 test 文件）。
    //    保留本行的理由：① Node <18.2 无 `closeIdleConnections`，老运行时 close() 不回收 ⇒
    //    那里它才是真修复；② 把"停面 ⇒ 立刻让出端口"这条不变量显式写在代码里。
    entry.server.closeIdleConnections?.()
  } catch {
    /* 已关闭 */
  }
  console.log(`[serenity-hooks] face ${name}: 已停止`)
  return true
}

/**
 * 停止**全部**在监听的面 + 取消全部在飞启动。
 * 这是插件卸载/HMR 拆卸自起 listener 的**唯一入口**（`seams/lifecycle.ts` 的聚合 disposer 调用）。
 * @returns 实际停掉的面名（顺序 = 启动顺序）
 */
export function stopAllFaces(): string[] {
  const names = [...faces.keys()]
  for (const name of names) {
    try {
      stopFace(name)
    } catch {
      /* 单个面停失败不阻断其余 */
    }
  }
  // 在飞启动（尚未入表）：同样取消——否则"卸载后重试窗口内"仍可能绑上端口
  for (const name of [...cancellers.keys()]) {
    try {
      stopFace(name)
    } catch {
      /* 同上 */
    }
  }
  return names
}

// ── 内部 ──

async function bind(spec: FaceSpec): Promise<FaceHandle> {
  const live = faces.get(spec.name)
  if (live) stopFace(spec.name) // 替换语义：同名面先停（关 socket 后立即重绑可能 EADDRINUSE → 下面的重试兜底）

  const server = createServer((req, res) => {
    void dispatch(spec, req, res)
  })
  // v1.22.3 崩溃修复（原 gateway 内联，C4 归一至此）：server 级 clientError 兜底——
  // 外部客户端半开连接 / 畸形请求后断开会让 Node 对无 'error' 监听的 socket 直接 throw
  // → 整个 dsh web 进程崩溃。这里静默销毁即可（代理/服务语义下是正常现象）。
  server.on('clientError', (_err: Error, socket: import('node:net').Socket) => {
    try {
      socket.destroy()
    } catch {
      /* noop */
    }
  })

  const port = await listenWithRetry(server, spec)
  // ── 块 5（v1.34.1）：按面的规格决定是否 unref。缺省 false = 维持事件循环（其余三面行为不变）；
  //    面 C（微信发送，默认开）传 true ⇒ 一次性命令（`dsh <cmd>`）不被这个 listener 拖住不退出。
  if (spec.unref === true) server.unref()
  const handle: FaceHandle = {
    name: spec.name,
    port,
    host: spec.host,
    server,
    dispose: () => {
      // 只停"这一实例"：同名后继实例（热重建）不得被旧句柄误停
      const current = faces.get(spec.name)
      if (current !== undefined && current.server === server) stopFace(spec.name)
    },
  }
  faces.set(spec.name, { spec, server, handle })
  console.log(`[serenity-hooks] face ${spec.name}: listening http://${spec.host}:${port}`)
  return handle
}

/**
 * 统一 listen：解析实际端口（支持 `port=0` 的内核分配）+ 统一错误处理。
 * 端口被占用（EADDRINUSE）→ 记录并按 {@link FaceSpec.retryDelays} 重试（缺省 {@link DEFAULT_RETRY_DELAYS}，
 * 即 10 × 1s——旧进程未释放是重启期常态；此前只有 gateway 独享这条稳定性逻辑）。
 *
 * 🔒 **不变量（调用方可见性）**：`attempt` 一旦超出预算长度，`reject(err)` 立即发生——
 * 本函数**不会**让一次绑定尝试无声挂满预算（更不会挂死）。调用方拿到 EADDRINUSE 后
 * 自行决定记日志/放弃；拆卸窗口内的取消则以 {@link FaceStartCancelled} reject。
 */
function listenWithRetry(server: Server, spec: FaceSpec): Promise<number> {
  const delays = spec.retryDelays ?? DEFAULT_RETRY_DELAYS
  return new Promise<number>((resolve, reject) => {
    let attempt = 0
    let cancelled = false
    let timer: NodeJS.Timeout | undefined

    cancellers.set(spec.name, () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      server.removeAllListeners('error')
      reject(new FaceStartCancelled(spec.name))
    })

    /** 绑上之后的常驻 error 兜底（监听期错误不得成为 unhandled 'error'） */
    const permanentOnError = (err: NodeJS.ErrnoException): void => {
      console.warn(`[serenity-hooks] face ${spec.name}: server error: ${err.message ?? String(err)}`)
    }

    const onError = (err: NodeJS.ErrnoException): void => {
      if (cancelled) return
      const delay = delays[attempt]
      if (err.code === 'EADDRINUSE' && delay !== undefined) {
        attempt += 1
        console.warn(
          `[serenity-hooks] face ${spec.name}: 端口 ${spec.port} 被占用（EADDRINUSE），${delay}ms 后重试（${attempt}/${delays.length}）…`,
        )
        timer = setTimeout(tryBind, delay)
        return
      }
      // 预算耗尽（或非占用类错误）→ reject：**调用方可见**，绝不静默悬挂
      reject(err)
    }

    const tryBind = (): void => {
      if (cancelled) return
      server.removeAllListeners('error')
      server.on('error', onError)
      server.listen(spec.port, spec.host, () => {
        if (cancelled) {
          try {
            server.close()
          } catch {
            /* noop */
          }
          return
        }
        server.removeAllListeners('error')
        server.on('error', permanentOnError)
        const addr = server.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : spec.port)
      })
    }
    tryBind()
  })
}

/** 统一请求分派：单请求异常不得杀进程（面自己的内层 try/catch 仍是第一道，这是第二道） */
async function dispatch(spec: FaceSpec, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await spec.handler(req, res)
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ face ${spec.name} 处理请求失败: ${String((err as Error)?.message ?? err)}`)
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal error' }))
      } else {
        res.end()
      }
    } catch {
      /* 响应已发出/连接已断 */
    }
  }
}
