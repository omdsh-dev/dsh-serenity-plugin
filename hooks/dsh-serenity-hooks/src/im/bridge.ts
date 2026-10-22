/**
 * im/bridge.ts — 微信桥装配（F4c-3，v1.27.0 实验性）
 *
 * **CCC 级**：dsh 一个进程含多个 CCC，每个 CCC 独立对接微信桥（S142 用户拍板）——
 * 扫描 live CCC → 每 CCC 读 weixin 配置（enabled + accounts + routes）→
 * 启动该 CCC 该账号的 iLink 轮询循环。消息 → weixin-route 路由 → 轨迹约束核心直调
 * （session/new + session/prompt，同进程不经网络）。
 *
 * 🔴 **一处陈旧注释的更正（2026-10-15，随面 E 退役一并核实）**：本行原写「→ **AcpServer 直调**
 * （…——acp-core 传输无关设计）」。**该描述从来不是事实** —— 实测 grep 全仓：本文件**从不**
 * `import acp-core`（它 import 的是 `trajectory-session` / `trajectory-constraint` / `weixin-*`），
 * 而 `acp-core` 的消费者**自始至终只有两个**（`acp-http.ts` ＋ 其测试）。
 * ⇒ 当年那句是**设计意图的误记**，不是依赖关系；面 E 退役后它更是彻底失效。
 * 🔵 判据复述：**注释里的"设计意图"不能当依赖判据**，必须 grep import。
 *
 * 实验性质：未配置/未启用 → 完全不启动（零资源占用）。配置变化（面板写入）
 * → 热重建受影响 CCC 的桥（对齐 gateway 热重建模式）。
 *
 * 🔴 **P0-2（2026-09-27，方案 §2.6）：起桥仍按 CCC，但"谁轮询"按账号判定** ——
 * 同一个账号（= 同一份凭据）在同一时刻**只允许一个 poller**，判定与归属表在
 * `im/inbound.ts`（机器级机制；本文件只接线）。这是"微信桥上移 ACC 层"的第一步。
 *
 * 外部面纯净（D9/D11 延续）：微信桥会话 = 外部面——session/prompt 走
 * includeCognitiveTrajectory:false（对外不返回轨迹）；轨迹约束角色白名单即授权（G9）。
 */

import type { Context } from 'cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readCheapWorkerConfig } from '../kernel/ccc.js'
// P0-2（方案 §2.6）：机器级归属判定（一账号一 poller）—— 机制在 im/inbound.ts，本文件只接线
// P0-3（方案 §11.4）：订阅表 ＋ 路由 ＋ 机器级留痕 —— 同上，机制在 im/inbound.ts
import {
  accountIdentity, planPollerClaims, commitPollerClaims, releasePollersOf, releaseAllPollers, pollerOwners, type PollerRequest,
  appendHumanChannelAudit,
} from './inbound.js'
// 机器级配置的**唯一读取入口**（P0-1 起 `humanChannel` 随它一起出）⇒ 天然热生效（方案 Q8）
import { readSimpleSettings, type HumanChannelSettings } from '../surface/settings.js'
import { readWeixinSettings, readWeixinCredential, readFeishuCredential, weixinSessionIdForTrajectory, matchWeixinRoute, extractWeixinText, hasVoiceItem, extractWeixinMedia, sanitizeFileName, type WeixinAccountCredential } from './route.js'
import { getUpdates, sendTextMessage, getConfig, sendTyping, TypingStatus, downloadMedia, sniffImageExt, markdownToPlainText, type WeixinMessage } from './ilink.js'
import { getTrajectoryAgent, askTrajectory, workspaceCognitiveTrajectoryLine, ensureWorkspacePromptSection, trajectoryWorkspaceMdPath } from '../trajectory/session.js'
import { noteManualOutputSession, forgetManualOutputSession, clearSentThisTurn, hasSentThisTurn, isWeixinOutputGuardActive } from './guard.js'
import { getActiveSessionInfo } from '../trajectory/core.js'
import { invokeWeixinHook, buildOutgoingHookEvent } from './hook.js'
import { getImAccountImpl, imAccountChannels, normalizeAccountChannel, type ImAccountCredential, type ImAccountImpl } from './accounts.js'
import { installWeixinAccountImpl } from './weixin-account.js'
import { installFeishuAccountImpl } from './feishu-account.js'
import {
  handleInboundEvent, resolveInboundTarget, manualOutputMarker, manualOutputFallbackNeeded,
  type ImInboundEvent, type ImAccountIo, type ResolvedInboundTarget,
} from './inbound-event.js'

export { manualOutputFallbackNeeded, resolveInboundTarget }
export type { ResolvedInboundTarget }

/** 运行中的桥（CCC 根 → 账号 id → 循环控制） */
interface AccountLoop {
  /** 停止信号（dispose 时置 true；循环每轮检查） */
  stopped: boolean
  /** 最近轮询开始时间（状态面板用） */
  lastPollAt: number
  /** 最近错误（状态面板用） */
  lastError?: string
}

interface CccBridge {
  root: string
  /** 账号 id → 循环 */
  loops: Map<string, AccountLoop>
}

const bridges = new Map<string, CccBridge>()

/**
 * 🔴 **机器级 poller 的"根"哨兵**（P0-3 A）—— 它**不是一个目录**。
 *
 * 机器级 poller **不属于任何 CCC**（这正是"上移 ACC 层"的含义：谁轮询不再由 CCC 数量决定）。
 * 用途有二：① `runAccountLoop` 的 `root` 形参在机器级模式下不被使用，传它以示"无根"；
 * ② 归属表（`im/inbound.ts`）按 root 区分拥有者 ⇒ 机器级用这个哨兵值，
 *    与任何**真实** CCC 根都不会撞（真根一律是绝对路径）。
 */
