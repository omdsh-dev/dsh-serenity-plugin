/**
 * weixin-bridge.ts — 微信桥装配（F4c-3，v1.27.0 实验性）
 *
 * **CCC 级**：dsh 一个进程含多个 CCC，每个 CCC 独立对接微信桥（S142 用户拍板）——
 * 扫描 live CCC → 每 CCC 读 weixin 配置（enabled + accounts + routes）→
 * 启动该 CCC 该账号的 iLink 轮询循环。消息 → weixin-route 路由 → AcpServer 直调
 * （session/new + session/prompt，同进程不经网络——acp-core 传输无关设计）。
 *
 * 实验性质：未配置/未启用 → 完全不启动（零资源占用）。配置变化（面板写入）
 * → 热重建受影响 CCC 的桥（对齐 gateway 热重建模式）。
 *
 * 🔴 **P0-2（2026-09-27，方案 §2.6）：起桥仍按 CCC，但"谁轮询"按账号判定** ——
 * 同一个账号（= 同一份凭据）在同一时刻**只允许一个 poller**，判定与归属表在
 * `human-channel.ts`（机器级机制；本文件只接线）。这是"微信桥上移 ACC 层"的第一步。
 *
 * 外部面纯净（D9/D11 延续）：微信桥会话 = 外部面——session/prompt 走
 * includeTrajectory:false（对外不返回轨迹）；skiff 角色白名单即授权（G9）。
 */

import type { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readHandymanConfig } from './ccc.js'
// P0-2（方案 §2.6）：机器级归属判定（一账号一 poller）—— 机制在 human-channel.ts，本文件只接线
// P0-3（方案 §11.4）：订阅表 ＋ 路由 ＋ 机器级留痕 —— 同上，机制在 human-channel.ts
import {
  accountIdentity, planPollerClaims, commitPollerClaims, releasePollersOf, releaseAllPollers, pollerOwners, type PollerRequest,
  planInboundRoute, appendHumanChannelAudit, type InboundRoutePlan,
} from './human-channel.js'
// 机器级配置的**唯一读取入口**（P0-1 起 `humanChannel` 随它一起出）⇒ 天然热生效（方案 Q8）
import { readSimpleSettings, type HumanChannelSettings } from './settings-section.js'
import { readWeixinSettings, readWeixinCredential, weixinSessionIdFor, matchWeixinRoute, extractWeixinText, hasVoiceItem, extractWeixinMedia, sanitizeFileName, weixinInboundDir, type WeixinAccountCredential } from './weixin-route.js'
import { getUpdates, sendTextMessage, getConfig, sendTyping, TypingStatus, downloadMedia, sniffImageExt, markdownToPlainText, type WeixinMessage } from './weixin-api.js'
import { readSkiffRoles, type SkiffRoleConfig } from './skiff-role.js'
import { stripThink } from './skiff-debug.js'
import { createSkiffAgent, getSkiffAgent, askSkiff, ensureSkiffSession, workspaceTrajectoryLine, ensureWorkspacePromptSection } from './skiff-core.js'
import { noteManualOutputSession, forgetManualOutputSession, clearSentThisTurn, hasSentThisTurn, isWeixinOutputGuardActive } from './weixin-output-guard.js'
import { getActiveSessionInfo } from './trajectory-ops.js'
import { invokeWeixinHook, buildIncomingHookEvent, buildOutgoingHookEvent, type WeixinHookMediaRef } from './weixin-hook.js'

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
 * ② 归属表（`human-channel.ts`）按 root 区分拥有者 ⇒ 机器级用这个哨兵值，
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

