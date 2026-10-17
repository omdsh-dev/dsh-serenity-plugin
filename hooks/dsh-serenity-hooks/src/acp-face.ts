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
import { isAbsolute } from 'node:path'
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
import { extractToken, resolveTokenAccount, listAcpRoots, cwdInsideRoot, ensureAcpChannelTokens, readAcpMainSession, writeAcpMainSession } from './acp-auth.js'
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
  | { ok: true; root: string; role: string; accountId: string }
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
  // 🔴 v1.59.1：**不再读快照**，每次判定现算（`expandAcpAccounts` 只读配置 ＋ localstore）。
  //    原先 `acpRoots` 是模块级快照，只由「宿主 settings 事件 ＋ 启动那次」刷新，
  //    而 `im.channel` 在 **CCC 自己的** `.opencode/serenity.json` 里 —— 那个文件
  //    **从不在** `settings/document-updated` 的事件面上 ⇒ 改配置永远不触发刷新，
  //    **只能重启宿主**。owner 判「这是设计缺陷」，实测代价 = 每加一台设备都要重启。
  //    ⇒ 判据：**准入名单必须与被读的那个文件同源现算**，否则就是一份会漂的缓存。
  const roots = knownAcpRoots()
  if (roots.length === 0) return { ok: false, reason: '本机没有任何启用了 ACP 通道的 CCC' }
  // 先判"token 认不认"（与"CCC 没配好"分开报，否则排障时会被误导到错的方向）
  const acct = resolveTokenAccount(candidate, roots)
  if (!acct) return { ok: false, reason: 'token 不匹配任何已声明账户的 ACP 通道' }
  const role = acct.role
  if (!role) return { ok: false, reason: `CCC（${acct.root}）账户 ${acct.accountId} 未配 im.acp.accounts[].role` }
  return { ok: true, root: acct.root, role, accountId: acct.accountId }
}

/**
 * CCC 根候选的来源（**只要根，不判配置**）。
 *
 * 🔴 v1.59.1 分层变更：**这份名单是"本机有哪些 CCC"，不是"谁能连 ACP"**。
 *    "谁能连"由 `expandAcpAccounts` 现算（读各 CCC 的 serenity.json ＋ localstore）。
 *    ⇒ 缓存失效的代价从"配错权限"降为"多看/少看一个候选根"，**不再是安全问题**。
 */
let knownRoots: string[] = []

/**
 * 准入名单的现算入口（v1.59.1）。
 *
 * 顺序：**先用已知根**（免 async）→ 逐个 `expandAcpAccounts` 现读配置。
 * 未知根时退回上次枚举的结果（可能稍旧，但只影响"会不会去问它"，不影响是否放行）。
 *
 * ⚠️ 这里是**同步**的（upgrade 回调用）⇒ 不 await、不扫盘。
 */
function knownAcpRoots(): string[] {
  return listAcpRoots(knownRoots)
}

/**
 * 刷新"本机有哪些 CCC"（async，枚举宿主三来源）。
 *
 * 🔴 **失败必须响亮**：v1.59.0 这里是 `void refresh(...)` 且没有 catch ——
 *    枚举失败会让名单清空 ⇒ **所有连接一律 401**，而现场只有一行 stdout 看不到的日志。
 *    这正是本轨记过的「调用没报错 ≠ 已验证」。
 *
 * @returns 本次枚举到的根数（0 ＝ 一个都没发现，日志会说为什么）
 */
export async function refreshAcpRoots(ctx: Context): Promise<number> {
  try {
    const entries = await listCccs(ctx)
    knownRoots = entries.map((e) => e.root)
    // owner 令「随即生成认证用的 token」：对**已声明**的账户补齐 token（幂等，不轮换）。
    let created = 0
    for (const root of knownRoots) {
      try {
        created += ensureAcpChannelTokens(root).length
      } catch (err) {
        console.warn(`[serenity-hooks] 面 E：为 CCC（${root}）生成 token 失败: ${String((err as Error)?.message ?? err)}`)
      }
    }
    if (created > 0) console.log(`[serenity-hooks] ✓ 面 E：已为 ${created} 个 ACP 账户生成 token`)
    return knownRoots.length
  } catch (err) {
    // 枚举失败 ⇒ 清空候选（fail-closed），但**响亮**记录原因，供 acpFaceStatus 读取。
    knownRoots = []
    const msg = `面 E：CCC 枚举失败（准入名单将为空，所有连接会被拒）: ${String((err as Error)?.message ?? err)}`
    console.warn(`[serenity-hooks] ${msg}`)
    state.lastErrors.push({ at: Date.now(), applied: false, error: msg })
    if (state.lastErrors.length > MAX_ERR_KEEP) state.lastErrors.shift()
    return 0
  }
}

