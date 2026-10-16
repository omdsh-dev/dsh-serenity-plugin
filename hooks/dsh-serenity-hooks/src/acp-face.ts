/**
 * acp-face.ts — **面 E：官方 ACP 面**（2026-10-16，owner 令「跑在 dsh web 进程内」）
 *
 * ## 它是什么
 *
 * 把**官方** `@deepseek-ai/dsh-acp` 挂进**本进程**（宿主 `dsh web` 那条 Cordis 树），
 * 让标准 ACP 客户端（Agmente 等）经 **WebSocket** 登入本 CCC。
 *
 * ## 🔴 为什么是"自持面"而不是借宿主 `webServer`（本模块的核心设计决策）
 *
 * 两条路，**选乙**：
 *   · 甲：`ctx.webServer.registerUpgrade({path})` —— 探针（P0′）走的那条；
 *   · 乙：**本插件自己起一个 listener**（面宿主统一范式），在它上面挂 `'upgrade'` ← **本模块**
 *
 * 选乙的理由（按强度）：
 *   ① 🔴 **不需要往 `HostWebServer` 本地接口补 `registerUpgrade`** —— 面宿主是**我们自己的**，
 *      `FaceHandle.server` 就是原始 `node:http` server（`face-host.ts:81` 注释逐字指出
 *      *"面若需挂自己的 server 级事件（gateway 的 `'upgrade'`）在此挂"*）⇒ **少动一处宿主缝**；
 *   ② ✅ **先例在生产里跑着**：`gateway.ts:454` 的 `handle.server.on('upgrade', …)` 就是这条路；
 *   ③ ✅ **与三个既有面同范式**（A 宿主监听／B C D 插件监听）⇒ **零新概念**；
 *   ④ ✅ **端口独立**（不动宿主 `webServer.host/port`）—— 而 owner Q3 恰恰说
 *      「**先 `0.0.0.0` 监听即可**」，自持面**可直接绑 `0.0.0.0`**（面自己的 `host`）⇒ 更贴那条裁决；
 *   ⑤ ✅ **拆卸免费**（`stopAllFaces` 是"插件卸载/HMR 拆卸自起 listener 的唯一入口"）。
 *
 * ## 🔴 为什么不走 `AcpServer` 而直接调 `dsh-acp` 的 `apply`（P0′ 实测结论）
 *
 * `AcpServer` 的入参是 `{ agent: AgentConnector }`，而 **`dsh-acp` 不导出它的 connector**
 * （它在 `apply` 内部自建）⇒ 走 `AcpServer` 就得**重写 `dsh-acp` 全部 onRequest 接线**。
 * ⇒ 最短路 = 自己把 socket 适配成 ACP `Stream`，交给 `apply` 的 `config.stream`
 * （其 JSDoc 逐字：*"Runtime-only transport override; production uses stdio"*）。
 *
 * ## ⚠️ 三个**已实测**的坑（照做，别重新发明）
 *
 * ① **直接调 `apply` 时，`inject` 要替 `dsh-acp` 声明它需要的全部服务** ——
 *    实测逐字失败过：`cannot get property "sessionPersistence" without inject`
 *    （抛自 `dsh-acp/lib/index.js:1074`）。故本模块 `inject` 含
 *    `agents` / `llm` / `sessionPersistence` / `sessions`。
 * ② **`dsh-acp` 的 `Config` schema 里没有 `stream` 字段** ⇒ 只能**程序化传入**，不可经 YAML。
 * ③ **`wsToAcpStream` 的元素是"已解析的 JSON-RPC 消息"**（不是字节）——
 *    官方 `ndJsonStream` 干的就是"字节 ↔ 消息"的分帧，我们照它的语义自己分帧（按行）。
 *
 * ## 🔴 安全边界（不许含混）
 *
 * **ACP 协议本身不做认证**（`dsh-acp` 的 `authenticate` 恒成功），而本面按 owner 裁决绑
 * **`0.0.0.0`** ⇒ **必须有外部接入层兜底**（现为 Cloudflare Access）。
 * ⛔ 「隧道不是 ACC 该关心的事」（Q3 裁决）**成立**，但「因此不需要认证层」**不成立** ——
 * 故本模块的启动日志与 `status()` **都显式带这条前提**。
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
// 🔴 D111「接真契约三件齐」之③ —— **一行真 `import type`**（devDep ＋ `paths` ＋ 本行）。
//    ⚠️ 它**不是装饰**：`AcpConfig` 就是 `dsh-acp` 的**真**配置契约（含那个 `stream?` 覆盖口）。
//    若我们照抄一份手写接口，它升版把 `stream` 去掉时**不会有任何编译信号**（正是 D119 那族）。
//    `WebSocket` / `WebSocketServer` 同理由 `@types/ws` 提供（`ws` 自身不带类型）——
//    有了它们就不必再手搓形状（本文件早先那两个 `*Like` 接口即由此**退场**，属熵减）。
import type { AcpConfig } from '@deepseek-ai/dsh-acp'
import type { WebSocket, WebSocketServer } from 'ws'
import { startFace, faceActive, facePort, stopFace, type FaceHandle } from './face-host.js'
import { FACE_PORTS } from './ports.js'
import { readSimpleSettings, SERENITY_SETTINGS_NS } from './settings-section.js'

/** 面名（面宿主幂等键；与 FACE_PORTS 的 id 同名，便于对账） */
const FACE_ACP = 'acp'