/** 单账号轮询循环：getupdates 长轮询 → 逐消息分发 → 回复回写 */
async function runAccountLoop(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  loop: AccountLoop,
  /**
   * P0-3 A：**机器级 poller**。为真时逐条消息先由订阅表解析目标（`root` 入参**不使用**，
   * 传 `MACHINE_SCOPE` 即可）—— 因为"投到哪个 CCC"是**每条消息**才决定的。
   */
  machine = false,
): Promise<void> {
  let buf = ''
  while (!loop.stopped) {
    loop.lastPollAt = Date.now()
    try {
      const resp = await getUpdates({
        baseUrl: cred.baseUrl,
        token: cred.token,
        getUpdatesBuf: buf,
        timeoutMs: 35_000,
      })
      buf = resp.get_updates_buf ?? buf
      for (const msg of resp.msgs ?? []) {
        if (loop.stopped) break
        // 只处理用户消息（message_type=1）——忽略 bot 自己/系统消息
        if (msg.message_type !== 1) continue
        if (machine) await handleMachineIncoming(ctx, accountId, cred, msg)
        else await handleIncoming(ctx, root, accountId, cred, msg)
      }
      // 成功 → 立即续轮询（不 sleep；长轮询本身 hold 35s）
    } catch (err) {
      loop.lastError = err instanceof Error ? err.message : String(err)
      // 失败 → 指数退避重试（对齐 orbit/ws 模式）
      await new Promise((r) => setTimeout(r, POLL_RETRY_MS))
    }
  }
}

/**
 * 手动输出模式的**机制标记**（v1.30.10 引入；v1.30.16 按 S142 用户"这个词不能让 ACC 定义，
 * 要让 CCC 定义"重构）。
 *
 * 边界（R↓）：ACC 只提供**机制与数据**——"桥不转发最终文本"这个事实 + 三个已填好的参数值
 * （CCC 根 / 账号 / 用户 id）。**纪律措辞归 CCC**：怎么写、必须怎么做、后果是什么，全部写在
 * CCC 的角色提示词文件里（如 `.opencode/skiff/zhaocai.md` 的「输出通道」节），CCC 可随时改，
 * 且 v1.30.15 起角色提示词热重载——改完立即生效，无需 ACC 发版。
 *
 * 为什么不用 ACC 写措辞（历史教训）：v1.30.10~v1.30.15 由 ACC 内嵌一段纪律文案，用户实测
 * "约束不够，LLM 不听"——且措辞迭代要动插件代码 + 发版 + 重启；把措辞放 CCC 才能快速迭代，
 * 也符合"ACC 管机制、CCC 管内容"的归属二分。
 *
 * 标记格式（稳定，供 CCC 提示词引用；v1.31.0 起为 ACC 工具形态）：
 * ```
 * [serenity:weixin-manual-output]
 * im-bridge({channel:"weixin", action:"send", account:"<account>", user:"<user>", text:"<回复>"})
 * ```
 */
function weixinManualOutputMarker(root: string, accountId: string, userId: string): string {
  return [
    '[serenity:weixin-manual-output]',
    `im-bridge({channel:"weixin", action:"send", account:"${accountId}", user:"${userId}", text:"<回复>"})`,
  ].join('\n')
}

/**
 * 手动输出模式的**兜底判定**（纯函数，v1.30.17——把决策矩阵从装配里抽出来，可独立测试）。
 *
 * 四个条件同时成立才兜底：
 * ① CCC 显式开启 `fallbackOnNoSend`（缺省 false = 严格静默，向后兼容）
 * ② 机械闸门**已装配**（未装配时无法判定"是否发送过" → 宁可静默也不冒重复发送风险）
 * ③ 本轮**没有**成功发送（agent 自己发过 → 输出权归 agent，桥不插话）
 * ④ 有最终文本可转发（空文本无意义）
 */
export function manualOutputFallbackNeeded(input: {
  fallbackOnNoSend?: boolean
  guardActive: boolean
  sentThisTurn: boolean
  answer: string
}): boolean {
  return input.fallbackOnNoSend === true && input.guardActive && !input.sentThisTurn && input.answer !== ''
}

/**
 * 订阅表里的 `ccc` **别名 → CCC 根**（P0-3）。
 *
 * 别名取值与面板下拉**同源**（方案 §2.3：`listCccs({withRoles:true})` 的下拉）⇒
 * 先按 **`CccEntry.name`**（= CCC 根目录名，`basename(root)`）匹配；再退一步接受**绝对路径**
 * （手写配置时人会直接粘路径）。两条都试 ⇒ 两种写法都可用，且**不引入第二张名字表**。
 * @returns 命中的 CCC 根；枚举里没有 ⇒ `null`（调用方**响亮报错**，不静默丢弃）
 */
