/**
 * im/channels.ts — IM 发送能力层（v1.31.0，S142 用户洞察）
 *
 * 用户原话：「既然微信桥是我们 ACC 提供的，那么 weixin-send 应该是我们 ACC 提供的能力，
 * 当用户配置了微信桥则可用，不配置则不可见」＋「设定一个复杂的多层工具，叫 im-bridge，
 * 里面有微信，然后保留后续可能兼容别的 im 的空间」。
 *
 * 分层（E↑）：
 *   `tools/im/channels.ts`（工具面：参数 → 结果渲染）
 *     → **本模块**（通道注册表 + 可见性判据 + 动作分发 + 错误码翻译）
 *       → 通道实现（`im/weixin-channel.ts`：协议/凭据/账号/记录）
 *
 * 边界（R↓）：
 * - **本模块零宿主依赖**（不 import cordis/agent）——可见性判定与分发都是纯逻辑，可独立单测。
 * - **通道只提供机制**：本模块不认识"微信"；新增 IM 只需注册一个通道实现（R3 家族式扩展）。
 * - **只能操作本会话 CCC**（R4）：`root` 由调用方（工具面）从 agent cwd 解析后传入，
 *   本模块不接受"目标 CCC"参数——跨 CCC 发送不在能力面。
 * - **记录归通道**（R5）：通道实现负责让每次发送都落既有 hook。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath, relative, isAbsolute } from 'node:path'
import { readWeixinSettings, readImSettings } from './route.js'
import { scanImContacts } from './log-scan.js'

/** 文本长度上限（微信侧单条实践上限；超限拒绝而非静默截断——与 HTTP 入口同值） */
export const IM_SEND_MAX_TEXT = 4000

/** 文件大小上限（20MB，与媒体接收上限一致） */
export const IM_FILE_MAX_BYTES = 20 * 1024 * 1024

/**
 * 通道内用户（别名 → 通道用户 id）。
 *
 * 用 **type 别名而非 interface**：interface 不获得隐式索引签名，无法赋给 `ImJson`
 * （工具返回值必须可 JSON 化 → 类型层就要挡住"不可序列化"的形状，而不是靠断言绕过）。
 */
export type ImUserEntry = {
  alias: string
  id: string
}

/** 文本发送输入（通道实现负责凭据解析与记录） */
interface ImSendInput {
  root: string
  /** 通道内用户 id（别名已由本模块解析） */
  userId: string
  text: string
  accountId?: string
}

/** 文本发送结果（与既有主动发送返回一致，便于记录/诊断） */
interface ImSendResult {
  accountId: string
  userId: string
  sessionId: string
  role: string
}

/** 文件发送输入（`data` 由本模块读盘并校验后传入——通道不碰 CCC 路径） */
interface ImSendFileInput {
  root: string
  userId: string
  data: Buffer
  fileName: string
  caption?: string
  accountId?: string
}

/**
 * 一个 IM 通道（机制插槽）。
 * `isEnabled` 是**可见性判据**：该 CCC 是否配置了这个通道。
 */