/** 本面绑定的地址（取自集中端口表 —— **单一真相源**，不在本文件硬写） */
const ACP_HOST = FACE_PORTS.acp.host ?? '127.0.0.1'

/**
 * `dsh-acp` 需要的服务（**替它声明**，见文件头坑 ①）。
 *
 * 逐字出处 = `dsh-acp/lib/index.js` 的 `const inject = ["agents","llm","sessionPersistence","sessions"]`。
 * ⚠️ **少一个就在它内部抛错**（实测那条是 `sessionPersistence`）⇒ 这里是**照抄它的声明**，
 *    不是"我们觉得它需要什么"。⇒ 它升版改了 `inject`，这里要跟着改（列为**跨版本注意点**）。
 */
const ACP_REQUIRED_SERVICES = ['agents', 'llm', 'sessionPersistence', 'sessions'] as const

export function acpFaceActive(): boolean {
  return faceActive(FACE_ACP)
}

export function acpFacePort(): number | null {
  return facePort(FACE_ACP)
}

/**
 * 面是否在监听（意图读取）。
 * ⚠️ 与 `startFace` 的关系同其余各面：**启动本身不读它**（`startFace` 是机械入口），
 * 由装配层用它决定"起还是停"。
 */
export function acpFaceEnabled(): boolean {
  return readSimpleSettings().acpFaceEnabled
}

// ── 动态依赖（**懒加载**：本面默认关 ⇒ 没开时不该把 dsh-acp 拉进模块图）──────────────
//
// 🔴 为什么用 `await import()` 而不是顶部静态 import：
//    ① `dsh-acp` 是**宿主提供的包**（peer），可能在某些部署里不存在；静态 import 会让
//       **整个插件**加载失败，而本面只是"一个默认关的可选面" ⇒ **不能让可选面拖垮插件的加载**；
//    ② 默认关 ⇒ 零成本（不 import = 不加载）。
// ⚠️ 类型面走 `import type`（编译期擦除），与上面那条不冲突 —— 见文件头的 D111 三件齐说明。

/**
 * `dsh-acp` 的**真**模块形状。
 *
 * 🔴 用 `typeof import(...)` 而**不是**手写 `{ apply, name }` 接口（2026-10-16 改）：
 *    手写那份是**我们自己编的规格**，它与上游漂移时**没有任何编译信号** ——
 *    正是 D119／D133 那族（"接口自述" ≠ "真契约"）。此处直接绑上游导出面：
 *    它删/改任何导出，**这一行就会红**。
 */
type DshAcpModule = typeof import('@deepseek-ai/dsh-acp')

/** `ws` 的 `WebSocketServer` 构造形状（真实类型来自 `@types/ws`；`ws` 自身不带类型） */
type WsServerCtor = new (options: { noServer: boolean }) => WebSocketServer

/**
 * 一条 ACP `Stream` —— **直接用官方契约**（`AcpConfig['stream']` 去掉 `undefined`）。
 *
 * 🔴 早先这里是手写的 `{ readable: ReadableStream<unknown>; writable: WritableStream<unknown> }`，
 *    看着等价，实则**比契约弱**：`unknown` 会让我们绕开"元素必须是 JSON-RPC 消息"这条约束
 *    （接线处因此差点漏掉一次类型检查 —— 实测由 `dshAcp.apply` 那一行抓出来）。
 *    ⇒ 改成官方 `Stream` 后，**消息级语义（`AnyMessage`）由上游把守**，我们不必自证。
 */
type AcpStream = NonNullable<AcpConfig['stream']>

