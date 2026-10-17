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
import { hostInjected } from './host/access.js'
import { FACE_PORTS } from './ports.js'
import { readSimpleSettings, SERENITY_SETTINGS_NS } from './settings-section.js'
import { extractToken, resolveTokenOwner, acpRoleFor, listAcpRoots, cwdInsideRoot, readAcpToken, ensureAcpToken, tokenFingerprint, acpChannelEnabled as acpChannelEnabledForToken } from './acp-auth.js'
import { listCccs } from './ccc-roots.js'
import { readSkiffRoles, createRolePromptReader, buildSkiffBasePrompt } from './skiff-role.js'

/** 面名（面宿主幂等键；与 FACE_PORTS 的 id 同名，便于对账） */
const FACE_ACP = 'acp'

/**
 * 🔴 认证判决（v1.59.0）。
 *
 * `ok: false` 的 `reason` 会**同时**出现在：① 401 响应体 ② console 告警 ③ `status().errors`
 * —— 三处都写**同一句**（可复算，不靠印象），且**按信息量从大到小**给因：
 * 先区分"根本没带 token"与"带了但不对"，再区分"是哪个 CCC 层的问题"。
 */
type AcpAuthVerdict =
  | { ok: true; root: string; role: string }
  | { ok: false; reason: string }

/**
 * 校验一次 upgrade 请求（**只读**：不改任何状态）。
 *
 * 判据链（任一环失败即拒，fail-closed）：候选 token 缺失 ⇒ 不匹配任何 CCC ⇒
 * 该 CCC 未启用 ACP 通道 ⇒ 该 CCC 未配角色。最后一环尤其重要：**没有角色的 ACP 会话
 * 等于一个无身份、无约束的裸 agent** ⇒ 宁可连不上。
 */
function authorizeUpgrade(req: IncomingMessage): AcpAuthVerdict {
  const candidate = extractToken(req.headers as Record<string, unknown>, req.url)
  if (!candidate) return { ok: false, reason: '未携带 token（用 Authorization: Bearer <t> 或 ?token=<t>）' }
  const roots = acpRoots
  if (roots.length === 0) return { ok: false, reason: '本机没有任何启用了 ACP 通道的 CCC' }
  // 先判"token 认不认"（与"CCC 没配好"分开报，否则排障时会被误导到错的方向）
  const owner = resolveTokenOwner(candidate, roots)
  if (!owner) return { ok: false, reason: 'token 不匹配任何已启用 ACP 通道的 CCC' }
  const role = acpRoleFor(owner)
  if (!role) return { ok: false, reason: `CCC（${owner}）未配置 im.acp.role` }
  return { ok: true, root: owner, role }
}

/**
 * 归属候选 CCC 的**同步**缓存。
 *
 * 🔴 为什么缓存而非每次现算：`listCccs()` 是 **async**（要读 workspace registry ＋
 *    `sessionPersistence`），而 `'upgrade'` 回调是**同步**的 ⇒ 不能在那里 await。
 * ⇒ 启动时算一次 ＋ 配置变更时刷新；这是**准入名单**，宁可用稍旧的名单（新 CCC 多等一次
 *    配置事件即可生效），也不让 upgrade 挂起。
 */
let acpRoots: string[] = []