export interface ImChannel {
  /** 通道 id（工具 `channel` 参数的取值，如 `weixin`） */
  id: string
  /** 该 CCC 是否启用了本通道（缺省实现：读该通道的 CCC 配置） */
  isEnabled(root: string): boolean
  /**
   * `isEnabled` 为假时**给人看的原因与怎么改**（可选）。
   *
   * 🔴 为什么它归通道自己而不归工具面（2026-10-20 Q4 真机验收踩到）：
   * 工具面先前统一印「enable it in … (weixin.enabled)」，而**只有通道自己知道
   * "怎样才能启用我"** —— 飞书能否用不取决于 `weixin.enabled`，而取决于有没有
   * 一条启用中的飞书账号。⇒ 统一文案在第二个渠道上就成了**教一个不生效的改法**。
   * 缺省（不给）⇒ 用通用文案，说"查该渠道自己的开关／账号表"，不点名任何具体字段。
   */
  notEnabledReason?(root: string): string | undefined
  /** 别名/裸 id → 通道用户；无法解析返回 null */
  resolveUser(root: string, input: string): ImUserEntry | null
  /** 已配置别名列表（`users` 动作） */
  listUsers(root: string): ImUserEntry[]
  /** 发文本 */
  send(input: ImSendInput): Promise<ImSendResult>
  /** 发文件（可选——未实现则工具返回 `ACTION_UNSUPPORTED`） */
  sendFile?(input: ImSendFileInput): Promise<{ fileName: string; size: number }>
  /** 通道健康快照（`status` 动作）——必须可 JSON 化（工具返回值契约） */
  status(root: string): ImJson
  /**
   * 列出**与这条 CCC 有过往来的对端用户**（`contacts` 动作，2026-10-22 新增）。
   *
   * 🔴 **它存在的理由**（owner 原话：「配路由需要的是账户到轨迹，轨迹 CCC 知道，
   * 账户 CCC 不知道，需要有个能力让 CCC 查询用户配好的账户」）：
   * 路由要写 `{ user: "<通道用户 id>", trajectory: "<轨迹编码>" }`。轨迹编码 CCC 知道，
   * **但"对方是谁"它不知道** —— 那个 id 只存在于聊天记录里。
   * ⇒ 没有本动作，CCC 配路由时只能去翻日志或猜。
   *
   * ⚠️ **可选**：某通道若没有可扫的记录来源（例如未实现记录落盘），不实现即可，
   * 工具会如实返回 `ACTION_UNSUPPORTED` —— 比返回空数组好（空数组会被读成"确实没有人"）。
   */
  listContacts?(root: string): ImContact[]
}

/**
 * 一个"有过往来的对端"（`contacts` 动作的条目）。
 *
 * 字段刻意**全部可 JSON 化**（工具返回值契约），且不引用内部类型。
 */
export interface ImContact {
  /** 该对端属于哪个渠道（`weixin` / `feishu`） */
  channel: string
  /** 对端在该通道内的稳定 id（微信 `xxx@im.wechat` / 飞书 `ou_…`） */
  userId: string
  /** 收发过它的账号（本地唯一键，如 `wechat-1`）—— 多账号 CCC 靠它区分 */
  accountIds: string[]
  /** 当前路由到的轨迹编码；未配路由 ⇒ `null` */
  route: string | null
  /** 首次/最近出现时间（ISO8601；取不到为 `null`） */
  firstSeen: string | null
  lastSeen: string | null
  /** 见过的消息条数 */
  messages: number
}

const channels = new Map<string, ImChannel>()

/** 注册通道（index.ts apply 调用；重复 id 覆盖——测试与热重载友好） */
export function registerImChannel(channel: ImChannel): void {
  channels.set(channel.id, channel)
}

/** 测试辅助：清空通道注册表 */
export function __resetImChannelsForTest(): void {
  channels.clear()
}

/** 已注册通道 id（工具 `channel` 参数枚举） */
export function imChannelIds(): string[] {
  return [...channels.keys()]
}

/**
 * 可见性判据：本 CCC 是否**有任何可用的 IM 账号**。
 * 未启用 → 工具面对该 agent **不可见**（`tools.restrict` 移除，而非调用时报错）。
 *
 * ## 🔴 2026-10-22 判据修正（owner 令：「把开关升级为有任意账号即可，而不是盯着微信」）
 *
 * **旧判据** = 遍历已注册通道、任一 `channel.isEnabled(root)` 为真即可见。
 * **旧判据的缺陷**（实测于一个只配飞书的 CCC）：`feishuChannel.isEnabled()` 首行是
 * `if (settings.enabled !== true) return false` —— 总开关一关，**后面的账号判断根本不执行**
 * ⇒ 账号明明配了、`enabled:true`，却因为一个**渠道无关的总开关**被永久判成"未启用"
 * ⇒ `im-bridge` 在模型清单里彻底消失，而配置面看上去是对的（`accounts[]` 里躺着一条 feishu）。
 * 这正是 D179 的形态：**配置说它有，行为说它没有**，且零报错。
 *
 * **新判据** = **账号即事实**：`readImSettings(root).accounts` 里存在
 * 「`enabled !== false` 的账号」即视为可见。理由三条：
 * ① **可见性问的是"这个 CCC 有没有 IM 能力"**，而能力的载体是**账号**，不是总开关；
 * ② 总开关的语义是"**要不要让桥跑起来**"，把它当成可见性上限，会让"配好了但暂时不想让它跑"
 *    这种合法状态变成"工具凭空消失"；
 * ③ 判**按账号判**后，微信与飞书不再各有一套"总开关 + 账号"的双重判据 ⇒ 消除同族漂移。
 *
 * ⚠️ **不放宽的部分**：没有账号 ⇒ 仍然不可见（`accounts` 为空即 false）。
 * ⚠️ 单个通道自己的 `isEnabled` 仍是**发送/启停**判据（那是通道自己的事），
 *    只是**不再兼任**工具可见性判据 —— 两件事被这次修正分开了。
 *
 * @param root 本会话 CCC 根（由调用方解析）
 */