/** 当前准入名单（诊断用只读快照；**现算**，不是缓存值） */
export function acpRootsSnapshot(): readonly string[] {
  return knownAcpRoots()
}

/**
 * 测试注入钩子（**生产零调用**）：直接置"本机有哪些 CCC 候选根"。
 *
 * ⚠️ 为什么需要：`refreshAcpRoots()` 依赖 `listCccs(ctx)`（要真 CCC 环境）。
 *    而认证闸本身是**纯逻辑**，测试要能单独驱动它 —— 否则"闸真的拦得住吗"这件事
 *    只能靠集成环境验，而集成环境恰恰是最不容易跑的那种。
 *
 * 🔴 v1.59.1：**置的是候选根，不是"放行名单"** —— 每个根会不会被放行，
 *    仍由它自己的 `serenity.json` ＋ localstore **现算**决定（测试照样要走真配置）。
 */
export function __setAcpRootsForTest(roots: readonly string[] | null): void {
  knownRoots = roots ? [...roots] : []
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
 * 把客户端给的 `cwd` 归一化成宿主要求的**绝对路径**（v1.59.1）。
 *
 * ## 为什么需要
 * 宿主 `dsh-acp` 在每次 `session/new` 都有这一行（`lib/index.js` 逐字）：
 * ```js
 * if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
 * ```
 * 而**连接归属哪个 CCC 已由 token 决定**（服务端权威）⇒ 让用户再手打一遍绝对路径
 * 是**同一个信息说两遍**，且那第二遍正是最容易打错的一遍。
 *
 * ## 规则（唯一一条）
 * **非绝对路径 ⇒ 一律解释为「本连接归属 CCC 的根」**。
 *
 * | 客户端填 | 送宿主 |
 * |---|---|
 * | `serenity` / `a` / `.` / 空 | `/…/home-serenity`（该 token 的 CCC 根） |
 * | `/…/home-serenity`（已绝对且在根内） | 原样 |
 * | `/…/home-serenity/sub` | 原样（仍在根内） |
 * | `/etc`（绝对但在根外） | **原样透传，交给 `cwdInsideRoot` 拒** |
 *
 * 🔴 **最后一行为什么不在这里直接拒**：越权判据必须**只有一处**（`cwdInsideRoot`，
 * 它也管着角色认领），在这里再判一次就是**两份会漂的实现**。归一化只负责"把非绝对变成绝对"。
 *
 * @param raw 客户端原样给的 `cwd`（可能是 `undefined`）
 * @param cccRoot 本连接归属的 CCC 根
 */
export function normalizeClientCwd(raw: unknown, cccRoot: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  // 空 ／ 非绝对 ⇒ 一律落到 CCC 根（"就是那个 CCC"，不必再问）
  if (value === '' || !isAbsolute(value)) return cccRoot
  return value
}

/**
 * 把一条裸 WS socket 适配成 ACP `Stream`。
 *
 * 🔴 与官方 `ndJsonStream` **同语义**：我们自己做「消息 ↔ 文本帧」的分帧（按行）。
 *    实测注意（P0′）：`dsh-acp` 写出的每条消息**自带换行**，客户端同样 ⇒ 按行切分即正确。
 *    ⚠️ **空行要丢**；**非 JSON 帧要容忍**（桥/客户端可能插入控制帧）。
 *
 * 🔴 v1.59.1：**入站消息在这里做一次 `cwd` 归一化**（见 {@link normalizeClientCwd}）。
 *    为什么是这里：`session/new` 与 `session/resume` 都带 `cwd`，而这是**唯一**能同时
 *    拦到两者、且属于我们自己的缝（再往下就进 `dsh-acp` 了，那里改了就是改宿主）。
 *
 * 🔴 v1.59.2：这条缝同时承担 **owner「每账户固定一条长期对话」** 的双向改写 ——
 *    入站 `recordAcpPending`（记 id→method）＋ 出站 `rewriteAcpResponse`（收窄 list ／ 记 new）。
 *    ⚠️ 两件事都必须在**同一个** `ws` 上做：`pending` 是**每条连接一份**的，
 *    拆到两处会让它失去"这条连接上请求与响应配对"这个唯一用途。
 *
 * @param cccRoot 本连接归属的 CCC 根（token 反查所得）
 * @param accountId 本连接归属的账户键（主会话键由它派生）
 */
function wsToAcpStream(ws: WebSocket, onWarn: (line: string) => void, cccRoot: string, accountId: string): AcpStream {
  const pin = createAcpSessionPin(cccRoot, accountId)
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
          let msg: unknown
          try {
            msg = JSON.parse(line)
          } catch {
            // 非 JSON 帧：记一条（对本面是"别人的噪音"），不中断本流
            onWarn(line.slice(0, 120))
            continue
          }
          // 先记账（找的是 `method`），再归一化（改的是 `params.cwd`）——**顺序不能反**：
          // 记账只认请求的 `method`，归一化只认白名单方法的 `params`，两者互不依赖，
          // 但先记能保证"任何被归一化的请求都已被记账"。
          recordAcpPending(pin, msg)
          controller.enqueue(normalizeInboundCwd(msg, cccRoot))
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
      // 🔴 owner「每账户固定一条」的**落点**：出站这一行原来是纯透传。
      ws.send(`${JSON.stringify(rewriteAcpResponse(pin, msg))}\n`)
    },
  })
  // 断言的理由：`Stream` 的元素类型是官方的 `AnyMessage`（JSON-RPC 消息联合体），
  // 而我们这里的分帧口径就是"按行 JSON.parse ⇒ 消息"（与官方 `ndJsonStream` 同语义）
  // ⇒ 形状一致，差异只在 `unknown` 与 `AnyMessage` 的**静态**标注上。
  return { readable, writable } as AcpStream
}