/** 刷新准入名单（**只收启用了 ACP 通道且已生成 token 的 CCC**）。返回新名单长度。 */
export async function refreshAcpRoots(ctx: Context): Promise<number> {
  try {
    const entries = await listCccs(ctx)
    const all = entries.map((e) => e.root)
    // 🔴 owner 令「**随即生成**认证用的 token」：凡启用了 ACP 通道的 CCC，若还没有 token，
    //    在这里**当场生成一枚**（幂等：已有则原样返回，不轮换）⇒ owner 配完 `im.channel=acp`
    //    即得一枚可用 token，**不必**再手敲任何命令去造它。
    //    ⚠️ 生成是**写 localstore** —— 只在"该 CCC 确实启用了 ACP"时发生（未启用的 CCC 一个字节都不动）。
    for (const root of all) {
      try {
        if (acpChannelEnabledForToken(root) && !readAcpToken(root)) {
          const token = ensureAcpToken(root)
          console.log(`[serenity-hooks] ✓ 面 E：已为 CCC 生成 ACP token（${root}，指纹 ${tokenFingerprint(token)}）`)
        }
      } catch (err) {
        console.warn(`[serenity-hooks] 面 E：为 CCC 生成 token 失败（${root}）: ${String((err as Error)?.message ?? err)}`)
      }
    }
    acpRoots = listAcpRoots(all)
  } catch (err) {
    // 枚举失败 ⇒ 名单清空（fail-closed：不保留旧名单，避免"CCC 已被移除但仍放行"）
    acpRoots = []
    console.warn(`[serenity-hooks] 面 E：CCC 准入名单刷新失败（已清空，连接将被拒）: ${String((err as Error)?.message ?? err)}`)
  }
  return acpRoots.length
}

/** 当前准入名单（诊断用只读快照） */
export function acpRootsSnapshot(): readonly string[] {
  return acpRoots
}

/**
 * 测试注入钩子（**生产零调用**）：直接置准入名单。
 *
 * ⚠️ 为什么需要：`refreshAcpRoots()` 依赖 `listCccs(ctx)`（要真 CCC 环境）。
 *    而认证闸本身是**纯逻辑**，测试要能单独驱动它 —— 否则"闸真的拦得住吗"这件事
 *    只能靠集成环境验，而集成环境恰恰是最不容易跑的那种。
 */
export function __setAcpRootsForTest(roots: readonly string[] | null): void {
  acpRoots = roots ? [...roots] : []
}

/**
 * 把**本连接归属的 CCC 角色**套到该连接创建的 agent 上（v1.59.0）。
 *
 * ## 🔴 为什么是"认领"而不是"直接挂"
 *
 * 理想形态是：在本连接的 scoped fiber 里监听 `session/created`，**只**收到本连接建的会话。
 * 但那条路依赖一个**我没有实测过的**引擎行为 —— cordis 的 `EventsService.dispatch()` 只在
 * **派发方设了 `Context.filter`** 时才按 ctx 过滤（读 `@deepseek-ai/cordis/src/events.ts`
 * 的 `.filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))`）。
 * ⇒ 若宿主派发 `session/created` 时**没设**过滤器，本监听器会**收到全进程**的会话
 * （网页端、别的轨迹、别的连接），**套错角色**。
 *
 * 🔴 **D119 纪律**：不许照源码的"意图"断言引擎行为 ⇒ 本实现**不赌**那条语义，
 * 改用**认领制**（两条过滤都可以自证，不依赖 filter）：
 *   ① **cwd 必须落在本连接归属的 CCC 内**（token 已定 CCC ⇒ 越界会话直接跳过）；
 *   ② **同一会话只被认领一次**（`claimed` 集合；先到先得 ⇒ 不会被另一条连接的监听器抢走）。
 *
 * ⚠️ **残余风险（如实标注）**：若**同一 CCC** 同时有网页端会话与 ACP 会话在创建，
 *   本函数可能把网页端那个会话也认领了（两者 cwd 都在该 CCC 内）。⇒ 判据是"cwd ＋ 先到先得"，
 *   **不是"确属本连接"**。⚠️ **这一格必须由探针实测**（见 REBUILD-TODO 的待办）；
 *   未实测前**不得**声称"只套本连接的会话"。
 *
 * 失败语义：全程不抛（本面是可选面）——角色挂不上只记日志，不阻断 ACP 接线。
 */