export function hasEnabledImChannel(root: string): boolean {
  let settings
  try {
    settings = readImSettings(root)
  } catch {
    // 判据失败按"不可见"处理会凭空夺走能力；但这里不能反过来放行——
    // 放行会让"坏配置"变成"工具在但用不了"。返回 false 由调用方决定是否告警。
    return false
  }
  const accounts = settings.accounts ?? []
  return accounts.some((a) => a.enabled !== false)
}

/**
 * 可见性判据（**轨迹级**，2026-10-23 owner 令）：
 * 这个 dsh 会话所属的认知轨迹，是否**被 IM 路由表点名**（= 它才是那个"接线人"）。
 *
 * ## 它解决的问题（owner 原话的**去标识改写**，原文含私有角色名，按 D145 不入仓库）
 *
 * > 「很多轨迹发消息给我，但是我没空回，它们就会等待我，其实并不是，我希望他们继续工作；
 * >  所以只有 IM 桥绑定了任意账户的认知轨迹才拥有 `im-bridge` 这个 tool，
 * >  这样可以确保只有一个接线角色和我联系，其它轨迹和它联系即可，它会自行回复它们的」
 *
 * ⇒ 旧判据是 **CCC 级**（{@link hasEnabledImChannel}：本 CCC 有任一启用账号 ⇒ 全体可见）。
 * 它的后果不是"少一个工具"，而是**一条错误的工作流**：每条轨迹都以为自己该直接对 owner 说话，
 * 于是发完就**停下来等人回**——而 owner 根本没空逐条回。**工具在，就把等待也带上了。**
 *
 * ## 判据（两条，缺一不可）
 *
 * 1. 本 CCC 有可用账号（{@link hasEnabledImChannel}）—— 没有账号时路由表也没有意义；
 * 2. 本会话**绑定的轨迹编码**出现在 `routes[].trajectory` 里。
 *
 * ⚠️ **为什么不看 `routes[].user`**：那是"对端是谁"（owner 的通道 id），
 *    判"这条轨迹能不能说话"只跟**轨迹**有关，与哪个对端无关。
 *
 * ⚠️ **`*` 通配也算点名**：`{ user:"*", trajectory:"<某轨迹>" }` 这条路由的含义就是
 *    "**没人认领的消息都归那条轨迹**" ⇒ 它确实是一条被授权的接线轨迹，必须算可见。
 *    这与 `matchWeixinRoute` 的通配兜底语义**同源**，不另立规则。
 *
 * ## 拿不到轨迹编码时怎么办（fail-closed，与 `exclusive` 同向）
 *
 * 会话 → 轨迹编码要读绑定。**取不到就判不可见**：
 * - 与 `exclusive`（未声明 ⇒ 隐藏）同向；
 * - 反向（取不到就放行）会让"绑定坏了"表现成"工具还在"，
 *   而那正是本判据要防的形态（D179：配置说它有、行为说它没有，且零报错）。
 * ⚠️ 代价明示：绑定读取若短暂失败，该轮会少一个工具；下一轮绑定恢复即回。
 *    这比"误给一条轨迹发消息的权限"便宜 —— 后者会让它**停下来等 owner**。
 *
 * @param root CCC 根
 * @param trajectoryCode 本会话所属认知轨迹的编码（**由调用方解析**，见 `trajectory/policy/profile.ts`）
 * @returns true = 该轨迹接线，`im-bridge` 可见
 */