async function resolveCccRootByAlias(ctx: Context, alias: string): Promise<string | null> {
  try {
    const { listCccs } = await import('./ccc-roots.js')
    const entries = await listCccs(ctx)
    const byName = entries.find((e) => e.name === alias)
    if (byName) return byName.root
    const byRoot = entries.find((e) => e.root === alias)
    return byRoot ? byRoot.root : null
  } catch {
    // 枚举失败（服务不可用等）⇒ 与"没找到"同处理（响亮报错 + 留痕，由调用方做）
    return null
  }
}

/**
 * 路由解析结果：目标根 ＋ 角色名 ＋ **角色配置**（三者一起给，避免调用方再读一次 skiff.roles）。
 * `null` 从本函数出去 ⇒ **不投递**（未命中已留痕 ／ 目标不存在已响亮出声）。
 */
interface ResolvedInboundTarget {
  root: string
  roleName: string
  role: SkiffRoleConfig
}

/**
 * **入站路由的单一解析处**（P0-3）：机器级订阅表优先 → CCC 级回退；三档语义都在这里落地。
 *
 * 🔴 为什么抽成一个函数而不是写两遍：**两种模式（CCC 起桥 ／ 机器级起 poller）走的是同一套
 * 判据**，差别只有一格 —— **有没有 CCC 级回退**（`cccFallback`）。写两遍必然分叉。
 *
 * 三档（方案 §3.1，**刻意分档**）：
 *  - **未命中** ⇒ 不投递 ＋ **留痕**（`console.warn`，静默档：这是"表里没有你"，不是错误）
 *  - **表残缺** ⇒ **响亮出声**（`console.error`；且**独立于是否命中**）
 *  - **目标不存在**（CCC ／ 角色）⇒ **响亮报错**（`console.error`；不静默丢弃）
 *
 * @param input.cccFallback 过渡期回退（方案 Q5）；**机器级模式传 `null`** ⇒ 未命中即不投递
 */
async function resolveInboundTarget(ctx: Context, input: {
  account: string
  user: string
  cccFallback: { root: string; role: string } | null
}): Promise<ResolvedInboundTarget | null> {
  const route: InboundRoutePlan = planInboundRoute({
    subscriptions: readSimpleSettings().humanChannel.subscriptions,
    account: input.account,
    user: input.user,
    // 🔴 回退目标的 `ccc` 装的是**本 CCC 的绝对路径**（不是别名）—— 计划层两种写法都收
    //    （先按别名匹配、再按根匹配），故此处无需解析；`source === 'ccc-fallback'` 时
    //    下面**跳过**枚举查找，直接把 `target.ccc` 当根用。
    fallback: input.cccFallback ? { ccc: input.cccFallback.root, role: input.cccFallback.role } : null,
  })

  // 表残缺 ⇒ **响亮出声**（与"未命中"分档：笔误必须有人去改）
  // ⚠️ 它**独立于是否命中** —— 命中一条完好的行不掩盖另一行的笔误。
  for (const defect of route.defects) {
    console.error(
      `[serenity-hooks] ✗ human-channel: 订阅表第 ${defect.index + 1} 行**残缺**（缺 ${defect.missing.join(' / ')}）`
      + `｜已有字段 ${JSON.stringify(defect.present)}｜该行**不生效** —— 请补全或删掉（机器级 humanChannel.subscriptions）`,
    )
    appendHumanChannelAudit({ kind: 'subscription-defect', account: input.account, index: defect.index, missing: defect.missing, present: defect.present })
  }

  const target = route.target
  // ① 未命中 ⇒ **不投递 ＋ 留痕**（**静默档**：这不是错误，是"表里没有你"）
  if (!target) {
    const detail = route.skipReason === 'no-subscription'
      ? '机器级订阅表为空（且无 CCC 级回退）'
      : '订阅表里没有匹配 (账号, 用户) 的行'
    console.warn(`[serenity-hooks] ⚠ human-channel: 入站未命中订阅 ⇒ **不投递**（account=${input.account} user=${input.user}）：${detail}`)
    appendHumanChannelAudit({ kind: 'inbound-unrouted', account: input.account, user: input.user, reason: route.skipReason ?? 'no-match', detail })
    return null
  }

  // ② 目标**不存在** ⇒ **响亮报错**（方案 §3.1 / W5'：**不静默丢弃**）
  // 🔴 回退来源的 `ccc` **就是已知的本 CCC 根** ⇒ 不做枚举查找（省一次 IO，也不依赖它出现在枚举里）
  const root = route.source === 'ccc-fallback' ? target.ccc : await resolveCccRootByAlias(ctx, target.ccc)
  if (root === null) {
    const detail = `订阅表指向的 CCC "${target.ccc}" 在本机 CCC 枚举里不存在`
    console.error(`[serenity-hooks] ✗ human-channel: ${detail}（account=${input.account} user=${input.user}）—— 该消息**未投递**，请改订阅表`)
    appendHumanChannelAudit({ kind: 'inbound-target-missing', account: input.account, user: input.user, ccc: target.ccc, role: target.role, detail })
    return null
  }
  const role = readSkiffRoles(root).get(target.role)
  if (!role) {
    const detail = `目标 CCC "${target.ccc}" 未定义 skiff 角色 "${target.role}"`
    console.error(`[serenity-hooks] ✗ human-channel: ${detail}（account=${input.account} user=${input.user}）—— 该消息**未投递**，请改订阅表或该 CCC 的 skiff.roles`)
    appendHumanChannelAudit({ kind: 'inbound-target-missing', account: input.account, user: input.user, ccc: target.ccc, role: target.role, detail })
    return null
  }
  return { root, roleName: target.role, role }
}