/**
 * 把一条裸 WS socket 适配成 ACP `Stream`。
 *
 * 🔴 与官方 `ndJsonStream` **同语义**：我们自己做「消息 ↔ 文本帧」的分帧（按行）。
 *    实测注意（P0′）：`dsh-acp` 写出的每条消息**自带换行**，客户端同样 ⇒ 按行切分即正确。
 *    ⚠️ **空行要丢**；**非 JSON 帧要容忍**（桥/客户端可能插入控制帧）。
 */
function wsToAcpStream(ws: WebSocket, onWarn: (line: string) => void): AcpStream {
  const readable = new ReadableStream<unknown>({
    start(controller) {
      let buf = ''
      // `ws` 的 `message` 回调给的是 `RawData`（含 Buffer / ArrayBuffer / Buffer[]）；
      // 按官方 `ndJsonStream` 的语义我们只处理文本形态（控制帧早已被分帧器剔除）。
      ws.on('message', (data: unknown) => {
        buf += typeof data === 'string' ? data : String(data)
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          try {
            controller.enqueue(JSON.parse(line))
          } catch {
            // 非 JSON 帧：记一条（对本面是"别人的噪音"），不中断本流
            onWarn(line.slice(0, 120))
          }
        }
      })
      ws.on('close', () => {
        try {
          controller.close()
        } catch {
          /* 已关 */
        }
      })
      ws.on('error', () => {
        try {
          controller.close()
        } catch {
          /* 已关 */
        }
      })
    },
  })
  const writable = new WritableStream<unknown>({
    write(msg) {
      ws.send(`${JSON.stringify(msg)}\n`)
    },
  })
  // 断言的理由：`Stream` 的元素类型是官方的 `AnyMessage`（JSON-RPC 消息联合体），
  // 而我们这里的分帧口径就是"按行 JSON.parse ⇒ 消息"（与官方 `ndJsonStream` 同语义）
  // ⇒ 形状一致，差异只在 `unknown` 与 `AnyMessage` 的**静态**标注上。
  return { readable, writable } as AcpStream
}

/** 一条连接的应用结果（诊断用） */
interface AcpConnStat {
  at: number
  /** `dsh-acp` 的 `apply` 是否成功接线 */
  applied: boolean
  /** 失败时的原因（截断） */
  error?: string
}

/** 面内状态（日志/诊断；不跨面共享） */
interface AcpFaceState {
  handle: FaceHandle | null
  wss: WebSocketServer | null
  connections: number
  applied: number
  lastErrors: AcpConnStat[]
  /** 每连接一次 `apply` 的析构集合（`dsh-acp` 的 `apply` 会注册 `ctx.on` ⇒ 需可回收） */
  disposers: Array<() => void>
}

function newState(): AcpFaceState {
  return { handle: null, wss: null, connections: 0, applied: 0, lastErrors: [], disposers: [] }
}

/** 当前面状态（供 `status()` / 诊断读；无监听时 `handle` 为 null） */
let state = newState()

/** 保留最近若干条连接错误（诊断窗口；不无限增长） */
const MAX_ERR_KEEP = 8

/** 面的运行统计（`dashboard` / 诊断面用；**只读快照**） */
export interface AcpFaceStatus {
  active: boolean
  port: number | null
  host: string
  enabled: boolean
  connections: number
  applied: number
  errors: Array<{ at: number; applied: boolean; error?: string }>
  /** 🔴 本面**没有内建认证** —— 这条随状态一起出，避免"看到 active 就以为它是安全的" */
  authNote: string
}

export function acpFaceStatus(): AcpFaceStatus {
  return {
    active: acpFaceActive(),
    port: acpFacePort(),
    host: ACP_HOST,
    enabled: acpFaceEnabled(),
    connections: state.connections,
    applied: state.applied,
    errors: [...state.lastErrors],
    authNote: 'ACP 协议本身不做认证；本面绑定 ' + ACP_HOST + ' ⇒ 必须由外部接入层（Access）兜底',
  }
}

/**
 * 启动面 E（幂等；重复调用只起一次）。
 *
 * 🔴 **失败语义**：本面**默认关**且是**可选面** ⇒ 起不来**不得**影响插件其余部分
 * （调用方负责 catch；本函数把失败原样抛出，由装配层记日志）。
 */