export function isImWiredTrajectory(root: string, trajectoryCode: string | null | undefined): boolean {
  // ① 无轨迹归属 ⇒ 无从判断"它是不是接线人" ⇒ 不给（fail-closed）
  if (typeof trajectoryCode !== 'string' || trajectoryCode.trim() === '') return false
  // ② CCC 级前置：没有可用账号，路由表再全也没人能收
  if (!hasEnabledImChannel(root)) return false
  let settings
  try {
    settings = readImSettings(root)
  } catch {
    return false
  }
  const wanted = trajectoryCode.trim()
  for (const route of settings.routes ?? []) {
    const target = typeof route.trajectory === 'string' ? route.trajectory.trim() : ''
    if (target !== '' && target === wanted) return true
  }
  return false
}

/** 结果载荷（lossless JSON——工具返回值必须可 JSON 化） */
export type ImJson = null | boolean | number | string | ImJson[] | { [key: string]: ImJson }

/** 分发结果（工具面直接渲染；错误码稳定，便于模型与日志消费） */
type ImToolResult =
  | { ok: true; channel: string; action: string; detail: ImJson }
  | { ok: false; code: string; error: string; remediation?: string }

interface ImToolRequest {
  channel?: string
  action?: string
  user?: string
  text?: string
  file?: string
  caption?: string
  account?: string
}

/**
 * 错误码 → 可行动提示（模型视角：说清怎么改）。
 *
 * 🔴 `CHANNEL_NOT_CONFIGURED` 的提示**不能写死某一个渠道的字段名**（2026-10-20 Q4 真机验收踩到）：
 * 首版逐字写「enable it in … (weixin.enabled)」，而接第二个渠道后，**飞书能不能用不取决于
 * 这个开关**（它取决于有没有一条启用中的飞书账号）⇒ 按那句提示去改 `weixin.enabled`
 * **不会生效**，而错误码又指向"没配置" ⇒ 用户据此改完还是同一句报错。
 * ⇒ 提示按**渠道是否带自己的启用判据**分岔：带 `channelHint` 的就用它自己的说法。
 */
function remediationFor(code: string, channelHint?: string): string | undefined {
  switch (code) {
    case 'CHANNEL_UNKNOWN': return 'Use a registered channel id (see the tool description)'
    case 'CHANNEL_NOT_CONFIGURED':
      return channelHint
        ?? 'This CCC has not configured that channel — check .opencode/serenity.json (the channel\'s own enabled flag / accounts) or the settings panel'
    case 'ACTION_UNKNOWN': return 'Use send / send-file / users / status'
    case 'ACTION_UNSUPPORTED': return 'This channel does not support that action'
    case 'ALIAS_UNKNOWN': return 'Use a configured alias (see action=users) or a raw channel user id'
    case 'TEXT_REQUIRED': return 'Provide text'
    case 'TEXT_TOO_LONG': return `Shorten the text to <= ${IM_SEND_MAX_TEXT} characters`
    case 'USER_REQUIRED': return 'Provide user'
    case 'FILE_REQUIRED': return 'Provide file (a path inside this CCC)'
    case 'FILE_ESCAPE': return 'Use a path inside this CCC'
    case 'FILE_NOT_FOUND': return 'Check the path exists inside this CCC'
    case 'FILE_TOO_LARGE': return `Use a file <= ${Math.round(IM_FILE_MAX_BYTES / (1024 * 1024))} MB`
    default: return undefined
  }
}

function fail(code: string, error: string, remediation?: string): ImToolResult {
  return { ok: false, code, error, ...(remediation ?? remediationFor(code) ? { remediation: remediation ?? remediationFor(code)! } : {}) }
}