/**
 * 需要把 `cwd` 钉到本连接 CCC 根的方法（**必须逐个列出**）。
 *
 * 🔴 **v1.59.1 的第一版判据错了**：只判「params 里有没有 `cwd`」⇒ 漏掉 `session/list`。
 *    宿主 `listSessions` 的过滤是
 *    `if (params.cwd !== void 0 && !sameDirectory(header.cwd, params.cwd)) return`
 *    —— **不给 cwd 就返回全机器所有会话**。实测后果：手机 App 列表里冒出
 *    23 条别的 CCC 的会话，全部显示为 `UNKNOWN` ／ `New Chat`
 *    （owner：「**我需要是指定CCC的，不然没办法用**」）。
 * ⇒ 🆕 **判据：凡"应当被 CCC 收窄"的读接口，都必须把 `cwd` 钉成 CCC 根，不能依赖客户端传** ——
 *    token 已经定了 CCC，让客户端再声明一次既冗余、又可以被静默漏掉。
 */
const CWD_PINNED_METHODS = new Set(['session/new', 'session/resume', 'session/list'])

/**
 * 把一条入站消息的 `cwd` 归一化（**含"没给就补上"**）。
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 方法不在 {@link CWD_PINNED_METHODS} | 原样（不碰别的消息） |
 * | 给了非绝对路径（`serenity` ／ `a` ／ 空串） | → 本连接 CCC 根 |
 * | 给了绝对路径 | 原样（越界由 `cwdInsideRoot` 拒） |
 * | **压根没给**（`session/list` 常见） | **→ 本连接 CCC 根**（否则列出全机器） |
 */
function normalizeInboundCwd(msg: unknown, cccRoot: string): unknown {
  if (typeof msg !== 'object' || msg === null) return msg
  const m = msg as { method?: unknown; params?: unknown }
  if (typeof m.method !== 'string' || !CWD_PINNED_METHODS.has(m.method)) return msg
  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as { cwd?: unknown }
  // 不就地改原对象（它来自 JSON.parse，理论上是我们的，但改副本更安全、也更易测）
  return { ...msg, params: { ...params, cwd: normalizeClientCwd(params.cwd, cccRoot) } }
}