export async function startAcpFace(ctx: Context): Promise<FaceHandle> {
  const port = readSimpleSettings().acpFacePort

  // ① 动态取依赖（默认关时不加载；缺失时给**可诊断**的错误，不是裸 ERR_MODULE_NOT_FOUND）
  let dshAcp: DshAcpModule
  let wsMod: { WebSocketServer: WsServerCtor }
  try {
    // `dsh-acp` 的导出面**逐字**就是 `DshAcpModule`（见其 `lib/types/index.d.ts`）⇒ 无需断言。
    dshAcp = await import('@deepseek-ai/dsh-acp')
    wsMod = (await import('ws')) as unknown as { WebSocketServer: WsServerCtor }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    throw new Error(
      `面 E 依赖不可用（${msg}）—— 需要宿主提供 @deepseek-ai/dsh-acp，且本插件能 resolve 到 ws`,
    )
  }
  if (typeof dshAcp.apply !== 'function') {
    throw new Error('面 E：@deepseek-ai/dsh-acp 未导出 apply（版本不匹配？）')
  }

  const wss = new wsMod.WebSocketServer({ noServer: true })
  const local = newState()
  local.wss = wss

  const handle = await startFace({
    name: FACE_ACP,
    port,
    host: ACP_HOST,
    // 意图：D0 面板键（装配层以此门控；本处是规格自述）
    enabled: () => readSimpleSettings().acpFaceEnabled,
    // HTTP 那半：本面**只**走 WS（ACP over WebSocket）⇒ 普通请求一律 426 Upgrade Required，
    // 让"用浏览器访问"的人一眼看出这不是网页面（对照：面 D 是网页面，会返回 HTML）。
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(426, {
        'content-type': 'text/plain; charset=utf-8',
        'upgrade': 'websocket',
        'cache-control': 'no-store',
      })
      res.end('This is an ACP (Agent Client Protocol) endpoint over WebSocket. Use an ACP client.\n')
    },
  })
  local.handle = handle

  // ② 在**自己的** server 上挂 upgrade（本模块的核心设计决策；先例 = gateway.ts:454）
  handle.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    local.connections += 1
    try {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        try {
          const stream = wsToAcpStream(ws, (line) => {
            console.log(`[serenity-hooks] 面 E：丢弃一条非 JSON 帧（前 120 字）: ${line}`)
          })
          // 🔴 关键接线（第一版**实测失败**过，故注释在此钉死）：
          //
          //   起初我直接 `dshAcp.apply(ctx, {stream})`，报逐字：
          //     `cannot get property "sessionPersistence" without inject`
          //     （抛自 dsh-acp/lib/index.js:1074）
          //   根因：**cordis 的 ctx 是 Proxy，对未声明 inject 的服务名直接抛错**
          //     （`ReflectService.handler.get`；本仓 `host/access.ts:30-43` 已记录同族现象）。
          //     于是"把我们的 ctx 借给它用"这条路**不成立** —— 它的直接属性读会炸。
          //
          //   ⇒ 正解 = **给它一个自己声明了 inject 的 scope**：
          //     `ctx.plugin({ inject: [...], apply })` 是"`inject` 声明 ＋ apply 回调"的简写
          //     （cordis `registry.d.ts:104` 注释逐字说明），它为该插件建独立 fiber
          //     ⇒ **`dsh-acp` 的服务读取在它自己的 scope 里成立**，且监听器随该 fiber 回收。
          //
          //   🔴 每连接一次 `ctx.plugin(...)`：`dsh-acp` 的 apply 是"一条连接一个实例"的结构
          //      （它内部只 `connect(stream)` 一次）⇒ 一个 plugin fiber 对应一条 WS 连接。
          const fiber = (ctx as unknown as {
            plugin: (p: unknown) => { dispose?: () => void }
          }).plugin({
            inject: ACP_REQUIRED_SERVICES,
            // `scoped` 收窄成真 `Context`：`dshAcp.apply` 要的就是它 ——
            // 这是 D111 那行 `import type` 逼出来的（手写形状下它是 `unknown`，检查被绕开）。
            apply: (scoped: Context) => {
              dshAcp.apply(scoped, {
                stream,
                provider: readAcpProvider(),
                model: readAcpModel(),
              })
            },
          })
          local.disposers.push(() => {
            try {
              fiber?.dispose?.()
            } catch {
              /* 已回收 */
            }
          })
          local.applied += 1
        } catch (err) {
          const msg = String((err as Error)?.message ?? err).slice(0, 200)
          local.lastErrors.push({ at: Date.now(), applied: false, error: msg })
          if (local.lastErrors.length > MAX_ERR_KEEP) local.lastErrors.shift()
          console.warn(`[serenity-hooks] ✗ 面 E：dsh-acp 接线失败: ${msg}`)
          try {
            ws.close(1011, 'acp bridge failed')
          } catch {
            /* 已关 */
          }
        }
      })
    } catch (err) {
      // handleUpgrade 自身失败（握手非法等）：销毁 socket，不让它成为 unhandled
      console.warn(`[serenity-hooks] ✗ 面 E：WebSocket 握手失败: ${String((err as Error)?.message ?? err)}`)
      try {
        socket.destroy()
      } catch {
        /* noop */
      }
    }
  })

  state = local
  console.log(
    `[serenity-hooks] ✓ 面 E（官方 ACP）：ws://${ACP_HOST}:${port}  ⚠️ 协议无认证，靠外部 Access 兜底`,
  )
  return handle
}