const MACHINE_SCOPE = '<machine>'

/** 机器级 poller（账号 id → 循环）。与 `bridges` **互斥**：同一时刻只有一种模式在跑。 */
const machineLoops = new Map<string, AccountLoop>()

/** 轮询间隔（getupdates 失败后重试延迟；成功 = 立即续轮询） */
const POLL_RETRY_MS = 3_000

/** 媒体大小上限（M6：20MB，对齐 vlm-describe；超限降级告知不落盘） */
const MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** typing_ticket 缓存（每 (accountId, fromUserId)；getconfig 一次后续复用——对齐参考实现 typingTicketCache） */
const typingTicketByUser = new Map<string, string>()

/**
 * 🔴 **最近一次 `context_token` 缓存**（每 `(accountId, userId)`）—— 2026-10-21，owner 报
 * 「久不在微信发言，认知轨迹主动发消息就不通」。
 *
 * ## 为什么必须有它（协议规范，不是我们的发明）
 *
 * 微信 iLink 协议的 `context_token` **不是"用户 ID"**，而是
 * **「当前对话上下文的会话能力令牌」**（[公开协议规范] §5.10）。规范逐字：
 *
 * - **文本回复：必填。图片/文件/视频回复：必填。**（§6.4）
 * - 「以 `(accountId, userId)` 为 key **缓存最近一次 `context_token`**」（§5.10 工程建议）
 * - 「**主动发消息能力**：公开实现普遍依赖**最近一次入站消息**带来的 `context_token`」（§12 对比表）
 *   —— 这是微信相对 Telegram/Slack 的**根本差异**（那两家只要知道 chat_id 就行）。
 * - 「协议里**未观察到**单独"打开会话"的 API」（§5.10）⇒ **没有任何办法主动"开一个会话"**，
 *   只能靠人发一条消息来刷新这张票。
 *
 * ## 🔴 修前我们是什么状态
 *
 * 收到 token 后**只用一次就丢**（唯一消费点是"回复这一条消息"）⇒ 那条回复发完，
 * 手上就**再没有票**了 ⇒ 之后任何**主动**发送都是裸发（不带 `context_token`）。
 * ⇒ 这与 owner 的观察完全吻合：**刚聊过就通**（票还在窗口内/刚被刷新），**隔久了就不通**。
 * ⚠️ 这**不是心跳问题** —— 规范里根本没有心跳；是**票没留住**。
 *
 * ## 边界（照规范原话）
 *
 * - **不跨用户复用、不跨 bot 账号复用**（key 含 accountId 与 userId 两段）。
 * - **不伪造 token**：只存服务端真给过的。
 * - **进程重启即丢失**（内存缓存）——规范也确认这条，因为**没有开新会话的 API**；
 *   重启后的第一条主动消息仍可能失败，这是**平台限制**，由 O3 的失败文案如实告知。
 */
const contextTokenByUser = new Map<string, string>()

/** context_token 的缓存键（与 typing 同款两段式，但**语义不同**：这里存的是会话票） */
function contextCacheKey(accountId: string, userId: string): string {
  return `${accountId}|${userId}`
}

/** 记下最近一次入站带来的 `context_token`（**只存非空**；空串会把好票覆盖成坏票） */
export function rememberContextToken(accountId: string, userId: string, token: string | undefined): void {
  if (!userId) return
  const t = (token ?? '').trim()
  if (t === '') return
  contextTokenByUser.set(contextCacheKey(accountId, userId), t)
}

/** 取该用户最近一次的 `context_token`（没有 ⇒ `undefined`，调用方按"裸发"处理并如实回执） */
export function recallContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenByUser.get(contextCacheKey(accountId, userId))
}

/** 测试辅助：清空 context_token 缓存（生产零调用；与 resetWeixinTypingCache 同款） */
export function resetWeixinContextCache(): void {
  contextTokenByUser.clear()
}

function typingCacheKey(accountId: string, fromUserId: string): string {
  return `${accountId}|${fromUserId}`
}

/** 处理开始：getconfig（无缓存时）→ sendtyping status=1（微信侧显示"正在输入..."）。
 *  任何失败静默（typing 不影响主流程——对齐参考实现 typingCallbacks try/catch 吞错）。 */