// ── 「每账户固定一条长期对话」（v1.59.2；owner 逐字裁决）─────────────────────────────
//
// owner 原话：「我只是希望用 ACP 和指定的会话来进行通信 …… 我只想和指定 skiff 通信」
// ⇒ 选定形态：**每个 ACP 账户 = 与该账户角色绑定的一个长期对话**（角色由 `im.acp.accounts[].role` 定）。
//
// ## 为什么必须在**这条缝**里做（而不是改宿主）
//
// 宿主 `dsh-acp` 的 `listSessions` 是**存量全列**（`lib/index.js` 逐字：
// `const listed = await persistence.list({ signal })`，仅按 `cwd` 过滤 ＋ 分页），
// 而 `SessionInfo` 只有 `{sessionId, cwd}`（**协议里没有 title**，`_meta` 是唯一扩展位，
// 客户端读不读不由我们定）⇒ **靠标题做"我的那条"不可靠**。D4 零改宿主
// ⇒ 只能在"我们自己的缝"（WS 帧 ↔ ACP Stream）做**出站改写**。
//
// ## 🔴 出站改写的核心难点：响应里只有 `id`，没有方法名
//
// ACP 的响应是 `{id, result}` / `{id, error}` —— **它不说自己回答的是哪个请求**。
// 而"要不要改写"完全取决于那个方法（`session/list` 要收窄、`session/new` 要记录）。
// ⇒ 唯一解：**入站时记账**（`pending: id → method`），出站时**凭 id 反查**。
// ⛔ 被否：按响应形状猜方法（`{sessions}` 猜 list）—— 那是把"形状巧合"当契约，
//    上游加一个同样带 `sessions` 的响应就静默改错。

/**
 * 一条连接的**会话钉住**状态（owner「每账户固定一条」的执行单元）。
 *
 * 生命周期 = 一条 WS 连接。⚠️ **跨连接的真相在 localstore**（`IM_ACP_SESSION_<ACCOUNT_ID>`）；
 * 本结构只是"这条连接上，请求 id 对应哪个方法"的记账 + 那两个方法的处理口径。
 */
interface AcpSessionPin {
  /** 本连接归属的 CCC 根（合成 `SessionInfo.cwd` 时用 —— 那也是我们当初钉的值） */
  root: string
  /** 本连接归属的账户（主会话键由它派生） */
  accountId: string
  /** 在飞的请求：`id` → 方法名（**出站改写唯一的方法来源**） */
  pending: Map<string, string>
}

/** 请求 id 的 Map 键（区分 `1` 与 `"1"` —— JSON-RPC 允许两者，混用也不该串号） */
function requestIdKey(id: unknown): string {
  return `${typeof id}:${String(id)}`
}

/** 记账上限（防"客户端发一堆请求又从不收响应"把内存撑大） */
const MAX_PENDING = 256

/** 建一条连接的钉住状态 */
export function createAcpSessionPin(root: string, accountId: string): AcpSessionPin {
  return { root, accountId, pending: new Map() }
}

/**
 * 入站记账：把"这条请求的方法"记住，供出站按 `id` 反查。
 *
 * 判据：**既要有 `id`，又要有 `method`** —— 只满足一个的是响应（`id` 无 `method`）
 * 或通知（`method` 无 `id`）⇒ 与我们无关，不记。
 */
export function recordAcpPending(pin: AcpSessionPin, msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return
  const m = msg as { id?: unknown; method?: unknown }
  if (m.id === undefined || m.id === null) return
  if (typeof m.method !== 'string') return
  const key = requestIdKey(m.id)
  pin.pending.set(key, m.method)
  // 溢出时丢最旧的（Map 保序）——**丢旧不丢新**：新请求更可能是"正在等着的那个"
  while (pin.pending.size > MAX_PENDING) {
    const oldest = pin.pending.keys().next()
    if (oldest.done) break
    pin.pending.delete(oldest.value)
  }
}

/**
 * 出站改写（本功能的落点）。返回**要发给客户端的那条消息**。
 *
 * | 原响应 | 改写后 |
 * |---|---|
 * | `session/list` | `{sessions:[该账户那一条]}`；**没有主会话 ⇒ `{sessions:[]}`** |
 * | `session/new` | 原样，**同时**把 `result.sessionId` 记为该账户的主会话 |
 * | 其余（含所有 error 响应、所有通知） | 原样 |
 *
 * 🔴 **没有主会话时回空数组，绝不回退成全量列表** —— 退回去正是 owner 说
 *    「23 个对我没什么用」的那个东西。空数组会让 App 引导用户新建，而新建即建立主会话。
 *
 * 🔴 `nextCursor` **一律丢掉**：收窄到一条之后，分页游标失去意义；
 *    留着它会让客户端继续翻页（而后续页仍会被收窄成同一条 ⇒ 前端可能出现重复项）。
 */