/**
 * 处理单条微信消息：路由 → skiff 会话（固定 id 创建/延续）→ 提问 → 回复回写。
 *
 * 会话语义：`weixinSessionIdFor(fromUserId)` 固定可重建——同用户长期同一会话；
 * 进程内已有（getSkiffAgent 命中）→ 延续；无（首次/进程重启）→ createSkiffAgent
 * 固定 id resume-or-create（v1.27.2）：磁盘已有持久化 log → resume（历史延续，
 * 重启后记忆保留——真正的"同用户长期延续"）；无 log（首次）→ create。
 * "新的对话已开始"通知仅真正首次（create）时发送；resume/进程内延续不发。
 *
 * 完善（v1.27.3）：
 * - **语音支持**：`voice_item.text` = 微信服务端自带语音转写 → 与文本同路径进对话
 *   （无需下载/ASR）；语音无转写 → 降级提示"暂时无法解析"
 * - **正在输入**：处理前 sendtyping 1（微信显示"正在输入..."），处理后（含异常）0
 * - **媒体接收（图片/文件）**：桥侧 CDN 下载 + AES 解密 → 落盘 CCC 根
 *   `_tmp/weixin-inbound/<userhash>/` → question 注入「存在性 + 路径」（ACC 层只保证
 *   可达性——"让会话知道文件的存在并可以拿到"；识别/解析归角色 LLM 决策，不编排）。
 *   降级不静默：下载失败 / 超 20MB → 注入说明进对话；typing 窗口覆盖下载（M7）。
 *
 * 🔴 **P0-3（2026-09-27）：路由改由机器级订阅表决定**（本函数的 `root` 入参退为
 * **回退目标**）。两档语义刻意分开（方案 §3.1）：**未命中 ⇒ 不投递 ＋ 留痕**（静默档）；
 * **目标不存在（CCC ／ 角色）⇒ 响亮报错**（`console.error` ＋ 机器级留痕）。两者都
 * **不是**"投给默认角色"。
 */