async function sendTypingStart(cred: WeixinAccountCredential, accountId: string, fromUserId: string, contextToken?: string): Promise<void> {
  try {
    const key = typingCacheKey(accountId, fromUserId)
    let ticket = typingTicketByUser.get(key)
    if (!ticket) {
      const configResp = await getConfig({
        baseUrl: cred.baseUrl,
        token: cred.token,
        ilinkUserId: fromUserId,
        contextToken: contextToken ?? '',
      })
      ticket = configResp.typing_ticket
      if (ticket) typingTicketByUser.set(key, ticket)
    }
    if (!ticket) return
    await sendTyping({ baseUrl: cred.baseUrl, token: cred.token, ilinkUserId: fromUserId, typingTicket: ticket, status: TypingStatus.TYPING })
  } catch (err) {
    console.log(`[serenity-hooks] weixin-bridge typing start skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 处理结束（含异常路径 finally）：sendtyping status=0；缓存保留（ticket 可复用）。 */
async function sendTypingStop(cred: WeixinAccountCredential, accountId: string, fromUserId: string): Promise<void> {
  try {
    const ticket = typingTicketByUser.get(typingCacheKey(accountId, fromUserId))
    if (!ticket) return
    await sendTyping({ baseUrl: cred.baseUrl, token: cred.token, ilinkUserId: fromUserId, typingTicket: ticket, status: TypingStatus.CANCEL })
  } catch (err) {
    console.log(`[serenity-hooks] weixin-bridge typing stop skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 测试辅助：清空 typing_ticket 缓存（生产零调用） */
export function resetWeixinTypingCache(): void {
  typingTicketByUser.clear()
}

/**
 * 🔴 **2026-10-19（P2）`runAccountLoop` 已迁出本文件** —— 逐字搬到
 * `im/weixin-account.ts`，成为 `ImAccountImpl` 的一个实现（微信）。
 *
 * 为什么搬：装配处原先把渠道写死在这里（`channel !== 'weixin'` ⇒ 跳过）。
 * owner 定向「飞书和微信一样，只不过是 account 方实现不同」⇒ 起循环这个动作
 * 归**账号自己的实现**，装配处只按 `channel` 查派发表。
 * ⚠️ 依赖（`getUpdates` / `handleIncoming` / `handleMachineIncoming`）通过
 * `installWeixinAccountImpl` **注入**，避免 `bridge ⇄ weixin-account` 互相 import 成环。
 */

/**
 * 处理单条**微信**消息：把 iLink 形状的 `msg` 归一成**中立入站事件**，
 * 再交给通道中立的 `handleInboundEvent`（`im/inbound-event.ts`）走主流程。
 *
 * ## 🔴 2026-10-19（B1）：本函数已退化为**薄适配器**，主流程不在本文件
 *
 * 原因：`handleIncoming` 原先同时承担两件不同的事 —— ① "iLink 消息长什么样"
 * ② "一条已到达的消息该投到哪、怎么答、怎么记账"。接第二家 IM 时只有 ① 需要新写，
 * 而 ② 应该**被两家共用**。两者混在一个函数里 ⇒ 飞书接进来只能复制一整份主流程。
 *
 * ⇒ 主流程搬到 `im/inbound-event.ts`，本函数只做**形状翻译**：
 *   `msg`（iLink）＋ `cred`（iLink 凭据）→ `ImInboundEvent` ＋ `ImAccountIo`。
 *
 * ## 为什么保留这个签名（而不是让调用方直接调新的主流程）
 *
 * 全仓约 50 处测试按 iLink 形状驱动本函数，而 B1 的验收判据是「**微信行为逐字不变**」
 * （用例数守恒 ＋ 真机一条微信）。保留签名 ⇒ 那 50 处**逐字不动**，判据可复算。
 *
 * 会话语义（不变）：会话 id 由**轨迹编码**派生 ⇒ 同一条轨迹恒同一条 dsh 会话；
 * 进程内已有 → 延续；无 → 固定 id resume-or-create。
 */
export async function handleIncoming(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  msg: Pick<WeixinMessage, 'from_user_id' | 'context_token' | 'item_list'>,
  /**
   * **机器级模式**（P0-3 A）：目标已解析好（`root` 入参即该目标根）⇒ 不再自行路由，
   * 且**不看本 CCC 的 `weixin.enabled`**。⚠️ 行为开关仍归目标 CCC。
   */
  preset?: { target: ResolvedInboundTarget },
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return

  // 🔴 **留住这张会话票**（2026-10-21）：`context_token` 是「当前对话上下文的会话能力令牌」，
  // 协议要求主动发送也带上它（公开规范 §5.10/§6.4）。不存 ⇒ 回复一发完就再也没有票 ⇒
  // 之后所有主动发送都是裸发 ⇒ 表现为"久不发言就不通"。
  // ⚠️ 必须在这里（**早于任何早退分支**）记：哪怕这条消息后来没投递（未命中路由等），
  //    服务端给的票仍然是有效的上下文 ⇐ 它证明"此刻这个会话窗口是活的"。
  rememberContextToken(accountId, fromUserId, msg.context_token)

  // ── 形状翻译：iLink → 中立事件 ────────────────────────────────────────────
  const event: ImInboundEvent = {
    userId: fromUserId,
    text: extractWeixinText(msg),
    // 媒体项与 iLink 的差异**全部收在这一处**：中立层只拿到"取字节的动作"。
    media: extractWeixinMedia(msg).map((ref) => ({
      kind: ref.kind,
      fileName: ref.fileName,
      fetch: () => downloadMedia({
        item: ref.item,
        mediaType: ref.kind === 'image' ? 'image_item' : 'file_item',
      }).then((r) => (r ? { data: r.data, fileName: r.fileName } : null)),
    })),
    hasVoice: hasVoiceItem(msg),
    replyRef: msg.context_token,
  }

  // ── 动作面：中立 io → iLink 发送/打字 ─────────────────────────────────────
  const io: ImAccountIo = {
    sendText: async ({ toUserId, text, replyRef }) => {
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId,
        text,
        contextToken: replyRef,
      })
    },
    typingStart: ({ toUserId, replyRef }) => sendTypingStart(cred, accountId, toUserId, replyRef),
    typingStop: ({ toUserId }) => sendTypingStop(cred, accountId, toUserId),
  }

  await handleInboundEvent(ctx, root, accountId, io, event, preset)
}

/**
 * **机器级 poller 的单条消息入口**（P0-3 A）。
 *
 * 与 `handleIncoming` 的唯一差别：**目标由机器级订阅表逐条解析，且没有 CCC 级回退**
 * （方案 §3.1：机器级模式下**未命中 = 不投递**，不是"投给默认角色"）。
 * 解析出来后把**目标根**当 `root` 交给 `handleIncoming`（并带上 `preset`）。
 *
 * 🔵 **导出供测试直接驱动**（与 `handleIncoming` 同款：它俩都是"单条消息的入口"，
 * 生产路径 `runAccountLoop` 只是循环壳）。
 */
export async function handleMachineIncoming(
  ctx: Context,
  accountId: string,
  cred: WeixinAccountCredential,
  msg: Pick<WeixinMessage, 'from_user_id' | 'context_token' | 'item_list'>,
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return
  const target = await resolveInboundTarget(ctx, { account: accountId, user: fromUserId, cccFallback: null })
  if (!target) return // 未命中／目标不存在 ⇒ 已留痕／已响亮出声，两者都**不投递**
  await handleIncoming(ctx, target.root, accountId, cred, msg, { target })
}

/**
 * **按渠道读凭据**（P3 起的单一入口）。
 *
 * 为什么必须抽成一个函数：CCC 级桥（`syncCccBridge`）与机器级 poller（`syncMachinePollers`）
 * 是**两条装配路径**，原先各自写着"怎么从 localstore 取微信 token"。接第二家渠道时若两边各写一份，
 * 必然分叉（一家改了另一家忘改，且**没有任何机械信号**）。
 *
 * 两种取法的**真实差别**（不是风格差异）：
 * - **CCC 级**：凭据在 localstore（`WEIXIN_<A>_TOKEN` / `FEISHU_<A>_APPID|SECRET`）。
 * - **机器级**：凭据在插件设置行（`account.token`）——那是宿主设置面，不经 localstore。
 *
 * ⇒ 本函数只负责**把"渠道"翻译成"该读哪套字段"**，返回统一形状 `ImAccountCredential`。
 *   微信的 appId 恒 undefined；飞书把 appSecret 装进 `token`（让两边共用同一个就绪判据位置）。
 */
function readImCredentialByChannel(root: string, accountId: string, channel: string): ImAccountCredential | null {
  if (channel === 'feishu') {
    const f = readFeishuCredential(root, accountId)
    return f ? { appId: f.appId, token: f.appSecret } : null
  }
  const w = readWeixinCredential(root, accountId)
  return w ? { token: w.token, baseUrl: w.baseUrl, userId: w.userId } : null
}

/**
 * 启动/重建某 CCC 的桥：读配置 → 对每个 enabled + 有凭据的账号启动轮询循环。
 * 已存在（配置变化热重建）→ 先停旧循环再启动新的。
 *
 * 🔴 **P0-2（2026-09-27，方案 §2.6）：一账号一 poller** —— 起循环**之前**先过机器级归属判定
 * （`im/inbound.ts`）：身份被**别的** CCC 占着的账号**不起循环**，只留一条响亮日志。
 * 身份 = **凭据 token 的哈希**（不是 `accountId`：那是每 CCC 的本地标签，跨 CCC 无意义）。
 * 先 `releasePollersOf(root)` 再重新 claim —— 热重建语义与"归属粘住不漂"的论证见该函数注释。
 */
export function syncCccBridge(ctx: Context, root: string): void {
  const existing = bridges.get(root)
  if (existing) {
    for (const loop of existing.loops.values()) loop.stopped = true
    bridges.delete(root)
  }
  // 先放开本 CCC 的旧归属（同步段：无 await ⇒ 没有"被别人抢走"的窗口）
  releasePollersOf(root)

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return

  // 组装请求（只含 enabled ＋ 已绑定凭据的账号）——凭据随请求带上，避免后面二次读取
  const requests: PollerRequest[] = []
  const creds = new Map<string, ImAccountCredential>()
  /** 账号 id → 它的实现（P2：按 `channel` 查派发表） */
  const implByAccount = new Map<string, ImAccountImpl>()
  for (const account of settings.accounts ?? []) {
    if (account.enabled === false) continue
    const channel = normalizeAccountChannel((account as { channel?: string }).channel)
    const impl = getImAccountImpl(channel)
    if (!impl) {
      if (!warnedChannels.has(`${account.accountId}:${channel}`)) {
        warnedChannels.add(`${account.accountId}:${channel}`)
        console.warn(`[serenity-hooks] ⚠ weixin-bridge: 账号 ${account.accountId}（ccc=${root}）的渠道 "${channel}" **本机未实现** ⇒ 不起循环（已实现：${imAccountChannels().join(', ') || '(无)'}）`)
      }
      continue
    }
    const cred = readImCredentialByChannel(root, account.accountId, channel)
    if (!cred) continue // 无凭据（未绑定）→ 跳过
    if (!impl.isReady(cred)) continue
    implByAccount.set(account.accountId, impl)
    creds.set(account.accountId, cred as WeixinAccountCredential)
    requests.push({ root, accountId: account.accountId, identity: accountIdentity(root, account.accountId, cred.token ?? '') })
  }

  const plan = planPollerClaims(requests, pollerOwners())
  // 被跳过**必须出声**：否则表现为"某个 CCC 的桥莫名其妙不工作"（fail-closed 但可见）
  for (const { request, ownedBy } of plan.skipped) {
    console.warn(
      `[serenity-hooks] ⚠ weixin-bridge: 账号 ${request.accountId}（ccc=${root}）已被 ccc=${ownedBy.root} 的账号 ${ownedBy.accountId} 轮询` +
        ' ⇒ 本处不重复起循环（一账号一 poller；方案 §2.6）',
    )
  }

  const bridge: CccBridge = { root, loops: new Map() }
  for (const claim of plan.claims) {
    const cred = creds.get(claim.accountId)
    const impl = implByAccount.get(claim.accountId)
    if (!cred || !impl) continue
    // 🔴 P2：起循环交给账号自己的实现（不认具体渠道）
    const loop = impl.startLoop({ ctx, root, accountId: claim.accountId, cred, machine: false })
    bridge.loops.set(claim.accountId, loop)
  }
  commitPollerClaims(plan)
  if (bridge.loops.size > 0) {
    bridges.set(root, bridge)
    console.log(`[serenity-hooks] ✓ weixin-bridge: ccc=${root} accounts=${[...bridge.loops.keys()].join(',')}`)
  }
}

/** 停止某 CCC 的桥（移除账号/禁用时）；同时释放它的账号归属 */
export function stopCccBridge(root: string): void {
  const bridge = bridges.get(root)
  releasePollersOf(root)
  if (!bridge) return
  for (const loop of bridge.loops.values()) loop.stopped = true
  bridges.delete(root)
}

/**
 * 停掉**全部 CCC 级桥**（不碰机器级 poller）＋ 释放它们各自的账号归属。
 * 🔴 模式切换时必须先调它：否则同一个 bot 会被**两处**轮询（方案 §2.6 要消灭的正是这个）。
 */
function stopCccBridges(): void {
  for (const root of [...bridges.keys()]) stopCccBridge(root)
}

/** 停掉**机器级 poller**（不碰 CCC 级桥）＋ 释放机器级归属 */
function stopMachineLoops(): void {
  for (const loop of machineLoops.values()) loop.stopped = true
  machineLoops.clear()
  releasePollersOf(MACHINE_SCOPE)
}

/**
 * 停止全部桥（插件 dispose）：CCC 级 ＋ 机器级
 */
export function stopAllBridges(): void {
  stopCccBridges()
  stopMachineLoops()
  releaseAllPollers()
}

// ── P0-3 A：机器级账号表 ⇒ 起 poller（"上移 ACC 层"的第二步）──────────────────────

/** 已告警过的"未实现渠道"（避免每次 session/created 都刷一行） */
const warnedChannels = new Set<string>()

/**
 * **机器级模式**：按**账号**起 poller（方案 §2.6「一账号一 poller」的正面形态）。
 *
 * 与 CCC 模式的差别：poller **不属于任何 CCC** —— 消息投到哪由**订阅表逐条决定**
 * （见 `handleMachineIncoming`）。凭据来自机器级配置本身（方案 Q3：凭据落插件 Config）。
 *
 * 🔴 进入本函数即**先停掉全部 CCC 级桥**：两种模式**互斥**（同时跑 = 同一 bot 两处轮询）。
 */
function syncMachinePollers(ctx: Context, hc: HumanChannelSettings): void {
  stopCccBridges()

  const requests: PollerRequest[] = []
  const creds = new Map<string, ImAccountCredential>()
  /** 账号 id → 它的实现（P2：**按 `channel` 查派发表**，不再写死 weixin） */
  const implByAccount = new Map<string, ImAccountImpl>()
  for (const account of hc.accounts) {
    const id = account.id
    if (account.enabled === false) continue
    if (!id) {
      console.warn('[serenity-hooks] ⚠ human-channel: 机器级账号表有一行**缺 `id`** ⇒ 跳过（该行无法被订阅表引用）')
      continue
    }
    // 🔴 P2：**按 channel 取实现**（原先是写死 `!== 'weixin'` 就跳过）。
    //    未注册的实现 ⇒ **出声但不静默跳过** —— 静默会表现成"某账号莫名不工作"。
    const channel = normalizeAccountChannel(account.channel)
    const impl = getImAccountImpl(channel)
    if (!impl) {
      // 🔴 未注册的实现 ⇒ **出声但不静默跳过**（静默会表现成"某账号莫名不工作"）。
      //    变异探针已验：把这里改成裸 continue ⇒ `human-channel-machine-poller.test.ts`
      //    的「渠道未实现 ⇒ 出声」当场变红 ⇒ 这条判据承重。
      if (!warnedChannels.has(`${id}:${channel}`)) {
        warnedChannels.add(`${id}:${channel}`)
        console.warn(`[serenity-hooks] ⚠ human-channel: 账号 ${id} 的渠道 "${account.channel ?? '(未填)'}" **本机未实现** ⇒ 不起 poller（已实现：${imAccountChannels().join(', ') || '(无)'}）`)
      }
      continue
    }
    // 🔴 机器级凭据来自**插件设置行**（不经 localstore）。飞书两要素：appId(account.userId? 不) ＋
    //    token(=appSecret)。⚠️ 设置行的形状是通道无关的（只有 token/userId 两格），
    //    飞书把 appId 放进 `account.appId`（设置面新增的可选字段，缺省 undefined ⇒ 微信不受影响）。
    const token = (account.token ?? '').trim()
    const appIdRaw = (account as { appId?: string }).appId
    const cred: ImAccountCredential = {
      token,
      baseUrl: '',
      userId: account.userId,
      ...(channel === 'feishu' && typeof appIdRaw === 'string' ? { appId: appIdRaw.trim() } : {}),
    }
    if (!impl.isReady(cred)) {
      console.warn(`[serenity-hooks] ⚠ human-channel: 账号 ${id} ${impl.notReadyReason?.(cred) ?? '**凭据不全**'} ⇒ 不起 poller`)
      continue
    }
    implByAccount.set(id, impl)
    // baseUrl 留空 = 走官方默认（机器级 schema 里刻意没有它；§2.2 拟稿同）
    creds.set(id, cred)
    requests.push({ root: MACHINE_SCOPE, accountId: id, identity: accountIdentity(MACHINE_SCOPE, id, token) })
  }

  // 归属判定复用 P0-2 的同一套（**同批重复身份一律跳过**：机器级表里两行绑同一个 bot
  // 也会被拦下 —— 与"跨 CCC 同账号"是同一类错误，不该有两套判据）
  const plan = planPollerClaims(requests, pollerOwners())
  for (const { request, ownedBy } of plan.skipped) {
    console.warn(
      `[serenity-hooks] ⚠ human-channel: 机器级账号 ${request.accountId} 与 ${ownedBy.accountId} **绑的是同一个 bot**`
      + ' ⇒ 本处不重复起循环（一账号一 poller；方案 §2.6）',
    )
  }

  stopMachineLoops()
  for (const claim of plan.claims) {
    const cred = creds.get(claim.accountId)
    const impl = implByAccount.get(claim.accountId)
    if (!cred || !impl) continue
    // 🔴 P2：起循环的动作交给**账号自己的实现**（微信与飞书并列，装配处不认具体渠道）
    const loop = impl.startLoop({ ctx, root: MACHINE_SCOPE, accountId: claim.accountId, cred, machine: true })
    machineLoops.set(claim.accountId, loop)
  }
  commitPollerClaims(plan)
  if (machineLoops.size > 0) {
    console.log(`[serenity-hooks] ✓ human-channel: 机器级 poller accounts=${[...machineLoops.keys()].join(',')}（与 CCC 无关）`)
  }
}

/**
 * 人机信道的**装配入口**（P0-3 A）—— 决定用哪种模式起 poller。
 *
 * 🔴 **模式由机器级账号表决定**（方案 §11.3 **Q5** 的过渡期语义）：
 *  - 账号表**非空** ⇒ **机器级模式**：按账号起 poller；路由**只认订阅表**
 *  - 账号表**为空** ⇒ **回退模式**（今天的形态）：按 CCC 起桥；路由**先查订阅表，未命中回退
 *    到 CCC 级 routes** ⇒ **不打断在用的微信**
 * ⚠️ 两种模式**互斥**（各自进入时先停掉另一种），否则同一个 bot 会被两处轮询。
 */
export function syncHumanChannel(ctx: Context): void {
  let hc: HumanChannelSettings | undefined
  try {
    hc = readSimpleSettings().humanChannel
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ human-channel: 机器级配置读取失败 ⇒ 按"未配置"处理（回退按 CCC 起桥）: ${String((err as Error)?.message ?? err)}`)
  }
  // 🔴 缺 `humanChannel` 与"读取失败"**同处理** = **未配置** ⇒ 回退模式（不打断在用的微信）。
  //    ⚠️ 这不是"防御性编程"：本函数在 `apply` 的调用链上，而**宿主对插件 apply 抛错 = 整个 dsh
  //    启动失败** ⇒ 一个形状不全的设置源绝不能把启动带下去。**门禁实测抓到过这一处**
  //    （`trajectory-startup-retry.test.ts` 对设置模块做了部分替身 ⇒ `humanChannel` 不在其中）。
  //    🔵 顺带：**"缺这一段"与"这段是空的"语义相同**（都是"机器级未配置"）⇒ 无需造一个缺省对象。
  if (hc && hc.accounts.length > 0) {
    try {
      syncMachinePollers(ctx, hc)
    } catch (err) {
      console.warn(`[serenity-hooks] ✗ human-channel: 机器级 poller 装配失败: ${String((err as Error)?.message ?? err)}`)
    }
    return
  }
  // 过渡期回退：按 CCC 起桥（原 `registerWeixinBridge` 的形态，逐字保留）
  void (async () => {
    try {
      stopMachineLoops()
      // C2（E5 修正）：CCC 枚举归 ccc-roots.listCccs——**并集**（工作区注册表 ∪ 持久化会话
      // ∪ live 会话），取代原先"只认 live 会话 cwd"的第三份内联 Set 实现。
      // 收益：没有 live 会话时也能为已知 CCC 启桥（原实现会漏）。
      // 角色不读（withRoles 缺省 false）——本处只需要根。
      const { listCccs } = await import('../kernel/ccc-roots.js')
      // 未配置的 CCC 不启动（syncCccBridge 内部判断 enabled）
      for (const entry of await listCccs(ctx)) syncCccBridge(ctx, entry.root)
    } catch {
      /* 扫描失败忽略（桥仍可在会话变化时重试） */
    }
  })()
}

// ── 主动发送（v1.30.9，S142 用户需求"微信桥支持被调用发消息给指定用户"）──

/** 主动发送失败原因（稳定 code——入口层翻译成 HTTP 状态 + 可行动提示） */
type ProactiveSendErrorCode =
  | 'BRIDGE_DISABLED'
  | 'NO_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_BOUND'
  | 'SEND_FAILED'

interface ProactiveSendInput {
  /** CCC 根（绝对路径；由入口层解析名称/路径后传入） */
  root: string
  /** 目标用户（iLink from_user_id，形如 xxx@im.wechat；别名解析归调用方） */
  toUserId: string
  /** 文本（md → 微信纯文本由 sendTextMessage 内置转换） */
  text: string
  /** 发送账号（缺省 = 该 CCC 第一个启用且已绑定的账号） */
  accountId?: string
}

type ProactiveSendResult =
  | { ok: true; accountId: string; userId: string; sessionId: string; role: string }
  | { ok: false; code: ProactiveSendErrorCode; error: string; remediation?: string }

/**
 * 以 bot 身份主动给指定用户发文本（**不经用户消息触发**）。
 *
 * 为什么放在桥里而不是让 CCC 自己直连 iLink（用户拍板 A 方案）：
 * ① **记录归桥**——发送成功后触发既有 outgoing hook，`_weixin-logs/*.jsonl` 与对话回复
 *    同源同格式（事件多一个 `source: 'proactive'` 标记）；② 协议/账号/凭据解析单一真相源，
 *    CCC 侧不必重复实现 sendmessage；③ 多账号可选。
 *
 * 记录一致性：`sessionId` 取 `weixinSessionIdFor(toUserId)`——与该用户平时对话**同一条轨迹**，
 * 记录里能直接按会话串联；`role` 取该 CCC 路由命中角色（未命中 → 空串）。
 *
 * 主动消息不带 context_token（iLink 接受 bot 主动发起；带 token 的路径见 handleIncoming 回复）。
 * @param input CCC 根 + 目标用户 + 文本 +（可选）账号
 * @returns 成功含 accountId/userId/sessionId/role；失败含稳定 code 与可行动提示（不抛错）
 */
/** 账号解析结果（文本 / 文件发送共用） */
type WeixinAccountResolution =
  | { ok: true; accountId: string; cred: WeixinAccountCredential }
  | { ok: false; code: ProactiveSendErrorCode; error: string; remediation?: string }

/**
 * 解析该 CCC 的发送账号 + 凭据（v1.31.0：文本与文件发送的**单一账号选择真相源**）。
 * 顺序：桥启用 → 有启用账号 → 指定账号存在 → 凭据已绑定（扫码）。
 * @param root CCC 根
 * @param accountId 指定账号（缺省 = 第一个启用账号）
 */
export function resolveWeixinAccount(root: string, accountId?: string): WeixinAccountResolution {
  const settings = readWeixinSettings(root)
  if (!settings.enabled) {
    return { ok: false, code: 'BRIDGE_DISABLED', error: `微信桥未启用（ccc=${root}）`, remediation: '在 CCC 的 .opencode/serenity.json weixin.enabled 打开' }
  }
  const accounts = (settings.accounts ?? []).filter((a) => a.enabled !== false)
  if (accounts.length === 0) {
    return { ok: false, code: 'NO_ACCOUNT', error: '微信桥未配置任何启用账号', remediation: '在设置面板「微信桥」扫码绑定账号' }
  }
  const id = accountId ?? accounts[0]!.accountId
  if (!accounts.some((a) => a.accountId === id)) {
    return {
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
      error: `账号不存在或未启用: ${id}`,
      remediation: `可用账号: ${accounts.map((a) => a.accountId).join(', ')}`,
    }
  }
  const cred = readWeixinCredential(root, id)
  if (!cred) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', error: `账号未绑定（无凭据）: ${id}`, remediation: '在设置面板重新扫码绑定' }
  }
  return { ok: true, accountId: id, cred }
}

export async function sendProactiveText(input: ProactiveSendInput): Promise<ProactiveSendResult> {
  const { root, toUserId } = input
  const settings = readWeixinSettings(root)
  const account = resolveWeixinAccount(root, input.accountId)
  if (!account.ok) return account
  const { accountId, cred } = account

  // 记录用的会话 id：按**该用户当前路由到的轨迹**派生（与真实对话同一条轨迹，
  // 记录里能直接按会话串联）。无路由 ⇒ 用用户标识兜底（仍可串联，只是没有轨迹语义）。
  const trajectory = matchWeixinRoute(settings.routes ?? [], toUserId) ?? ''
  const sessionId = weixinSessionIdForTrajectory(trajectory !== '' ? trajectory : sanitizeFileName(toUserId) || 'unknown')
  /**
   * 🔴 **带上最近一次的 `context_token`**（2026-10-21，协议规范 §5.10/§6.4）。
   *
   * 修前这里是**裸发**（`sendTextMessage` 不传 `contextToken`）。而规范把 `context_token`
   * 定为「会话能力令牌」：主动发送**依赖最近一次入站消息**带来的那张票（§12 对比表逐字：
   * 这正是微信相对 Telegram/Slack 的根本差异）。
   * ⇒ 没有票时，服务端无法把消息关联到对话窗口 ⇒ 表现为"久不发言就发不出去"。
   *
   * ⚠️ **仍然允许无票发送**（不改成硬拒绝）：修前就是这么发的，而且**部分时机它是能成功的**
   * （票还在服务端窗口内的那些时刻）。改成硬拒绝 = 把"有时能发"变成"永远不发"。
   * ⇒ 取**尽力而为 + 如实回执**：能带就带；没票照发，但把"没票"这件事**写进回执**，
   * 让人知道这一条是"运气发出去的"（D186：可以降级，但不许不出声）。
   */
  const contextToken = recallContextToken(accountId, toUserId)
  try {
    await sendTextMessage({
      baseUrl: cred.baseUrl,
      token: cred.token,
      toUserId,
      text: input.text,
      ...(contextToken === undefined ? {} : { contextToken }),
    })
  } catch (err) {
    /**
     * 🔴 **失败必须落盘**（2026-10-21，O1）。修前失败只回给调用方、**不写任何流水**
     * （outgoing hook 只在**成功后**触发）⇒ 「失败过没有、失败成什么样」在盘上不可见
     * ⇒ 下次报障只能猜。这里补上**只有失败才会产生**的那行日志。
     *
     * ⚠️ 按规范 §11：`ret=-2` 在社区实现里被误报成"rate limited"，
     *    而真因常是**缺 `context_token`**（第三方实测）⇒ 故把「有没有票」一起记进日志，
     *    这样一眼能分辨"票的问题"还是"账号/网络的问题"。
     */
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(
      `[serenity-hooks] ✗ im 主动发送失败: account=${accountId} user=${toUserId} ` +
        `contextToken=${contextToken === undefined ? 'ABSENT(无票，裸发)' : 'present'} err=${detail}`,
    )
    return {
      ok: false,
      code: 'SEND_FAILED',
      error: `发送失败: ${detail}`,
      ...(contextToken === undefined
        ? { remediation: '该用户近期未发过消息 ⇒ 手上没有 context_token（会话能力令牌）。协议没有"主动开新会话"的 API ⇒ 请先让用户在微信里发一条消息激活会话，再重试。' }
        : {}),
    }
  }
  // hook：outgoing（source=proactive）——与回复同源记录；失败仅日志（旁路容忍 H3）
  if (settings.hook) {
    void invokeWeixinHook(root, settings.hook, buildOutgoingHookEvent({
      cccRoot: root,
      // 本文件是微信 iLink 的发送实现 ⇒ 渠道已知（不从 accountId 名字推断，D167）
      channel: 'weixin',
      accountId,
      userId: toUserId,
      sessionId,
      role: trajectory,
      reply: markdownToPlainText(input.text),
      source: 'proactive',
    })).catch((err) => {
      console.log(`[serenity-hooks] weixin hook outgoing(proactive) error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return { ok: true, accountId, userId: toUserId, sessionId, role: trajectory }
}

/**
 * 桥状态快照（面板数据源）：每 CCC → 每账号 → 轮询健康。
 * 🔴 **P0-3 A 起多一行**：机器级 poller 以 `ccc: '<machine>'`（`MACHINE_SCOPE`）出现 ——
 * 它**不属于任何 CCC**，故**不伪装成某个 CCC 的行**（面板按原样显示这个哨兵值即可）。
 */
export function weixinBridgeStatus(): Array<{
  ccc: string
  accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }>
}> {
  const out: Array<{ ccc: string; accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }> }> = []
  const toAccounts = (loops: Map<string, AccountLoop>) => [...loops.entries()].map(([accountId, loop]) => ({
    accountId,
    lastPollAt: loop.lastPollAt,
    ...(loop.lastError ? { lastError: loop.lastError } : {}),
  }))
  for (const [root, bridge] of bridges) out.push({ ccc: root, accounts: toAccounts(bridge.loops) })
  if (machineLoops.size > 0) out.push({ ccc: MACHINE_SCOPE, accounts: toAccounts(machineLoops) })
  return out
}

/**
 * 装配（index.ts 调用）：**按机器级配置决定模式**（P0-3 A：`syncHumanChannel`），
 * 并监听会话变化以重扫（新 CCC 出现即启动其桥；配置变化也可经此路径热重建）。
 * 事件驱动（对齐 autotrajectory v1.26.15）。
 */
export function registerWeixinBridge(ctx: Context): void {
  // 🟢 P2：微信实现**已在模块求值时**登记进派发表（见文件末尾）——
  //    不能等这里，因为测试与面板会**直接**调 `syncCccBridge`（那时本函数还没跑过）。
  syncHumanChannel(ctx)

  // 会话创建/关闭 → 重扫（配置变化经此路径热重建 ⇒ 方案 Q8 的"热生效"）
  try {
    ctx.on('session/created', () => syncHumanChannel(ctx))
  } catch {
    /* 事件监听失败不阻断（桥仍可按需启动） */
  }
}

/**
 * 🔴 **P2 装配：微信实现登记进"账号实现派发表"**（模块求值时执行，不是等 `apply`）。
 *
 * ## 为什么必须在模块求值时做（本轮实测教训）
 *
 * 首版把这句放在 `registerWeixinBridge` 里 ⇒ 全量测试 **12 例红**，报的全是
 * 「`weixinBridgeStatus()` 空数组」。根因：测试与设置面板会**直接**调 `syncCccBridge` /
 * `syncHumanChannel`，那时装配入口还没跑过 ⇒ 派发表是空的 ⇒ 每条账号都走进
 * 「渠道未实现」分支（那分支是给**真正**未实现的渠道用的）。
 *
 * ⇒ 判据：**"谁能被调"决定"注册要在哪儿发生"**，不能按"装配流程"想当然。
 *
 * 注入的是本模块自己的函数（`getUpdates` / `handleIncoming` / `handleMachineIncoming`）——
 * 不需要 `weixin-account.ts import 回 bridge.ts`，避免两个文件互相 import 成环。
 */
installWeixinAccountImpl({
  getUpdates: getUpdates as never,
  handleIncoming: handleIncoming as never,
  handleMachineIncoming: handleMachineIncoming as never,
})

/**
 * 🆕 **P3 装配：飞书实现登记进同一张派发表**（同样是模块求值时）。
 *
 * 飞书不需要注入依赖 —— 它的收（`WSClient`）与发（`im.v1.message.create`）都在 SDK 里，
 * 主流程则复用 `im/inbound-event.ts`。⇒ 这一行就是"微信与飞书成为并列实现"的**最后一块**：
 * 派发表有了两个条目，装配处一行没改（它只按 `channel` 查表）。
 */
installFeishuAccountImpl()