function bindRoleToConnScopedAgent(scoped: Context, root: string, roleName: string): void {
  try {
    const role = readSkiffRoles(root).get(roleName)
    if (!role) {
      console.warn(`[serenity-hooks] 面 E：CCC（${root}）未定义 skiff 角色 "${roleName}" ⇒ 本连接不注入角色`)
      return
    }
    // persistent 型角色：每轮动态重读提示词文件（改文件即生效，无需重连）——与微信桥同源
    const rolePrompt = createRolePromptReader(root, role)
    const claimed = new Set<string>()
    const onCreated = (session: { header?: { id?: string; cwd?: string } }): void => {
      try {
        const id = session?.header?.id
        const cwd = session?.header?.cwd
        if (!id || !cwd) return
        if (claimed.has(id)) return
        if (!cwdInsideRoot(cwd, root)) return // 越界（不属于本连接的 CCC）⇒ 不认领
        // 角色提示词段（与 skiff-core 的 `serenity-skiff` 同形：order -60，动态求值）
        const target = resolveAgentById(scoped, id)
        if (!target) return
        target.ctx.systemPrompt.section({
          name: 'serenity-skiff',
          order: -60,
          text: () => [buildSkiffBasePrompt(roleName, role), rolePrompt()].filter(Boolean).join('\n'),
        })
        claimed.add(id)
        console.log(`[serenity-hooks] ✓ 面 E：会话 ${id} 已绑定角色 "${roleName}"（CCC=${root}）`)
      } catch (err) {
        console.warn(`[serenity-hooks] 面 E：角色注入失败（不影响会话）: ${String((err as Error)?.message ?? err)}`)
      }
    }
    for (const eventName of ['session/created', 'agent/created'] as const) {
      try {
        scoped.on(eventName, onCreated as never)
      } catch {
        /* 事件通道缺失不阻断 */
      }
    }
  } catch (err) {
    console.warn(`[serenity-hooks] 面 E：角色绑定装配失败: ${String((err as Error)?.message ?? err)}`)
  }
}

/** 按会话 id 取 live agent（只读；取不到返回 undefined） */
function resolveAgentById(scoped: Context, sessionId: string): { ctx: { systemPrompt: { section: (s: { name: string; order?: number; text: () => string }) => unknown } } } | undefined {
  try {
    const agents = hostInjected<{ get?: (id: string) => unknown }>(scoped, 'agents')
    const agent = agents?.get?.(sessionId) as { ctx?: { systemPrompt?: { section?: unknown } } } | undefined
    if (!agent?.ctx?.systemPrompt || typeof agent.ctx.systemPrompt.section !== 'function') return undefined
    return agent as never
  } catch {
    return undefined
  }
}

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

/**
 * 额外**读取**的服务（`agentDefaultModel`）—— 与上面那份 `inject` **分开**，理由：
 * ① 那份是**照抄 `dsh-acp` 自己的 `inject`**（少一个就在它内部抛错），**不该混入我们的需求**；
 * ② 本项是**可选**的（服务缺失时退回旧行为，见 `resolveAcpSelection`）⇒ 让它进 `inject`
 *    会把"可选"变成"必需"（服务缺失 ⇒ 整个 fiber 挂起）。
 * ⚠️ 我们自己的插件 `inject` 里**也没有** `agentDefaultModel`（那是宿主选择面，不是我们的依赖）
 *    ⇒ 这里**用可选读取**（`ctx.get?.(...)` 语义），**不靠 inject**。
 */
const ACP_OPTIONAL_SERVICES = ['agentDefaultModel'] as const

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
  /** 🔴 被认证闸拒掉的连接数（v1.59.0；与 `connections` 分开，否则"有人在敲门"会被读成"已服务") */
  rejected: number
  lastErrors: AcpConnStat[]
  /** 每连接一次 `apply` 的析构集合（`dsh-acp` 的 `apply` 会注册 `ctx.on` ⇒ 需可回收） */
  disposers: Array<() => void>
}