export async function handleIncoming(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  msg: Pick<WeixinMessage, 'from_user_id' | 'context_token' | 'item_list'>,
  /**
   * **机器级模式**（P0-3 A）：目标已由 `handleMachineIncoming` 解析好（`root` 入参即该目标根）。
   * 给了它 ⇒ 本函数**不再自行路由**，且**不看本 CCC 的 `weixin.enabled`** ——
   * 起 poller 与路由都已上移机器级（目标 CCC 没配 weixin 段也照样收得到）。
   * ⚠️ **行为开关仍归目标 CCC**（`hook` ／ `autoReplyWithLastMessage` ／ `fallbackOnNoSend`）
   * —— 机器级只管"**谁收**"与"**投到哪**"，不管"**怎么答**"。
   */
  preset?: { target: ResolvedInboundTarget },
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return
  const text = extractWeixinText(msg)
  const mediaRefs = extractWeixinMedia(msg)

  const settings = readWeixinSettings(root)

  // ── P0-3 路由：**机器级订阅表优先** → CCC 级 `routes` 回退 ─────────────────────────
  // 🔴 回退是**过渡期**语义（方案 §11.3 **Q5**："不打断在用的微信"）：机器级账号表为空时，
  //    桥仍按 CCC 起、路由也仍认 CCC 级 routes。机器级一旦配起来 ⇒ 回退传 null ⇒
  //    **未命中 = 不投递**（**不是**"投给默认角色" —— 方案 §3.1 明令禁止）。
  // 🔴 三档语义（未命中 ／ 表残缺 ／ 目标不存在）的落地**只有一处** = `resolveInboundTarget`。
  let resolved: ResolvedInboundTarget | null
  if (preset) {
    resolved = preset.target // 机器级模式：目标已解析（且**不看本 CCC 的 enabled**）
  } else {
    if (!settings.enabled) return
    const cccRole = matchWeixinRoute(settings.routes ?? [], fromUserId)
    resolved = await resolveInboundTarget(ctx, {
      account: accountId,
      user: fromUserId,
      cccFallback: cccRole ? { root, role: cccRole } : null,
    })
  }
  if (!resolved) return // 未命中／目标不存在 ⇒ 已留痕／已出声，两者都**不投递**
  const { roleName, role } = resolved
  // 🔴 此后本函数的 `root` 语义 = **投递目标根**：回退模式下恒 === 入参 root；
  //    机器级模式下由订阅表指定（`handleMachineIncoming` 已把入参传成该根）。
  root = resolved.root

  // 纯语音无转写（无文本无媒体）→ 降级提示（不静默；不创建会话）
  if (!text && mediaRefs.length === 0) {
    if (hasVoiceItem(msg)) {
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: '（抱歉，暂时无法解析这条语音消息，请尝试发送文字）',
        contextToken: msg.context_token,
      }).catch(() => { /* 提示失败不影响 */ })
    }
    return
  }

  try {
    const sessionId = weixinSessionIdFor(fromUserId)
    const existing = getSkiffAgent(sessionId)
    const hc = readHandymanConfig(root)
    // v1.30.4：existing（进程内/重启后 live 复用）路径也走 ensureSkiffSession——
    // create 路径由 createSkiffAgent 内 ensure；live/老 agent 快路径此前跳过 → 未绑定/未注入。
    if (existing) {
      try {
        // 微信桥恒为持久身份（固定 skiff 会话 id）→ persistent=true
        ensureSkiffSession(root, existing, roleName, role, true)
      } catch (err) {
        console.warn(`[serenity-hooks] weixin-bridge ensure 失败（不影响处理）: ${String((err as Error)?.message ?? err)}`)
      }
    }
    const ref = existing
      ? { agent: existing, sessionId, resumed: true }
      : await createSkiffAgent(ctx, root, roleName, role, hc?.defaultModel, sessionId)

    if (!ref.resumed) {
      // 真正首次（无持久化历史）→ 通知用户"新对话开始"（对齐 3100 问答页行为）；
      // resume（历史延续）不发——用户记得之前的对话
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: '（新的对话已开始）',
        contextToken: msg.context_token,
      }).catch(() => { /* 通知失败不影响主流程 */ })
    }

    // 正在输入：处理前开始（**含媒体下载**——M7 用户等待时显示状态），处理完（含异常路径）结束
    await sendTypingStart(cred, accountId, fromUserId, msg.context_token)
    try {
      // 媒体：下载 → 落盘 → 存在性+路径注入（ACC 层最小闭环；M1/M2/M3/M4/M6）
      const mediaNotes: string[] = []
      const degradedNotes: string[] = []
      // hook 事件媒体列表（v1.27.13：成功带 relPath，失败 null——CCC 记录侧可完整审计）
      const hookMedia: WeixinHookMediaRef[] = []
      for (const mediaRef of mediaRefs) {
        const mediaType = mediaRef.kind === 'image' ? 'image_item' : 'file_item'
        const label = mediaRef.kind === 'image' ? '一张图片' : `文件 ${mediaRef.fileName ?? '(未命名)'}`
        const result = await downloadMedia({ item: mediaRef.item, mediaType })
        if (!result) {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（用户发送了${label}，但下载失败——可请用户重发）`)
          continue
        }
        if (result.data.length > MEDIA_MAX_BYTES) {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（用户发送了${label}，但超过 20MB 大小限制）`)
          continue
        }
        try {
          const inboundDir = weixinInboundDir(root, fromUserId)
          mkdirSync(inboundDir, { recursive: true })
          const fname = mediaRef.kind === 'image'
            ? `img_${Date.now()}_${randomBytes(4).toString('hex')}.${sniffImageExt(result.data)}`
            : (sanitizeFileName(result.fileName ?? '') || `file_${Date.now()}_${randomBytes(4).toString('hex')}`)
          const abs = join(inboundDir, fname)
          writeFileSync(abs, result.data)
          const rel = relative(root, abs)
          hookMedia.push({ kind: mediaRef.kind, relPath: rel })
          // 注引用**实际保存的文件名**（fname = 净化后）——agent 按 rel 路径找文件，名字须一致
          mediaNotes.push(`（用户发送了${mediaRef.kind === 'image' ? '一张图片' : `文件 ${fname}`}，已保存到 ${rel}）`)
        } catch {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（媒体保存失败，请重试）`)
        }
      }

      // question = 原文 + 媒体存在性注入 + 降级说明（不做内容转述/工具引导——M3）
      // v1.30.13（S142 用户："微信桥的注入机制每个用户消息都会注入，skiff 本身也会注入，
      // 这样就重复，能否微信桥情况下注入内容直接取 skiff 的"）：工作台纪律块**单一注入点**
      // = skiff agent 的系统提示词段（ensureWorkspacePromptSection，动态读活跃 mdPath）——
      // 桥不再每轮把它拼进 question（省 token + 不重复配置）。仅当该 agent 挂不上
      // 系统提示词段（返回 false）时降级为 question 前缀注入，保证约束仍在场。
      const parts: string[] = []
      const activeWorkspace = getActiveSessionInfo(sessionId)
      if (activeWorkspace?.mdPath) {
        const sectionOk = ensureWorkspacePromptSection(ref.agent, sessionId)
        if (!sectionOk) parts.push(workspaceTrajectoryLine(activeWorkspace.mdPath))
      }
      // v1.30.10：关闭自动回发最终文本（weixin.autoReplyWithLastMessage: false）→
      // 每轮注入**机制标记**（事实 + 已填参数，措辞归 CCC——见 weixinManualOutputMarker 头注）。
      // v1.30.16（用户"约束不够，LLM 不听"+"这个词要让 CCC 定义"）：
      // ① 标记移到**消息末尾**（recency——用户正文之前的位置被压过）
      // ② ACC 不再写纪律措辞（归 CCC 角色提示词，可热改）
      // ③ 登记手动模式会话 → 机械闸门在 turn-stopping 检查本轮是否真的发过（不可绕过）
      const manualOutput = settings.autoReplyWithLastMessage === false
      if (text) parts.push(text)
      parts.push(...mediaNotes, ...degradedNotes)
      if (manualOutput) {
        // v1.30.17：本轮开始 → 清空"已发送"标记（闸门只置位；桥在 askSkiff 后读它决定兜底）
        clearSentThisTurn(sessionId)
        noteManualOutputSession(sessionId, { root, accountId, userId: fromUserId, role: roleName })
        parts.push(weixinManualOutputMarker(root, accountId, fromUserId))
      } else {
        forgetManualOutputSession(sessionId)
      }
      const question = parts.join('\n')

      // hook：incoming 事件（用户 → bot）——媒体落盘后、askSkiff 前 fire。
      // 旁路容忍（H3）：异步 fire-and-forget，失败仅日志——不阻塞对话处理。
      const hookRel = settings.hook
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildIncomingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: roleName,
          text,
          media: hookMedia,
        })).catch((err) => {
          console.log(`[serenity-hooks] weixin hook incoming error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      const result = await askSkiff(ctx, ref.agent, question, undefined, { includeTrajectory: false })
      const answer = result.answer ?? ''
      // v1.30.10：手动输出模式——桥不转发最终文本（输出权归 agent，记录只记 agent 实际发出的
      // 消息，source=proactive）。系统类消息（新对话通知/语音提示）不受影响。
      //
      // v1.30.17 兜底（S142 用户拍板"鲁棒修法"）：`weixin.fallbackOnNoSend: true` 时，若本轮
      // agent **一次都没成功调用输出工具**（v1.31.0 起为 im-bridge；闸门打回 ≤2 次仍无效——实证某模型在寒暄类消息
      // 上跨 3 版提示词仍不调工具），桥把该轮最终文本转发给用户（`source: "reply-fallback"`），
      // 保证"不丢消息"。前置条件 `isWeixinOutputGuardActive()`：闸门未装配 → 无法判定 → 不兜底
      // （宁可静默也不冒重复发送的风险）。agent 自己发过 → 不兜底，输出权仍在 agent。
      if (manualOutput) {
        const fallback = manualOutputFallbackNeeded({
          fallbackOnNoSend: settings.fallbackOnNoSend,
          guardActive: isWeixinOutputGuardActive(),
          sentThisTurn: hasSentThisTurn(sessionId),
          answer,
        })
        if (!fallback) return
        const reply = markdownToPlainText(stripThink(answer))
        await sendTextMessage({
          baseUrl: cred.baseUrl,
          token: cred.token,
          toUserId: fromUserId,
          text: reply,
          contextToken: msg.context_token,
        })
        console.warn(
          `[serenity-hooks] ⚠ weixin 输出兜底：agent 本轮未发送（闸门打回用尽）→ 桥转发最终文本（session=${sessionId}, role=${roleName}）`,
        )
        if (hookRel) {
          void invokeWeixinHook(root, hookRel, buildOutgoingHookEvent({
            cccRoot: root,
            accountId,
            userId: fromUserId,
            sessionId,
            role: roleName,
            reply,
            source: 'reply-fallback',
          })).catch((err) => {
            console.log(`[serenity-hooks] weixin hook outgoing(reply-fallback) error: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
        return
      }
      if (answer === '') return

      // 回复文本：stripThink 剥离 <think> 块（微信桥用户反馈：用户不应看到思考过程）→
      // md→plain 转微信可见纯文本（sendTextMessage 内置同款转换——hook 记录与用户实际收到一致）
      const reply = markdownToPlainText(stripThink(answer))
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: reply,
        contextToken: msg.context_token,
      })

      // hook：outgoing 事件（bot → 用户）——发送成功后 fire（发送失败不记录——从未送达的回复无记录价值）
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildOutgoingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: roleName,
          reply,
        })).catch((err) => {
          console.log(`[serenity-hooks] weixin hook outgoing error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } finally {
      await sendTypingStop(cred, accountId, fromUserId)
    }
  } catch (err) {
    // 桥错误静默（日志可见；不中断轮询循环）——含堆栈（v1.27.2 诊断 resume 失败路径）
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[serenity-hooks] weixin-bridge error (ccc=${root}): ${msg}`)
    const stack = err instanceof Error ? err.stack : undefined
    if (stack) console.log(`[serenity-hooks] weixin-bridge stack:\n${stack.slice(0, 1500)}`)
  }
}

/**
 * **机器级 poller 的单条消息入口**（P0-3 A）。
 *
 * 与 `handleIncoming` 的唯一差别：**目标由机器级订阅表逐条解析，且没有 CCC 级回退**
 * （方案 §3.1：机器级模式下**未命中 = 不投递**，不是"投给默认角色"）。
 * 解析出来后把**目标根**当 `root` 交给 `handleIncoming`（并带上 `preset` ⇒ 它不再自行路由、
 * 也不看目标 CCC 的 `weixin.enabled`）。
 *
 * 🔴 为什么"起 poller"与"路由"必须同批（本件即 P0-2 的后半）：机器级 poller 收到消息时
 * **不知道它属于哪个 CCC** —— 那个答案是订阅表给的。没有订阅表 ⇒ **能收不能投**。
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
 * 启动/重建某 CCC 的桥：读配置 → 对每个 enabled + 有凭据的账号启动轮询循环。
 * 已存在（配置变化热重建）→ 先停旧循环再启动新的。
 *
 * 🔴 **P0-2（2026-09-27，方案 §2.6）：一账号一 poller** —— 起循环**之前**先过机器级归属判定
 * （`human-channel.ts`）：身份被**别的** CCC 占着的账号**不起循环**，只留一条响亮日志。
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
  const creds = new Map<string, WeixinAccountCredential>()
  for (const account of settings.accounts ?? []) {
    if (account.enabled === false) continue
    const cred = readWeixinCredential(root, account.accountId)
    if (!cred) continue // 无凭据（未扫码绑定）→ 跳过
    creds.set(account.accountId, cred)
    requests.push({ root, accountId: account.accountId, identity: accountIdentity(root, account.accountId, cred.token) })
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
    if (!cred) continue
    const loop: AccountLoop = { stopped: false, lastPollAt: 0 }
    bridge.loops.set(claim.accountId, loop)
    void runAccountLoop(ctx, root, claim.accountId, cred, loop)
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
  const creds = new Map<string, WeixinAccountCredential>()
  for (const account of hc.accounts) {
    const id = account.id
    if (account.enabled === false) continue
    if (!id) {
      console.warn('[serenity-hooks] ⚠ human-channel: 机器级账号表有一行**缺 `id`** ⇒ 跳过（该行无法被订阅表引用）')
      continue
    }
    // 只有已实现的渠道能起 poller（P2 才加第二个实现）⇒ 未实现的**出声但不静默跳过**
    if (account.channel !== 'weixin') {
      if (!warnedChannels.has(`${id}:${account.channel ?? ''}`)) {
        warnedChannels.add(`${id}:${account.channel ?? ''}`)
        console.warn(`[serenity-hooks] ⚠ human-channel: 账号 ${id} 的渠道 "${account.channel ?? '(未填)'}" **本机未实现** ⇒ 不起 poller（当前只有 weixin）`)
      }
      continue
    }
    const token = (account.token ?? '').trim()
    if (token === '') {
      console.warn(`[serenity-hooks] ⚠ human-channel: 账号 ${id} **无 token**（未绑定）⇒ 不起 poller`)
      continue
    }
    // baseUrl 留空 = 走官方默认（机器级 schema 里刻意没有它；§2.2 拟稿同）
    creds.set(id, { token, baseUrl: '', userId: account.userId })
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
    if (!cred) continue
    const loop: AccountLoop = { stopped: false, lastPollAt: 0 }
    machineLoops.set(claim.accountId, loop)
    void runAccountLoop(ctx, MACHINE_SCOPE, claim.accountId, cred, loop, true)
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
  //    （`skiff-startup-retry.test.ts` 对设置模块做了部分替身 ⇒ `humanChannel` 不在其中）。
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
      const { listCccs } = await import('./ccc-roots.js')
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

  const sessionId = weixinSessionIdFor(toUserId)
  const role = matchWeixinRoute(settings.routes ?? [], toUserId) ?? ''
  try {
    await sendTextMessage({ baseUrl: cred.baseUrl, token: cred.token, toUserId, text: input.text })
  } catch (err) {
    return { ok: false, code: 'SEND_FAILED', error: `发送失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  // hook：outgoing（source=proactive）——与回复同源记录；失败仅日志（旁路容忍 H3）
  if (settings.hook) {
    void invokeWeixinHook(root, settings.hook, buildOutgoingHookEvent({
      cccRoot: root,
      accountId,
      userId: toUserId,
      sessionId,
      role,
      reply: markdownToPlainText(input.text),
      source: 'proactive',
    })).catch((err) => {
      console.log(`[serenity-hooks] weixin hook outgoing(proactive) error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return { ok: true, accountId, userId: toUserId, sessionId, role }
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
  syncHumanChannel(ctx)

  // 会话创建/关闭 → 重扫（配置变化经此路径热重建 ⇒ 方案 Q8 的"热生效"）
  try {
    ctx.on('session/created', () => syncHumanChannel(ctx))
  } catch {
    /* 事件监听失败不阻断（桥仍可按需启动） */
  }
}