/** CCC 内文件读取（路径逃逸/缺失/超限一律拒绝，返回稳定码） */
function readCccFile(root: string, relOrAbs: string): { ok: true; data: Buffer; fileName: string } | { ok: false; code: string; error: string } {
  const abs = isAbsolute(relOrAbs) ? resolvePath(relOrAbs) : resolvePath(root, relOrAbs)
  const rel = relative(resolvePath(root), abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'FILE_ESCAPE', error: `file escapes the CCC root: ${relOrAbs}` }
  }
  if (!existsSync(abs)) return { ok: false, code: 'FILE_NOT_FOUND', error: `file not found: ${relOrAbs}` }
  let size = 0
  try {
    size = statSync(abs).size
  } catch (err) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `cannot stat file: ${relOrAbs} (${err instanceof Error ? err.message : String(err)})` }
  }
  if (size > IM_FILE_MAX_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE', error: `file is ${size} bytes (> ${IM_FILE_MAX_BYTES})` }
  }
  try {
    return { ok: true, data: readFileSync(abs), fileName: abs.split('/').pop() ?? 'file' }
  } catch (err) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `cannot read file: ${relOrAbs} (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * 执行一次 IM 动作（工具面唯一入口）。
 *
 * 顺序：通道解析 → 动作校验 → 用户解析（别名 → id）→ 输入校验 → 调用通道实现。
 * 任何一步失败都返回**稳定错误码 + 可行动提示**（不抛错——工具面统一渲染）。
 *
 * @param root 本会话 CCC 根（调用方从 agent cwd 解析；本函数不接受目标 CCC）
 * @param req 工具参数
 */
export async function runImBridge(root: string, req: ImToolRequest): Promise<ImToolResult> {
  const channelId = (req.channel ?? '').trim()
  const action = (req.action ?? '').trim()
  if (channelId === '') return fail('CHANNEL_REQUIRED', 'channel is required', 'Provide channel (e.g. "weixin")')
  const channel = channels.get(channelId)
  if (!channel) {
    return fail('CHANNEL_UNKNOWN', `unknown channel "${channelId}" (registered: ${imChannelIds().join(', ') || '(none)'})`)
  }
  if (!channel.isEnabled(root)) {
    // 🔴 提示按**通道自己**的说法给（2026-10-20 Q4 真机验收踩到）：
    //    首版写死「enable it in … (weixin.enabled)」，而飞书能不能用**不取决于那个开关**
    //    （它取决于有没有一条启用中的飞书账号）⇒ 照着改不会生效，报错却还是同一句。
    //    ⚠️ 只有通道自己知道"怎样才能启用我" —— 这就是 `notEnabledReason` 存在的原因。
    return fail(
      'CHANNEL_NOT_CONFIGURED',
      `channel "${channelId}" is not configured for this CCC (${root})`,
      channel.notEnabledReason?.(root),
    )
  }
  if (action === 'users') {
    return { ok: true, channel: channelId, action, detail: { users: channel.listUsers(root) } }
  }
  if (action === 'contacts') {
    // 🔴 2026-10-22（owner：「需要有个能力让 CCC 查询用户配好的账户」）：
    //    对端用户 id 只存在于聊天记录里 ⇒ 这里把记录读成联系人表，并与**当前路由**对账。
    //    三个输出各有用途，缺一个这个动作就只剩"列名字"：
    //      · contacts      —— 这些人是谁（含 id，供复制进 routes）
    //      · unrouted      —— ⚠️ 有往来但没配路由（**该配的**）
    //      · orphanRoutes  —— ❓ 配了路由但从没收到过消息（**id 可能写错了**，D179 同族：假入口要能被发现）
    if (!channel.listContacts) {
      return fail('ACTION_UNSUPPORTED', `channel "${channelId}" has no record source for contacts`)
    }
    const settings = readWeixinSettings(root)
    // 存量事件缺 `channel` 时按账号回填（⛔ 不按 userId 形状猜渠道）
    const accountChannel: Record<string, string> = {}
    for (const account of settings.accounts ?? []) {
      if (typeof account.accountId === 'string' && account.accountId !== '') {
        accountChannel[account.accountId] = typeof account.channel === 'string' && account.channel !== ''
          ? account.channel
          : 'weixin'
      }
    }
    const scanned = scanImContacts(root, accountChannel)
    // 只保留**本渠道**的联系人（本动作是"按渠道"提问的）
    const mine = scanned.contacts.filter((c) => c.channel === channelId)

    /** 当前路由表（`user → trajectory`）；同一 user 多条时后者覆盖 */
    const routeMap = new Map<string, string>()
    for (const route of settings.routes ?? []) {
      if (typeof route.user === 'string' && route.user !== '') {
        routeMap.set(route.user, typeof route.trajectory === 'string' ? route.trajectory : '')
      }
    }

    const contacts: ImJson[] = mine.map((c) => ({
      channel: c.channel,
      userId: c.userId,
      accountIds: c.accountIds,
      route: routeMap.get(c.userId) ?? null,
      firstSeen: c.firstSeen === null ? null : new Date(c.firstSeen).toISOString(),
      lastSeen: c.lastSeen === null ? null : new Date(c.lastSeen).toISOString(),
      messages: c.messages,
    }))
    const seenUsers = new Set(mine.map((c) => c.userId))
    // ⚠️ 有往来、但当前路由表里没有它 ⇒ 这个人的消息现在**无处可去**
    const unrouted = mine.filter((c) => !routeMap.has(c.userId)).map((c) => c.userId)
    // ❓ 配了路由、但记录里从没出现过 ⇒ 大概率 id 写错了（或从未有人发过消息）
    const orphanRoutes = [...routeMap.keys()].filter((user) => !seenUsers.has(user))

    return {
      ok: true,
      channel: channelId,
      action,
      detail: {
        contacts,
        unrouted,
        orphanRoutes,
        // 🔴 **不可省**：unrouted / orphanRoutes 是**否定性结论**，
        //    其可信度上限 = 扫描域（判据纪律）。没有它，调用方会把"日志里没有"
        //    读成"这个人不存在"。
        sources: scanned.sources,
        ...(scanned.errors.length > 0 ? { errors: scanned.errors } : {}),
      },
    }
  }
  if (action === 'status') {
    return { ok: true, channel: channelId, action, detail: channel.status(root) }
  }
  if (action === 'send') {
    const rawUser = (req.user ?? '').trim()
    if (rawUser === '') return fail('USER_REQUIRED', 'user is required')
    const text = req.text ?? ''
    if (text === '') return fail('TEXT_REQUIRED', 'text is required')
    if (text.length > IM_SEND_MAX_TEXT) return fail('TEXT_TOO_LONG', `text is ${text.length} characters (> ${IM_SEND_MAX_TEXT})`)
    const resolved = channel.resolveUser(root, rawUser)
    if (!resolved) return fail('ALIAS_UNKNOWN', `unknown user "${rawUser}"`)
    try {
      const sent = await channel.send({ root, userId: resolved.id, text, accountId: req.account })
      return { ok: true, channel: channelId, action, detail: { ...sent, user: resolved.alias ?? resolved.id } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail('SEND_FAILED', message)
    }
  }
  if (action === 'send-file') {
    if (!channel.sendFile) return fail('ACTION_UNSUPPORTED', `channel "${channelId}" does not support send-file`)
    const rawUser = (req.user ?? '').trim()
    if (rawUser === '') return fail('USER_REQUIRED', 'user is required')
    const fileArg = (req.file ?? '').trim()
    if (fileArg === '') return fail('FILE_REQUIRED', 'file is required')
    const resolved = channel.resolveUser(root, rawUser)
    if (!resolved) return fail('ALIAS_UNKNOWN', `unknown user "${rawUser}"`)
    const file = readCccFile(root, fileArg)
    if (!file.ok) return fail(file.code, file.error)
    try {
      const sent = await channel.sendFile({
        root,
        userId: resolved.id,
        data: file.data,
        fileName: file.fileName,
        caption: req.caption,
        accountId: req.account,
      })
      return { ok: true, channel: channelId, action, detail: { ...sent, user: resolved.alias ?? resolved.id } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail('SEND_FAILED', message)
    }
  }
  return fail('ACTION_UNKNOWN', `unknown action "${action}"`)
}