function newState(): AcpFaceState {
  return { handle: null, wss: null, connections: 0, applied: 0, rejected: 0, lastErrors: [], disposers: [] }
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
  /** 🔴 被认证闸拒掉的连接数（v1.59.0）：它 > 0 说明**有人在敲门或 token 配错了** */
  rejected: number
  /** 当前准入的 CCC 数（启用了 ACP 通道 ＋ 已生成 token） */
  authorizedCccs: number
  errors: Array<{ at: number; applied: boolean; error?: string }>
  /** 🔴 认证状态一句话（v1.59.0 取代原"本面无认证"） */
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
    rejected: state.rejected,
    authorizedCccs: acpRoots.length,
    errors: [...state.lastErrors],
    authNote:
      'ACP 协议本身不做认证；本面在 WS upgrade 层以 **每 CCC 一枚 token**（localstore 键 ' +
      'IM_ACP_TOKEN）把关，未过闸的连接升不上来。⚠️ 明文 ws:// ⇒ 局域网内可抓包；上公网必须走 wss ＋ Access。',
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

    // 🔴 ③ 认证闸（v1.59.0，owner 2026-10-17 令「随即生成认证用的 token」）：
    //    **必须在 handleUpgrade 之前** —— 未过闸的连接**根本升不上来**（不是"升上来再拒"）。
    //    判据：token 无效 ／ CCC 未启用 ACP ／ 角色未配置 ⇒ 401 ＋ destroy，一次都不进 ACP。
    //    ⚠️ 为什么在这里而不在 ACP 协议层：`dsh-acp` 的 authenticate() 恒成功且无认证缝
    //      （见文件头「安全边界」与 `acp-auth.ts` 的架构决策）。
    const verdict = authorizeUpgrade(req)
    if (!verdict.ok) {
      local.rejected += 1
      local.lastErrors.push({ at: Date.now(), applied: false, error: `auth: ${verdict.reason}` })
      if (local.lastErrors.length > MAX_ERR_KEEP) local.lastErrors.shift()
      try {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'content-type: text/plain; charset=utf-8\r\n' +
            'connection: close\r\n' +
            '\r\n' +
            `ACP 面：认证失败（${verdict.reason}）。请在该 CCC 的 localstore 生成并使用 IM_ACP_TOKEN。\n`,
        )
      } catch {
        /* socket 已断 */
      }
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      console.warn(`[serenity-hooks] ✗ 面 E：拒绝一条连接（${verdict.reason}）`)
      return
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        try {
          // 该连接**归属的 CCC 与角色**（token 反查所得，服务端权威）
          const connRoot = verdict.root
          const connRole = verdict.role
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
              // 🔴 模型解析必须**在每连接时**做（而不是启动时缓存）：宿主默认模型是
              // **可变的**（`agent-default-model` 的 Config 是 `volatile` —— 用户在界面上换模型就变），
              // 而 ACP 的 `apply` 是"一连接一实例"⇒ 每连接解析一次正合适。
              const sel = resolveAcpSelection(scoped)
              // 🔴 v1.59.0：**绑 skiff 角色**（owner 令「ACP 实现就可以暴露端口并绑定 skiff」）。
              //    本连接**已由 token 确定**归属的 CCC 与角色（`connRoot`/`connRole`）⇒
              //    把该 CCC 的角色提示词套到本连接创建的 agent 上。
              //    ⚠️ 接线方式与微信桥「existing 路径」同源（`skiff-core` 的 section 注入），
              //      不接管 `dsh-acp` 的建会话（它不导出 connector —— P0′ 已实测此路不通）。
              bindRoleToConnScopedAgent(scoped, connRoot, connRole)
              dshAcp.apply(scoped, {
                stream,
                provider: sel.provider,
                model: sel.model,
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
 * 解析 ACP 会话该用的 `{provider, model}`。
 *
 * ## 🔴 为什么必须有这个函数（2026-10-16 容器实测抓出的**真缺陷**）
 *
 * 早先我们是**裸传** `provider: readAcpProvider(), model: readAcpModel()` —— 而它们读的是
 * **环境变量**，默认**未设** ⇒ 传下去就是 `undefined`。后果**不是"用默认模型"**：
 * 上游 `dsh-acp` 的 `agentOptions()`（`lib/index.js:1356-1361`）**只在字段非 undefined 时才带上**：
 * ```js
 * ...config.provider !== void 0 ? { provider: config.provider } : {},
 * ...config.model    !== void 0 ? { model: config.model }    : {}
 * ```
 * ⇒ **我们传 undefined，agent 就真的没有模型** ⇒ 第一条 `session/prompt` 必失败，逐字报：
 * `Internal error: turn failed: prompt variable "{{model}}" has no value for this assembly
 *  (section "deployment:persona-prefix")`。
 *
 * ⚠️ **网页端不中招**（它经 `agent-default-model` 层拿到默认值）⇒ **只有 ACP 这条入口坏** ——
 * 也就是说：**手机上第一条消息必然失败，而本机怎么试都正常**。
 * 🔴 这个缺陷 **typecheck ／ 2812 条单测 ／ deploy 预检 全绿**（它是运行时合成形态，
 * 静态面结构性地看不见）⇒ **只有"容器 ＋ 真模型"那一跑能抓到它**。
 *
 * ## 修法 = **读宿主自己的默认模型服务**（不另造真相源）
 *
 * 宿主暴露服务 `ctx.agentDefaultModel.currentSelection()`，其契约逐字写着
 * *"Default model selection for Agents created **without an explicit model**"*
 * （`dsh-agent-default-model/lib/types/index.d.ts`）—— 这正是"没显式指定时该用什么"的**权威出处**。
 * ⇒ 我们只是**把它转交给 ACP**，不引入第二套缺省。
 *
 * 优先级（**显式 > 宿主默认**）：`SERENITY_ACP_PROVIDER/MODEL` 环境变量（调试用）＞ 宿主默认。
 * ⚠️ **一处如实标注的弱化**：这里**不打日志**（每次连接都解析一次，打日志会刷屏）；
 * 若宿主服务缺失，**退回"两个都 undefined"＝旧行为**（即那条已知会失败的形态）——
 * 而不是静默编一个模型。⇒ 副作用是"没有默认模型时仍会失败"，但那**与宿主自身缺配置时的行为一致**。
 *
 * 🔵 **公开导出**（而非模块私有）：它是一个**纯函数 ＋ 有独立契约**的单元（本仓同类先例 =
 * `host/access.ts` 的一组读取器），且**那个真缺陷正是在它这一层**（裸传 undefined）——
 * 回归钉必须能**直接钉住它**，而不是隔着 WS 握手去间接观察（那样测不出"取到了什么"）。
 */
export function resolveAcpSelection(ctx: Context): { provider?: string; model?: string } {
  const envProvider = readAcpProvider()
  const envModel = readAcpModel()
  // 显式给了（且成对）⇒ 用它；只给一半视为不完整，继续走宿主默认
  if (envProvider && envModel) return { provider: envProvider, model: envModel }

  try {
    // 🔴 必须走 `hostInjected`（**不是**裸属性读）：本仓 v1.31.4 实证 —— 真实 cordis 的
    //    Context 是 Proxy，对**未经 `inject` 声明**的服务名直接属性读会**抛错**
    //    （`cannot get property "<name>" without inject`），异常会逃逸 ⇒ 静默回落永远走不到。
    //    而 `agentDefaultModel` 正是"我们**没**声明 inject"的（见 ACP_OPTIONAL_SERVICES 注释）。
    const svc = hostInjected<{
      currentSelection?: () => { provider?: string; model?: string } | undefined
    }>(ctx, 'agentDefaultModel')
    const sel = svc?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch {
    /* 服务缺失/契约变化 ⇒ 退回旧行为（不抛：本面是可选面，不得拖垮插件） */
  }
  return { provider: envProvider, model: envModel }
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
  // 🔴 v1.59.0：准入名单（哪些 CCC 启用了 ACP 通道）**必须先算出来** —— 认证闸是同步的，
  //    名单为空 ⇒ 所有连接一律 401（fail-closed）。配置变更时同步刷新（新增 CCC 无需重启）。
  const refresh = (): void => {
    void refreshAcpRoots(ctx).then((n) => {
      console.log(`[serenity-hooks] 面 E：CCC 准入名单已刷新（${n} 个 CCC 启用 ACP 通道）`)
    })
  }
  try {
    ctx.on('settings/document-updated', (ns: unknown) => {
      if (String(ns) === SERENITY_SETTINGS_NS) refresh()
    })
  } catch {
    /* 同上 */
  }
  refresh()
  sync()
}