/**
 * 停面 E（幂等）。
 *
 * ⚠️ **与其余各面同款注意**：`stopFace` **不用** `closeAllConnections()`（那会掐断在飞的请求）；
 *  WS 连接由 `wss.close()` 与 socket 自身生命周期收束。
 */
export function stopAcpFace(): boolean {
  const wss = state.wss
  if (wss) {
    try {
      wss.close()
    } catch {
      /* 已关 */
    }
  }
  // `dsh-acp` 的 apply 注册的监听器随插件拆卸统一回收（`ctx.effect`）；这里清掉本地引用
  state.disposers = []
  state.wss = null
  state.handle = null
  const stopped = stopFace(FACE_ACP)
  if (stopped) console.log('[serenity-hooks] face acp: 已停止')
  return stopped
}

/** ACP 会话用的 provider（取 CCC 现有路由；留空 = 由宿主/请求监听器决定） */
function readAcpProvider(): string | undefined {
  return process.env.SERENITY_ACP_PROVIDER || undefined
}
/** ACP 会话用的 model（同上） */
function readAcpModel(): string | undefined {
  return process.env.SERENITY_ACP_MODEL || undefined
}

/**
 * 装配（`index.ts` 的 `apply` 调用）：按**面板/部署键**启停面 E，配置变化热同步。
 *
 * 🔴 **W3 接线**（2026-10-16）：本轮之前 `startAcpFace` 虽已实现却**没有任何调用点**
 * —— 即"面写好了但从不起"。本函数补上它，形式与两个兄弟面一致
 * （`registerWeixinSendApi` ／ `registerDiagramTool`）：
 *
 * ① **反应式**：面板拨开关**只改配置、不重跑 `apply`**（v1.51.1 实测过的那条铁律）
 *    ⇒ 必须监听事件才会"拨了就有反应"；
 * ② 监听**宿主的真事件** `settings/document-updated`（按 ns 过滤），
 *    ⛔ **不监听** `serenity/settings-changed` —— 那个事件**全仓没有任何 `emit` 点**
 *    （＝死通道；见 `registerDiagramTool` 的注释），照它接线等于接了个永远不响的铃；
 * ③ 再挂 `agent/created`／`session/created` 兜底（宿主事件面若换名，至少还有这条能自愈）；
 * ④ 启动时同步一次（`apply` 时按当前配置定初始态）。
 *
 * ⚠️ **失败语义**：本面**默认关**且**依赖可选**（`dsh-acp` 是 peer）⇒ 起不来**只记日志**，
 *    绝不抛出（抛出会让整个插件加载失败，而它只是一个可选面）。
 */
export function registerAcpFace(ctx: Context): void {
  const sync = (): void => {
    if (!acpFaceEnabled()) {
      // 关闭状态：已起则停（幂等；没起时 `stopAcpFace` 也是安全的）
      if (acpFaceActive()) stopAcpFace()
      return
    }
    if (acpFaceActive()) return // 已在监听 ⇒ 幂等返回（避免 EADDRINUSE）
    void startAcpFace(ctx).catch((err) => {
      // 响亮但不抛出：静默失败会让"拨了开关没反应"看起来像开关坏了
      console.error(`[serenity-hooks] ✗ 面 E（官方 ACP）启动失败: ${String((err as Error)?.message ?? err)}`)
    })
  }

  try {
    ctx.on('settings/document-updated', (ns: unknown) => {
      if (String(ns) === SERENITY_SETTINGS_NS) sync()
    })
  } catch {
    /* 事件通道缺失不阻断（下面还有兜底与启动那次） */
  }
  for (const eventName of ['agent/created', 'session/created'] as const) {
    try {
      ctx.on(eventName, () => { sync() })
    } catch {
      /* 同上 */
    }
  }
  sync()
}
