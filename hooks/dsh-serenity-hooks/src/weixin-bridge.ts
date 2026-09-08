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
 * 外部面纯净（D9/D11 延续）：微信桥会话 = 外部面——session/prompt 走
 * includeTrajectory:false（对外不返回轨迹）；skiff 角色白名单即授权（G9）。
 */

import type { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findSerenityRoot, readHandymanConfig } from './ccc.js'
import { readWeixinSettings, readWeixinCredential, weixinSessionIdFor, matchWeixinRoute, extractWeixinText, hasVoiceItem, extractWeixinMedia, sanitizeFileName, weixinInboundDir, type WeixinAccountCredential } from './weixin-route.js'
import { getUpdates, sendTextMessage, getConfig, sendTyping, TypingStatus, downloadMedia, sniffImageExt, markdownToPlainText, type WeixinMessage } from './weixin-api.js'
import { readSkiffRoles } from './skiff-role.js'
import { stripThink } from './skiff-debug.js'
import { createSkiffAgent, getSkiffAgent, askSkiff, ensureSkiffSession, workspaceTrajectoryLine, ensureWorkspacePromptSection } from './skiff-core.js'
import { noteManualOutputSession, forgetManualOutputSession } from './weixin-output-guard.js'
import { getActiveSessionInfo } from './session-ops.js'
import { hostSessions } from './host/access.js'
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
        await handleIncoming(ctx, root, accountId, cred, msg)
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
 * 标记格式（稳定，供 CCC 提示词引用）：
 * ```
 * [serenity:weixin-manual-output]
 * msm("weixin-send", ["send", "--ccc", "<root>", "--account", "<account>", "--user", "<user>", "<回复>"])
 * ```
 */