export function rewriteAcpResponse(pin: AcpSessionPin, msg: unknown): unknown {
  if (typeof msg !== 'object' || msg === null) return msg
  const m = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
  if (m.method !== undefined) return msg // 通知（`session/update` 等）：不碰
  const method = m.id === undefined || m.id === null ? undefined : pin.pending.get(requestIdKey(m.id))
  if (method === undefined) return msg // 账上没有 ⇒ 不是我们关心的请求
  if (m.error !== undefined) return msg // 失败的请求不记主会话、不收窄列表

  if (method === 'session/new') {
    const sessionId = (m.result as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      try {
        writeAcpMainSession(pin.root, pin.accountId, sessionId)
      } catch (err) {
        // 写失败**不改写响应**：会话已经建好了，客户端该拿到它。
        // ⚠️ 但必须响亮 —— 否则表现是"每次重连都多一条会话"，且无人知道为什么。
        console.warn(
          `[serenity-hooks] ⚠ 面 E：记录主会话失败（CCC=${pin.root} 账户=${pin.accountId}）: ${String((err as Error)?.message ?? err)}`,
        )
      }
    }
    return msg
  }

  if (method === 'session/list') {
    const pinned = readAcpMainSession(pin.root, pin.accountId)
    if (!pinned) return { ...m, result: { sessions: [] } }
    const list = (m.result as { sessions?: unknown } | undefined)?.sessions
    const hit = Array.isArray(list)
      ? list.find((s) => (s as { sessionId?: unknown } | null)?.sessionId === pinned)
      : undefined
    // 命中就**原样保留宿主给的那条**（它可能带 title/updatedAt）；未命中则合成最小形态。
    //
    // 🔴 **为什么"未命中"不等于"没有"**：宿主 `listSessions` 会**跳过本进程内已活跃的会话**
    //    （其 `sessions.has(header.id) || activating.has(...) || ctx.sessions.get(...)` 那条 return）
    //    ⇒ 刚建完就列表的同一条连接**必然看不到它**。若这里回空数组，用户会看到
    //    "刚聊的对话消失了"并可再建一条 —— 那正是要消灭的东西。
    //    合成值不是编造：`{sessionId, cwd}` 两项都是**我们当初自己钉的**
    //    （`cwd` 由 `normalizeClientCwd` 钉成 `pin.root`），而 `SessionInfo` 只要求这两项。
    const sessions = hit !== undefined ? [hit] : [{ sessionId: pinned, cwd: pin.root }]
    return { ...m, result: { sessions } }
  }

  return msg
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
  const roots = knownAcpRoots()
  return {
    active: acpFaceActive(),
    port: acpFacePort(),
    host: ACP_HOST,
    enabled: acpFaceEnabled(),
    connections: state.connections,
    applied: state.applied,
    rejected: state.rejected,
    authorizedCccs: roots.length,
    errors: [...state.lastErrors],
    authNote:
      'ACP 协议本身不做认证；本面在 WS upgrade 层以 **每账户一枚 token**（localstore 键 ' +
      'IM_ACP_TOKEN_<ACCOUNT_ID>）把关，未过闸的连接升不上来。名单**每次连接现算**（改配置即生效，无需重启）。' +
      '⚠️ 明文 ws:// ⇒ 局域网内可抓包；上公网必须走 wss ＋ Access。',
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
          const connAccount = verdict.accountId
          const stream = wsToAcpStream(ws, (line) => {
            console.log(`[serenity-hooks] 面 E：丢弃一条非 JSON 帧（前 120 字）: ${line}`)
          }, connRoot, connAccount)
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
  // 🔴 v1.59.1：刷新"本机有哪些 CCC 候选根"（只影响"会不会去问它"，不影响是否放行）。
  //    ⚠️ 这个刷新**不再是权限的正确性来源** —— 放行与否由每次连接现算配置决定。
  //    所以即使这里漏了一次（例如新 CCC 尚未被枚举到），代价也只是"暂不认它"，
  //    而**不是**"配了却要重启"。失败要响亮（见 refreshAcpRoots 的 catch）。
  const refresh = (): void => {
    void refreshAcpRoots(ctx).then((n) => {
      console.log(`[serenity-hooks] 面 E：CCC 候选根已枚举（${n} 个）`)
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