export function weixinManualOutputMarker(root: string, accountId: string, userId: string): string {
  return [
    '[serenity:weixin-manual-output]',
    `msm("weixin-send", ["send", "--ccc", "${root}", "--account", "${accountId}", "--user", "${userId}", "<回复>"])`,
  ].join('\n')
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
 */
export async function handleIncoming(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  msg: Pick<WeixinMessage, 'from_user_id' | 'context_token' | 'item_list'>,
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return
  const text = extractWeixinText(msg)
  const mediaRefs = extractWeixinMedia(msg)

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return
  const roleName = matchWeixinRoute(settings.routes ?? [], fromUserId)
  if (!roleName) return // 无路由 → 不回复（未配置该用户）

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
    const role = readSkiffRoles(root).get(roleName)
    if (!role) {
      console.log(`[serenity-hooks] weixin-bridge: 路由命中角色 "${roleName}" 但该 CCC 未定义（检查 skiff.roles）`)
      return
    }
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
      // v1.30.10：手动输出模式——桥不转发最终文本（用户拍板：静默不兜底；记录只记 agent
      // 实际发出的消息，source=proactive）。系统类消息（新对话通知/语音提示）不受影响。
      if (manualOutput) return
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
 * 启动/重建某 CCC 的桥：读配置 → 对每个 enabled + 有凭据的账号启动轮询循环。
 * 已存在（配置变化热重建）→ 先停旧循环再启动新的。
 */
export function syncCccBridge(ctx: Context, root: string): void {
  const existing = bridges.get(root)
  if (existing) {
    for (const loop of existing.loops.values()) loop.stopped = true
    bridges.delete(root)
  }

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return

  const bridge: CccBridge = { root, loops: new Map() }
  for (const account of settings.accounts ?? []) {
    if (account.enabled === false) continue
    const cred = readWeixinCredential(root, account.accountId)
    if (!cred) continue // 无凭据（未扫码绑定）→ 跳过
    const loop: AccountLoop = { stopped: false, lastPollAt: 0 }
    bridge.loops.set(account.accountId, loop)
    void runAccountLoop(ctx, root, account.accountId, cred, loop)
  }
  if (bridge.loops.size > 0) {
    bridges.set(root, bridge)
    console.log(`[serenity-hooks] ✓ weixin-bridge: ccc=${root} accounts=${[...bridge.loops.keys()].join(',')}`)
  }
}

/** 停止某 CCC 的桥（移除账号/禁用时） */
export function stopCccBridge(root: string): void {
  const bridge = bridges.get(root)
  if (!bridge) return
  for (const loop of bridge.loops.values()) loop.stopped = true
  bridges.delete(root)
}

/**
 * 停止全部桥（插件 dispose）
 */
export function stopAllBridges(): void {
  for (const bridge of bridges.values()) {
    for (const loop of bridge.loops.values()) loop.stopped = true
  }
  bridges.clear()
}

// ── 主动发送（v1.30.9，S142 用户需求"微信桥支持被调用发消息给指定用户"）──

/** 主动发送失败原因（稳定 code——入口层翻译成 HTTP 状态 + 可行动提示） */
export type ProactiveSendErrorCode =
  | 'BRIDGE_DISABLED'
  | 'NO_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_BOUND'
  | 'SEND_FAILED'

export interface ProactiveSendInput {
  /** CCC 根（绝对路径；由入口层解析名称/路径后传入） */
  root: string
  /** 目标用户（iLink from_user_id，形如 xxx@im.wechat；别名解析归调用方） */
  toUserId: string
  /** 文本（md → 微信纯文本由 sendTextMessage 内置转换） */
  text: string
  /** 发送账号（缺省 = 该 CCC 第一个启用且已绑定的账号） */
  accountId?: string
}

export type ProactiveSendResult =
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
export async function sendProactiveText(input: ProactiveSendInput): Promise<ProactiveSendResult> {
  const { root, toUserId } = input
  const settings = readWeixinSettings(root)
  if (!settings.enabled) {
    return { ok: false, code: 'BRIDGE_DISABLED', error: `微信桥未启用（ccc=${root}）`, remediation: '在 CCC 的 .opencode/serenity.json weixin.enabled 打开' }
  }
  const accounts = (settings.accounts ?? []).filter((a) => a.enabled !== false)
  if (accounts.length === 0) {
    return { ok: false, code: 'NO_ACCOUNT', error: '微信桥未配置任何启用账号', remediation: '在设置面板「微信桥」扫码绑定账号' }
  }
  const accountId = input.accountId ?? accounts[0]!.accountId
  if (!accounts.some((a) => a.accountId === accountId)) {
    return {
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
      error: `账号不存在或未启用: ${accountId}`,
      remediation: `可用账号: ${accounts.map((a) => a.accountId).join(', ')}`,
    }
  }
  const cred = readWeixinCredential(root, accountId)
  if (!cred) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', error: `账号未绑定（无凭据）: ${accountId}`, remediation: '在设置面板重新扫码绑定' }
  }

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

/** 桥状态快照（面板数据源）：每 CCC → 每账号 → 轮询健康 */
export function weixinBridgeStatus(): Array<{
  ccc: string
  accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }>
}> {
  const out: Array<{ ccc: string; accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }> }> = []
  for (const [root, bridge] of bridges) {
    out.push({
      ccc: root,
      accounts: [...bridge.loops.entries()].map(([accountId, loop]) => ({
        accountId,
        lastPollAt: loop.lastPollAt,
        ...(loop.lastError ? { lastError: loop.lastError } : {}),
      })),
    })
  }
  return out
}

/**
 * 装配（index.ts 调用）：扫描 live CCC 启动桥 + 监听会话变化。
 * 事件驱动（对齐 autotrajectory v1.26.15）：live 会话出现 → 同步该 CCC 桥。
 */
export function registerWeixinBridge(ctx: Context): void {
  const syncFromLive = (): void => {
    try {
      const sessions = hostSessions(ctx)
      const cwds = (sessions?.list?.() ?? []).map((s) => s.header?.cwd ?? '').filter(Boolean)
      const roots = [...new Set(cwds.map((c) => findSerenityRoot(c))).values()].filter((r): r is string => r !== null)
      // 未配置的 CCC 不启动（syncCccBridge 内部判断 enabled）
      for (const root of roots) syncCccBridge(ctx, root)
    } catch {
      /* 扫描失败忽略 */
    }
  }

  syncFromLive()

  // 会话创建/关闭 → 重扫（新 CCC 出现即启动其桥；配置变化也可经此路径热重建）
  try {
    ctx.on('session/created', () => syncFromLive())
  } catch {
    /* 事件监听失败不阻断（桥仍可按需启动） */
  }
}
